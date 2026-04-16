import type { DriverHooks } from '@ydbjs/core'
import type { Tracer } from './tracing.js'

import { createTracingHooks } from './hooks.js'
import { createOpenTelemetryTracer } from './open-telemetry-tracer.js'

function parseConnectionString(connectionString: string): URL {
	return new URL(connectionString.replace(/^grpc/, 'http'))
}

export function withTracing(
	connectionString: string,
	tracer?: Tracer
): { hooks: DriverHooks; tracer: Tracer } {
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
	}
}
