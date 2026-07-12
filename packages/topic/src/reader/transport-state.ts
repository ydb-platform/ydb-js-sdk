import { fail } from 'node:assert/strict'

import type { StreamReadMessage_FromServer } from '@ydbjs/api/topic'
import type { TransitionResult, TransitionRuntime } from '@ydbjs/fsm'

// One physical streamRead lifecycle. All reader business logic (partition
// sessions, offsets, commits, buffer, backoff) lives in the reader FSM; the
// transport only owns the stream and forwards server messages as outputs.
//
// The full transition map (table + diagram) lives in packages/topic/ARCHITECTURE.md —
// update it in the same commit when you change this dispatch.
//
// Unlike the writer transport, the reader has many server-message types
// (read / start-partition / stop-partition / commit / end-partition / …), so
// the transport does not classify them — it recognizes only the init handshake
// and forwards every other server message verbatim for the reader FSM to route.
export type TransportState = 'idle' | 'connecting' | 'ready' | 'disconnected' | 'closed'

// The transport FSM keeps no ctx state — every fact rides on the event/output.
export type TransportCtx = {}

export type TransportEvent =
	// lifecycle commands the owner dispatches inward
	| { type: 'transport.connect' }
	| { type: 'transport.close' }
	| { type: 'transport.destroy'; reason?: unknown }
	// stream facts the ingest task forwards — only the init handshake is
	// recognized; every other server message rides verbatim in transport.message
	// for the reader FSM to route
	| { type: 'transport.init'; sessionId: string }
	| { type: 'transport.message'; message: StreamReadMessage_FromServer }
	| { type: 'transport.ended' }
	| { type: 'transport.error'; error: unknown }

export type TransportEffect =
	| { type: 'transport.effect.open_stream' }
	| { type: 'transport.effect.close_stream' }
	| { type: 'transport.effect.finalize'; reason: unknown }

// Emitted to the reader FSM, which ingests these as reader events.
export type TransportOutput =
	| { type: 'transport.stream.init_response'; sessionId: string }
	| { type: 'transport.stream.message'; message: StreamReadMessage_FromServer }
	| { type: 'transport.stream.disconnected'; error?: unknown }

type TransportRuntime = TransitionRuntime<TransportState, TransportEvent, TransportOutput>

let disconnect = function disconnect(
	error: unknown,
	runtime: TransportRuntime
): TransitionResult<TransportState, TransportEffect> {
	let output: TransportOutput = { type: 'transport.stream.disconnected' }
	if (error !== undefined) {
		output = { ...output, error }
	}
	runtime.emit(output)
	return { state: 'disconnected', effects: [{ type: 'transport.effect.close_stream' }] }
}

export let transportTransition = function transportTransition(
	_ctx: TransportCtx,
	event: TransportEvent,
	runtime: TransportRuntime
): TransitionResult<TransportState, TransportEffect> | void {
	let state = runtime.state

	if (state !== 'closed' && event.type === 'transport.destroy') {
		return {
			state: 'closed',
			effects: [
				{ type: 'transport.effect.close_stream' },
				{
					type: 'transport.effect.finalize',
					reason: event.reason ?? new Error('Transport destroyed'),
				},
			],
		}
	}

	switch (state) {
		case 'idle': {
			if (event.type === 'transport.connect') {
				return { state: 'connecting', effects: [{ type: 'transport.effect.open_stream' }] }
			}
			if (event.type === 'transport.close') {
				return {
					state: 'closed',
					effects: [
						{
							type: 'transport.effect.finalize',
							reason: new Error('Transport closed'),
						},
					],
				}
			}
			return
		}

		case 'connecting':
		case 'ready': {
			if (event.type === 'transport.connect') {
				// Reopen the stream (open_stream disposes the previous one first).
				return { state: 'connecting', effects: [{ type: 'transport.effect.open_stream' }] }
			}
			if (event.type === 'transport.init') {
				runtime.emit({ type: 'transport.stream.init_response', sessionId: event.sessionId })
				return state === 'ready' ? undefined : { state: 'ready' }
			}
			if (event.type === 'transport.message') {
				runtime.emit({ type: 'transport.stream.message', message: event.message })
				return
			}
			if (event.type === 'transport.ended') {
				return disconnect(undefined, runtime)
			}
			if (event.type === 'transport.error') {
				return disconnect(event.error, runtime)
			}
			if (event.type === 'transport.close') {
				return {
					state: 'closed',
					effects: [
						{ type: 'transport.effect.close_stream' },
						{
							type: 'transport.effect.finalize',
							reason: new Error('Transport closed'),
						},
					],
				}
			}
			return
		}

		case 'disconnected': {
			if (event.type === 'transport.connect') {
				return { state: 'connecting', effects: [{ type: 'transport.effect.open_stream' }] }
			}
			if (event.type === 'transport.close') {
				return {
					state: 'closed',
					effects: [
						{
							type: 'transport.effect.finalize',
							reason: new Error('Transport closed'),
						},
					],
				}
			}
			return
		}

		case 'closed':
			return

		default: {
			let exhaustive: never = state
			fail(`Unhandled transport state: ${exhaustive}`)
		}
	}
}
