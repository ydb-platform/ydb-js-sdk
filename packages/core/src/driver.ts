import * as assert from 'node:assert/strict'
import { channel as dc } from 'node:diagnostics_channel'
import * as tls from 'node:tls'

import { create } from '@bufbuild/protobuf'
import { anyUnpack } from '@bufbuild/protobuf/wkt'
import {
	type ClientOptions,
	type Metadata,
	type ServiceClient,
	type ServiceDefinition,
	createServiceClient,
} from '@ydbjs/grpc'
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

import pkg from '../package.json' with { type: 'json' }

import { createRoutingTransport } from './routing.js'
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
	DriverDegradedThresholdError,
	DriverDiscoveryIntervalError,
	DriverDiscoveryOptionsError,
	DriverDiscoveryTimeoutError,
	DriverResponseError,
} from './errors.js'
import { type DriverHooks, type EndpointInfo, safeHook } from './hooks.js'
import { type MetadataHook, getRegisteredMetadataHooks } from './metadata-hooks.js'
import { detectRuntime } from './runtime.js'

export type { DriverHooks, EndpointInfo }

export type ClientTarget = {
	nodeId: bigint
	/** Never substitute a different node when the target is unavailable. */
	hard?: boolean
}

export type PinnedClientTarget = ClientTarget & {
	endpoint: {
		host: string
		port: number
		location?: string
		sslTargetNameOverride?: string
		generation?: number
	}
}

export type DriverOptions = {
	/**
	 * SSL/TLS options for secure connections.
	 *
	 * @deprecated Use `secureOptions` instead.
	 */
	ssl?: tls.SecureContextOptions
	secureOptions?: tls.SecureContextOptions | undefined
	transportOptions?: ClientOptions
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
	/**
	 * Prefer local-DC endpoints (opt-in, soft — only reorders tiers, never pins).
	 * @default false
	 */
	'ydb.sdk.locality_enabled'?: boolean
	/**
	 * Prefer PRIMARY/PROMOTED-pile endpoints in a bridge (2DC) cluster, falling
	 * back to SYNCHRONIZED when the primary pile has no available node. Opt-in,
	 * soft, and a no-op outside bridge mode. Takes precedence over
	 * `ydb.sdk.locality_enabled` in bridge mode.
	 * @default false
	 */
	'ydb.sdk.prefer_primary_pile'?: boolean
	/**
	 * Fraction of pessimized nodes (0..1) that forces an early rediscovery round.
	 * @default 0.5
	 */
	'ydb.sdk.discovery_degraded_threshold'?: number
}

let dbg = loggers.driver

let databaseFromUrl = function databaseFromUrl(url: URL): string {
	if (url.pathname && url.pathname !== '/') {
		return url.pathname
	}

	if (url.searchParams.has('database')) {
		return url.searchParams.get('database') || ''
	}

	return ''
}

function normalizeMetadata(input: Metadata = {}): Record<string, Metadata[string]> {
	let metadata: Record<string, Metadata[string]> = Object.create(null)
	for (let [name, value] of Object.entries(input)) {
		let key = name.toLowerCase()
		let previous = metadata[key]
		metadata[key] = previous === undefined ? value : [previous, value].flat()
	}
	return metadata
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

let defaultTransportOptions: ClientOptions = {
	userAgent: `ydb-js-sdk/${pkg.version} ${detectRuntime()}`,
	keepaliveIntervalMs: 10_000,
	keepaliveTimeoutMs: 5_000,
	maxSendBytes: 64 * 1024 * 1024,
	maxReceiveBytes: 64 * 1024 * 1024,
}

export class Driver implements Disposable {
	readonly cs: URL
	readonly options: DriverOptions = {}

	// The endpoints engine — owns discovery, balancing, pessimization, and all
	// ydb:driver.* diagnostics. Undefined when discovery is disabled (the sole
	// bootstrap connection is used directly).
	#endpoints: EndpointsRuntime | undefined

	// Discovery and discovery-disabled calls use the bootstrap connection.
	// The HTTP/2 session is opened by the first RPC.
	#connection: Connection
	#metadataHooks: readonly MetadataHook[]
	#closedController = new AbortController()
	#discoveryClient: ServiceClient<typeof DiscoveryServiceDefinition> | undefined

	#credentialsProvider: CredentialsProvider = new AnonymousCredentialsProvider()

	#libraries: Set<string> = new Set()
	#buildInfo: string = `ydb-js-sdk/${pkg.version}`

	#initAt: number
	#readyAt: number | undefined
	#closed = false

	#identity!: DriverIdentity

	constructor(connectionString: string, userOptions: Readonly<DriverOptions> = defaultOptions) {
		this.#initAt = performance.now()

		this.cs = this.#parseConnectionString(connectionString)
		this.options = this.#mergeOptions(userOptions)
		this.#assertDiscoveryTimings()

		this.#identity = this.#buildIdentity()

		this.#connection = new GrpcConnection(
			this.#initialEndpoint(),
			this.options.transportOptions
		)

		if (this.options.credentialsProvider) {
			this.#credentialsProvider = this.options.credentialsProvider
		}

		this.#metadataHooks = [...getRegisteredMetadataHooks()]

		if (this.options['ydb.sdk.enable_discovery'] === false) {
			dbg.log('discovery disabled, using single endpoint')
			this.#markReadyDisabled()
		} else {
			// The endpoints runtime kicks the first discovery round itself and owns
			// the rediscovery loop + all ydb:driver.* diagnostics.
			this.#endpoints = createEndpointsRuntime({
				identity: this.identity,
				listEndpoints: this.#fetchEndpoints,
				secure: this.isSecure || this.options.secureOptions !== undefined,
				transportOptions: this.options.transportOptions,
				hooks: this.options.hooks,
				localityEnabled: this.options['ydb.sdk.locality_enabled'],
				preferPrimaryPile: this.options['ydb.sdk.prefer_primary_pile'],
				degradedThreshold: this.options['ydb.sdk.discovery_degraded_threshold'],
				discoveryTimeoutMs: this.options['ydb.sdk.discovery_timeout_ms'],
				discoveryIntervalMs: this.options['ydb.sdk.discovery_interval_ms'],
				idleIntervalMs: this.options['ydb.sdk.connection_idle_interval_ms'],
				// `connection_idle_timeout_ms` now bounds the grace a retired (dropped
				// from discovery) channel is kept before reaping — the endpoints engine
				// has no separate idle-active teardown.
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
			linkedSignal.signal.throwIfAborted()
			if (this.#closed) throw new Error('Driver is closed')
			if (this.#endpoints) {
				await this.#endpoints.pool.ready(linkedSignal.signal)
			}
			if (this.#closed) throw new Error('Driver is closed')

			dbg.log('driver is ready')
		} catch (error) {
			dbg.log('driver failed to become ready: %O', error)
			throw error
		}
	}

	close(): void {
		if (this.#closed) return
		this.#closed = true

		dbg.log('closing driver')
		this.#closedController.abort(new Error('Driver is closed'))
		this.#connection.close()
		if (this.#endpoints) this.#endpoints.pool.close()
		else this.#markClosedDisabled()
	}

	/** Create an async service client that borrows the driver's connections. */
	createClient<Service extends ServiceDefinition>(
		service: Service,
		target?: bigint | ClientTarget
	): ServiceClient<Service> {
		let nodeId = typeof target === 'bigint' ? target : target?.nodeId
		let hard = typeof target === 'object' ? (target.hard ?? false) : false
		let transport = createRoutingTransport(
			this.#endpoints?.pool ?? this.#connection,
			this.#prepareMetadata,
			{ signal: this.#closedController.signal, hooks: this.options.hooks, nodeId, hard }
		)
		return createServiceClient(service, transport)
	}

	/** Wait for the endpoint pin to be published before exposing its client. */
	async createPinnedClient<Service extends ServiceDefinition>(
		service: Service,
		target: PinnedClientTarget,
		signal?: AbortSignal
	): Promise<ServiceClient<Service> & Disposable> {
		signal?.throwIfAborted()
		if (this.#closed) {
			throw new Error('Driver is closed')
		}

		let pool = this.#endpoints?.pool
		if (!pool) {
			throw new Error('Endpoint pinning requires discovery')
		}

		let nodeId = target.nodeId
		let hard = target.hard ?? false
		let pinned = pool.pin(nodeId, target.endpoint.host, target.endpoint.port, target.endpoint)

		try {
			await abortable(signal, pinned)

			if (this.#closed) {
				throw new Error('Driver is closed')
			}

			let client = this.createClient(service, { nodeId, hard })
			let close = client.close.bind(client)
			let disposed = false

			client.close = () => {
				if (disposed) {
					return
				}

				disposed = true
				close()
				pool.invalidate(nodeId)
			}

			return Object.assign(client, { [Symbol.dispose]: () => client.close() })
		} catch (error) {
			pool.invalidate(nodeId)
			throw error
		}
	}

	[Symbol.dispose](): void {
		this.close()
	}

	#markReadyDisabled(): void {
		this.#readyAt = performance.now()

		let duration = this.#readyAt - this.#initAt
		dc('ydb:driver.ready').publish({ driver: this.identity, duration })

		dbg.log('driver ready (discovery disabled) in %d ms', duration)
	}

	#markClosedDisabled(): void {
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
		merged.secureOptions ??= merged.ssl
		merged.transportOptions = {
			...defaultTransportOptions,
			...merged.transportOptions,
			tls: { ...merged.transportOptions?.tls, ...merged.secureOptions },
		}
		return merged
	}

	#assertDiscoveryTimings(): void {
		let timeout = this.options['ydb.sdk.discovery_timeout_ms']!
		let interval = this.options['ydb.sdk.discovery_interval_ms']!

		assert.ok(timeout > 0, new DriverDiscoveryTimeoutError(timeout))
		assert.ok(interval > 0, new DriverDiscoveryIntervalError(interval))
		assert.ok(timeout < interval, new DriverDiscoveryOptionsError())

		let threshold = this.options['ydb.sdk.discovery_degraded_threshold']
		if (threshold !== undefined) {
			assert.ok(threshold > 0 && threshold <= 1, new DriverDegradedThresholdError(threshold))
		}
	}

	#initialEndpoint() {
		return create(EndpointInfoSchema, {
			address: this.cs.hostname,
			nodeId: -1,
			port: parseInt(this.cs.port || (this.isSecure ? '443' : '80'), 10),
			ssl: this.isSecure || this.options.secureOptions !== undefined,
		})
	}

	[kRegisterLibrary](name: string, version: string): void {
		let entry = `${name}/${version}`
		if (this.#libraries.has(entry)) return
		this.#libraries.add(entry)
		this.#buildInfo = `${this.#buildInfo};${entry}`
	}

	#prepareMetadata = async (
		input: Metadata | undefined,
		signal: AbortSignal
	): Promise<Metadata> => {
		let metadata = normalizeMetadata(input)
		for (let hook of this.#metadataHooks) {
			safeHook('metadata', hook, metadata)
		}
		if (this.#metadataHooks.length) {
			metadata = normalizeMetadata(metadata)
		}

		let tokenController = new AbortController()
		let onAbort = () => tokenController.abort(signal.reason)
		signal.throwIfAborted()
		signal.addEventListener('abort', onAbort, { once: true })
		let token: string
		try {
			token = await abortable(
				signal,
				this.#credentialsProvider.getToken(false, tokenController.signal)
			)
		} finally {
			// A completed getToken() may have started a background refresh that outlives this RPC.
			signal.removeEventListener('abort', onAbort)
		}

		metadata['x-ydb-sdk-build-info'] = this.#buildInfo
		metadata['x-ydb-database'] = this.database
		metadata['x-ydb-application-name'] = this.application
		metadata['x-ydb-auth-ticket'] = token
		return metadata
	}

	// The listEndpoints seam handed to the endpoints runtime. One plain RPC — the
	// FSM owns retry/backoff, and the run_discovery_round effect owns the
	// tracing:ydb:driver.discovery span; this closure must not add either.
	#fetchEndpoints: ListEndpoints = async (signal: AbortSignal): Promise<DiscoveryResult> => {
		if (!this.#discoveryClient) {
			let transport = createRoutingTransport(this.#connection, this.#prepareMetadata, {
				signal: this.#closedController.signal,
			})
			this.#discoveryClient = createServiceClient(DiscoveryServiceDefinition, transport)
		}

		let response = await this.#discoveryClient.listEndpoints(
			{ database: this.database },
			{ signal }
		)
		assert.ok(response.operation, new DriverResponseError('Missing operation data.'))

		if (response.operation.status !== StatusIds_StatusCode.SUCCESS) {
			throw new YDBError(response.operation.status, response.operation.issues)
		}

		let res = anyUnpack(response.operation.result!, ListEndpointsResultSchema)
		assert.ok(res, new DriverResponseError('Missing result in operation data.'))

		return mapDiscoveryResult(res)
	}
}
