import { create } from '@bufbuild/protobuf'
import {
	Codec,
	StreamWriteMessage_WriteRequestSchema,
	TransactionIdentitySchema,
} from '@ydbjs/api/topic'
import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'
import { type MachineRuntime, createMachineRuntime } from '@ydbjs/fsm'

import { type InitParams, WriterTransport } from './transport.js'
import type { TransportOutput } from './transport-state.js'
import type { TopicWriterOptions } from './types.js'
import {
	type GlobalTimerName,
	MAX_BATCH_BYTES,
	type WriterCtx,
	type WriterEffect,
	type WriterEvent,
	type WriterOutput,
	type WriterState,
	createWriterCtx,
	writerTransition,
} from './writer-state.js'

// Watchdog for a connect that never produces an init response.
let DEFAULT_START_TIMEOUT_MS = 30_000
// Single source of the option defaults — the facade imports these for its
// diagnostics config snapshot, so the published effective config cannot drift.
export const DEFAULT_MAX_BUFFER_BYTES = 256n * 1024n * 1024n
export const DEFAULT_MAX_INFLIGHT_COUNT = 1000
export const DEFAULT_FLUSH_INTERVAL_MS = 1000
export const DEFAULT_UPDATE_TOKEN_INTERVAL_MS = 60_000
export const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000
export const DEFAULT_RECOVERY_WINDOW_MS = Infinity
let BACKOFF_BASE_MS = 50
let BACKOFF_MAX_MS = 30_000

// I/O handles and config — visible to effect handlers only, never to the transition.
type WriterEnv = {
	// I/O
	transport: WriterTransport
	codec: number
	txIdentity?: { id: string; session: string }

	// timer durations (ms)
	startTimeoutMs: number
	flushIntervalMs: number
	updateTokenIntervalMs: number
	gracefulShutdownTimeoutMs: number

	// lifecycle
	ac: AbortController
	closedDeferred: PromiseWithResolvers<void>
	isFinalized: boolean
	// Keyed by GlobalTimerName — string-keyed like the reader, whose keys also
	// carry a partition suffix (the writer has no partition timers).
	timers: Map<string, ReturnType<typeof setTimeout>>
}

type FullCtx = WriterCtx & WriterEnv

export type WriterRuntime = {
	machine: MachineRuntime<WriterState, WriterCtx, WriterEvent, WriterOutput>
}

let timerEvent = function timerEvent(which: GlobalTimerName): WriterEvent {
	switch (which) {
		case 'start_timeout':
			return { type: 'writer.timer.start_timeout' }
		case 'retry_backoff':
			return { type: 'writer.timer.retry_backoff' }
		case 'recovery_window':
			return { type: 'writer.timer.recovery_window' }
		case 'flush_tick':
			return { type: 'writer.timer.flush_tick' }
		case 'update_token':
			return { type: 'writer.timer.update_token' }
		case 'graceful_timeout':
			return { type: 'writer.timer.graceful_timeout' }
	}
}

// Equal-jitter exponential backoff: half fixed, half random in [d/2, d].
let backoffDelay = function backoffDelay(attempts: number): number {
	let capped = Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_MAX_MS)
	return Math.round(capped / 2 + Math.random() * (capped / 2))
}

let delayFor = function delayFor(ctx: FullCtx, which: GlobalTimerName): number {
	switch (which) {
		case 'start_timeout':
			return ctx.startTimeoutMs
		case 'retry_backoff':
			return backoffDelay(ctx.attempts)
		case 'recovery_window':
			return ctx.recoveryWindowMs
		case 'flush_tick':
			return ctx.flushIntervalMs
		case 'update_token':
			return ctx.updateTokenIntervalMs
		case 'graceful_timeout':
			return ctx.gracefulShutdownTimeoutMs
	}
}

let clearTimerByKey = function clearTimerByKey(ctx: FullCtx, key: string): void {
	let handle = ctx.timers.get(key)
	if (handle) {
		clearTimeout(handle)
		ctx.timers.delete(key)
	}
}

// `dbg` carries low-frequency lifecycle (connect, start); the per-event / per-batch
// trace goes to `evdbg` so enabling `ydb:topic:writer` doesn't flood with the
// per-message send/transition noise — opt into it with `ydb:topic:writer:event`.
let dbg = loggers.topic.extend('writer')
let evdbg = dbg.extend('event')

let mapTransportOutput = function mapTransportOutput(output: TransportOutput): WriterEvent | null {
	evdbg.log('transport → writer: %s', output.type)
	switch (output.type) {
		case 'transport.stream.init_response':
			return {
				type: 'writer.stream.init_response',
				sessionId: output.sessionId,
				lastSeqNo: output.lastSeqNo,
				...(output.partitionId !== undefined && { partitionId: output.partitionId }),
			}
		case 'transport.stream.write_response':
			return { type: 'writer.stream.write_response', acks: output.acks }
		case 'transport.stream.token_response':
			return { type: 'writer.stream.token_response' }
		case 'transport.stream.disconnected':
			return {
				type: 'writer.stream.disconnected',
				...('error' in output ? { error: output.error } : {}),
			}
		default:
			return null
	}
}

// Builds the writer FSM and binds its effects to real I/O: transport connect/send,
// timers with equal-jitter backoff, and transport-output → writer-event mapping.
// The returned machine is the only handle the facade drives; every side effect
// (sockets, timers, token refresh) fires from the effect handlers wired here.
export function createWriterRuntime(driver: Driver, options: TopicWriterOptions): WriterRuntime {
	let initParams: InitParams = {
		path: options.topic,
		producerId: options.producer!,
		...(options.partitionId !== undefined && { partitionId: options.partitionId }),
		...(options.messageGroupId !== undefined && { messageGroupId: options.messageGroupId }),
	}

	let transport = new WriterTransport(driver, initParams)

	let env: WriterEnv = {
		// I/O
		transport,
		codec: options.codec?.codec ?? Codec.RAW,
		...(options.tx && {
			txIdentity: { id: options.tx.transactionId, session: options.tx.sessionId },
		}),

		// timer durations (ms)
		startTimeoutMs: DEFAULT_START_TIMEOUT_MS,
		flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
		updateTokenIntervalMs: options.updateTokenIntervalMs ?? DEFAULT_UPDATE_TOKEN_INTERVAL_MS,
		gracefulShutdownTimeoutMs:
			options.gracefulShutdownTimeoutMs ?? DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS,

		// lifecycle
		ac: new AbortController(),
		closedDeferred: Promise.withResolvers<void>(),
		isFinalized: false,
		timers: new Map(),
	}

	let ctx = createWriterCtx(
		{
			maxInflightCount: options.maxInflightCount ?? DEFAULT_MAX_INFLIGHT_COUNT,
			maxBatchBytes: MAX_BATCH_BYTES,
		},
		{
			retryOnSchemeError: options.retryOnSchemeError ?? false,
			recoveryWindowMs: options.recoveryWindowMs ?? DEFAULT_RECOVERY_WINDOW_MS,
		}
	)

	let machine = createMachineRuntime<
		WriterState,
		WriterCtx,
		WriterEnv,
		WriterEvent,
		WriterEffect,
		WriterOutput
	>({
		initialState: 'idle',
		ctx,
		env,
		// Wrap the pure transition to log each event and state change without
		// putting side effects in the transition itself.
		transition: (fullCtx, event, runtime) => {
			let result = writerTransition(fullCtx, event, runtime)
			if (evdbg.enabled) {
				evdbg.log('%s: %s → %s', event.type, runtime.state, result?.state ?? runtime.state)
			}
			return result
		},
		effects: {
			'writer.effect.transport.connect': (fullCtx, effect) => {
				dbg.log('connect (getLastSeqNo=%s)', effect.getLastSeqNo)
				fullCtx.transport.connect(effect.getLastSeqNo)
			},

			'writer.effect.transport.close': (fullCtx) => {
				fullCtx.transport.close()
			},

			'writer.effect.send.write_request': (fullCtx, effect) => {
				evdbg.log(
					'send write_request: %d messages (seqNo %s..%s)',
					effect.messages.length,
					effect.messages[0]?.seqNo,
					effect.messages[effect.messages.length - 1]?.seqNo
				)
				let request = create(StreamWriteMessage_WriteRequestSchema, {
					codec: fullCtx.codec,
					messages: effect.messages,
					...(fullCtx.txIdentity && {
						tx: create(TransactionIdentitySchema, fullCtx.txIdentity),
					}),
				})
				fullCtx.transport.sendBatch(request)
			},

			'writer.effect.send.update_token': (fullCtx) => {
				void fullCtx.transport.sendUpdateToken().catch(() => {
					// Token refresh failures surface as a stream error on the next write.
				})
			},

			'writer.effect.timer.schedule': (fullCtx, effect, runtime) => {
				let which = effect.which
				// The recovery window is armed once per reconnect saga.
				if (which === 'recovery_window' && fullCtx.timers.has('recovery_window')) {
					return
				}

				clearTimerByKey(fullCtx, which)

				let repeating = which === 'flush_tick' || which === 'update_token'
				let delay = delayFor(fullCtx, which)
				let event = timerEvent(which)

				let handle = repeating
					? setInterval(() => runtime.dispatch(event), delay)
					: setTimeout(() => {
							fullCtx.timers.delete(which)
							runtime.dispatch(event)
						}, delay)

				handle.unref?.()
				fullCtx.timers.set(which, handle)
			},

			'writer.effect.timer.clear': (fullCtx, effect) => {
				clearTimerByKey(fullCtx, effect.which)
			},

			'writer.effect.finalize': (fullCtx, effect) => {
				if (fullCtx.isFinalized) {
					return
				}
				fullCtx.isFinalized = true

				for (let handle of fullCtx.timers.values()) {
					clearTimeout(handle)
				}
				fullCtx.timers.clear()

				fullCtx.transport.destroy(effect.reason)
				fullCtx.ac.abort(effect.reason)
				fullCtx.closedDeferred.resolve()
			},
		},
	})

	// Route transport lifecycle events into the writer FSM.
	machine.ingest(transport.events, mapTransportOutput)

	dbg.log('starting writer on %s (producer=%s)', options.topic, options.producer)

	machine.dispatch({ type: 'writer.start' })

	return { machine }
}
