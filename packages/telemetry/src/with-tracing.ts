import { getActiveSubscriberSpan } from './context-manager.js'
import { type SubscribeOptions, subscribe } from './subscribe.js'
import type { Tracer } from './tracing.js'

/**
 * Minimal structural subset of @ydbjs/core DriverHooks needed here.
 * TypeScript structural typing ensures this is assignable to DriverHooks.
 */
interface WithTracingHooks {
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

/**
 * Subscribes to all @ydbjs diagnostics channels and returns driver `hooks`
 * that enrich spans with endpoint-specific attributes (node id/dc, peer address/port,
 * gRPC status code). Pass the result to `new Driver(connectionString, { ...withTracing(...) })`.
 */
export function withTracing(
	connectionString: string,
	tracer?: Tracer
): { hooks: WithTracingHooks } {
	let options: SubscribeOptions = { endpoint: connectionString }
	if (tracer) options.tracer = tracer

	subscribe(options)

	return {
		hooks: {
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
		},
	}
}
