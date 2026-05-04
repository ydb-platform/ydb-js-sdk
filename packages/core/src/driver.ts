import * as tls from 'node:tls'
import * as assert from 'node:assert/strict'
import { channel as dc, tracingChannel } from 'node:diagnostics_channel'

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

let discoveryCh = tracingChannel<{ database: string }, { database: string }>(
	'tracing:ydb:discovery'
)

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

function databaseFromUrl(url: URL): string {
	if (url.pathname && url.pathname !== '/') {
		return url.pathname
	}
	if (url.searchParams.has('database')) {
		return url.searchParams.get('database') || ''
	}
	return ''
}

let defaultOptions: DriverOptions = {
	'ydb.sdk.ready_timeout_ms': 30_000,
	'ydb.sdk.token_timeout_ms': 10_000,
	'ydb.sdk.enable_discovery': true,
	'ydb.sdk.discovery_timeout_ms': 10_000,
	'ydb.sdk.discovery_interval_ms': 60_000,
	'ydb.sdk.connection_idle_timeout_ms': 300_000,
	'ydb.sdk.connection_idle_interval_ms': 60_000,
	'ydb.sdk.connection_pessimization_timeout_ms': 60_000,
} as const satisfies DriverOptions

let defaultChannelOptions: ChannelOptions = {
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
		let promise = new Promise<T>((res, rej) => {
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

	// Construction time, used for `driver.ready.duration` and `driver.closed.uptime`.
	#initAt: number
	#readyAt: number | undefined
	#closed = false

	constructor(connectionString: string, userOptions: Readonly<DriverOptions> = defaultOptions) {
		dbg.log('Driver(connectionString: %s, options: %o)', connectionString, userOptions)

		this.#initAt = performance.now()

		this.cs = this.#parseConnectionString(connectionString)
		this.options = this.#mergeOptions(userOptions)
		this.#assertDiscoveryTimings()

		let channelCredentials = this.#createChannelCredentials()

		// The initial connection is always to the endpoint from the connection
		// string. It is used for discovery and as the sole connection when
		// discovery is disabled. GrpcConnection creates the channel eagerly but
		// grpc-js starts it in IDLE — no TCP/TLS until the first RPC.
		this.#connection = new GrpcConnection(
			this.#initialEndpoint(),
			channelCredentials,
			this.options.channelOptions
		)

		if (this.options.credentialsProvider) {
			this.#credentialsProvider = this.options.credentialsProvider
		}

		this.#middleware = this.#buildMiddleware()

		this.#pool = new ConnectionPool({
			hooks: this.options.hooks,
			channelOptions: this.options.channelOptions,
			channelCredentials: channelCredentials,
			idleTimeout: this.options['ydb.sdk.connection_idle_timeout_ms']!,
			idleInterval: this.options['ydb.sdk.connection_idle_interval_ms']!,
			pessimizationTimeout: this.options['ydb.sdk.connection_pessimization_timeout_ms']!,
		})

		if (this.options['ydb.sdk.enable_discovery'] === false) {
			dbg.log('discovery disabled, using single endpoint')
			this.#markReady()
		} else {
			this.#startDiscoveryLoop()
		}
	}

	get token(): Promise<string> {
		let signal = AbortSignal.timeout(this.options['ydb.sdk.token_timeout_ms']!)

		return this.#credentialsProvider.getToken(false, signal)
	}

	get database(): string {
		return databaseFromUrl(this.cs)
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
		// Idempotent — mixing an explicit `driver.close()` with `using` /
		// `Symbol.dispose` must not double-tear-down resources or double-fire
		// lifecycle events.
		if (this.#closed) return
		this.#closed = true

		let uptime = this.#readyAt ? performance.now() - this.#readyAt : 0
		dbg.log('closing driver (uptime %d ms)', uptime)

		if (this.#rediscoverTimer) {
			clearInterval(this.#rediscoverTimer)
		}
		this.#pool.close()
		this.#connection.close()

		dc('ydb:driver.closed').publish({ database: this.database, uptime })
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

	#parseConnectionString(cs: string): URL {
		if (!cs) {
			throw new Error('Invalid connection string. Must be a non-empty string')
		}

		let url = new URL(cs.replace(/^grpc/, 'http'))
		assert.match(url.protocol, /^(grpc|http)(s?):$/, new DriverCSProtocolError())
		assert.ok(databaseFromUrl(url), new DriverCSDatabaseError())

		return url
	}

	#mergeOptions(userOptions: Readonly<DriverOptions>): DriverOptions {
		let merged: DriverOptions = { ...defaultOptions, ...userOptions }
		merged.channelOptions = { ...defaultChannelOptions, ...merged.channelOptions }
		return merged
	}

	#assertDiscoveryTimings(): void {
		let timeout = this.options['ydb.sdk.discovery_timeout_ms']!
		let interval = this.options['ydb.sdk.discovery_interval_ms']!

		assert.ok(timeout > 0, new DriverDiscoveryTimeoutError(timeout))
		assert.ok(interval > 0, new DriverDiscoveryIntervalError(interval))
		assert.ok(timeout < interval, new DriverDiscoveryOptionsError())
	}

	#initialEndpoint() {
		return create(EndpointInfoSchema, {
			address: this.cs.hostname,
			nodeId: -1,
			port: parseInt(this.cs.port || (this.isSecure ? '443' : '80'), 10),
			ssl: this.isSecure,
		})
	}

	#createChannelCredentials() {
		if ((this.options.secureOptions ??= this.options.ssl)) {
			let secureContext = tls.createSecureContext(this.options.secureOptions)
			return credentials.createFromSecureContext(secureContext)
		}
		return this.isSecure ? credentials.createSsl() : credentials.createInsecure()
	}

	#buildMiddleware(): ClientMiddleware {
		let stamp: ClientMiddleware = (call, options) => {
			let metadata = Metadata(options.metadata)
				.set('x-ydb-sdk-build-info', `ydb-js-sdk/${pkg.version}`)
				.set('x-ydb-database', this.database)
				.set('x-ydb-application-name', this.application)

			return call.next(call.request, Object.assign(options, { metadata }))
		}

		return composeClientMiddleware(
			composeClientMiddleware(debug, stamp),
			this.#credentialsProvider.middleware
		)
	}

	#startDiscoveryLoop(): void {
		let timeout = this.options['ydb.sdk.discovery_timeout_ms']!
		let interval = this.options['ydb.sdk.discovery_interval_ms']!

		dbg.log('discovery enabled, initial timeout %d ms, interval %d ms', timeout, interval)

		this.#discovery(AbortSignal.timeout(timeout)).then(
			() => this.#markReady(),
			(error) => this.#markFailed(error)
		)

		this.#rediscoverTimer = setInterval(() => {
			void this.#discovery(AbortSignal.timeout(timeout))
		}, interval)

		// Don't keep the process alive solely for rediscovery.
		this.#rediscoverTimer.unref()
	}

	#markReady(): void {
		this.#readyAt = performance.now()
		let duration = this.#readyAt - this.#initAt
		dbg.log('driver ready in %d ms', duration)
		this.#ready.resolve()
		dc('ydb:driver.ready').publish({ database: this.database, duration })
	}

	#markFailed(error: unknown): void {
		let duration = performance.now() - this.#initAt
		dbg.log('driver init failed after %d ms: %O', duration, error)
		this.#ready.reject(error)
		dc('ydb:driver.failed').publish({ database: this.database, duration, error })
	}

	async #discovery(signal: AbortSignal): Promise<void> {
		await discoveryCh.tracePromise(() => this.#runDiscoveryRound(signal), {
			database: this.database,
		})
	}

	async #runDiscoveryRound(signal: AbortSignal): Promise<void> {
		let started = performance.now()
		let retryConfig: RetryConfig = {
			...defaultRetryConfig,
			signal,
			onRetry: (ctx) => {
				dbg.log('retrying discovery, attempt %d, error: %O', ctx.attempt, ctx.error)
				this.#safeHook('onDiscoveryError', () =>
					this.options.hooks?.onDiscoveryError?.({
						error: ctx.error,
						attempt: ctx.attempt,
						duration: performance.now() - started,
					})
				)
			},
		}

		let result = await retry(retryConfig, (s) => this.#fetchEndpoints(s))
		let { added, removed } = this.#pool.sync(result.endpoints)
		let duration = performance.now() - started

		dbg.log(
			'discovered %d endpoints (+%d / -%d) in %d ms',
			result.endpoints.length,
			added.length,
			removed.length,
			duration
		)

		dc('ydb:discovery.completed').publish({
			database: this.database,
			addedCount: added.length,
			removedCount: removed.length,
			totalCount: result.endpoints.length,
			duration,
		})

		this.#safeHook('onDiscovery', () =>
			this.options.hooks?.onDiscovery?.({
				added,
				removed,
				duration,
				endpoints: result.endpoints.map((ep) =>
					Object.freeze<EndpointInfo>({
						nodeId: BigInt(ep.nodeId),
						address: `${ep.address}:${ep.port}`,
						location: ep.location,
					})
				),
			})
		)
	}

	async #fetchEndpoints(signal: AbortSignal) {
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
	}

	#safeHook(name: string, fn: () => void): void {
		try {
			fn()
		} catch (error) {
			dbg.log('hook %s threw an error (swallowed): %O', name, error)
		}
	}
}
