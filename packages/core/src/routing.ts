import { AsyncLocalStorage } from 'node:async_hooks'

import { linkSignals } from '@ydbjs/abortable'
import { loggers } from '@ydbjs/debug'
import {
	type CallOptions,
	type Metadata,
	type MethodDefinition,
	RpcError,
	type RpcStatus,
	Status,
	type Transport,
	createDeadline,
} from '@ydbjs/grpc'

import type { Connection } from './conn.js'
import type { EndpointPool } from './endpoints/endpoints-runtime.js'
import { type CallCompleteEvent, type DriverHooks, safeHook } from './hooks.js'

let dbg = loggers.grpc

type RoutingOptions = {
	signal?: AbortSignal | undefined
	hooks?: DriverHooks | undefined
	nodeId?: bigint | undefined
	hard?: boolean | undefined
}

export function createRoutingTransport(
	source: EndpointPool | Connection,
	prepareMetadata: (metadata: Metadata | undefined, signal: AbortSignal) => Promise<Metadata>,
	routing: RoutingOptions = {}
): Transport {
	let pool = 'acquire' in source ? source : undefined
	let closed = false

	return {
		close() {
			closed = true
		},
		async *call<Request, Response>(
			method: MethodDefinition<Request, Response>,
			input: Request | AsyncIterable<Request>,
			options: CallOptions = {}
		) {
			if (closed || pool?.closed) {
				throw new Error('Client is closed')
			}

			using linked = linkSignals(options.signal, routing.signal)
			let connection: Connection | undefined
			let registeredWithPool = false
			let statusReported = false
			let startedAt = 0
			let onComplete: ((event: CallCompleteEvent) => void) | undefined
			let restore = routing.hooks?.onCall ? AsyncLocalStorage.snapshot() : undefined
			let reportStatus = (status: RpcStatus) => {
				if (statusReported) {
					return
				}

				statusReported = true
				if (pool && connection) {
					let nodeId = connection.endpoint.nodeId
					if (
						status.code === Status.UNAVAILABLE ||
						status.code === Status.DEADLINE_EXCEEDED
					) {
						pool.penalize(nodeId)
					} else if (
						status.code === Status.OK &&
						pool.snapshot.byNodeId.get(nodeId)?.state === 'pessimized'
					) {
						pool.recover(nodeId)
					}
				}
				if (onComplete && restore) {
					restore(() =>
						safeHook('onComplete', onComplete, {
							grpcStatusCode: status.code,
							duration: performance.now() - startedAt,
						})
					)
				}
				dbg.log('%s status=%d: %s', method.path, status.code, status.details)
				safeHook('onStatus', options.onStatus, status)
			}

			try {
				linked.signal.throwIfAborted()
				let metadata: Metadata
				{
					using deadline = createDeadline(options.deadline)
					using auth = deadline ? linkSignals(linked.signal, deadline.signal) : undefined
					metadata = await prepareMetadata(
						options.metadata,
						auth?.signal ?? linked.signal
					)
				}
				linked.signal.throwIfAborted()
				if (closed || pool?.closed) {
					throw new Error('Client is closed')
				}

				if (!pool) {
					connection = source as Connection
				} else if (routing.hard && routing.nodeId !== undefined) {
					connection = pool.acquireNode(routing.nodeId, { hard: true })
				} else {
					connection = pool.acquire(routing.nodeId)
				}
				if (pool) {
					pool.callStarted(connection.endpoint.nodeId)
					registeredWithPool = true
					if (routing.hooks?.onCall) {
						startedAt = performance.now()
						let snapshot = pool.snapshot
						let completion = safeHook('onCall', routing.hooks.onCall, {
							method: method.path,
							endpoint: connection.endpoint,
							preferred:
								routing.nodeId !== undefined &&
								connection.endpoint.nodeId === routing.nodeId,
							pool: {
								activeCount: snapshot.prefer.length + snapshot.fallback.length,
								pessimizedCount: snapshot.pessimizedCount,
							},
						})
						if (typeof completion === 'function') {
							onComplete = completion
						}
					}
				}

				yield* connection.client.call(method, input, {
					...options,
					metadata,
					signal: linked.signal,
					onStatus: reportStatus,
				})
				reportStatus({ code: Status.OK, details: '', metadata: {} })
			} catch (error) {
				let status: RpcStatus
				if (error instanceof RpcError) {
					status = error
				} else {
					status = {
						code: linked.signal.aborted ? Status.CANCELLED : Status.UNKNOWN,
						details: error instanceof Error ? error.message : String(error),
						metadata: {},
					}
				}
				reportStatus(status)
				throw error
			} finally {
				reportStatus({
					code: Status.CANCELLED,
					details: 'Response iterator closed',
					metadata: {},
				})
				if (registeredWithPool) {
					pool!.callEnded(connection!.endpoint.nodeId)
				}
			}
		},
	}
}
