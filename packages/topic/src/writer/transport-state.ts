import { fail } from 'node:assert/strict'

import type { TransitionResult, TransitionRuntime } from '@ydbjs/fsm'

import type { WriteAck } from './types.js'

// One physical streamWrite lifecycle. All business logic (buffer, seqNo, backoff)
// lives in the writer FSM; the transport only owns the socket and forwards
// classified server messages to the writer as outputs.
//
// The full transition map (table + diagram) lives in packages/topic/ARCHITECTURE.md —
// update it in the same commit when you change this dispatch.
export type TransportState = 'idle' | 'connecting' | 'ready' | 'disconnected' | 'closed'

// The transport FSM keeps no ctx state — every fact rides on the event/output.
export type TransportCtx = {}

// Events are pre-classified by the ingest task, so the transition never touches
// raw protobuf — it just maps stream facts to state and outputs.
export type TransportEvent =
	// lifecycle commands the owner dispatches inward
	| { type: 'transport.connect' }
	| { type: 'transport.close' }
	| { type: 'transport.destroy'; reason?: unknown }
	// classified stream facts the ingest task forwards
	| { type: 'transport.init'; sessionId: string; lastSeqNo: bigint; partitionId?: bigint }
	| { type: 'transport.write'; acks: WriteAck[] }
	| { type: 'transport.token' }
	| { type: 'transport.ended' }
	| { type: 'transport.error'; error: unknown }

export type TransportEffect =
	| { type: 'transport.effect.open_stream' }
	| { type: 'transport.effect.close_stream' }
	| { type: 'transport.effect.finalize'; reason: unknown }

// Emitted to the writer FSM, which ingests these as writer events.
export type TransportOutput =
	| {
			type: 'transport.stream.init_response'
			sessionId: string
			lastSeqNo: bigint
			partitionId?: bigint
	  }
	| { type: 'transport.stream.write_response'; acks: WriteAck[] }
	| { type: 'transport.stream.token_response' }
	| { type: 'transport.stream.disconnected'; error?: unknown }

type TransportRuntime = TransitionRuntime<TransportState, TransportEvent, TransportOutput>

let toInitResponse = function toInitResponse(
	event: Extract<TransportEvent, { type: 'transport.init' }>
): TransportOutput {
	let output: TransportOutput = {
		type: 'transport.stream.init_response',
		sessionId: event.sessionId,
		lastSeqNo: event.lastSeqNo,
	}
	if (event.partitionId !== undefined) {
		output = { ...output, partitionId: event.partitionId }
	}
	return output
}

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
				runtime.emit(toInitResponse(event))
				return state === 'ready' ? undefined : { state: 'ready' }
			}
			if (event.type === 'transport.write') {
				runtime.emit({ type: 'transport.stream.write_response', acks: event.acks })
				return
			}
			if (event.type === 'transport.token') {
				runtime.emit({ type: 'transport.stream.token_response' })
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
