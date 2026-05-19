import { context, propagation } from '@opentelemetry/api'
import { type ClientMiddleware, Metadata } from 'nice-grpc'

/**
 * W3C trace context propagation middleware for `@ydbjs/core`'s gRPC client.
 *
 * Injects the active OTel context — `traceparent` / `tracestate` by default,
 * plus any other propagator registered via `propagation.setGlobalPropagator`
 * (Baggage, B3, AWS X-Amzn, …) — into outgoing gRPC metadata. Without a
 * registered OTel SDK the global `propagation` is a no-op, so the middleware
 * adds no headers and makes no allocations beyond the empty record passed
 * to `inject`.
 */
export let propagator: ClientMiddleware = async function* (call, options) {
	let metadata = Metadata(options.metadata)

	propagation.inject(context.active(), metadata, {
		set(carrier, key, value) {
			carrier.set(key, String(value))
		},
	})

	return yield* call.next(call.request, Object.assign(options, { metadata }))
}
