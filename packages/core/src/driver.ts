import * as tls from 'node:tls'

import { create } from '@bufbuild/protobuf'
import { anyUnpack } from '@bufbuild/protobuf/wkt'
import { credentials } from '@grpc/grpc-js'
import { abortable } from '@ydbjs/abortable'
import { DiscoveryServiceDefinition, EndpointInfoSchema, ListEndpointsResultSchema } from '@ydbjs/api/discovery'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import type { CredentialsProvider } from '@ydbjs/auth'
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous'
import { loggers } from '@ydbjs/debug'
import { YDBError } from '@ydbjs/error'
import { type RetryConfig, defaultRetryConfig, retry } from '@ydbjs/retry'
import {
	type Channel,
	type ChannelOptions,
	type Client,
	ClientError,
	type ClientMiddleware,
	type CompatServiceDefinition,
	Metadata,
	Status,
	composeClientMiddleware,
	createClientFactory,
} from 'nice-grpc'
import pkg from '../package.json' with { type: 'json' }
import { type Connection, LazyConnection } from './conn.js'
import { debug } from './middleware.js'
import { ConnectionPool } from './pool.js'
import { detectRuntime } from './runtime.js'
import { ConnectivityState } from '@grpc/grpc-js/build/src/connectivity-state.js'

let dbg = loggers.driver

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

const defaultChannelOptions: ChannelOptions = {
	'grpc.primary_user_agent': `ydb-js-sdk/${pkg.version}`,
	'grpc.secondary_user_agent': detectRuntime(),

	'grpc.keepalive_time_ms': 30_000,
	'grpc.keepalive_timeout_ms': 5_000,
	'grpc.keepalive_permit_without_calls': 1,

	'grpc.max_send_message_length': 64 * 1024 * 1024,
	'grpc.max_receive_message_length': 64 * 1024 * 1024,

	'grpc.initial_reconnect_backoff_ms': 50,
	'grpc.max_reconnect_backoff_ms': 5_000,
}

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
	readonly cs: URL
	readonly options: DriverOptions = {}

	#pool: ConnectionPool
	#ready: PromiseWithResolvers<void> = Promise.withResolvers<void>()

	#connection: Connection
	#middleware: ClientMiddleware

	#credentialsProvider: CredentialsProvider = new AnonymousCredentialsProvider()
	#discoveryClient!: Client<typeof DiscoveryServiceDefinition>
	#rediscoverTimer?: NodeJS.Timeout

	constructor(connectionString: string, options: Readonly<DriverOptions> = defaultOptions) {
		dbg.log('Driver(connectionString: %s, options: %o)', connectionString, options)

		if (!connectionString) {
			throw new Error('Invalid connection string. Must be a non-empty string')
		}

		this.cs = new URL(connectionString.replace(/^grpc/, 'http'))
		this.options = Object.assign({}, defaultOptions, options)
		this.options.secureOptions ??= this.options.ssl

		// Merge default channel options with user-provided options
		this.options.channelOptions = Object.assign({}, defaultChannelOptions, this.options.channelOptions)

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

		if (this.options['ydb.sdk.enable_discovery'] === false) {
			dbg.log('discovery disabled, using single endpoint')
			// Channel will be lazily created on first use
			// Readiness check is skipped to avoid memory leaks from Promise chains
			this.#ready.resolve()
		}

		if (this.options['ydb.sdk.enable_discovery'] === true) {
			dbg.log('discovery enabled, using connection pool')

			// Initial discovery
			dbg.log('starting initial discovery with timeout %d ms', this.options['ydb.sdk.discovery_timeout_ms'])
			this.#discovery(AbortSignal.timeout(this.options['ydb.sdk.discovery_timeout_ms']!))
				.then(() => {
					dbg.log('initial discovery completed successfully')
					return this.#ready.resolve()
				})
				.catch((error) => {
					dbg.log('initial discovery failed: %O', error)
					this.#ready.reject(error)
				})

			// Periodic discovery
			dbg.log(
				'setting up periodic discovery every %d ms',
				this.options['ydb.sdk.discovery_interval_ms'] || defaultOptions['ydb.sdk.discovery_interval_ms']!
			)
			this.#rediscoverTimer = setInterval(() => {
				dbg.log('starting periodic discovery')
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

	#getDiscoveryClient(): Client<typeof DiscoveryServiceDefinition> {
		return (this.#discoveryClient ??= createClientFactory()
			.use(this.#middleware)
			.create(DiscoveryServiceDefinition, this.#connection.channel))
	}

	async #discovery(signal: AbortSignal): Promise<void> {
		dbg.log('starting discovery for database: %s', this.database)

		let retryConfig: RetryConfig = {
			...defaultRetryConfig,
			signal,
			onRetry: (ctx) => {
				dbg.log('retrying discovery, attempt %d, error: %O', ctx.attempt, ctx.error)
			},
		}

		let result = await retry(retryConfig, async (signal) => {
			dbg.log('attempting to list endpoints for database: %s', this.database)
			let response = await this.#getDiscoveryClient().listEndpoints({ database: this.database }, { signal })
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

			dbg.log('discovery successful, received %d endpoints: %O', result.endpoints.length, result.endpoints)
			return result
		})

		for (let endpoint of result.endpoints) {
			this.#pool.add(endpoint)
		}
		dbg.log('connection pool updated successfully')
	}

	async ready(signal?: AbortSignal): Promise<void> {
		dbg.log('waiting for driver to become ready')

		let timeoutMs = this.options['ydb.sdk.ready_timeout_ms']!
		let effectiveSignal = signal
			? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
			: AbortSignal.timeout(timeoutMs)

		try {
			await abortable(effectiveSignal, this.#ready.promise)

			if (this.options['ydb.sdk.enable_discovery'] === false) {
				dbg.log('checking channel connectivity for single endpoint mode')
				await this.#checkChannelConnectivity(this.#connection.channel, timeoutMs, effectiveSignal)
			}

			dbg.log('driver is ready')
		} catch (error) {
			dbg.log('driver failed to become ready: %O', error)
			throw error
		}
	}

	async #checkChannelConnectivity(channel: Channel, timeoutMs: number, signal: AbortSignal): Promise<void> {
		let deadline = new Date(Date.now() + timeoutMs)

		while (true) {
			if (signal.aborted) {
				throw signal.reason || new Error('Aborted while waiting for channel connectivity')
			}

			let state = channel.getConnectivityState(true) // true = try to connect
			dbg.log('channel connectivity state: %d', state)

			if (state === ConnectivityState.READY) {
				dbg.log('channel is ready')
				return
			}

			if (state === ConnectivityState.SHUTDOWN) {
				throw new Error('Channel is shutdown')
			}

			let { promise, resolve, reject } = Promise.withResolvers<void>()
			channel.watchConnectivityState(state, deadline, (err?: Error) => {
				if (err) {
					dbg.log('channel connectivity state change timeout: %O', err)
					reject(err)
				} else {
					dbg.log('channel connectivity state changed')
					resolve()
				}
			})

			// oxlint-disable-next-line no-await-in-loop
			await abortable(signal, promise)
		}
	}

	close(): void {
		dbg.log('closing driver')
		if (this.#rediscoverTimer) {
			dbg.log('clearing discovery timer')
			clearInterval(this.#rediscoverTimer)
		}
		dbg.log('closing connection pool')
		this.#pool.close()
		dbg.log('closing primary connection')
		this.#connection.close()
		dbg.log('driver closed')
	}

	createClient<Service extends CompatServiceDefinition>(service: Service, preferNodeId?: bigint): Client<Service> {
		dbg.log(
			`creating client for %s${preferNodeId ? ` with preferNodeId: ${preferNodeId}` : ''}`,
			service.fullName || service.name
		)
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
