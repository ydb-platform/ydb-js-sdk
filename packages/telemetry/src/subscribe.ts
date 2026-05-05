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

export type SubscribeOptions = {
	/** Custom tracer. Defaults to the global OpenTelemetry tracer. */
	tracer?: Tracer
	/** YDB connection string — used to populate server.address / server.port / db.namespace. */
	endpoint?: string
	/** Include raw query text as db.query.text. Defaults to false (set to '<redacted>'). */
	captureQueryText?: boolean
}

/**
 * Subscribes to all @ydbjs diagnostics channels and converts them into
 * OpenTelemetry spans. Returns an unsubscribe function.
 * For Driver-based tracing prefer withTracing().
 */
export function subscribe(options?: Tracer | SubscribeOptions): () => void {
	let tracer: Tracer | undefined
	let serverAddress: string | undefined
	let serverPort: number | undefined
	let database: string | undefined

	if (options && 'startSpan' in options) {
		// Backward-compatible: subscribe(myTracer)
		tracer = options
	} else if (options) {
		tracer = options.tracer
		if (options.endpoint) {
			;({ serverAddress, serverPort, database } = parseEndpoint(options.endpoint))
		}
	}

	let t = tracer ?? createOpenTelemetryTracer()

	let base: Record<string, string | number | boolean> = {
		'db.system.name': 'ydb',
		...(serverAddress !== undefined && { 'server.address': serverAddress }),
		...(serverPort !== undefined && { 'server.port': serverPort }),
		...(database !== undefined && { 'db.namespace': database }),
	}

	let setup = createTracingSetup(t, base)

	let captureQueryText = false
	if (options && !('startSpan' in options)) {
		captureQueryText = options.captureQueryText ?? false
	}

	let disposers = [
		subscribeDriverTracing(setup),
		subscribeDiscoveryTracing(setup),
		subscribeSessionTracing(setup),
		subscribeQueryTracing(setup, { captureQueryText }),
		subscribeRetryTracing(setup),
		subscribeAuthTracing(setup),
		subscribePoolTracing(setup),
	]

	return () => {
		for (let d of disposers) d()
	}
}
