import { abortable } from '@ydbjs/abortable'
import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'

import { type CompressionCodec, RAW_CODEC } from '../codec.js'
import type { TX } from '../tx.js'
import { generateProducerId } from './producer-id.js'
import {
	type WriterScope,
	ackBreakdown,
	publishAcknowledged,
	publishClosed,
	publishErrored,
	publishOpened,
	publishReconnecting,
	publishSessionStarted,
	traceFlush,
} from './diagnostics.js'
import { MAX_PAYLOAD_BYTES } from './writer-state.js'
import {
	DEFAULT_FLUSH_INTERVAL_MS,
	DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
	DEFAULT_MAX_BUFFER_BYTES,
	DEFAULT_MAX_INFLIGHT_COUNT,
	DEFAULT_RECOVERY_WINDOW_MS,
	DEFAULT_UPDATE_TOKEN_INTERVAL_MS,
	type WriterRuntime,
	createWriterRuntime,
} from './writer-runtime.js'
import type { OnAckCallback, TopicWriterOptions, WriteExtra } from './types.js'

// Lifecycle logging on the `ydb:topic:writer` namespace — low-frequency session /
// reconnect / terminal events, so it covers the failure paths without the
// per-message noise (that lives under `ydb:topic:writer:event`).
let dbg = loggers.topic.extend('writer')

// Synchronous seqNo validator, owned by the facade so write() can reject bad
// input at the call site without racing the FSM's async event queue.
class SeqNoValidator {
	#mode: 'auto' | 'manual' | null = null
	#highest = 0n

	// Returns the message seqNo (0n means "assign at send time" in auto mode).
	validate(userSeqNo: bigint | undefined): bigint {
		let provided = userSeqNo !== undefined

		if (this.#mode === null) {
			this.#mode = provided ? 'manual' : 'auto'
		}

		if (this.#mode === 'auto') {
			if (provided) {
				throw new Error('Cannot provide a seqNo in auto mode — omit it for all messages')
			}
			return 0n
		}

		if (!provided) {
			throw new Error('Cannot omit seqNo in manual mode — provide it for all messages')
		}
		if (userSeqNo! <= this.#highest) {
			throw new Error(
				`SeqNo must be strictly increasing: got ${userSeqNo}, highest seen ${this.#highest}`
			)
		}
		this.#highest = userSeqNo!
		return userSeqNo!
	}
}

// The public topic writer — construct it via createTopicWriter / createTopicTxWriter,
// which resolve the producer id, wire transaction hooks, and validate options.
//
// write() is synchronous and fire-and-forget: it buffers the message and returns.
// Invalid input (bad seqNo, over-size payload, a full buffer, or a closed/failed
// writer) throws synchronously at the call site. In auto mode the final seqNo is
// assigned only when the message reaches the wire, so it is not returned — use
// flush() (or the onAck callback) for the last acknowledged seqNo.
export class TopicWriter implements AsyncDisposable, Disposable {
	#scope: WriterScope
	#codec: CompressionCodec
	#runtime: WriterRuntime
	#validator = new SeqNoValidator()
	#flushWaiters: Array<PromiseWithResolvers<bigint>> = []

	// Byte budget mirrored here so write() can reject a full buffer synchronously,
	// ahead of the FSM's async mailbox. Incremented on write, decremented as the
	// FSM reports acked bytes leaving the window (writer.acknowledgments.freedBytes).
	#maxBufferBytes: bigint
	#bufferedBytes = 0n

	#lastError: unknown = undefined

	#closing = false
	#closed = false
	#closedDeferred = Promise.withResolvers<void>()

	#onAck: OnAckCallback | undefined
	#transactional: boolean

	constructor(driver: Driver, options: TopicWriterOptions) {
		this.#onAck = options.onAck
		this.#transactional = options.tx !== undefined
		this.#codec = options.codec ?? RAW_CODEC
		this.#maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES
		this.#scope = { driver: driver.identity, topic: options.topic, producer: options.producer! }

		// One-shot effective-config snapshot for late-joining metrics/traces
		// subscribers — built from the runtime's own defaults, correct by construction.
		publishOpened(this.#scope, {
			codec: this.#codec.codec,
			maxInflightCount: options.maxInflightCount ?? DEFAULT_MAX_INFLIGHT_COUNT,
			maxBufferBytes: this.#maxBufferBytes,
			flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
			updateTokenIntervalMs:
				options.updateTokenIntervalMs ?? DEFAULT_UPDATE_TOKEN_INTERVAL_MS,
			gracefulShutdownTimeoutMs:
				options.gracefulShutdownTimeoutMs ?? DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
			recoveryWindowMs: options.recoveryWindowMs ?? DEFAULT_RECOVERY_WINDOW_MS,
			retryOnSchemeError: options.retryOnSchemeError ?? false,
			...(options.partitionId !== undefined && { partitionId: options.partitionId }),
			...(options.messageGroupId !== undefined && { messageGroupId: options.messageGroupId }),
		})

		this.#runtime = createWriterRuntime(driver, options)
		// Fire-and-forget drain. An internal machine error rethrows from the async
		// iterator, rejecting this promise — route it to the terminal path so the
		// facade never strands a caller (nor leaks it as an unhandled rejection).
		this.#consume().catch((error) => this.#fail(error))

		// Tx lifecycle is wired here — not in the factory — mirroring the reader:
		// commit flushes pending writes (close drains first), rollback or a close
		// without commit drops them.
		if (options.tx) {
			options.tx.onCommit(async (signal) => {
				await this.close(signal)
			})
			options.tx.onRollback(() => {
				this.destroy(new Error('Transaction rolled back'))
			})
			options.tx.onClose((committed) => {
				if (!committed) {
					this.destroy(new Error('Transaction closed without commit'))
				}
			})
		}
	}

	// Drain the FSM output stream, resolving/rejecting the promises the facade owns.
	async #consume(): Promise<void> {
		for await (let output of this.#runtime.machine) {
			switch (output.type) {
				case 'writer.session':
					dbg.log(
						'session started (id=%s, lastSeqNo=%s)',
						output.sessionId,
						output.lastSeqNo
					)
					publishSessionStarted(this.#scope, output.sessionId, output.lastSeqNo)
					break

				case 'writer.acknowledgments':
					// Acked bytes left the window — reclaim the budget write() checks against.
					this.#bufferedBytes -= output.freedBytes
					if (this.#bufferedBytes < 0n) {
						this.#bufferedBytes = 0n
					}
					publishAcknowledged(
						this.#scope,
						ackBreakdown(output.acknowledgments, output.freedBytes)
					)
					if (this.#onAck) {
						for (let [seqNo, status] of output.acknowledgments) {
							try {
								this.#onAck(seqNo, status)
							} catch (error) {
								// User callback errors are logged and ignored — a throwing
								// callback must never break the writer.
								dbg.log('onAck threw: %O', error)
							}
						}
					}
					break

				case 'writer.flushed':
					for (let waiter of this.#flushWaiters.splice(0)) {
						waiter.resolve(output.lastSeqNo)
					}
					break

				case 'writer.reconnecting':
					dbg.log('reconnecting (attempt %d): %O', output.attempt, output.error)
					publishReconnecting(this.#scope, output.attempt, output.error)
					break

				case 'writer.error':
					dbg.log('errored: %O', output.error)
					this.#lastError = output.error
					publishErrored(this.#scope, output.error)
					for (let waiter of this.#flushWaiters.splice(0)) {
						waiter.reject(output.error)
					}
					break

				case 'writer.closed':
					dbg.log('closed')
					this.#markClosed()
					break
			}
		}

		// A graceful shutdown emits writer.closed (which set #closed) before the
		// stream ends. If it ended without one, the machine stopped without a
		// terminal output — fail defensively rather than strand callers.
		if (!this.#closed) {
			this.#fail(
				this.#runtime.machine.signal.reason ?? new Error('Writer stopped unexpectedly')
			)
		}
	}

	// Closed-side bookkeeping shared by the graceful (writer.closed) and failure
	// (#fail) paths. Idempotent — safe to reach from both.
	#markClosed(): void {
		if (this.#closed) {
			return
		}
		this.#closed = true
		this.#bufferedBytes = 0n
		publishClosed(this.#scope)
		for (let waiter of this.#flushWaiters.splice(0)) {
			waiter.reject(this.#lastError ?? new Error('Writer closed before flush completed'))
		}
		// Resolved AFTER writer.error was processed (emitted first), so close()
		// sees #lastError and can reject on an unclean close.
		this.#closedDeferred.resolve()
	}

	// Terminal fallback when the machine stops without emitting writer.error /
	// writer.closed (an internal runtime error): record the failure, then close.
	#fail(error: unknown): void {
		if (this.#closed) {
			return
		}
		if (this.#lastError === undefined) {
			this.#lastError = error
			publishErrored(this.#scope, error)
		}
		this.#markClosed()
	}

	write(data: Uint8Array, extra?: WriteExtra): void {
		if (this.#closed || this.#closing) {
			throw new Error('Writer is closed — cannot write messages')
		}
		if (this.#lastError) {
			throw new Error('Writer has failed — cannot write messages', { cause: this.#lastError })
		}
		// Size limit applies to the uncompressed payload.
		if (BigInt(data.length) > MAX_PAYLOAD_BYTES) {
			throw new Error(
				`Message payload of ${data.length} bytes exceeds the ${MAX_PAYLOAD_BYTES} byte limit`
			)
		}

		let uncompressedSize = BigInt(data.length)
		let payload = this.#codec.compress(data)
		let bufferedSize = BigInt(payload.length)

		// Fail-fast cap on retained (un-acknowledged) bytes to bound memory. Checked
		// before the seqNo validator mutates, so a rejected write leaves no state behind.
		if (this.#bufferedBytes + bufferedSize > this.#maxBufferBytes) {
			throw new Error(
				`Writer buffer is full: ${this.#bufferedBytes + bufferedSize} bytes would exceed the ${this.#maxBufferBytes} byte limit`
			)
		}

		let seqNo = this.#validator.validate(extra?.seqNo)
		this.#bufferedBytes += bufferedSize

		this.#runtime.machine.dispatch({
			type: 'writer.write',
			message: {
				data: payload,
				uncompressedSize,
				seqNo,
				createdAt: extra?.createdAt ?? new Date(),
				...(extra?.metadataItems && { metadataItems: extra.metadataItems }),
			},
		})
	}

	async flush(signal?: AbortSignal): Promise<bigint> {
		if (this.#lastError) {
			throw this.#lastError
		}
		if (this.#closed) {
			throw new Error('Writer is closed')
		}

		// One span per flush covers batching + server acks + any reconnect in between.
		return traceFlush(this.#scope, async () => {
			let waiter = Promise.withResolvers<bigint>()
			this.#flushWaiters.push(waiter)
			this.#runtime.machine.dispatch({ type: 'writer.flush' })

			if (!signal) {
				return waiter.promise
			}

			try {
				return await abortable(signal, waiter.promise)
			} catch (error) {
				// Abort (or a rejected flush) settled the caller's promise. Drop our
				// waiter so it neither lingers in #flushWaiters — which would grow
				// unbounded when a long-lived signal is threaded into many flush() calls
				// — nor later rejects unhandled when the writer terminates. If the FSM
				// already removed it (error/closed), indexOf is -1 and this is a no-op.
				let index = this.#flushWaiters.indexOf(waiter)
				if (index !== -1) {
					this.#flushWaiters.splice(index, 1)
				}
				throw error
			}
		})
	}

	// Debuggers and util.inspect show the constructor name, which cannot tell a tx
	// writer apart — the tag makes it render as TopicWriter [TopicTxWriter] { ... }.
	get [Symbol.toStringTag](): string {
		return this.#transactional ? 'TopicTxWriter' : 'TopicWriter'
	}

	async close(signal?: AbortSignal): Promise<void> {
		if (this.#closed) {
			// A close that dropped data surfaces the failure even on a repeat call.
			if (this.#lastError) {
				throw this.#lastError
			}
			return
		}

		// Set synchronously so a concurrent write() is rejected rather than dropped.
		this.#closing = true
		this.#runtime.machine.dispatch({ type: 'writer.close' })

		let closed = this.#closedDeferred.promise
		await (signal ? abortable(signal, closed) : closed)

		// The graceful drain failed (errored / timed out with undelivered messages).
		if (this.#lastError) {
			throw this.#lastError
		}
	}

	destroy(reason?: unknown): void {
		if (this.#closed) {
			return
		}

		this.#closing = true
		let error = reason ?? new Error('Writer destroyed')
		this.#lastError = error
		for (let waiter of this.#flushWaiters.splice(0)) {
			waiter.reject(error)
		}

		this.#runtime.machine.dispatch({ type: 'writer.destroy', reason: error })
	}

	async [Symbol.asyncDispose](): Promise<void> {
		try {
			await this.close()
		} catch (error) {
			this.destroy(error)
			throw error
		}
	}

	// Synchronous disposal is a hard stop — destroy() drops un-acknowledged messages
	// immediately. Use `await using` (graceful close, drains the buffer) when delivery
	// matters; a sync `using` cannot await a drain, so it must hard-stop.
	[Symbol.dispose](): void {
		this.destroy()
	}
}

export function createTopicWriter(driver: Driver, options: TopicWriterOptions): TopicWriter {
	if (options.partitionId !== undefined && options.messageGroupId !== undefined) {
		throw new Error(
			'partitionId and messageGroupId are mutually exclusive — provide at most one'
		)
	}

	// Reject send-path-deadlocking config up front rather than stalling silently:
	// maxInflightCount < 1 gates every batch, so writes would never leave the buffer.
	if (
		options.maxInflightCount !== undefined &&
		(!Number.isInteger(options.maxInflightCount) || options.maxInflightCount < 1)
	) {
		throw new Error('maxInflightCount must be a positive integer')
	}
	if (options.maxBufferBytes !== undefined && options.maxBufferBytes < 1n) {
		throw new Error('maxBufferBytes must be a positive number of bytes')
	}

	// A producer id is generated when omitted (zero-config writes).
	let resolved: TopicWriterOptions = {
		...options,
		producer: options.producer ?? generateProducerId(),
	}

	dbg.log('creating writer for topic %s', options.topic)

	// The constructor wires the tx lifecycle when options.tx is set.
	return new TopicWriter(driver, resolved)
}

// Transaction writer: writes are tagged with the tx and the tx commit waits for
// the buffered writes to flush (rollback/close drops them).
export function createTopicTxWriter(
	tx: TX,
	driver: Driver,
	options: Omit<TopicWriterOptions, 'tx'>
): TopicWriter {
	return createTopicWriter(driver, { ...options, tx })
}
