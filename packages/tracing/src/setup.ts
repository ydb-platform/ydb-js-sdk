import type { DriverHooks } from '@ydbjs/core'
import type { Tracer } from '@ydbjs/telemetry'

import { createTracingHooks } from './hooks.js'
import { createOpenTelemetryTracer } from './open-telemetry-tracer.js'

export function withTracing(tracer?: Tracer): { tracer: Tracer; hooks: DriverHooks } {
	return {
		tracer: tracer ?? createOpenTelemetryTracer(),
		hooks: createTracingHooks(),
	}
}
