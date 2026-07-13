import * as assert from 'node:assert/strict'
import { channel as dc } from 'node:diagnostics_channel'
import * as tls from 'node:tls'

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
import type { DriverIdentity } from './driver-identity.js'
import {
	type DiscoveryResult,
	type EndpointsRuntime,
	type ListEndpoints,
	createEndpointsRuntime,
	mapDiscoveryResult,
} from './endpoints/endpoints-runtime.js'
import {
	DriverCSDatabaseError,
	DriverCSProtocolError,
	DriverDiscoveryIntervalError,
	DriverDiscoveryOptionsError,
	DriverDiscoveryTimeoutError,
	DriverResponseError,
} from './errors.js'
import type { DriverHooks, EndpointInfo } from './hooks.js'
import { debug, getRegisteredClientMiddlewares } from './middleware.js'
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
	 * Optional driver hooks.
	 *
	 * Hooks are synchronous, zero-cost when unused, and fire in the caller's
	 * AsyncLocalStorage context so OpenTelemetry trace.getActiveSpan() works.
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
	/**
	 * @deprecated The endpoints engine has no fixed pessimization timer; a node
	 * recovers on the next successful RPC or discovery round. Ignored.
	 */
	'ydb.sdk.connection_pessimization_timeout_ms'?: number
	/** Prefer local-DC endpoints (opt-in, soft). Off by default. */
	'ydb.sdk.locality_enabled'?: boolean
	/** Fraction of pessimized nodes that forces an early rediscovery (0..1). */
	'ydb.sdk.discovery_degraded_threshold'?: number
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

export const kRegisterLibrary: unique symbol = Symbol('ydbjs.core.registerLibrary')

let defaultOptions: DriverOptions = {
	'ydb.sdk.ready_timeout_ms': 30_000,
	'ydb.sdk.token_timeout_ms': 10_000,
	'ydb.sdk.enable_discovery': true,
	'ydb.sdk.discovery_timeout_ms': 10_000,
	'ydb.sdk.discovery_interval_ms': 60_000,
	'ydb.sdk.connection_idle_timeout_ms': 300_000,
	'ydb.sdk.connection_idle_interval_ms': 60_000,
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

export class Driver implements Disposable, AsyncDisposable {
	readonly cs: URL
	readonly options: DriverOptions = {}

	// The endpoints engine — owns discovery, balancing, pessimization, and all
	// ydb:driver.* diagnostics. Undefined when discovery is disabled (the sole
	// bootstrap connection is used directly).
	#endpoints: EndpointsRuntime | undefined

	// Single connection: always the bootstrap endpoint from the connection
	// string. Used for the discovery client, and as the sole transport when
	// discovery is disabled. GrpcConnection creates the channel eagerly but
	// grpc-js starts it IDLE — no TCP/TLS until the first RPC.
	#connection: Connection
	#middleware: ClientMiddleware
	#discoveryClient: Client<typeof DiscoveryServiceDefinition> | undefined

	// Ready latch for the discovery-DISABLED path only (resolved immediately at
	// construction, rejected on close). The enabled path delegates to the pool.
	#ready: PromiseWithResolvers<void> = Promise.withResolvers<void>()

	#credentialsProvider: CredentialsProvider = new AnonymousCredentialsProvider()

	#libraries: Set<string> = new Set()
	#buildInfo: string = `ydb-js-sdk/${pkg.version}`

	#initAt: number
	#readyAt: number | undefined
	#closed = false

	#identity!: DriverIdentity

	constructor(connectionString: string, userOptions: Readonly<DriverOptions> = defaultOptions) {
		dbg.log('Driver(connectionString: %s, options: %o)', connectionString, userOptions)

		this.#initAt = performance.now()

		// close() rejects #ready to unblock awaiters; silence unhandled
		// rejection when no one observes the promise.
		this.#ready.promise.catch(() => {})

		this.cs = this.#parseConnectionString(connectionString)
		this.options = this.#mergeOptions(userOptions)
		this.#assertDiscoveryTimings()

		this.#identity = this.#buildIdentity()

		let channelCredentials = this.#createChannelCredentials()

		this.#connection = new GrpcConnection(
			this.#initialEndpoint(),
			channelCredentials,
			this.options.channelOptions
		)

		if (this.options.credentialsProvider) {
			this.#credentialsProvider = this.options.credentialsProvider
		}

		this.#middleware = this.#buildMiddleware()

		if (this.options['ydb.sdk.enable_discovery'] === false) {
			dbg.log('discovery disabled, using single endpoint')
			this.#markReadyDisabled()
		} else {
			// The endpoints runtime kicks the first discovery round itself and owns
			// the rediscovery loop + all ydb:driver.* diagnostics.
			this.#endpoints = createEndpointsRuntime({
				identity: this.identity,
				listEndpoints: this.#fetchEndpoints,
				channelCredentials,
				channelOptions: this.options.channelOptions,
				hooks: this.options.hooks,
				localityEnabled: this.options['ydb.sdk.locality_enabled'],
				degradedThreshold: this.options['ydb.sdk.discovery_degraded_threshold'],
				discoveryIntervalMs: this.options['ydb.sdk.discovery_interval_ms'],
				idleIntervalMs: this.options['ydb.sdk.connection_idle_interval_ms'],
				retiredGraceMs: this.options['ydb.sdk.connection_idle_timeout_ms'],
			})
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

	/**
	 * Stable identity stamped onto every `diagnostics_channel` payload so
	 * subscribers can attribute events to a specific Driver instance. Returns the
	 * same frozen object for the driver's lifetime — safe as a Map key.
	 */
	get identity(): DriverIdentity {
		return this.#identity
	}

	async ready(signal?: AbortSignal): Promise<void> {
		dbg.log('waiting for driver to become ready')

		let timeout = this.options['ydb.sdk.ready_timeout_ms']!
		using linkedSignal = linkSignals(signal, AbortSignal.timeout(timeout))

		try {
			if (this.#endpoints) {
				await this.#endpoints.pool.ready(linkedSignal.signal)
			} else {
				await abortable(linkedSignal.signal, this.#ready.promise)
			}

			dbg.log('driver is ready')
		} catch (error) {
			dbg.log('driver failed to become ready: %O', error)
			throw error
		}
	}

	close(): void {
		if (this.#closed) return
		this.#closed = true

		if (this.#endpoints) {
			// Synchronous teardown — dispatch destroy; the pool closes channels and
			// publishes ydb:driver.closed on a later turn.
			this.#endpoints.pool[Symbol.dispose]()
		} else {
			this.#markClosedDisabled()
		}

		this.#connection.close()
		dbg.log('closing driver')
	}

	/**
	 * Create a nice-grpc client for the given service.
	 *
	 * When discovery is enabled, each RPC is routed through a BalancedChannel that
	 * selects a connection from the endpoints pool. When disabled, the single
	 * bootstrap connection is used directly.
	 *
	 * @param preferNodeId  Optional nodeId hint — route RPCs to this node when possible.
	 */
	createClient<Service extends CompatServiceDefinition>(
		service: Service,
		preferNodeId?: bigint
	): Client<Service> {
		dbg.log(`creating client for %s with preferNodeId %d`, service.fullName, preferNodeId)

		let channel = this.#connection.channel

		if (this.#endpoints) {
			channel = new BalancedChannel(
				this.#endpoints.pool,
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

	async [Symbol.asyncDispose](): Promise<void> {
		if (this.#closed) return
		this.#closed = true

		if (this.#endpoints) {
			await this.#endpoints.pool.close()
		} else {
			this.#markClosedDisabled()
		}

		this.#connection.close()
		dbg.log('closing driver')
	}

	#markReadyDisabled(): void {
		this.#ready.resolve()
		this.#readyAt = performance.now()

		let duration = this.#readyAt - this.#initAt
		dc('ydb:driver.ready').publish({ driver: this.identity, duration })

		dbg.log('driver ready (discovery disabled) in %d ms', duration)
	}

	#markClosedDisabled(): void {
		this.#ready.reject(new Error('driver closed'))

		let uptime = this.#readyAt ? performance.now() - this.#readyAt : 0
		dc('ydb:driver.closed').publish({ driver: this.identity, uptime })

		dbg.log('closing driver (uptime %d ms)', uptime)
	}

	#buildIdentity(): DriverIdentity {
		let port = this.cs.port ? parseInt(this.cs.port, 10) : undefined
		return Object.freeze({
			database: this.database,
			address: this.cs.hostname,
			...(port !== undefined && { port }),
		})
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

	[kRegisterLibrary](name: string, version: string): void {
		let entry = `${name}/${version}`
		if (this.#libraries.has(entry)) return
		this.#libraries.add(entry)
		this.#buildInfo = `${this.#buildInfo};${entry}`
	}

	#buildMiddleware(): ClientMiddleware {
		let stamp: ClientMiddleware = (call, options) => {
			let metadata = Metadata(options.metadata)
				.set('x-ydb-sdk-build-info', this.#buildInfo)
				.set('x-ydb-database', this.database)
				.set('x-ydb-application-name', this.application)

			return call.next(call.request, Object.assign(options, { metadata }))
		}

		// Order: debug (logging) → stamp (SDK / db / app headers) → any
		// externally-registered middleware → auth (x-ydb-auth-ticket). Auth runs
		// last so a token refresh from inside another middleware still wins.
		//
		// The registry snapshot is taken at construction — call
		// addClientMiddleware() BEFORE new Driver(...) for it to apply.
		let chain = composeClientMiddleware(debug, stamp)
		for (let mw of getRegisteredClientMiddlewares()) {
			chain = composeClientMiddleware(chain, mw)
		}
		return composeClientMiddleware(chain, this.#credentialsProvider.middleware)
	}

	// The listEndpoints seam handed to the endpoints runtime. One plain RPC — the
	// FSM owns retry/backoff, and the run_discovery_round effect owns the
	// tracing:ydb:driver.discovery span; this closure must not add either.
	#fetchEndpoints: ListEndpoints = async (signal: AbortSignal): Promise<DiscoveryResult> => {
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

		return mapDiscoveryResult(res)
	}
}
