import type { DriverHooks } from '@ydbjs/core'
import type { RetryHooks } from '@ydbjs/retry'
import type { Tracer } from './tracing.js'

import { createTracingHooks } from './hooks.js'
import { createOpenTelemetryTracer } from './open-telemetry-tracer.js'
import { makeRetryTracingHooks } from './tracing.js'

function parseConnectionString(connectionString: string): URL {
	return new URL(connectionString.replace(/^grpc/, 'http'))
}

export function withTracing(
	connectionString: string,
	tracer?: Tracer
): { hooks: DriverHooks; tracer: Tracer; retryHooks: () => RetryHooks } {
	const cs = parseConnectionString(connectionString)
	const activeTracer = tracer ?? createOpenTelemetryTracer()

	return {
		hooks: createTracingHooks(
			cs.hostname,
			Number.parseInt(cs.port || '2135', 10),
			cs.pathname && cs.pathname !== '/' ? cs.pathname : undefined,
			activeTracer
		),
		tracer: activeTracer,
		retryHooks: () => makeRetryTracingHooks(activeTracer),
	}
}
