import type { CallCompleteEvent, CallStartEvent, DriverHooks } from '@ydbjs/core'
import type { Span } from './tracing.js'
import { tracingContext } from './tracing-context.js'

export function createTracingHooks(): DriverHooks {
	return {
		onCall(event: CallStartEvent) {
			const span = tracingContext.getStore()?.span as Span | undefined
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

			return (complete: CallCompleteEvent) => {
				span.setAttribute('rpc.grpc.status_code', complete.grpcStatusCode)
			}
		},
	}
}
