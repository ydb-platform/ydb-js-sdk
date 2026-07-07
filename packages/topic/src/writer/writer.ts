import { abortable } from '@ydbjs/abortable'
import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'

import { type CompressionCodec, RAW_CODEC } from '../codec.js'
import type { TX } from '../tx.js'
import { generateProducerId } from './_gen_producer_id.js'
import {
	type WriterScope,
	publishAcknowledged,
	publishClosed,
	publishErrored,
	publishReconnecting,
	publishSessionStarted,
} from './diagnostics.js'
import { MAX_PAYLOAD_BYTES } from './writer-state.js'
import { type WriterRuntime, createWriterRuntime } from './writer-runtime.js'
import type { AckStatus, TopicWriterOptions, WriteExtra } from './types.js'

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

// Public topic writer. Construct via createTopicWriter / createTopicTxWriter,
// which resolve the producer id, wire transaction hooks, and validate options.
export class TopicWriter implements AsyncDisposable {
	#runtime: WriterRuntime
	#validator = new SeqNoValidator()
	#codec: CompressionCodec
	#flushWaiters: Array<PromiseWithResolvers<bigint>> = []
	#closedDeferred = Promise.withResolvers<void>()
	#onAck: ((seqNo: bigint, status: AckStatus) => void) | undefined
	#scope: WriterScope
	#lastError: unknown = undefined
	#closing = false
	#closed = false

	constructor(driver: Driver, options: TopicWriterOptions) {
		this.#onAck = options.onAck
		this.#codec = options.codec ?? RAW_CODEC
		this.#scope = { driver: driver.identity, topic: options.topic, producer: options.producer! }
		this.#runtime = createWriterRuntime(driver, options)
		void this.#consume()
	}

	// Drain the FSM output stream, resolving/rejecting the promises the facade owns.
	async #consume(): Promise<void> {
		for await (let output of this.#runtime.machine) {
			switch (output.type) {
				case 'writer.session':
					publishSessionStarted(this.#scope, output.sessionId, output.lastSeqNo)
					break

				case 'writer.acknowledgments':
					publishAcknowledged(this.#scope, output.acknowledgments.size)
					if (this.#onAck) {
						for (let [seqNo, status] of output.acknowledgments) {
							try {
								this.#onAck(seqNo, status)
							} catch {
								// User callback errors must not break the writer.
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
					publishReconnecting(this.#scope, output.attempt, output.error)
					break

				case 'writer.error':
					this.#lastError = output.error
					publishErrored(this.#scope, output.error)
					for (let waiter of this.#flushWaiters.splice(0)) {
						waiter.reject(output.error)
					}
					break

				case 'writer.closed':
					this.#closed = true
					publishClosed(this.#scope)
					for (let waiter of this.#flushWaiters.splice(0)) {
						waiter.reject(
							this.#lastError ?? new Error('Writer closed before flush completed')
						)
					}
					// Resolved AFTER writer.error was processed above (emitted first),
					// so close() sees #lastError and can reject on an unclean close.
					this.#closedDeferred.resolve()
					break
			}
		}
	}

	write(data: Uint8Array, extra?: WriteExtra): void {
		if (this.#closed || this.#closing) {
			throw new Error('Writer is closed, cannot write messages')
		}
		if (this.#lastError) {
			throw new Error('Writer has failed, cannot write messages', { cause: this.#lastError })
		}
		// Size limit applies to the uncompressed payload.
		if (BigInt(data.length) > MAX_PAYLOAD_BYTES) {
			throw new Error(`Message payload of ${data.length} bytes exceeds the size limit`)
		}

		let seqNo = this.#validator.validate(extra?.seqNo)
		let uncompressedSize = BigInt(data.length)
		let payload = this.#codec.compress(data)

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

		let waiter = Promise.withResolvers<bigint>()
		this.#flushWaiters.push(waiter)
		this.#runtime.machine.dispatch({ type: 'writer.flush' })

		return signal ? abortable(signal, waiter.promise) : waiter.promise
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
}

export function createTopicWriter(driver: Driver, options: TopicWriterOptions): TopicWriter {
	if (options.partitionId !== undefined && options.messageGroupId !== undefined) {
		throw new Error(
			'partitionId and messageGroupId are mutually exclusive — provide at most one'
		)
	}

	// A producer id is generated when omitted (zero-config writes).
	let resolved: TopicWriterOptions = {
		...options,
		producer: options.producer ?? generateProducerId(),
	}

	loggers.topic.extend('writer').log('creating writer for topic %s', options.topic)

	// Wire transaction lifecycle: commit flushes pending writes, rollback/close drops them.
	if (resolved.tx) {
		let writer = new TopicWriter(driver, resolved)

		resolved.tx.onCommit(async (signal) => {
			await writer.close(signal)
		})
		resolved.tx.onRollback(() => {
			writer.destroy(new Error('Transaction rolled back'))
		})
		resolved.tx.onClose((committed) => {
			if (!committed) {
				writer.destroy(new Error('Transaction closed without commit'))
			}
		})

		return writer
	}

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
