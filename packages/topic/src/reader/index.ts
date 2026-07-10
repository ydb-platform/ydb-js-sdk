import { timestampDate } from '@bufbuild/protobuf/wkt'
import type { Codec } from '@ydbjs/api/topic'
import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'
import { AsyncQueue } from '@ydbjs/fsm/queue'

import { type CodecMap, defaultCodecMap, getCodec } from '../codec.js'
import { TopicMessage } from '../message.js'
import type { TopicPartitionSession } from '../partition-session.js'
import type { TX } from '../tx.js'
import { updateOffsetsInTransaction } from './tx-offsets.js'
import {
	type ReaderScope,
	publishClosed,
	publishCommitted,
	publishErrored,
	publishOpened,
	publishPartitionStarted,
	publishPartitionStopped,
	publishReconnecting,
	traceCommit,
} from './diagnostics.js'
import { type ReaderRuntime, createReaderRuntime } from './reader-runtime.js'
import type { ReaderMessage } from './reader-state.js'
import type { TopicReaderOptions, TopicTxReader } from './types.js'

let DEFAULT_MAX_BUFFER_BYTES = 8n * 1024n * 1024n

// Re-export the public types for consumers importing from the reader entry point.
// (`TopicReader` itself is the exported class below, mirroring `TopicWriter`.)
export type {
	TopicReaderOptions,
	TopicReaderSource,
	TopicTxReader,
	onCommittedOffsetCallback,
	onPartitionSessionStartCallback,
	onPartitionSessionStopCallback,
} from './types.js'

let dbg = loggers.topic.extend('reader')

// A decoded ReadResponse: the consumer takes the messages, then the reader releases
// the response's flow-control credit (backpressure — credit is granted only as the
// consumer keeps up).
type Chunk = { messages: TopicMessage[]; releaseBytes: bigint }

// The public topic reader. read() is a pull async-iterator over decoded batches;
// commit() acknowledges offsets and resolves once the server's committed high-water
// mark reaches them — surviving transparent reconnects (never rejected by one).
export class TopicReader implements AsyncDisposable, Disposable {
	#options: TopicReaderOptions
	#codecs: CodecMap
	#runtime: ReaderRuntime

	#chunks = new AsyncQueue<Chunk>()
	#chunkIterator: AsyncIterator<Chunk>
	#pendingNext: Promise<IteratorResult<Chunk>> | null = null

	// waiterId -> commit() promise; the FSM only carries the id, never the callback.
	#waiters = new Map<number, PromiseWithResolvers<void>>()
	#nextWaiterId = 1

	// partitionId -> current session, for the committed/stopped callbacks and tx hook.
	#sessions = new Map<bigint, TopicPartitionSession>()

	// tx read offsets: first/last delivered offset per partitionId. The FSM is
	// tx-agnostic — the facade tracks these itself from delivered messages (only for a
	// tx reader) and commits them in the tx.onCommit hook. Undefined for a non-tx reader.
	#txReadOffsets?: Map<bigint, { firstOffset: bigint; lastOffset: bigint }>

	// Shadow of the FSM's terminal error: set by the #consume drain on `reader.error`
	// (or a machine fault), then consulted synchronously by read()/commit()/close() to
	// surface it to the caller — the FSM cannot reject an already-running read() promise.
	#lastError: unknown = undefined
	#closed = false
	#closing = false
	#reading = false // read() is single-consumer
	#isTx: boolean
	#scope: ReaderScope
	#closedDeferred = Promise.withResolvers<void>()

	constructor(driver: Driver, options: TopicReaderOptions, runtimeOptions?: { tx?: TX }) {
		this.#options = options
		this.#isTx = runtimeOptions?.tx !== undefined
		if (this.#isTx) {
			this.#txReadOffsets = new Map()
		}
		this.#codecs = options.codecMap ?? defaultCodecMap
		this.#scope = { driver: driver.identity, consumer: options.consumer }
		publishOpened(this.#scope, {
			maxBufferBytes: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
			updateTokenIntervalMs: options.updateTokenIntervalMs ?? 60_000,
			recoveryWindowMs: options.recoveryWindowMs ?? Infinity,
			retryOnSchemeError: options.retryOnSchemeError ?? false,
		})
		this.#runtime = createReaderRuntime(driver, options)
		this.#chunkIterator = this.#chunks[Symbol.asyncIterator]()
		// Fire-and-forget drain; an internal machine fault rethrows and is funneled to
		// the terminal path (never an unhandled rejection).
		this.#consume().catch((error) => this.#fail(error))
	}

	async *read(options?: {
		limit?: number
		// Max time to accumulate a batch before yielding (possibly empty, so an idle
		// topic never hangs the consumer). Omit to block for one chunk.
		batchWindowMs?: number
		/** @deprecated renamed to `batchWindowMs`. */
		waitMs?: number
		signal?: AbortSignal
	}): AsyncIterable<TopicMessage[]> {
		// Single-consumer: two concurrent read() loops would race the shared chunk
		// iterator and double-release flow-control credit.
		if (this.#reading) {
			throw new Error('read() is already in progress — the reader is single-consumer')
		}
		this.#reading = true
		let limit = options?.limit
		// `waitMs` is the deprecated alias for `batchWindowMs`.
		let batchWindowMs = options?.batchWindowMs ?? options?.waitMs
		let signal = options?.signal

		try {
			for (;;) {
				if (this.#lastError) {
					throw this.#lastError
				}

				// Accumulate a batch of up to `limit` messages, waiting at most
				// `batchWindowMs` (a batch is yielded — possibly empty — once the window
				// elapses so an idle topic never hangs the consumer). With no
				// `batchWindowMs`, block for one chunk.
				let batch: TopicMessage[] = []
				let releases: bigint[] = []
				let deadline =
					batchWindowMs !== undefined ? performance.now() + batchWindowMs : undefined
				let closed = false

				for (;;) {
					let remaining =
						deadline !== undefined
							? Math.max(0, deadline - performance.now())
							: undefined
					// oxlint-disable-next-line no-await-in-loop
					let chunk = await this.#nextChunk(signal, remaining)
					if (chunk === 'closed') {
						closed = true
						break
					}
					if (chunk === 'timeout') {
						break
					}
					batch.push(...chunk.messages)
					releases.push(chunk.releaseBytes)
					if (
						(limit !== undefined && batch.length >= limit) ||
						batchWindowMs === undefined
					) {
						break
					}
				}

				if (batch.length > 0) {
					if (limit !== undefined && batch.length > limit) {
						for (let i = 0; i < batch.length; i += limit) {
							yield batch.slice(i, i + limit)
						}
					} else {
						yield batch
					}
				} else if (batchWindowMs !== undefined && !closed) {
					// Idle-window tick: yield an empty batch so the consumer can act.
					yield batch
				}

				// Release each consumed response's credit now that the consumer has it.
				for (let bytes of releases) {
					this.#runtime.machine.dispatch({ type: 'reader.read_release', bytes })
				}

				if (closed) {
					// A terminal error surfaces to the consumer — it must not look like a
					// clean end-of-stream. Any buffered batch above was delivered first, then
					// we throw. The reader is already torn down (markClosed + FSM finalize):
					// it is not reusable, and every further read()/commit() throws this too.
					if (this.#lastError) {
						throw this.#lastError
					}
					return
				}
			}
		} finally {
			this.#reading = false
		}
	}

	commit(input: TopicMessage | TopicMessage[]): Promise<void> {
		// One span per commit covers batching, the server ack, and any reconnect in between.
		return traceCommit(this.#scope, () => this.#commitOffsets(input))
	}

	async #commitOffsets(input: TopicMessage | TopicMessage[]): Promise<void> {
		if (this.#lastError) {
			throw this.#lastError
		}
		if (this.#closed || this.#closing) {
			throw new Error('Reader is closed, cannot commit')
		}

		let messages = Array.isArray(input) ? input : [input]
		let byPartition = new Map<bigint, bigint[]>()

		for (let message of messages) {
			let session = message.partitionSession.deref()
			if (!session || session.isStopped) {
				throw new Error(
					'Cannot commit a message from a stopped or expired partition session'
				)
			}
			if (message.offset === undefined) {
				throw new Error('Cannot commit a message without an offset')
			}
			let offsets = byPartition.get(session.partitionId)
			if (offsets === undefined) {
				byPartition.set(session.partitionId, [message.offset])
			} else {
				offsets.push(message.offset)
			}
		}

		// One waiter per partition; the call resolves only when every partition's
		// offsets are acknowledged.
		let promises: Promise<void>[] = []
		for (let [partitionId, offsets] of byPartition) {
			offsets.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
			let waiterId = this.#nextWaiterId++
			let waiter = Promise.withResolvers<void>()
			this.#waiters.set(waiterId, waiter)
			this.#runtime.machine.dispatch({
				type: 'reader.commit',
				partitionId,
				offsets,
				waiterId,
			})
			promises.push(waiter.promise)
		}

		await Promise.all(promises)
	}

	async close(): Promise<void> {
		if (this.#closed) {
			if (this.#lastError) {
				throw this.#lastError
			}
			return
		}
		this.#closing = true
		this.#runtime.machine.dispatch({ type: 'reader.close' })
		await this.#closedDeferred.promise
		if (this.#lastError) {
			throw this.#lastError
		}
	}

	destroy(reason?: Error): void {
		if (this.#closed) {
			return
		}
		this.#closing = true
		let error = reason ?? new Error('Reader destroyed')
		this.#lastError = error
		this.#runtime.machine.dispatch({ type: 'reader.destroy', reason: error })
	}

	[Symbol.dispose](): void {
		this.destroy()
	}

	async [Symbol.asyncDispose](): Promise<void> {
		try {
			await this.close()
		} catch (error) {
			this.destroy(error instanceof Error ? error : new Error(String(error)))
			throw error
		}
	}

	// Snapshot of the tx read offsets (tx reader only), mapped to the sessions the tx
	// commit hook needs. Read synchronously in the hook.
	txReadOffsetUpdates(): Array<{
		partitionSession: TopicPartitionSession
		offsetRange: { firstOffset: bigint; lastOffset: bigint }
	}> {
		if (!this.#txReadOffsets) {
			return []
		}
		let updates: Array<{
			partitionSession: TopicPartitionSession
			offsetRange: { firstOffset: bigint; lastOffset: bigint }
		}> = []
		for (let [partitionId, offsetRange] of this.#txReadOffsets) {
			let partitionSession = this.#sessions.get(partitionId)
			if (partitionSession) {
				updates.push({ partitionSession, offsetRange })
			}
		}
		return updates
	}

	// ── internals ────────────────────────────────────────────────────────────────

	async #consume(): Promise<void> {
		for await (let output of this.#runtime.machine) {
			switch (output.type) {
				case 'reader.messages': {
					// tx read-offset tracking (before decode, keyed by the stable partitionId
					// so it survives a reconnect — the map is never cleared mid-tx).
					if (this.#txReadOffsets) {
						for (let group of output.groups) {
							for (let message of group.messages) {
								let existing = this.#txReadOffsets.get(group.session.partitionId)
								if (existing === undefined) {
									this.#txReadOffsets.set(group.session.partitionId, {
										firstOffset: message.offset,
										lastOffset: message.offset,
									})
								} else {
									existing.lastOffset = message.offset
								}
							}
						}
					}
					try {
						let messages: TopicMessage[] = []
						for (let group of output.groups) {
							for (let message of group.messages) {
								messages.push(this.#toMessage(group.session, message))
							}
						}
						this.#chunks.push({ messages, releaseBytes: output.releaseBytes })
					} catch (error) {
						// An undecodable message (corrupt payload / unsupported codec)
						// faults the reader — tear the machine down cleanly rather than
						// crash the drain loop into an unhandled rejection.
						this.#lastError ??= error
						this.#runtime.machine.dispatch({ type: 'reader.destroy', reason: error })
					}
					break
				}

				case 'reader.partition.started':
					this.#sessions.set(output.partitionId, output.session)
					publishPartitionStarted(
						this.#scope,
						output.partitionId,
						output.partitionSessionId,
						output.committedOffset
					)
					break

				case 'reader.partition.stopped': {
					let session = this.#sessions.get(output.partitionId)
					if (session && this.#options.onPartitionSessionStop) {
						try {
							void this.#options.onPartitionSessionStop(
								session,
								session.partitionCommittedOffset
							)
						} catch (error) {
							dbg.log('onPartitionSessionStop threw: %O', error)
						}
					}
					publishPartitionStopped(this.#scope, output.partitionId, output.reason)
					// Drop the stopped partition's session to keep the map bounded. The tx
					// reader keeps it (its offsets are committed at tx commit) and clears
					// everything on terminal; a re-Started partition re-registers anyway.
					if (!this.#isTx) {
						this.#sessions.delete(output.partitionId)
					}
					break
				}

				case 'reader.committed': {
					let session = this.#sessions.get(output.partitionId)
					if (session && this.#options.onCommittedOffset) {
						try {
							this.#options.onCommittedOffset(session, output.committedOffset)
						} catch (error) {
							dbg.log('onCommittedOffset threw: %O', error)
						}
					}
					publishCommitted(this.#scope, output.partitionId, output.committedOffset)
					break
				}

				case 'reader.commit.resolved': {
					let waiter = this.#waiters.get(output.waiterId)
					if (waiter) {
						this.#waiters.delete(output.waiterId)
						waiter.resolve()
					}
					break
				}

				case 'reader.commit.rejected': {
					let waiter = this.#waiters.get(output.waiterId)
					if (waiter) {
						this.#waiters.delete(output.waiterId)
						waiter.reject(output.reason)
					}
					break
				}

				case 'reader.reconnecting':
					dbg.log('reconnecting (attempt %d): %O', output.attempt, output.error)
					publishReconnecting(this.#scope, output.attempt, output.error)
					break

				case 'reader.error':
					dbg.log('errored: %O', output.error)
					this.#lastError = output.error
					publishErrored(this.#scope, output.error)
					break

				case 'reader.closed':
					dbg.log('closed')
					publishClosed(this.#scope)
					this.#markClosed()
					break

				case 'reader.session':
					dbg.log('session started (id=%s)', output.sessionId)
					break
			}
		}

		// Stream ended; if no reader.closed arrived, the machine faulted — surface it.
		if (!this.#closed) {
			this.#fail(
				this.#runtime.machine.signal.reason ?? new Error('Reader stopped unexpectedly')
			)
		}
	}

	#toMessage(session: TopicPartitionSession, message: ReaderMessage): TopicMessage {
		let codec = this.#codecs.get(message.codec) ?? getCodec(message.codec as Codec)
		return new TopicMessage({
			partitionSession: session,
			producer: message.producer,
			payload: codec.decompress(message.data),
			codec: message.codec as Codec,
			seqNo: message.seqNo,
			offset: message.offset,
			uncompressedSize: message.uncompressedSize,
			...(message.createdAt && { createdAt: timestampDate(message.createdAt).getTime() }),
			...(message.writtenAt && { writtenAt: timestampDate(message.writtenAt).getTime() }),
			...(message.metadataItems.length > 0 && {
				metadataItems: Object.fromEntries(
					message.metadataItems.map((item) => [item.key, item.value])
				),
			}),
		})
	}

	// Await the next decoded response, honoring a signal and a wait budget without
	// dropping a chunk: a timed-out `next()` promise is kept for the next call.
	async #nextChunk(
		signal?: AbortSignal,
		timeoutMs?: number
	): Promise<Chunk | 'timeout' | 'closed'> {
		if (signal?.aborted) {
			throw signal.reason
		}
		if (!this.#pendingNext) {
			this.#pendingNext = this.#chunkIterator.next()
		}
		let pending = this.#pendingNext

		if (timeoutMs === undefined && !signal) {
			this.#pendingNext = null
			let result = await pending
			return result.done ? 'closed' : result.value
		}

		let timer: ReturnType<typeof setTimeout> | undefined
		let onAbort: (() => void) | undefined
		let racers: Promise<'next' | 'timeout' | 'abort'>[] = [pending.then(() => 'next' as const)]
		if (timeoutMs !== undefined) {
			racers.push(
				new Promise((resolve) => {
					timer = setTimeout(() => resolve('timeout'), timeoutMs)
				})
			)
		}
		if (signal) {
			racers.push(
				new Promise((resolve) => {
					onAbort = () => resolve('abort')
					signal.addEventListener('abort', onAbort, { once: true })
				})
			)
		}

		let winner = await Promise.race(racers)
		if (timer) {
			clearTimeout(timer)
		}
		if (signal && onAbort) {
			signal.removeEventListener('abort', onAbort)
		}

		if (winner === 'abort') {
			throw signal!.reason
		}
		if (winner === 'timeout') {
			return 'timeout' // pendingNext preserved
		}
		this.#pendingNext = null
		let result = await pending
		return result.done ? 'closed' : result.value
	}

	#markClosed(): void {
		if (this.#closed) {
			return
		}
		this.#closed = true
		this.#chunks.close()
		this.#sessions.clear()
		this.#txReadOffsets?.clear()
		// The FSM's terminate() already rejects outstanding commits via
		// reader.commit.rejected; this settles any that slipped through, avoiding leaks.
		for (let waiter of this.#waiters.values()) {
			waiter.reject(this.#lastError ?? new Error('Reader closed'))
		}
		this.#waiters.clear()
		this.#closedDeferred.resolve()
	}

	#fail(error: unknown): void {
		if (this.#closed) {
			return
		}
		this.#lastError ??= error
		this.#markClosed()
	}
}

export function createTopicReader(driver: Driver, options: TopicReaderOptions): TopicReader {
	return new TopicReader(driver, options)
}

export function createTopicTxReader(
	tx: TX,
	driver: Driver,
	options: TopicReaderOptions
): TopicTxReader {
	let reader = new TopicReader(driver, options, { tx })

	// Commit the read offsets atomically with the transaction; on failure the tx (and
	// thus the offsets) roll back, and the reader is torn down.
	tx.onCommit(async () => {
		await updateOffsetsInTransaction(tx, driver, options.consumer, reader.txReadOffsetUpdates())
		// Release the partition once offsets are committed. A tx reader left open keeps
		// the consumer's partition assigned server-side, so a later reader on the same
		// consumer never gets a partition session — it hangs until its read deadline.
		await reader.close()
	})
	tx.onRollback(() => {
		reader.destroy(new Error('Transaction rolled back'))
	})
	tx.onClose((committed) => {
		if (!committed) {
			reader.destroy(new Error('Transaction closed without commit'))
		}
	})

	// A tx reader tracks offsets automatically — explicit commit() is not exposed.
	return {
		read: (readOptions) => reader.read(readOptions),
		close: () => reader.close(),
		destroy: (reason) => reader.destroy(reason),
		[Symbol.dispose]: () => reader[Symbol.dispose](),
		[Symbol.asyncDispose]: () => reader[Symbol.asyncDispose](),
	}
}
