import { AsyncLocalStorage } from 'node:async_hooks'

import type { ChannelInterface as Channel, InterceptingListener, Metadata } from '@grpc/grpc-js'
import { status as Status, connectivityState } from '@grpc/grpc-js'
import { loggers } from '@ydbjs/debug'

import type { Connection } from './conn.js'
import type { EndpointPool } from './endpoints/endpoints-runtime.js'
import type { CallCompleteEvent, CallStartEvent, DriverHooks } from './hooks.js'
import { safeHook } from './hooks.js'

let dbg = loggers.driver.extend('channel')

// gRPC status codes that mark the selected node as bad → pessimize it.
// UNAVAILABLE: the node is unreachable. DEADLINE_EXCEEDED: the node hung.
// Cluster-wide codes (INTERNAL / RESOURCE_EXHAUSTED) are intentionally excluded
// so a global spike does not pessimize every node at once.
const PESSIMIZING_CODES: ReadonlySet<number> = new Set<number>([
	Status.UNAVAILABLE,
	Status.DEADLINE_EXCEEDED,
])

/**
 * A grpc-js Channel that routes each RPC to a connection selected by the
 * EndpointPool.
 *
 * Overrides createCall() — the single method grpc-js calls exactly once per RPC
 * — acquires a connection from the pool there, delegates to the real channel,
 * and observes onReceiveStatus to report the RPC outcome back to the pool
 * (pessimize on transport failure, optimistic un-ban on success).
 *
 * ## grpc-js version pinning
 *
 * This class touches four grpc-js internal contact points:
 *   Channel.createCall(method, deadline, host, parentCall, propagateFlags) → Call
 *   Call.start(metadata, listener)
 *   listener.onReceiveStatus(status)
 *   status.code
 *
 * These are exported but not documented as stable public API. The grpc-js
 * version must be kept in lockstep with @ydbjs/core.
 */
export class BalancedChannel implements Channel {
	#pool: EndpointPool
	#hooks: DriverHooks
	#nodeId: bigint | undefined
	// Hard routing: every RPC goes to #nodeId or fails (never substitutes). Used
	// for direct topic read/write, where landing on the wrong node is incorrect.
	#hard: boolean

	constructor(pool: EndpointPool, hooks?: DriverHooks, nodeId?: bigint, hard = false) {
		this.#pool = pool
		this.#hooks = hooks || {}
		this.#nodeId = nodeId
		this.#hard = hard
	}

	createCall(...args: Parameters<Channel['createCall']>): ReturnType<Channel['createCall']> {
		let [method, deadline, host, parentCall, propagateFlags] = args

		let conn =
			this.#hard && this.#nodeId !== undefined
				? this.#pool.acquireNode(this.#nodeId, { hard: true })
				: this.#pool.acquire(this.#nodeId)
		let start = performance.now()

		// The onCall hook (and its ALS restore) is the only reason to snapshot the
		// async context — skip both when no hook is registered so the common path
		// stays allocation-light.
		let hasOnCall = this.#hooks.onCall !== undefined
		let restoreContext = hasOnCall ? AsyncLocalStorage.snapshot() : null
		let onComplete = hasOnCall
			? (safeHook('onCall', this.#hooks.onCall, this.#buildStartEvent(conn, method)) ?? null)
			: null

		dbg.log('createCall %s → node %d %s', method, conn.endpoint.nodeId, conn.endpoint.address)

		let call = conn.channel.createCall(method, deadline, host, parentCall, propagateFlags)
		// Count the RPC as in-flight so a graceful close can wait for it to drain.
		this.#pool.callStarted(conn.endpoint.nodeId)

		return this.#wrapCall(call, conn, start, restoreContext, onComplete)
	}

	// ── Channel interface — pool-level implementations ─────────────────────────

	/** No-op: pool lifecycle is owned by Driver, not by individual clients. */
	close(): void {
		// intentional no-op
	}

	getTarget(): string {
		return 'ydb-balanced-channel'
	}

	/** READY while the pool knows of any endpoint; TRANSIENT_FAILURE otherwise. */
	getConnectivityState(_tryToConnect: boolean): connectivityState {
		return this.#pool.snapshot.byNodeId.size > 0
			? connectivityState.READY
			: connectivityState.TRANSIENT_FAILURE
	}

	watchConnectivityState(
		_currentState: connectivityState,
		_deadline: Date | number,
		callback: (error?: Error) => void
	): void {
		process.nextTick(callback)
	}

	getChannelzRef(): ReturnType<Channel['getChannelzRef']> {
		return {
			id: 0,
			kind: 'channel',
			name: 'BalancedChannel',
		} as unknown as ReturnType<Channel['getChannelzRef']>
	}

	#wrapCall(
		call: ReturnType<Channel['createCall']>,
		conn: Connection,
		startTime: number,
		restoreContext: (<T>(fn: (...args: unknown[]) => T) => T) | null,
		onComplete: ((event: CallCompleteEvent) => void) | null
	): ReturnType<Channel['createCall']> {
		let pool = this.#pool

		return new Proxy(call, {
			get(target, prop, receiver) {
				if (prop !== 'start') {
					return Reflect.get(target, prop, receiver)
				}

				return (metadata: Metadata, listener: InterceptingListener) => {
					let onReceiveStatus: InterceptingListener['onReceiveStatus'] = (status) => {
						let nodeId = conn.endpoint.nodeId

						// The call has ended — release its in-flight slot (drives the
						// graceful-close drain).
						pool.callEnded(nodeId)

						// Feed the outcome back before propagating. The dispatch is
						// enqueue-only and the RoutingSnapshot swap is async, so this
						// is best-effort: a zero-backoff retry may still observe the
						// pre-pessimization snapshot for one more attempt.
						if (PESSIMIZING_CODES.has(status.code)) {
							pool.penalize(nodeId)
						} else if (
							status.code === Status.OK &&
							pool.snapshot.byNodeId.get(nodeId)?.state === 'pessimized'
						) {
							// Optimistic recovery — only dispatch when the node is
							// actually pessimized (avoid a per-RPC event for healthy nodes).
							pool.recover(nodeId)
						}

						if (onComplete !== null) {
							let run = () =>
								safeHook('onComplete', onComplete, {
									grpcStatusCode: status.code,
									duration: performance.now() - startTime,
								})
							if (restoreContext !== null) restoreContext(run)
							else run()
						}

						listener.onReceiveStatus(status)
					}

					target.start(metadata, { ...listener, onReceiveStatus })
				}
			},
		})
	}

	#buildStartEvent(conn: Connection, method: string): CallStartEvent {
		let snapshot = this.#pool.snapshot
		let pessimizedCount = 0
		for (let ref of snapshot.byNodeId.values()) {
			if (ref.state === 'pessimized') pessimizedCount++
		}

		return {
			method,
			endpoint: conn.endpoint,
			preferred: this.#nodeId !== undefined && conn.endpoint.nodeId === this.#nodeId,
			pool: {
				activeCount: snapshot.prefer.length + snapshot.fallback.length,
				pessimizedCount,
			},
		}
	}
}
