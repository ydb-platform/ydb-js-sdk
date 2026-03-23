import type { DriverHooks } from '@ydbjs/core'
import type { ClientMiddleware } from 'nice-grpc'
import type { Tracer } from './tracing.js'

import { createTracingHooks } from './driver-hooks.js'
import { createTracingMiddleware } from './middleware.js'
import { createOpenTelemetryTracer } from './open-telemetry-tracer.js'

function parseConnectionString(connectionString: string): URL {
	return new URL(connectionString.replace(/^grpc/, 'http'))
}

export function withTracing(
	connectionString: string,
	tracer?: Tracer
): { middleware: ClientMiddleware; hooks: DriverHooks } {
	const cs = parseConnectionString(connectionString)
	const activeTracer = tracer ?? createOpenTelemetryTracer()

	return {
		middleware: createTracingMiddleware(
			cs.hostname,
			Number.parseInt(cs.port || '2135', 10),
			cs.pathname && cs.pathname !== '/' ? cs.pathname : undefined,
			activeTracer
		),
		hooks: createTracingHooks(),
	}
}
