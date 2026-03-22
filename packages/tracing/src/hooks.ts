import type { DriverHooks } from '@ydbjs/core'
import { tracingContext } from '@ydbjs/telemetry'

export function createTracingHooks(): DriverHooks {
	return {
		onCall(event) {
			const span = tracingContext.getStore()?.span
			if (!span) return

			span.setAttribute('ydb.node.id', Number(event.endpoint.nodeId))

			if (event.endpoint.location) {
				span.setAttribute('ydb.node.dc', event.endpoint.location)
			}

			const colonIdx = event.endpoint.address.lastIndexOf(':')
			if (colonIdx !== -1) {
				span.setAttribute('network.peer.address', event.endpoint.address.slice(0, colonIdx))
				span.setAttribute(
					'network.peer.port',
					Number(event.endpoint.address.slice(colonIdx + 1))
				)
			}

			return (complete) => {
				span.setAttribute('rpc.grpc.status_code', complete.grpcStatusCode)
			}
		},
	}
}
