import { AsyncLocalStorage } from 'node:async_hooks'

import type { ChannelInterface as Channel, InterceptingListener, Metadata } from '@grpc/grpc-js'
import { status as Status, connectivityState } from '@grpc/grpc-js'
import { loggers } from '@ydbjs/debug'

import type { Connection } from './conn.ts'
import type { CallCompleteEvent, CallStartEvent, DriverHooks } from './hooks.ts'
import type { ConnectionPool } from './pool.ts'

let dbg = loggers.driver.extend('channel')

/**
 * A grpc-js Channel implementation that routes each RPC to a connection
 * selected by ConnectionPool.
 *
 * ## Why BalancedChannel instead of a Proxy?
 *
 * A Proxy on a Channel intercepts ALL property accesses and cannot bind
 * a specific connection to the RPC being dispatched. BalancedChannel
 * overrides createCall() — the single method grpc-js calls exactly once
 * per RPC — and acquires a connection there.
 *
 * ## How it works
 *
 * 1. nice-grpc calls createCall() once per RPC (unary or stream).
 * 2. We acquire a connection from the pool (round-robin or preferred nodeId).
 * 3. We delegate createCall() to the real grpc-js Channel on that connection.
 * 4. We return a Proxy-wrapped Call that intercepts start() to observe
 *    onReceiveStatus — the single callback grpc-js fires when the RPC ends.
 * 5. On UNAVAILABLE: pessimize the connection so the next acquire() skips it.
 * 6. Fire telemetry hooks in the original async context (AsyncLocalStorage).
 *
 * ## Async context preservation
 *
 * onReceiveStatus fires from the HTTP/2 event loop via process.nextTick(),
 * which loses AsyncLocalStorage context. We capture it at createCall() time
 * with AsyncLocalStorage.snapshot() and restore it in onReceiveStatus.
 * This makes trace.getActiveSpan() work inside the onCall completion callback.
 *
 * ## grpc-js version pinning
 *
 * This class touches four grpc-js internal contact points:
 *   Channel.createCall(method, deadline, host, parentCall, propagateFlags) → Call
 *   Call.start(metadata, listener)
 *   listener.onReceiveStatus(status)
 *   status.code
 *
 * These are exported but not formally documented as stable public API.
 * The grpc-js version MUST be pinned in peerDependencies of @ydbjs/core.
 */
export class BalancedChannel implements Channel {
	#pool: ConnectionPool
	#hooks: DriverHooks
	#nodeId: bigint | undefined

	constructor(pool: ConnectionPool, hooks?: DriverHooks, nodeId?: bigint) {
		this.#pool = pool
		this.#hooks = hooks || {}
		this.#nodeId = nodeId
	}

	createCall(...args: Parameters<Channel['createCall']>): ReturnType<Channel['createCall']> {
		let [method, deadline, host, parentCall, propagateFlags] = args

		let conn = this.#pool.acquire(this.#nodeId)
		let start = performance.now()

		// Capture all active AsyncLocalStorage contexts (including OpenTelemetry's
		// internal store) so we can restore them in the onReceiveStatus callback,
		// which fires from the grpc-js HTTP/2 event loop with lost context.
		let restoreContext = AsyncLocalStorage.snapshot()

		// Fire onCall in the original async context (we're still in it here).
		// The optional return value is a completion callback — captured in closure.
		let onComplete = this.#safeHook(
			'onCall',
			this.#hooks?.onCall,
			this.#buildStartEvent(conn, method)
		)

		dbg.log('createCall %s → node %d %s', method, conn.endpoint.nodeId, conn.endpoint.address)

		let call = conn.channel.createCall(method, deadline, host, parentCall, propagateFlags)

		return this.#wrapCall(call, conn, start, restoreContext, onComplete ?? null)
	}

	// ── Channel interface — pool-level implementations ─────────────────────────

	/**
	 * No-op: pool lifecycle is managed by Driver, not by individual clients.
	 * nice-grpc calls close() on the channel when a client is destroyed, but
	 * BalancedChannel does not own the pool.
	 */
	close(): void {
		// intentional no-op
	}

	/**
	 * Returns the address of the first active connection (best-effort).
	 * Used by grpc-js for logging and error messages only.
	 */
	getTarget(): string {
		return 'ydb-balanced-channel'
	}

	/**
	 * Returns READY if the pool has any usable connections (active or pessimized),
	 * TRANSIENT_FAILURE otherwise.
	 *
	 * The tryToConnect flag is intentionally ignored — connection management is
	 * handled by grpc-js internally for each GrpcConnection channel.
	 */
	getConnectivityState(_tryToConnect: boolean): any {
		return this.#pool.activeSize > 0 || this.#pool.pessimizedSize > 0
			? connectivityState.READY
			: connectivityState.TRANSIENT_FAILURE
	}

	/**
	 * Fires the callback on the next tick.
	 *
	 * watchConnectivityState is only used by Channel.waitForReady(), which is not
	 * called in pool mode (Driver.ready() uses its own mechanism). We provide a
	 * minimal implementation to satisfy the interface.
	 */
	watchConnectivityState(
		_currentState: any,
		_deadline: Date | number,
		callback: (error?: Error) => void
	): void {
		// Fire on next tick — the caller typically re-checks connectivity state
		// immediately after the callback fires.
		process.nextTick(callback)
	}

	/**
	 * Returns a stub ChannelzRef. We do not participate in channelz.
	 */
	getChannelzRef(): ReturnType<Channel['getChannelzRef']> {
		return {
			id: 0,
			kind: 'channel',
			name: 'BalancedChannel',
		} as unknown as ReturnType<Channel['getChannelzRef']>
	}

	/**
	 * Wrap a grpc-js Call with a Proxy that intercepts start() to observe
	 * onReceiveStatus. This is the only method we need to intercept.
	 *
	 * Why a Proxy and not monkey-patching?
	 * - Does not mutate a foreign object (the original Call is untouched).
	 * - Safe if grpc-js freezes Call objects in the future.
	 * - Explicit about what is intercepted (start) vs delegated (everything else).
	 *
	 * The Proxy is on a short-lived per-RPC Call object — performance overhead
	 * is negligible.
	 */
	#wrapCall(
		call: ReturnType<Channel['createCall']>,
		conn: Connection,
		startTime: number,
		restoreContext: <T>(fn: (...args: unknown[]) => T) => T,
		onComplete: ((event: CallCompleteEvent) => void) | null
	): ReturnType<Channel['createCall']> {
		let pool = this.#pool
		let safeHook = this.#safeHook.bind(this)

		return new Proxy(call, {
			get(target, prop, receiver) {
				if (prop !== 'start') {
					return Reflect.get(target, prop, receiver)
				}

				return (metadata: Metadata, listener: InterceptingListener) => {
					let onReceiveStatus: InterceptingListener['onReceiveStatus'] = (status) => {
						// Pessimize BEFORE propagating the error to nice-grpc.
						// This ensures the next acquire() (e.g., from a retry)
						// already skips the pessimized node.
						if (status.code === Status.UNAVAILABLE) {
							pool.pessimize(conn)
						}

						// Fire completion hook in the original async context.
						// onComplete is null when no onCall hook was registered.
						if (onComplete !== null) {
							restoreContext(() => {
								safeHook('onComplete', onComplete, {
									grpcStatusCode: status.code,
									duration: performance.now() - startTime,
								})
							})
						}

						listener.onReceiveStatus(status)
					}

					target.start(metadata, { ...listener, onReceiveStatus })
				}
			},
		})
	}

	/**
	 * Build the CallStartEvent for the onCall hook.
	 */
	#buildStartEvent(conn: Connection, method: string): CallStartEvent {
		return {
			method,
			endpoint: conn.endpoint,
			// preferred = caller asked for this nodeId AND we got it
			preferred: this.#nodeId !== undefined && conn.endpoint.nodeId === this.#nodeId,
			pool: {
				activeCount: this.#pool.activeSize,
				pessimizedCount: this.#pool.pessimizedSize,
			},
		}
	}

	#safeHook<A, R>(name: string, fn: ((arg: A) => R) | undefined, arg: A): R | undefined {
		if (fn === undefined) return undefined
		try {
			return fn(arg)
		} catch (error) {
			dbg.log('hook %s threw an error (swallowed): %O', name, error)
			return undefined
		}
	}
}
