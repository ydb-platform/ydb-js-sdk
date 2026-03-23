import * as tls from 'node:tls'
import * as assert from 'node:assert/strict'

import { create } from '@bufbuild/protobuf'
import { anyUnpack } from '@bufbuild/protobuf/wkt'
import { credentials } from '@grpc/grpc-js'
import { abortable, linkSignals } from '@ydbjs/abortable'
import {
	DiscoveryServiceDefinition,
	EndpointInfoSchema,
	ListEndpointsResultSchema,
} from '@ydbjs/api/discovery'
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
	type ClientMiddleware,
	type CompatServiceDefinition,
	Metadata,
	composeClientMiddleware,
	createClientFactory,
} from 'nice-grpc'

import pkg from '../package.json' with { type: 'json' }
import { BalancedChannel } from './channel.js'
import { type Connection, GrpcConnection } from './conn.js'
import {
	DriverCSDatabaseError,
	DriverCSProtocolError,
	DriverDiscoveryIntervalError,
	DriverDiscoveryOptionsError,
	DriverDiscoveryTimeoutError,
	DriverResponseError,
} from './errors.js'
import type { DriverHooks, EndpointInfo } from './hooks.js'
import { debug } from './middleware.js'
import { ConnectionPool } from './pool.js'
import { detectRuntime } from './runtime.js'

export type { DriverHooks, EndpointInfo }

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
	/**
	 * Optional low-level gRPC middleware extension point.
	 *
	 * Use this to attach custom middleware (for example, telemetry) without
	 * coupling `@ydbjs/core` to a specific observability implementation.
	 */
	middleware?: ClientMiddleware

	/**
	 * Optional driver hooks.
	 *
	 * Hooks are synchronous, zero-cost when unused, and fire in the caller's
	 * AsyncLocalStorage context so OpenTelemetry trace.getActiveSpan() works.
	 *
	 * @example
	 * ```ts
	 * hooks: {
	 *   onCall(event) {
	 *     let span = tracer.startSpan('ydb.rpc')
	 *     return (complete) => { span.end() }
	 *   },
	 *   onPessimize(event) {
	 *     console.warn('node pessimized', event.endpoint.address)
	 *   },
	 * }
	 * ```
	 */
	hooks?: DriverHooks

	'ydb.sdk.application'?: string
	'ydb.sdk.ready_timeout_ms'?: number
	'ydb.sdk.token_timeout_ms'?: number
	'ydb.sdk.enable_discovery'?: boolean
	'ydb.sdk.discovery_timeout_ms'?: number
	'ydb.sdk.discovery_interval_ms'?: number
	'ydb.sdk.connection_idle_timeout_ms'?: number
	'ydb.sdk.connection_idle_interval_ms'?: number
	'ydb.sdk.connection_pessimization_timeout_ms'?: number
}

let dbg = loggers.driver

const defaultOptions: DriverOptions = {
	'ydb.sdk.ready_timeout_ms': 30_000,
	'ydb.sdk.token_timeout_ms': 10_000,
	'ydb.sdk.enable_discovery': true,
	'ydb.sdk.discovery_timeout_ms': 10_000,
	'ydb.sdk.discovery_interval_ms': 60_000,
	'ydb.sdk.connection_idle_timeout_ms': 300_000,
	'ydb.sdk.connection_idle_interval_ms': 60_000,
	'ydb.sdk.connection_pessimization_timeout_ms': 60_000,
} as const satisfies DriverOptions

const defaultChannelOptions: ChannelOptions = {
	'grpc.primary_user_agent': `ydb-js-sdk/${pkg.version}`,
	'grpc.secondary_user_agent': detectRuntime(),

	'grpc.keepalive_time_ms': 10_000,
	'grpc.keepalive_timeout_ms': 5_000,
	'grpc.keepalive_permit_without_calls': 1,

	'grpc.max_send_message_length': 64 * 1024 * 1024,
	'grpc.max_receive_message_length': 64 * 1024 * 1024,

	'grpc.max_reconnect_backoff_ms': 5_000,
	'grpc.initial_reconnect_backoff_ms': 50,
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

	// Single connection used when discovery is disabled or for the discovery
	// client itself (always contacts the initial endpoint directly).
	#connection: Connection
	#middleware: ClientMiddleware

	#discoveryClient!: Client<typeof DiscoveryServiceDefinition>
	#rediscoverTimer?: NodeJS.Timeout

	#credentialsProvider: CredentialsProvider = new AnonymousCredentialsProvider()

	constructor(connectionString: string, userOptions: Readonly<DriverOptions> = defaultOptions) {
		dbg.log('Driver(connectionString: %s, options: %o)', connectionString, userOptions)

		if (!connectionString) {
			throw new Error('Invalid connection string. Must be a non-empty string')
		}

		this.cs = new URL(connectionString.replace(/^grpc/, 'http'))
		assert.ok(this.database, new DriverCSDatabaseError())
		assert.match(this.cs.protocol, /^(grpc|http)(s?):$/, new DriverCSProtocolError())

		this.options = { ...defaultOptions, ...userOptions }
		this.options.channelOptions = { ...defaultChannelOptions, ...this.options.channelOptions }

		let discoveryTimeout = this.options['ydb.sdk.discovery_timeout_ms']!
		let discoveryInterval = this.options['ydb.sdk.discovery_interval_ms']!

		assert.ok(discoveryTimeout > 0, new DriverDiscoveryTimeoutError(discoveryTimeout))
		assert.ok(discoveryInterval > 0, new DriverDiscoveryIntervalError(discoveryInterval))
		assert.ok(discoveryTimeout < discoveryInterval, new DriverDiscoveryOptionsError())

		let initialEndpoint = create(EndpointInfoSchema, {
			address: this.cs.hostname,
			nodeId: -1,
			port: parseInt(this.cs.port || (this.isSecure ? '443' : '80'), 10),
			ssl: this.isSecure,
		})

		let channelCredentials = this.isSecure
			? credentials.createSsl()
			: credentials.createInsecure()

		if ((this.options.secureOptions ??= this.options.ssl)) {
			let secureContext = tls.createSecureContext(this.options.secureOptions)
			channelCredentials = credentials.createFromSecureContext(secureContext)
		}

		// The initial connection is always to the endpoint from the connection
		// string. It is used for discovery and as the sole connection when
		// discovery is disabled. GrpcConnection creates the channel eagerly but
		// grpc-js starts it in IDLE — no TCP/TLS until the first RPC.
		this.#connection = new GrpcConnection(
			initialEndpoint,
			channelCredentials,
			this.options.channelOptions
		)

		if (this.options.credentialsProvider) {
			this.#credentialsProvider = this.options.credentialsProvider
		}

		this.#middleware =
			this.options.middleware ?? ((call, options) => call.next(call.request, options))

		const metadataMiddleware: ClientMiddleware = (call, options) => {
			let metadata = Metadata(options.metadata)
				.set('x-ydb-database', this.database)
				.set('x-ydb-application-name', this.application)

			return call.next(call.request, Object.assign(options, { metadata }))
		}

		this.#middleware = composeClientMiddleware(this.#middleware, debug)
		this.#middleware = composeClientMiddleware(this.#middleware, metadataMiddleware)
		this.#middleware = composeClientMiddleware(
			this.#middleware,
			this.#credentialsProvider.middleware
		)

		if (this.options['ydb.sdk.enable_discovery'] === false) {
			dbg.log('discovery disabled, using single endpoint')
			this.#ready.resolve()
		}

		if (this.options['ydb.sdk.enable_discovery'] === true) {
			dbg.log('discovery enabled, using connection pool')

			dbg.log('starting initial discovery with timeout %d ms', discoveryTimeout)
			this.#discovery(AbortSignal.timeout(discoveryTimeout))
				.then(() => {
					dbg.log('initial discovery completed successfully')
					return this.#ready.resolve()
				})
				.catch((error) => {
					dbg.log('initial discovery failed: %O', error)
					this.#ready.reject(error)
				})

			dbg.log('setting up periodic discovery every %d ms', discoveryInterval)
			this.#rediscoverTimer = setInterval(() => {
				dbg.log('starting periodic discovery')
				void this.#discovery(AbortSignal.timeout(discoveryTimeout))
			}, discoveryInterval)

			// Unref the timer so it doesn't keep the process running
			this.#rediscoverTimer.unref()
		}

		this.#pool = new ConnectionPool({
			hooks: this.options.hooks,
			channelOptions: this.options.channelOptions,
			channelCredentials: channelCredentials,
			idleTimeout: this.options['ydb.sdk.connection_idle_timeout_ms']!,
			idleInterval: this.options['ydb.sdk.connection_idle_interval_ms']!,
			pessimizationTimeout: this.options['ydb.sdk.connection_pessimization_timeout_ms']!,
		})
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

	get application(): string {
		if (this.options['ydb.sdk.application']) {
			return this.options['ydb.sdk.application']
		}

		if (this.cs.searchParams.has('application')) {
			return this.cs.searchParams.get('application') || ''
		}

		return ''
	}

	async #discovery(outerSignal: AbortSignal): Promise<void> {
		dbg.log('starting discovery for database: %s', this.database)

		let discoveryStart = performance.now()
		let retryConfig: RetryConfig = {
			...defaultRetryConfig,
			signal: outerSignal,
			onRetry: (ctx) => {
				dbg.log('retrying discovery, attempt %d, error: %O', ctx.attempt, ctx.error)

				// Fire onDiscoveryError hook for each failed attempt
				this.#safeHook('onDiscoveryError', () =>
					this.options.hooks?.onDiscoveryError?.({
						error: ctx.error,
						attempt: ctx.attempt,
						duration: performance.now() - discoveryStart,
					})
				)
			},
		}

		let result = await retry(retryConfig, async (signal) => {
			let client = (this.#discoveryClient ??= createClientFactory()
				.use(this.#middleware)
				.create(DiscoveryServiceDefinition, this.#connection.channel))

			let response = await client.listEndpoints({ database: this.database }, { signal })
			assert.ok(response.operation, new DriverResponseError('Missing operation data.'))

			if (response.operation.status !== StatusIds_StatusCode.SUCCESS) {
				throw new YDBError(response.operation.status, response.operation.issues)
			}

			let res = anyUnpack(response.operation.result!, ListEndpointsResultSchema)
			assert.ok(res, new DriverResponseError('Missing result in operation data.'))

			return res
		})

		dbg.log('discovered %d endpoints: %O', result.endpoints.length, result.endpoints)

		let { added, removed } = this.#pool.sync(result.endpoints)

		let endpoints: EndpointInfo[] = result.endpoints.map((ep) =>
			Object.freeze<EndpointInfo>({
				nodeId: BigInt(ep.nodeId),
				address: `${ep.address}:${ep.port}`,
				location: ep.location,
			})
		)

		this.#safeHook('onDiscovery', () =>
			this.options.hooks?.onDiscovery?.({
				added,
				removed,
				duration: performance.now() - discoveryStart,
				endpoints,
			})
		)
	}

	async ready(signal?: AbortSignal): Promise<void> {
		dbg.log('waiting for driver to become ready')

		let timeout = this.options['ydb.sdk.ready_timeout_ms']!
		using linkedSignal = linkSignals(signal, AbortSignal.timeout(timeout))

		try {
			await abortable(linkedSignal.signal, this.#ready.promise)

			dbg.log('driver is ready')
		} catch (error) {
			dbg.log('driver failed to become ready: %O', error)
			throw error
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

	/**
	 * Create a nice-grpc client for the given service.
	 *
	 * When discovery is enabled, each RPC is routed through a BalancedChannel
	 * that acquires a connection from the pool exactly once per RPC.
	 *
	 * When discovery is disabled, the single initial connection is used directly
	 * (no pool, no balancing).
	 *
	 * @param service   gRPC service definition
	 * @param preferNodeId  Optional nodeId hint — route RPCs to this node when possible.
	 */
	createClient<Service extends CompatServiceDefinition>(
		service: Service,
		preferNodeId?: bigint
	): Client<Service> {
		dbg.log(`creating client for %s with preferNodeId %d`, service.fullName, preferNodeId)

		let channel = this.#connection.channel

		if (this.options['ydb.sdk.enable_discovery'] === true) {
			channel = new BalancedChannel(
				this.#pool,
				this.options.hooks,
				preferNodeId
			) as unknown as Channel
		}

		return createClientFactory().use(this.#middleware).create(service, channel, {
			'*': this.options.channelOptions,
		})
	}

	[Symbol.dispose](): void {
		this.close()
	}

	[Symbol.asyncDispose](): PromiseLike<void> {
		return Promise.resolve(this.close())
	}

	#safeHook(name: string, fn: () => void): void {
		try {
			fn()
		} catch (error) {
			dbg.log('hook %s threw an error (swallowed): %O', name, error)
		}
	}
}
