import * as tls from 'node:tls';

import { create } from '@bufbuild/protobuf';
import { anyUnpack } from '@bufbuild/protobuf/wkt';
import { credentials } from '@grpc/grpc-js';
import { DiscoveryServiceDefinition, EndpointInfoSchema, ListEndpointsResultSchema } from '@ydbjs/api/discovery';
import { StatusIds_StatusCode } from '@ydbjs/api/operation';
import type { CredentialsProvider } from '@ydbjs/auth';
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous';
import { YDBError } from '@ydbjs/errors';
import { retry, type RetryConfig } from '@ydbjs/retry';
import { exponential } from '@ydbjs/retry/strategy';
import { ClientError, composeClientMiddleware, Metadata, Status, waitForChannelReady, type ChannelOptions, type Client, type ClientMiddleware, type CompatServiceDefinition } from 'nice-grpc';
import { LazyConnection, type Connection, type ConnectionCallOptions } from './conn.ts';
import { dbg } from './dbg.js';
import { ConnectionPool } from './pool.js';

export type DriverOptions = ChannelOptions & {
	ssl?: tls.SecureContextOptions
	credentialsProvier?: CredentialsProvider

	'ydb.sdk.application'?: string;
	'ydb.sdk.ready_timeout_ms'?: number;
	'ydb.sdk.enable_discovery'?: boolean;
	'ydb.sdk.discovery_timeout_ms'?: number;
	'ydb.sdk.discovery_interval_ms'?: number;

	[key: string]: any;
}

const defaultOptions: DriverOptions = {
	'ydb.sdk.enable_discovery': true,
	'ydb.sdk.discovery_timeout_ms': 10_000,
	'ydb.sdk.discovery_interval_ms': 60_000,
} as const satisfies DriverOptions

export class Driver implements Disposable {
	protected readonly cs: URL
	protected readonly options: DriverOptions = {}

	#pool: ConnectionPool
	#ready: PromiseWithResolvers<void> = Promise.withResolvers<void>()

	#connection: Connection
	#middleware: ClientMiddleware

	#credentialsProvider: CredentialsProvider = new AnonymousCredentialsProvider()
	#discoveryClient!: Client<typeof DiscoveryServiceDefinition, ConnectionCallOptions>
	#rediscoverTimer?: NodeJS.Timeout

	constructor(connectionString: string, options: Readonly<DriverOptions> = defaultOptions) {
		dbg.extend("driver")("Driver(connectionString: %s, options: %o)", connectionString, options)

		this.cs = new URL(connectionString.replace(/^grpc/, 'http'))

		for (let key in defaultOptions) {
			this.options[key] = options[key] ?? defaultOptions[key]
		}

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

		const discoveryInterval = this.options['ydb.sdk.discovery_interval_ms'] ?? defaultOptions['ydb.sdk.discovery_interval_ms']!;
		const discoveryTimeout = this.options['ydb.sdk.discovery_timeout_ms'] ?? defaultOptions['ydb.sdk.discovery_timeout_ms']!;
		if (discoveryInterval < discoveryTimeout) {
			throw new Error('Discovery interval must be greater than discovery timeout.')
		}

		let endpoint = create(EndpointInfoSchema, {
			address: this.cs.hostname,
			nodeId: -1,
			port: parseInt(this.cs.port || (this.isSecure ? '443' : '80')),
			ssl: this.isSecure,
		})

		let channelCredentials = this.options.ssl
			? credentials.createFromSecureContext(tls.createSecureContext(this.options.ssl))
			: this.isSecure ? credentials.createSsl() : credentials.createInsecure()

		this.#connection = new LazyConnection(endpoint, channelCredentials, this.options)

		this.#middleware = (call, options) => {
			let metadata = Metadata(options.metadata)
				.set('x-ydb-database', this.database)
				.set('x-ydb-application-name', this.options['ydb.sdk.application'] || '')

			return call.next(call.request, Object.assign(options, { metadata }))
		}

		if (options.credentialsProvier) {
			this.#credentialsProvider = options.credentialsProvier
			this.#middleware = composeClientMiddleware(this.#middleware, this.#credentialsProvider.middleware)
		}

		this.#pool = new ConnectionPool(channelCredentials, this.options)

		this.#discoveryClient = this.#connection.clientFactory.use(this.#middleware).create(DiscoveryServiceDefinition, this.#connection.channel)

		if (this.options['ydb.sdk.enable_discovery'] === false) {
			dbg.extend("driver")('discovery disabled, using single endpoint')
			waitForChannelReady(this.#connection.channel, new Date(Date.now() + (this.options['ydb.sdk.ready_timeout_ms'] || 10000)))
				.then(this.#ready.resolve)
				.catch(this.#ready.reject)
		}

		if (this.options['ydb.sdk.enable_discovery'] === true) {
			dbg.extend("driver")('discovery enabled, using connection pool')

			// Initial discovery
			this.#discovery(AbortSignal.timeout(this.options['ydb.sdk.discovery_timeout_ms']!))
				.then(this.#ready.resolve)
				.catch(this.#ready.reject)

			// Periodic discovery
			this.#rediscoverTimer = setInterval(() => {
				this.#discovery(AbortSignal.timeout(this.options['ydb.sdk.discovery_timeout_ms']!))
			}, this.options['ydb.sdk.discovery_interval_ms'] || defaultOptions['ydb.sdk.discovery_interval_ms']!)

			// Unref the timer so it doesn't keep the process running
			this.#rediscoverTimer.unref()
		}
	}

	get database(): string {
		return this.cs.pathname || this.cs.searchParams.get('database') || ''
	}

	get isSecure(): boolean {
		return this.cs.protocol === 'https:'
	}

	// TODO: add retry logic
	async #discovery(signal?: AbortSignal): Promise<void> {
		dbg.extend("driver")("discovery(signal: %o)", signal)

		let retryConfig: RetryConfig = {
			retry: (err) => err instanceof ClientError || err instanceof YDBError || err instanceof Error && err.name !== 'TimeoutError',
			signal,
			budget: Infinity,
			strategy: exponential(50)
		}

		let result = await retry(retryConfig, async () => {
			let response = await this.#discoveryClient.listEndpoints({ database: this.database }, { signal })
			if (!response.operation) {
				throw new ClientError(DiscoveryServiceDefinition.listEndpoints.path, Status.UNKNOWN, 'No operation in response');
			}

			if (response.operation.status !== StatusIds_StatusCode.SUCCESS) {
				throw new YDBError(response.operation.status, response.operation.issues)
			}

			let result = anyUnpack(response.operation.result!, ListEndpointsResultSchema);
			if (!result) {
				throw new ClientError(DiscoveryServiceDefinition.listEndpoints.path, Status.UNKNOWN, 'No result in operation');
			}

			return result
		})

		for (let endpoint of result.endpoints) {
			this.#pool.add(endpoint)
		}
	}

	ready(signal?: AbortSignal): Promise<void> {
		let abortPromise = new Promise<void>((_, reject) => {
			if (signal) {
				signal.addEventListener('abort', function abortHandler() {
					reject(signal.reason)
					signal.removeEventListener('abort', abortHandler)
				})
			}
		})

		return Promise.race([
			this.#ready.promise,
			abortPromise,
		])
	}

	close(): void {
		clearInterval(this.#rediscoverTimer)
		this.#pool.close()
		this.#connection.channel.close()
	}

	createClient<Service extends CompatServiceDefinition>(service: Service, preferNodeId?: bigint): Client<Service, ConnectionCallOptions> {
		let connection = this.options['ydb.sdk.enable_discovery'] ? this.#pool.aquire(preferNodeId) : this.#connection
		let factory = connection.clientFactory.use(this.#middleware)

		return factory.create(service, connection.channel, {
			'*': this.options,
		})
	}

	[Symbol.dispose](): void {
		this.close()
	}

	[Symbol.asyncDispose](): PromiseLike<void> {
		return Promise.resolve(this.close())
	}
}
