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
	MAX_BATCH_BYTES,
	type TimerName,
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
	timers: Map<TimerName, ReturnType<typeof setTimeout>>
}

type FullCtx = WriterCtx & WriterEnv

export type WriterRuntime = {
	machine: MachineRuntime<WriterState, WriterCtx, WriterEvent, WriterOutput>
}

let timerEvent = function timerEvent(which: TimerName): WriterEvent {
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

let delayFor = function delayFor(ctx: FullCtx, which: TimerName): number {
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

let clearTimerByName = function clearTimerByName(ctx: FullCtx, which: TimerName): void {
	let handle = ctx.timers.get(which)
	if (handle) {
		clearTimeout(handle)
		ctx.timers.delete(which)
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
		flushIntervalMs: options.flushIntervalMs ?? 1000,
		updateTokenIntervalMs: options.updateTokenIntervalMs ?? 60_000,
		gracefulShutdownTimeoutMs: options.gracefulShutdownTimeoutMs ?? 30_000,

		// lifecycle
		ac: new AbortController(),
		closedDeferred: Promise.withResolvers<void>(),
		isFinalized: false,
		timers: new Map(),
	}

	let ctx = createWriterCtx(
		{
			maxInflightCount: options.maxInflightCount ?? 1000,
			maxBatchBytes: MAX_BATCH_BYTES,
		},
		options.retryOnSchemeError ?? false,
		options.recoveryWindowMs ?? Infinity
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

			'writer.effect.transport.send_batch': (fullCtx, effect) => {
				evdbg.log(
					'send_batch %d messages (seqNo %s..%s)',
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

			'writer.effect.transport.send_update_token': (fullCtx) => {
				void fullCtx.transport.sendUpdateToken().catch(() => {
					// Token refresh failures surface as a stream error on the next write.
				})
			},

			'writer.effect.transport.close': (fullCtx) => {
				fullCtx.transport.close()
			},

			'writer.effect.timer.schedule': (fullCtx, effect, runtime) => {
				let which = effect.which
				// The recovery window is armed once per reconnect saga.
				if (which === 'recovery_window' && fullCtx.timers.has('recovery_window')) {
					return
				}

				clearTimerByName(fullCtx, which)

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
				clearTimerByName(fullCtx, effect.which)
			},

			'writer.effect.finalize': (fullCtx, effect, runtime) => {
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

				// Seal the machine after this drain completes so buffered outputs
				// (writer.closed / writer.error) are delivered first.
				void runtime.close(effect.reason)
			},
		},
	})

	// Route transport lifecycle events into the writer FSM.
	machine.ingest(transport.events, mapTransportOutput)

	loggers.topic
		.extend('writer')
		.log('starting writer on %s (producer=%s)', options.topic, options.producer)

	machine.dispatch({ type: 'writer.start' })

	return { machine }
}
