import type { CallCompleteEvent, CallStartEvent, DriverHooks } from '@ydbjs/core'
import { Status } from 'nice-grpc'
import { SPAN_NAMES, SpanFinalizer, SpanKind, type Tracer, getBaseAttributes } from './tracing.js'
import { tracingContext } from './tracing-context.js'

const METHOD_TO_SPAN: Record<string, string> = {
	CreateSession: SPAN_NAMES.CreateSession,
	ExecuteQuery: SPAN_NAMES.ExecuteQuery,
	CommitTransaction: SPAN_NAMES.Commit,
	RollbackTransaction: SPAN_NAMES.Rollback,
}

function grpcMethodName(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1)
}

function parseEndpoint(address: string): { peerAddress?: string; peerPort?: number } {
	const colonIdx = address.lastIndexOf(':')
	if (colonIdx === -1) return {}

	const peerAddress = address.slice(0, colonIdx)
	const portRaw = address.slice(colonIdx + 1)
	const peerPort = Number(portRaw)
	if (!Number.isFinite(peerPort)) return { peerAddress }

	return { peerAddress, peerPort }
}

export function createTracingHooks(
	serverAddress: string,
	serverPort: number,
	dbNamespace: string | undefined,
	tracer: Tracer
): DriverHooks {
	const baseAttrs = getBaseAttributes(
		serverAddress,
		serverPort,
		dbNamespace ? { dbNamespace } : undefined
	)

	return {
		onBeforeCall(_event, metadata) {
			const span = tracingContext.getStore()?.span as { getId?: () => string } | undefined
			const traceparent = span?.getId?.()
			if (traceparent) {
				metadata.set('traceparent', traceparent)
			}
		},

		onCall(event: CallStartEvent) {
			const methodName = grpcMethodName(event.method)
			const spanName = METHOD_TO_SPAN[methodName]
			if (!spanName) return

			const existingStore = tracingContext.getStore()
			const span = tracer.startSpan(spanName, {
				kind: SpanKind.CLIENT,
				attributes: baseAttrs,
			})
			if (existingStore?.queryText && methodName === 'ExecuteQuery') {
				span.setAttribute('db.query.text', existingStore.queryText)
			}
			tracingContext.enterWith({ ...existingStore, span })

			span.setAttribute('ydb.node.id', Number(event.endpoint.nodeId))

			if (event.endpoint.location) {
				span.setAttribute('ydb.node.dc', event.endpoint.location)
			}

			const { peerAddress, peerPort } = parseEndpoint(event.endpoint.address)
			if (peerAddress) span.setAttribute('network.peer.address', peerAddress)
			if (peerPort !== undefined) span.setAttribute('network.peer.port', peerPort)

			return (complete: CallCompleteEvent) => {
				span.setAttribute('rpc.grpc.status_code', complete.grpcStatusCode)
				if (complete.grpcStatusCode === Status.OK) {
					SpanFinalizer.finishSuccess(span)
					return
				}

				const statusName =
					(Status as Record<number, string>)[complete.grpcStatusCode] ?? 'UNKNOWN'
				const error = new Error(`gRPC ${statusName}`)
				error.name = 'ClientError'
				SpanFinalizer.finishByError(span, error)
			}
		},
	}
}
