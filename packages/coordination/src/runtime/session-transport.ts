import { create } from '@bufbuild/protobuf'
import { abortable, linkSignals } from '@ydbjs/abortable'
import {
	SessionRequest_PingPongSchema,
	SessionRequest_SessionStartSchema,
	SessionRequest_SessionStopSchema,
} from '@ydbjs/api/coordination'
import { loggers } from '@ydbjs/debug'
import { type MachineRuntime, createMachineRuntime } from '@ydbjs/fsm'
import { AsyncQueue } from '@ydbjs/fsm/queue'

import {
	type Deferred,
	SessionReconnectError,
	SessionRequestRegistry,
	createDeferred,
} from './session-registry.js'
import {
	type CoordinationSessionClient,
	type StreamEnvelope,
	type StreamOpenParams,
	type TransportCtx,
	type TransportEffect,
	type TransportEvent,
	type TransportOutput,
	type TransportState,
	type WatchChange,
	classifyMessage,
	isAbortError,
	transportTransition,
} from './session-state.js'

export type {
	CoordinationSessionClient,
	StreamEnvelope,
	StreamOpenParams,
	TransportOutput,
	WatchChange,
}

let dbg = loggers.coordination.extend('transport')

// ── Watch subscription ─────────────────────────────────────────────────────────

export class WatchSubscription implements Disposable {
	#transport: SessionTransport
	#name: string
	#disposed = false

	queue: AsyncQueue<WatchChange>
	reqId = 0n

	constructor(transport: SessionTransport, name: string, queue: AsyncQueue<WatchChange>) {
		this.#transport = transport
		this.#name = name
		this.queue = queue
	}

	updateReqId(reqId: bigint): void {
		this.#transport.remapWatch(this.#name, this, reqId)
	}

	[Symbol.dispose](): void {
		if (this.#disposed) {
			return
		}

		this.#disposed = true
		this.#transport.removeWatch(this.#name, this)
		this.queue.close()
	}
}

// ── Session transport ──────────────────────────────────────────────────────────

export class SessionTransport implements Disposable {
	#ac = new AbortController()
	#client: CoordinationSessionClient
	#registry = new SessionRequestRegistry()
	#readyDeferred: Deferred<void> = createDeferred<void>()
	#destroyed = false
	#watchesByName = new Map<string, WatchSubscription>()
	#watchesByReqId = new Map<bigint, WatchSubscription>()

	#streamAC: AbortController | null = null
	#streamInput: AsyncQueue<StreamEnvelope> | null = null
	#streamParams: StreamOpenParams | null = null
	#streamIngestTask: Promise<void> | null = null

	#machine: MachineRuntime<TransportState, TransportCtx, TransportEvent, TransportOutput>

	constructor(client: CoordinationSessionClient) {
		this.#client = client
		this.#machine = createMachineRuntime<
			TransportState,
			TransportCtx,
			{},
			TransportEvent,
			TransportEffect,
			TransportOutput
		>({
			initialState: 'idle',
			ctx: { wasEverReady: false },
			env: {},
			transition: transportTransition,
			effects: {
				'transport.effect.open_stream': () => {
					this.#openStream()
				},

				'transport.effect.close_stream': async () => {
					await this.#closeStream()
				},

				'transport.effect.send_pong': (_ctx, effect) => {
					this.#sendPong(effect.opaque)
				},

				'transport.effect.send_stop': () => {
					this.#sendStop()
				},

				'transport.effect.mark_ready': (_ctx, effect, runtime) => {
					this.#markReady(effect.sessionId)
					runtime.emit({ type: 'transport.stream.started', sessionId: effect.sessionId })
				},

				'transport.effect.mark_disconnected': (_ctx, _effect, runtime) => {
					this.#markDisconnected()
					runtime.emit({ type: 'transport.stream.disconnected' })
				},

				'transport.effect.notify_watches': () => {
					this.notifyAllWatches()
				},

				'transport.effect.finalize': (_ctx, effect) => {
					this.#finalize(effect.reason)
				},
			},
		})
	}

	// ── Accessors ──────────────────────────────────────────────────────────────

	get signal(): AbortSignal {
		return this.#ac.signal
	}

	get state(): TransportState {
		return this.#machine.state
	}

	// The parent session FSM iterates this to receive transport events.
	get events(): AsyncIterable<TransportOutput> {
		return this.#machine
	}

	// ── Commands (called by parent session FSM) ────────────────────────────────

	connect(params: StreamOpenParams): void {
		this.#streamParams = params
		this.#machine.dispatch({ type: 'transport.connect' })
	}

	stop(): void {
		this.#machine.dispatch({ type: 'transport.stop' })
	}

	close(): void {
		this.#machine.dispatch({ type: 'transport.close' })
	}

	// ── Request multiplexing (called by business layer) ────────────────────────

	send(envelope: StreamEnvelope): void {
		if (!this.#streamInput || this.#streamInput.isClosed || this.#streamInput.isDestroyed) {
			return
		}

		this.#streamInput.push(envelope)
	}

	// Send a request and wait for the matching response. Retries transparently
	// on reconnect — allocates a fresh reqId each attempt because the server
	// lost the previous request state.
	async call(
		buildEnvelope: (reqId: bigint) => StreamEnvelope,
		signal?: AbortSignal
	): Promise<import('@ydbjs/api/coordination').SessionResponse> {
		for (;;) {
			// oxlint-disable-next-line no-await-in-loop
			await this.waitReady(signal)

			let reqId = this.#registry.nextReqId()
			using pending = this.#registry.register(reqId)
			using combined = linkSignals(this.#ac.signal, signal)

			try {
				this.send(buildEnvelope(reqId))
				// oxlint-disable-next-line no-await-in-loop
				return await abortable(combined.signal, pending.promise)
			} catch (error) {
				if (error instanceof SessionReconnectError) {
					continue
				}

				throw error
			}
		}
	}

	// Wait for a response to an already-sent request with a pinned reqId.
	// Used by the acquire pending loop — the server tracks the waiter slot
	// by reqId so it must not change across reconnects.
	async callPinned(
		reqId: bigint,
		resend: () => void,
		signal?: AbortSignal
	): Promise<import('@ydbjs/api/coordination').SessionResponse> {
		for (;;) {
			using pending = this.#registry.register(reqId)
			using combined = linkSignals(this.#ac.signal, signal)

			try {
				// oxlint-disable-next-line no-await-in-loop
				return await abortable(combined.signal, pending.promise)
			} catch (error) {
				if (error instanceof SessionReconnectError) {
					// oxlint-disable-next-line no-await-in-loop
					await this.waitReady(signal)
					resend()
					continue
				}

				throw error
			}
		}
	}

	// ── Watch subscriptions ────────────────────────────────────────────────────

	watch(name: string): WatchSubscription {
		let previous = this.#watchesByName.get(name)
		if (previous) {
			previous[Symbol.dispose]()
		}

		let queue = new AsyncQueue<WatchChange>()
		let subscription = new WatchSubscription(this, name, queue)
		this.#watchesByName.set(name, subscription)

		return subscription
	}

	remapWatch(name: string, subscription: WatchSubscription, reqId: bigint): void {
		let active = this.#watchesByName.get(name)
		if (active !== subscription) {
			return
		}

		if (subscription.reqId !== 0n) {
			this.#watchesByReqId.delete(subscription.reqId)
		}

		subscription.reqId = reqId
		this.#watchesByReqId.set(reqId, subscription)
	}

	removeWatch(name: string, subscription: WatchSubscription): void {
		let active = this.#watchesByName.get(name)
		if (active === subscription) {
			this.#watchesByName.delete(name)
		}

		if (subscription.reqId !== 0n) {
			this.#watchesByReqId.delete(subscription.reqId)
		}
	}

	notifyAllWatches(): void {
		dbg.log('notifying %d active watches to re-read after reconnect', this.#watchesByName.size)
		for (let subscription of this.#watchesByName.values()) {
			subscription.queue.push({ dataChanged: false, ownersChanged: false })
		}
	}

	// ── waitReady ──────────────────────────────────────────────────────────────

	// Loops through transient reconnect rejections — each time readyDeferred
	// is rejected the transport replaces it with a fresh one.
	async waitReady(callerSignal?: AbortSignal): Promise<void> {
		using combined = linkSignals(this.#ac.signal, callerSignal)

		for (;;) {
			try {
				// oxlint-disable-next-line no-await-in-loop
				await abortable(combined.signal, this.#readyDeferred.promise)
				return
			} catch (error) {
				if (combined.signal.aborted) {
					throw error
				}
			}
		}
	}

	// ── Teardown ───────────────────────────────────────────────────────────────

	destroy(reason: unknown): void {
		this.#finalize(reason)
	}

	[Symbol.dispose](): void {
		this.destroy(new Error('Transport disposed'))
	}

	// ── Internal ───────────────────────────────────────────────────────────────

	#openStream(): void {
		let params = this.#streamParams
		if (!params) {
			throw new Error('No stream params set — call connect() first')
		}

		// Dispose previous stream if any (fire-and-forget).
		void this.#closeStream()

		let ac = new AbortController()
		let input = new AsyncQueue<StreamEnvelope>()

		let grpcStream = this.#client.session(input, { signal: ac.signal })

		input.push({
			request: {
				case: 'sessionStart',
				value: create(SessionRequest_SessionStartSchema, {
					path: params.path,
					sessionId: params.sessionId ?? 0n,
					timeoutMillis: BigInt(params.recoveryWindow),
					description: params.description,
					seqNo: 0n,
					protectionKey: new Uint8Array(),
				}),
			},
		})

		dbg.log(
			'connecting to %s (sessionId=%s, recoveryWindow=%dms)',
			params.path,
			params.sessionId ?? 'new',
			params.recoveryWindow
		)

		let registry = this.#registry
		let dispatch = this.#machine.dispatch.bind(this.#machine)
		let handleWatch = this.#handleWatch.bind(this)
		let endEmitted = false

		let ingestTask = (async () => {
			try {
				for await (let response of grpcStream) {
					// Responses and watch notifications are resolved directly —
					// they bypass the FSM because they don't affect transport state.
					let msg = classifyMessage(response)
					if (msg && msg.kind === 'response') {
						registry.resolve(msg.reqId, msg.response)
						continue
					}
					if (msg && msg.kind === 'watch') {
						handleWatch(msg.reqId, msg.change)
						continue
					}

					// Everything else (ping, started, stopped, failure) goes
					// through the transport FSM for state transitions.
					dispatch({ type: 'transport.stream.message', response })
				}
			} catch (error) {
				if (!isAbortError(error)) {
					dispatch({ type: 'transport.stream.error', error })
				}
			} finally {
				input.close()

				if (!endEmitted) {
					endEmitted = true
					dispatch({ type: 'transport.stream.ended' })
				}
			}
		})()

		this.#streamAC = ac
		this.#streamInput = input
		this.#streamIngestTask = ingestTask
	}

	async #closeStream(): Promise<void> {
		let ac = this.#streamAC
		let input = this.#streamInput
		let ingestTask = this.#streamIngestTask

		this.#streamAC = null
		this.#streamInput = null
		this.#streamIngestTask = null

		if (!ac) {
			return
		}

		// Abort first so the gRPC read unblocks — without this
		// the ingest task deadlocks waiting for a message that never arrives.
		ac.abort(new Error('Stream disposed'))
		input?.close()

		// Wait for the ingest finally{} block so the ended event
		// is dispatched before we return.
		await ingestTask
	}

	#sendPong(opaque: bigint): void {
		this.send({
			request: {
				case: 'pong',
				value: create(SessionRequest_PingPongSchema, { opaque }),
			},
		})
	}

	#sendStop(): void {
		dbg.log('requesting graceful session stop')
		this.#registry.close()
		this.send({
			request: {
				case: 'sessionStop',
				value: create(SessionRequest_SessionStopSchema, {}),
			},
		})
	}

	#markReady(sessionId: bigint): void {
		dbg.log('transport ready (sessionId=%s)', sessionId)
		this.#readyDeferred.resolve()
	}

	#markDisconnected(): void {
		dbg.log('transport disconnected, rejecting pending requests')
		this.#registry.reconnect()
		this.#readyDeferred.reject(new Error('Session reconnecting'))
		this.#readyDeferred = createDeferred<void>()
	}

	#finalize(reason: unknown): void {
		if (this.#destroyed) {
			return
		}

		this.#destroyed = true

		let watches = Array.from(this.#watchesByName.values())
		for (let subscription of watches) {
			subscription[Symbol.dispose]()
		}

		this.#registry.destroy(reason)

		// Replace the deferred with an already-rejected one so that any future
		// waitReady() call rejects immediately. The old deferred is safe to
		// reject because createDeferred attaches a no-op .catch() guard.
		this.#readyDeferred.reject(reason)
		this.#readyDeferred = createDeferred<void>()
		this.#readyDeferred.reject(reason)

		this.#ac.abort(reason)
	}

	#handleWatch(reqId: bigint, change: WatchChange): void {
		let subscription = this.#watchesByReqId.get(reqId)
		if (!subscription) {
			return
		}

		if (subscription.reqId === reqId) {
			subscription.queue.push(change)
		}
	}
}
