import { createOpenTelemetryTracer } from './open-telemetry-tracer.js'
import { parseEndpoint } from './attributes.js'
import { createTracingSetup } from './context-manager.js'
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
export { createSpan } from './span.js'
export { subscribe, type SubscribeOptions } from './subscribe.js'
export { withTracing } from './with-tracing.js'
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

/** Call to remove all subscriptions created by a single register() call. */
export type Disposer = () => void

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
	return () => {}
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
		subscribeDriverTracing(setup),
		subscribeDiscoveryTracing(setup),
		subscribeSessionTracing(setup),
		subscribeQueryTracing(setup, { captureQueryText: options.captureQueryText ?? false }),
		subscribeRetryTracing(setup),
		subscribeAuthTracing(setup),
		subscribePoolTracing(setup),
	]
}

export function installMetrics(_options: RegisterOptions = {}): Disposer[] {
	return [
		setupAuthMetrics(),
		setupPoolMetrics(),
		setupSessionMetrics(),
		setupQueryMetrics(),
		setupRetryMetrics(),
	]
}

export function installLogs(_options: RegisterOptions = {}): Disposer[] {
	return [setupLifecycleLogs()]
}

/**
 * Subscribes to all @ydbjs diagnostics channels and returns a Disposer that
 * tears down exactly this registration. Each call is independent.
 *
 * Call once at application startup after the OTel SDK is initialised.
 * For zero-config setup prefer: `node --import @ydbjs/telemetry/register`
 */
export function register(options: RegisterOptions = {}): Disposer {
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

	return () => {
		for (let d of disposers) d()
	}
}
