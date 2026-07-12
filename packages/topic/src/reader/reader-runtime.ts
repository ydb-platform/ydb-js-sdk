import { create } from '@bufbuild/protobuf'
import type { StreamReadMessage_FromServer } from '@ydbjs/api/topic'
import { StreamReadMessage_FromClientSchema } from '@ydbjs/api/topic'
import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'
import { type MachineRuntime, createMachineRuntime } from '@ydbjs/fsm'

import { parseReadSettings } from './read-settings.js'
import { PRIORITY_CONTROL, ReaderTransport } from './transport.js'
import type { TransportOutput } from './transport-state.js'
import {
	type ReaderCtx,
	type ReaderEffect,
	type ReaderEvent,
	type ReaderOutput,
	type ReaderState,
	type TimerName,
	type TimerRef,
	createReaderCtx,
	readerTransition,
} from './reader-state.js'
import type { TopicReaderOptions, onPartitionSessionStartCallback } from './types.js'

// Watchdog for a connect that never produces an init response.
let DEFAULT_START_TIMEOUT_MS = 30_000
// Unbounded by default: the reader reconnects forever (waits for the server / topic).
// A finite `recoveryWindowMs` option re-imposes a terminal deadline.
let DEFAULT_RECOVERY_WINDOW_MS = Infinity
let DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000
let DEFAULT_UPDATE_TOKEN_INTERVAL_MS = 60_000
// Bound how long pending commits are held for a partition that was stopped
// (rebalanced away) and never re-Started before rejecting them.
let DEFAULT_PARTITION_REASSIGN_GC_MS = 60_000
// Single source of truth — the facade imports it for its diagnostics config snapshot.
export const DEFAULT_MAX_BUFFER_BYTES = 8n * 1024n * 1024n
let BACKOFF_BASE_MS = 50
let BACKOFF_MAX_MS = 30_000

// I/O handles and config — visible to effect handlers only, never to the transition.
type ReaderEnv = {
	transport: ReaderTransport
	onPartitionSessionStart?: onPartitionSessionStartCallback

	startTimeoutMs: number
	updateTokenIntervalMs: number
	gracefulShutdownTimeoutMs: number
	partitionReassignGcMs: number

	ac: AbortController
	closedDeferred: PromiseWithResolvers<void>
	isFinalized: boolean
	timers: Map<string, ReturnType<typeof setTimeout>>
}

type FullCtx = ReaderCtx & ReaderEnv

export type ReaderRuntime = {
	machine: MachineRuntime<ReaderState, ReaderCtx, ReaderEvent, ReaderOutput>
}

let dbg = loggers.topic.extend('reader')
let evdbg = dbg.extend('event')

let timerEvent = function timerEvent(ref: TimerRef): ReaderEvent {
	switch (ref.which) {
		case 'start_timeout':
			return { type: 'reader.timer.start_timeout' }
		case 'retry_backoff':
			return { type: 'reader.timer.retry_backoff' }
		case 'recovery_window':
			return { type: 'reader.timer.recovery_window' }
		case 'update_token':
			return { type: 'reader.timer.update_token' }
		case 'graceful_timeout':
			return { type: 'reader.timer.graceful_timeout' }
		case 'partition_graceful_timeout':
			return { type: 'reader.timer.partition_graceful_timeout', partitionId: ref.partitionId }
		case 'partition_reassign_gc':
			return { type: 'reader.timer.partition_reassign_gc', partitionId: ref.partitionId }
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
		case 'update_token':
			return ctx.updateTokenIntervalMs
		case 'graceful_timeout':
		case 'partition_graceful_timeout':
			return ctx.gracefulShutdownTimeoutMs
		case 'partition_reassign_gc':
			return ctx.partitionReassignGcMs
	}
}

// Timer key — global key is the name; partition_* timers key per partition so
// concurrently stopping partitions cannot collide.
let timerKey = function timerKey(ref: TimerRef): string {
	return 'partitionId' in ref ? `${ref.which}:${ref.partitionId}` : ref.which
}

let clearTimerByKey = function clearTimerByKey(ctx: FullCtx, key: string): void {
	let handle = ctx.timers.get(key)
	if (handle) {
		clearTimeout(handle)
		ctx.timers.delete(key)
	}
}

let mapTransportOutput = function mapTransportOutput(output: TransportOutput): ReaderEvent | null {
	evdbg.log('transport → reader: %s', output.type)
	switch (output.type) {
		case 'transport.stream.init_response':
			return { type: 'reader.stream.init_response', sessionId: output.sessionId }
		case 'transport.stream.disconnected':
			return {
				type: 'reader.stream.disconnected',
				...('error' in output ? { error: output.error } : {}),
			}
		case 'transport.stream.message':
			return classifyServerMessage(output.message)
		default:
			return null
	}
}

// Classify one raw StreamRead server frame into a typed reader event. This is the
// single protobuf → domain boundary; the reader FSM never touches serverMessage.case.
let classifyServerMessage = function classifyServerMessage(
	message: StreamReadMessage_FromServer
): ReaderEvent | null {
	let server = message.serverMessage
	switch (server.case) {
		case 'readResponse':
			return {
				type: 'reader.stream.read_response',
				partitionData: server.value.partitionData,
				bytesSize: server.value.bytesSize,
			}
		case 'startPartitionSessionRequest': {
			let ps = server.value.partitionSession
			if (!ps) {
				return null
			}
			return {
				type: 'reader.stream.start_partition',
				partitionSessionId: ps.partitionSessionId,
				partitionId: ps.partitionId,
				path: ps.path,
				committedOffset: server.value.committedOffset,
				partitionOffsets: server.value.partitionOffsets ?? { start: 0n, end: 0n },
			}
		}
		case 'stopPartitionSessionRequest':
			return {
				type: 'reader.stream.stop_partition',
				partitionSessionId: server.value.partitionSessionId,
				graceful: server.value.graceful,
				committedOffset: server.value.committedOffset,
			}
		case 'commitOffsetResponse':
			return {
				type: 'reader.stream.commit_response',
				committed: server.value.partitionsCommittedOffsets,
			}
		case 'endPartitionSession':
			return {
				type: 'reader.stream.end_partition',
				partitionSessionId: server.value.partitionSessionId,
			}
		// Direct-read / status / token frames — nothing for the reader FSM to route.
		default:
			return null
	}
}

// Builds the reader FSM and binds its effects to real I/O: transport connect/send,
// timers with equal-jitter backoff, the async onPartitionSessionStart handshake, and
// transport-output → reader-event mapping.
export function createReaderRuntime(driver: Driver, options: TopicReaderOptions): ReaderRuntime {
	let transport = new ReaderTransport(driver, {
		consumer: options.consumer,
		topicsReadSettings: parseReadSettings(options.topic),
		autoPartitioningSupport: false,
	})

	let env: ReaderEnv = {
		transport,
		...(options.onPartitionSessionStart && {
			onPartitionSessionStart: options.onPartitionSessionStart,
		}),

		startTimeoutMs: DEFAULT_START_TIMEOUT_MS,
		updateTokenIntervalMs: options.updateTokenIntervalMs ?? DEFAULT_UPDATE_TOKEN_INTERVAL_MS,
		gracefulShutdownTimeoutMs:
			options.gracefulShutdownTimeoutMs ?? DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
		partitionReassignGcMs: DEFAULT_PARTITION_REASSIGN_GC_MS,

		ac: new AbortController(),
		closedDeferred: Promise.withResolvers<void>(),
		isFinalized: false,
		timers: new Map(),
	}

	let ctx = createReaderCtx(
		{ maxBufferBytes: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES },
		{
			retryOnSchemeError: options.retryOnSchemeError ?? false,
			recoveryWindowMs: options.recoveryWindowMs ?? DEFAULT_RECOVERY_WINDOW_MS,
		}
	)

	let machine = createMachineRuntime<
		ReaderState,
		ReaderCtx,
		ReaderEnv,
		ReaderEvent,
		ReaderEffect,
		ReaderOutput
	>({
		initialState: 'idle',
		ctx,
		env,
		transition: (fullCtx, event, runtime) => {
			let result = readerTransition(fullCtx, event, runtime)
			if (evdbg.enabled) {
				evdbg.log('%s: %s → %s', event.type, runtime.state, result?.state ?? runtime.state)
			}
			return result
		},
		effects: {
			'reader.effect.transport.connect': (fullCtx) => {
				dbg.log('connect')
				fullCtx.transport.connect()
			},

			'reader.effect.send.read_request': (fullCtx, effect) => {
				fullCtx.transport.send(
					create(StreamReadMessage_FromClientSchema, {
						clientMessage: {
							case: 'readRequest',
							value: { bytesSize: effect.bytesSize },
						},
					})
				)
			},

			'reader.effect.send.commit': (fullCtx, effect) => {
				fullCtx.transport.send(
					create(StreamReadMessage_FromClientSchema, {
						clientMessage: {
							case: 'commitOffsetRequest',
							value: {
								commitOffsets: [
									{
										partitionSessionId: effect.partitionSessionId,
										offsets: effect.ranges,
									},
								],
							},
						},
					})
				)
			},

			'reader.effect.send.stop_response': (fullCtx, effect) => {
				// Partition-session handshake — keep it ahead of the read/commit backlog.
				fullCtx.transport.send(
					create(StreamReadMessage_FromClientSchema, {
						clientMessage: {
							case: 'stopPartitionSessionResponse',
							value: { partitionSessionId: effect.partitionSessionId },
						},
					}),
					PRIORITY_CONTROL
				)
			},

			'reader.effect.send.update_token': (fullCtx) => {
				void fullCtx.transport.sendUpdateToken().catch(() => {
					// Token refresh failures surface as a stream error on the next read.
				})
			},

			'reader.effect.transport.close': (fullCtx) => {
				fullCtx.transport.close()
			},

			// The one effect where the runtime makes a domain decision, by necessity: the
			// StartPartitionSessionResponse's read_offset/commit_offset come from the async
			// `onPartitionSessionStart` hook (typically an external offset-store lookup — I/O),
			// which the pure synchronous transition cannot await. So the hook call, the
			// reassign guard, and the response are built here — an intrinsic async protocol
			// handshake, not leaked policy. The FSM owns "the partition started" (the
			// reader.partition.started output + this effect); the runtime owns the async ack.
			'reader.effect.partition.start_hook': (fullCtx, effect, runtime) => {
				// The user hook runs DETACHED: awaiting it here would freeze the whole
				// drain loop (every partition, commits, even destroy) on user code. Its
				// result re-enters the machine as reader.partition.start_ready, so the
				// answer-or-not decision is made against fresh state in the transition.
				void (async () => {
					let session = fullCtx.partitions.get(effect.partitionId)?.session
					let readOffset: bigint | undefined
					let commitOffset: bigint | undefined

					if (fullCtx.onPartitionSessionStart && session) {
						try {
							let result = await fullCtx.onPartitionSessionStart(
								session,
								effect.committedOffset,
								effect.partitionOffsets
							)
							if (result) {
								readOffset = result.readOffset
								commitOffset = result.commitOffset
							}
						} catch (error) {
							dbg.log('onPartitionSessionStart threw: %O', error)
						}
					}

					runtime.dispatch({
						type: 'reader.partition.start_ready',
						partitionSessionId: effect.partitionSessionId,
						partitionId: effect.partitionId,
						grantId: effect.grantId,
						...(readOffset !== undefined && { readOffset }),
						...(commitOffset !== undefined && { commitOffset }),
					})
				})()
			},

			'reader.effect.send.start_response': (fullCtx, effect) => {
				// Omit read_offset/commit_offset unless the hook set them: the server
				// validates read_offset >= committed offset, so a spurious 0 would be
				// rejected when the committed offset is already past 0.
				fullCtx.transport.send(
					create(StreamReadMessage_FromClientSchema, {
						clientMessage: {
							case: 'startPartitionSessionResponse',
							value: {
								partitionSessionId: effect.partitionSessionId,
								...(effect.readOffset !== undefined && {
									readOffset: effect.readOffset,
								}),
								...(effect.commitOffset !== undefined && {
									commitOffset: effect.commitOffset,
								}),
							},
						},
					}),
					PRIORITY_CONTROL
				)
			},

			'reader.effect.timer.schedule': (fullCtx, effect, runtime) => {
				let key = timerKey(effect)
				// The recovery window is armed once per reconnect saga.
				if (effect.which === 'recovery_window' && fullCtx.timers.has(key)) {
					return
				}
				clearTimerByKey(fullCtx, key)

				let repeating = effect.which === 'update_token'
				let delay = delayFor(fullCtx, effect.which)
				let event = timerEvent(effect)

				let handle = repeating
					? setInterval(() => runtime.dispatch(event), delay)
					: setTimeout(() => {
							fullCtx.timers.delete(key)
							runtime.dispatch(event)
						}, delay)

				handle.unref?.()
				fullCtx.timers.set(key, handle)
			},

			'reader.effect.timer.clear': (fullCtx, effect) => {
				clearTimerByKey(fullCtx, timerKey(effect))
			},

			'reader.effect.finalize': (fullCtx, effect) => {
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

	machine.ingest(transport.events, mapTransportOutput)

	dbg.log('starting reader on consumer %s', options.consumer)
	machine.dispatch({ type: 'reader.start' })

	return { machine }
}
