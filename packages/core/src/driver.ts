import * as tls from 'node:tls'

import { create } from '@bufbuild/protobuf'
import { anyUnpack } from '@bufbuild/protobuf/wkt'
import { credentials } from '@grpc/grpc-js'
import { abortable } from '@ydbjs/abortable'
import { DiscoveryServiceDefinition, EndpointInfoSchema, ListEndpointsResultSchema } from '@ydbjs/api/discovery'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import type { CredentialsProvider } from '@ydbjs/auth'
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous'
import { YDBError } from '@ydbjs/error'
import { type RetryConfig, defaultRetryConfig, retry } from '@ydbjs/retry'
import {
	type ChannelOptions,
	type Client,
	ClientError,
	type ClientMiddleware,
	type CompatServiceDefinition,
	Metadata,
	Status,
	composeClientMiddleware,
	createClientFactory,
	waitForChannelReady,
} from 'nice-grpc'

import { type Connection, LazyConnection } from './conn.js'
import { dbg } from './dbg.js'
import { ConnectionPool } from './pool.js'
import { debug } from './middleware.js'

export type DriverOptions = {
	/**
	 * SSL/TLS options for secure connections.
	 *
	 * @deprecated Use `secureOptions` instead.
	 */
	ssl?: tls.SecureContextOptions
	secureOptions?: tls.SecureContextOptions | undefined
	channelOptions?: ChannelOptions
	credentialsProvider?: CredentialsProvider

	'ydb.sdk.application'?: string
	'ydb.sdk.ready_timeout_ms'?: number
	'ydb.sdk.token_timeout_ms'?: number
	'ydb.sdk.enable_discovery'?: boolean
	'ydb.sdk.discovery_timeout_ms'?: number
	'ydb.sdk.discovery_interval_ms'?: number
}

const defaultOptions: DriverOptions = {
	'ydb.sdk.ready_timeout_ms': 30_000,
	'ydb.sdk.token_timeout_ms': 10_000,
	'ydb.sdk.enable_discovery': true,
	'ydb.sdk.discovery_timeout_ms': 10_000,
	'ydb.sdk.discovery_interval_ms': 60_000,
} as const satisfies DriverOptions

if (!Promise.withResolvers) {
	Promise.withResolvers = function <T>(): {
		promise: Promise<T>
		resolve: (value: T | PromiseLike<T>) => void
		reject: (reason?: any) => void
	} {
		let resolve: (value: T | PromiseLike<T>) => void
		let reject: (reason?: any) => void
		const promise = new Promise<T>((res, rej) => {
			resolve = res
			reject = rej
		})
		return { promise, resolve: resolve!, reject: reject! }
	}
}

export class Driver implements Disposable {
	protected readonly cs: URL
	protected readonly options: DriverOptions = {}

	#pool: ConnectionPool
	#ready: PromiseWithResolvers<void> = Promise.withResolvers<void>()

	#connection: Connection
	#middleware: ClientMiddleware

	#credentialsProvider: CredentialsProvider = new AnonymousCredentialsProvider()
	#discoveryClient!: Client<typeof DiscoveryServiceDefinition>
	#rediscoverTimer?: NodeJS.Timeout

	constructor(connectionString: string, options: Readonly<DriverOptions> = defaultOptions) {
		dbg.extend('driver')('Driver(connectionString: %s, options: %o)', connectionString, options)

		if (!connectionString) {
			throw new Error('Invalid connection string. Must be a non-empty string')
		}

		this.cs = new URL(connectionString.replace(/^grpc/, 'http'))
		this.options = Object.assign({}, defaultOptions, options)
		this.options.secureOptions ??= this.options.ssl

		if (['grpc:', 'grpcs:', 'http:', 'https:'].includes(this.cs.protocol) === false) {
			throw new Error('Invalid connection string protocol. Must be one of grpc, grpcs, http, https')
		}

		if (this.cs.pathname === '' && this.cs.searchParams.has('database') === false) {
			throw new Error('Invalid connection string. Database name is required')
		}

		if (this.cs.searchParams.has('application') === false) {
			this.cs.searchParams.set('application', this.options['ydb.sdk.application'] || '')
		} else {
			this.options['ydb.sdk.application'] ??= this.cs.searchParams.get('application') || ''
		}

		let discoveryInterval =
			this.options['ydb.sdk.discovery_interval_ms'] ?? defaultOptions['ydb.sdk.discovery_interval_ms']!
		let discoveryTimeout =
			this.options['ydb.sdk.discovery_timeout_ms'] ?? defaultOptions['ydb.sdk.discovery_timeout_ms']!
		if (discoveryInterval < discoveryTimeout) {
			throw new Error('Discovery interval must be greater than discovery timeout.')
		}

		let endpoint = create(EndpointInfoSchema, {
			address: this.cs.hostname,
			nodeId: -1,
			port: parseInt(this.cs.port || (this.isSecure ? '443' : '80'), 10),
			ssl: this.isSecure,
		})

		let channelCredentials = this.options.secureOptions
			? credentials.createFromSecureContext(tls.createSecureContext(this.options.secureOptions))
			: this.isSecure
				? credentials.createSsl()
				: credentials.createInsecure()

		this.#connection = new LazyConnection(endpoint, channelCredentials, this.options.channelOptions)

		this.#middleware = debug
		this.#middleware = composeClientMiddleware(this.#middleware, (call, options) => {
			let metadata = Metadata(options.metadata)
				.set('x-ydb-database', this.database)
				.set('x-ydb-application-name', this.options['ydb.sdk.application'] || '')

			return call.next(call.request, Object.assign(options, { metadata }))
		})

		if (this.options.credentialsProvider) {
			this.#credentialsProvider = this.options.credentialsProvider
			this.#middleware = composeClientMiddleware(this.#middleware, this.#credentialsProvider.middleware)
		}

		this.#pool = new ConnectionPool(channelCredentials, this.options.channelOptions)

		this.#discoveryClient = createClientFactory()
			.use(this.#middleware)
			.create(DiscoveryServiceDefinition, this.#connection.channel)

		if (this.options['ydb.sdk.enable_discovery'] === false) {
			dbg.extend('driver')('discovery disabled, using single endpoint')
			waitForChannelReady(
				this.#connection.channel,
				new Date(Date.now() + (this.options['ydb.sdk.ready_timeout_ms'] || 10000))
			)
				.then(this.#ready.resolve)
				.catch(this.#ready.reject)
		}

		if (this.options['ydb.sdk.enable_discovery'] === true) {
			dbg.extend('driver')('discovery enabled, using connection pool')

			// Initial discovery
			this.#discovery(AbortSignal.timeout(this.options['ydb.sdk.discovery_timeout_ms']!))
				.then(this.#ready.resolve)
				.catch(this.#ready.reject)

			// Periodic discovery
			this.#rediscoverTimer = setInterval(() => {
				void this.#discovery(AbortSignal.timeout(this.options['ydb.sdk.discovery_timeout_ms']!))
			}, this.options['ydb.sdk.discovery_interval_ms'] || defaultOptions['ydb.sdk.discovery_interval_ms']!)

			// Unref the timer so it doesn't keep the process running
			this.#rediscoverTimer.unref()
		}
	}

	get token(): Promise<string> {
		let signal = AbortSignal.timeout(this.options['ydb.sdk.token_timeout_ms']!)

		return this.#credentialsProvider.getToken(false, signal)
	}

	get database(): string {
		if (this.cs.pathname && this.cs.pathname !== '/') {
			return this.cs.pathname
		}

		if (this.cs.searchParams.has('database')) {
			return this.cs.searchParams.get('database') || ''
		}

		return ''
	}

	get isSecure(): boolean {
		return this.cs.protocol === 'https:' || this.cs.protocol === 'grpcs:'
	}

	async #discovery(signal: AbortSignal): Promise<void> {
		let retryConfig: RetryConfig = {
			...defaultRetryConfig,
			signal,
		}

		let result = await retry(retryConfig, async (signal) => {
			let response = await this.#discoveryClient.listEndpoints({ database: this.database }, { signal })
			if (!response.operation) {
				throw new ClientError(
					DiscoveryServiceDefinition.listEndpoints.path,
					Status.UNKNOWN,
					'No operation in response'
				)
			}

			if (response.operation.status !== StatusIds_StatusCode.SUCCESS) {
				throw new YDBError(response.operation.status, response.operation.issues)
			}

			let result = anyUnpack(response.operation.result!, ListEndpointsResultSchema)
			if (!result) {
				throw new ClientError(
					DiscoveryServiceDefinition.listEndpoints.path,
					Status.UNKNOWN,
					'No result in operation'
				)
			}

			return result
		})

		for (let endpoint of result.endpoints) {
			this.#pool.add(endpoint)
		}
	}

	async ready(signal?: AbortSignal): Promise<void> {
		signal = signal
			? AbortSignal.any([signal, AbortSignal.timeout(this.options['ydb.sdk.ready_timeout_ms']!)])
			: AbortSignal.timeout(this.options['ydb.sdk.ready_timeout_ms']!)

		return abortable(signal, this.#ready.promise);
	}

	close(): void {
		clearInterval(this.#rediscoverTimer)
		this.#pool.close()
		this.#connection.close()
	}

	createClient<Service extends CompatServiceDefinition>(service: Service, preferNodeId?: bigint): Client<Service> {
		return createClientFactory()
			.use(this.#middleware)
			.create(
				service,
				new Proxy(this.#connection.channel, {
					get: (target, propertyKey) => {
						let channel = this.options['ydb.sdk.enable_discovery']
							? this.#pool.acquire(preferNodeId).channel
							: target

						return Reflect.get(channel, propertyKey, channel)
					},
				}),
				{
					'*': this.options.channelOptions,
				}
			)
	}

	[Symbol.dispose](): void {
		this.close()
	}

	[Symbol.asyncDispose](): PromiseLike<void> {
		return Promise.resolve(this.close())
	}
}
