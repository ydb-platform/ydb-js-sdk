import { context as otelContext } from '@opentelemetry/api'

import { createOpenTelemetryTracer } from './open-telemetry-tracer.js'
import { parseEndpoint } from './attributes.js'
import {
	createAlsContextManager,
	createTracingSetup,
	getActiveSubscriberSpan,
} from './context-manager.js'
import type { Tracer } from './tracing.js'
import { subscribeDiscoveryTracing } from './tracing/discovery.js'
import { subscribeDriverTracing } from './tracing/driver.js'
import { subscribeAuthTracing } from './tracing/auth.js'
import { subscribePoolTracing } from './tracing/pool.js'
import { subscribeQueryTracing } from './tracing/query.js'
import { subscribeRetryTracing } from './tracing/retry.js'
import { subscribeSessionTracing } from './tracing/session.js'
import { setupAuthMetrics } from './metrics/auth.js'
import { setupPoolMetrics } from './metrics/pool.js'
import { setupSessionMetrics } from './metrics/session.js'
import { setupQueryMetrics } from './metrics/query.js'
import { setupRetryMetrics } from './metrics/retry.js'
import { setupLifecycleLogs } from './logs/lifecycle.js'

export { createOpenTelemetryTracer } from './open-telemetry-tracer.js'
export {
	DB_SYSTEM,
	SPAN_NAMES,
	formatTraceparent,
	getBaseAttributes,
	parseEndpoint,
	recordErrorAttributes,
	type GetBaseAttributesOptions,
	type SpanBaseAttributes,
} from './attributes.js'
export {
	NoopTracer,
	SpanFinalizer,
	SpanKind,
	type Span,
	type SpanContext,
	type StartSpanOptions,
	type Tracer,
} from './tracing.js'
export { getActiveSubscriberSpan } from './context-manager.js'

export type Disposer = (() => void) & Disposable & AsyncDisposable

function asDisposer(fn: () => void): Disposer {
	let d = fn as Disposer
	d[Symbol.dispose] = d
	d[Symbol.asyncDispose] = async () => d()
	return d
}

export type YdbDriverHooks = {
	onCall?(event: {
		method: string
		endpoint: {
			readonly nodeId: bigint
			/** 'host:port' */
			readonly address: string
			readonly location: string
		}
		preferred: boolean
		pool: { activeCount: number; pessimizedCount: number }
	}): void | ((complete: { grpcStatusCode: number; duration: number }) => void)
}

export type TelemetryResult = Disposer & { hooks: YdbDriverHooks }

export type RegisterOptions = {
	/** @default true */
	contextManager?: boolean
	/** @default true */
	traces?: boolean
	/** @default true */
	metrics?: boolean
	/** @default false */
	logs?: boolean
	/** Custom OTel tracer. Defaults to the global tracer. */
	tracer?: Tracer
	/** YDB connection string — used to populate server.address / server.port / db.namespace. */
	endpoint?: string
	/**
	 * Include raw query text as db.query.text.
	 * Disabled by default — query text may contain PII.
	 * @default false
	 */
	captureQueryText?: boolean
}

export function installContextManager(): Disposer {
	let installed = otelContext.setGlobalContextManager(createAlsContextManager())
	return asDisposer(() => {
		if (installed) {
			otelContext.disable()
		}
	})
}

export function installTracing(options: RegisterOptions = {}): Disposer[] {
	let tracer = options.tracer ?? createOpenTelemetryTracer()

	let serverAddress: string | undefined
	let serverPort: number | undefined
	let database: string | undefined
	if (options.endpoint) {
		;({ serverAddress, serverPort, database } = parseEndpoint(options.endpoint))
	}

	let base: Record<string, string | number | boolean> = {
		'db.system.name': 'ydb',
		...(serverAddress !== undefined && { 'server.address': serverAddress }),
		...(serverPort !== undefined && { 'server.port': serverPort }),
		...(database !== undefined && { 'db.namespace': database }),
	}

	let setup = createTracingSetup(tracer, base)

	return [
		asDisposer(subscribeDriverTracing(setup)),
		asDisposer(subscribeDiscoveryTracing(setup)),
		asDisposer(subscribeSessionTracing(setup)),
		asDisposer(
			subscribeQueryTracing(setup, { captureQueryText: options.captureQueryText ?? false })
		),
		asDisposer(subscribeRetryTracing(setup)),
		asDisposer(subscribeAuthTracing(setup)),
		asDisposer(subscribePoolTracing(setup)),
	]
}

export function installMetrics(options: RegisterOptions = {}): Disposer[] {
	let base: Record<string, string | number | boolean> = {}
	if (options.endpoint) {
		let { database } = parseEndpoint(options.endpoint)
		base['endpoint'] = options.endpoint
		if (database !== undefined) base['database'] = database
	}

	let sessionBase: Record<string, string | number | boolean> = {
		'ydb.query.session.pool.name': base['database'] ?? base['endpoint'] ?? '',
	}

	return [
		asDisposer(setupAuthMetrics()),
		asDisposer(setupPoolMetrics()),
		asDisposer(setupSessionMetrics(sessionBase)),
		asDisposer(setupQueryMetrics(base)),
		asDisposer(setupRetryMetrics(base)),
	]
}

export function installLogs(_options: RegisterOptions = {}): Disposer[] {
	return [asDisposer(setupLifecycleLogs())]
}

export function register(options: RegisterOptions = {}): TelemetryResult {
	let disposers: Disposer[] = []

	if (options.contextManager !== false) {
		disposers.push(installContextManager())
	}
	if (options.traces ?? true) {
		disposers.push(...installTracing(options))
	}
	if (options.metrics ?? true) {
		disposers.push(...installMetrics(options))
	}
	if (options.logs ?? false) {
		disposers.push(...installLogs(options))
	}

	let fn = () => {
		for (let d of disposers) d()
	}

	let hooks: YdbDriverHooks = {
		onCall(event) {
			let span = getActiveSubscriberSpan()
			if (!span) return

			let addr = event.endpoint.address
			let colonIdx = addr.lastIndexOf(':')
			let peerAddress = colonIdx > -1 ? addr.slice(0, colonIdx) : addr
			let peerPort = colonIdx > -1 ? parseInt(addr.slice(colonIdx + 1), 10) : undefined

			span.setAttributes({
				'ydb.node.id': Number(event.endpoint.nodeId),
				'ydb.node.dc': event.endpoint.location,
				'network.peer.address': peerAddress,
				...(peerPort !== undefined &&
					!isNaN(peerPort) && { 'network.peer.port': peerPort }),
			})

			return (complete) => {
				span.setAttribute('rpc.grpc.status_code', complete.grpcStatusCode)
			}
		},
	}

	let dispose = fn as TelemetryResult
	dispose[Symbol.dispose] = fn
	dispose[Symbol.asyncDispose] = async () => fn()
	dispose.hooks = hooks

	return dispose
}
