import { create } from '@bufbuild/protobuf'
import { timestampDate } from '@bufbuild/protobuf/wkt'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	Codec,
	OffsetsRangeSchema,
	TopicServiceDefinition,
	TransactionIdentitySchema,
	UpdateOffsetsInTransactionRequestSchema,
	UpdateOffsetsInTransactionRequest_TopicOffsetsSchema,
	UpdateOffsetsInTransactionRequest_TopicOffsets_PartitionOffsetsSchema,
} from '@ydbjs/api/topic'
import { linkSignals } from '@ydbjs/abortable'
import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'
import { YDBError } from '@ydbjs/error'
import { AsyncQueue } from '@ydbjs/fsm/queue'

import { type CodecMap, defaultCodecMap, getCodec } from '../codec.js'
import { TopicMessage } from '../message.js'
import type { TopicPartitionSession } from '../partition-session.js'
import type { TX } from '../tx.js'
import { parseReadSettings } from './read-settings.js'
import {
	type ReaderScope,
	publishClosed,
	publishCommitted,
	publishErrored,
	publishOpened,
	publishPartitionStarted,
	publishPartitionStopped,
	publishReconnecting,
	publishSessionStarted,
	traceCommit,
} from './diagnostics.js'
import {
	DEFAULT_MAX_BUFFER_BYTES,
	type ReaderRuntime,
	createReaderRuntime,
} from './reader-runtime.js'
import type { ReaderMessage } from './reader-state.js'
import type { TopicReadOptions, TopicReaderOptions, TopicTxReader } from './types.js'

let dbg = loggers.topic.extend('reader')

// A decoded ReadResponse: the consumer takes the messages, then the reader releases
// the response's flow-control credit (backpressure — credit is granted only as the
// consumer keeps up).
type Chunk = { messages: TopicMessage[]; releaseBytes: bigint }

type TxReadOffsetUpdate = {
	partitionSession: TopicPartitionSession
	offsetRange: { firstOffset: bigint; lastOffset: bigint }
}

// Bind the read offsets to the transaction via UpdateOffsetsInTransaction, so they
// become committed if and only if the transaction commits. Called from the tx.onCommit
// hook the constructor wires; a throw here fails the commit, and the offsets roll
// back with it.
let commitTxOffsets = async function commitTxOffsets(
	tx: TX,
	driver: Driver,
	consumer: string,
	updates: TxReadOffsetUpdate[]
): Promise<void> {
	if (updates.length === 0) {
		return
	}

	// The request nests ranges per topic per partition; updates arrive flat.
	let partitionsByTopic = new Map<string, TxReadOffsetUpdate[]>()
	for (let update of updates) {
		let path = update.partitionSession.topicPath
		let partitions = partitionsByTopic.get(path)
		if (!partitions) {
			partitions = []
			partitionsByTopic.set(path, partitions)
		}
		partitions.push(update)
	}

	let request = create(UpdateOffsetsInTransactionRequestSchema, {
		tx: create(TransactionIdentitySchema, {
			id: tx.transactionId,
			session: tx.sessionId,
		}),
		topics: Array.from(partitionsByTopic, ([path, partitions]) =>
			create(UpdateOffsetsInTransactionRequest_TopicOffsetsSchema, {
				path,
				partitions: partitions.map((update) =>
					create(UpdateOffsetsInTransactionRequest_TopicOffsets_PartitionOffsetsSchema, {
						partitionId: update.partitionSession.partitionId,
						partitionOffsets: [
							create(OffsetsRangeSchema, {
								start: update.offsetRange.firstOffset,
								// The wire range is half-open; updates carry inclusive lastOffset.
								end: update.offsetRange.lastOffset + 1n,
							}),
						],
					})
				),
			})
		),
		consumer,
	})

	dbg.log('committing read offsets in tx %s (%d partitions)', tx.transactionId, updates.length)

	let client = driver.createClient(TopicServiceDefinition)
	let response = await client.updateOffsetsInTransaction(request)
	if (response.operation?.status !== StatusIds_StatusCode.SUCCESS) {
		// YDBError carries the status code and issues, so retry classifiers and user
		// code can inspect it like every other server-status failure in the package.
		throw new YDBError(
			response.operation?.status ?? StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED,
			response.operation?.issues ?? []
		)
	}
}

// The public topic reader. read() is a pull async-iterator over decoded batches;
// commit() acknowledges offsets and resolves once the server's committed high-water
// mark reaches them — surviving transparent reconnects (never rejected by one).
export class TopicReader implements AsyncDisposable, Disposable {
	#options: TopicReaderOptions
	#codecs: CodecMap
	#runtime: ReaderRuntime

	#chunks = new AsyncQueue<Chunk>()

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
	#transactional: boolean
	#scope: ReaderScope
	#closedDeferred = Promise.withResolvers<void>()

	constructor(driver: Driver, options: TopicReaderOptions, runtimeOptions?: { tx?: TX }) {
		this.#options = options
		this.#transactional = runtimeOptions?.tx !== undefined
		if (this.#transactional) {
			this.#txReadOffsets = new Map()
		}
		this.#codecs = options.codecMap ?? defaultCodecMap
		this.#scope = {
			driver: driver.identity,
			consumer: options.consumer,
			topics: parseReadSettings(options.topic).map((settings) => settings.path),
		}
		publishOpened(this.#scope, {
			maxBufferBytes: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
			updateTokenIntervalMs: options.updateTokenIntervalMs ?? 60_000,
			gracefulShutdownTimeoutMs: options.gracefulShutdownTimeoutMs ?? 30_000,
			recoveryWindowMs: options.recoveryWindowMs ?? Infinity,
			retryOnSchemeError: options.retryOnSchemeError ?? false,
		})
		this.#runtime = createReaderRuntime(driver, options)
		// Fire-and-forget drain; an internal machine fault rethrows and is funneled to
		// the terminal path (never an unhandled rejection).
		this.#consume().catch((error) => this.#fail(error))

		// Tx lifecycle is wired here — not in the factory — so the hooks can reach
		// #-private state directly instead of going through an exported accessor.
		if (runtimeOptions?.tx) {
			let tx = runtimeOptions.tx
			tx.onCommit(async () => {
				// Bind the read offsets to the tx; on failure the commit (and thus the
				// offsets) roll back, and the reader is torn down by onClose below.
				await commitTxOffsets(tx, driver, options.consumer, this.#txReadOffsetUpdates())
				// Release the partition once offsets are committed. A tx reader left open
				// keeps the consumer's partition assigned server-side, so a later reader on
				// the same consumer never gets a partition session — it hangs until its
				// read deadline.
				await this.close()
			})
			tx.onRollback(() => {
				this.destroy(new Error('Transaction rolled back'))
			})
			tx.onClose((committed) => {
				if (!committed) {
					this.destroy(new Error('Transaction closed without commit'))
				}
			})
		}
	}

	async *read(options?: TopicReadOptions): AsyncIterable<TopicMessage[]> {
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
				let closed = false

				// The batch window is a cancellation source: link it with the user signal
				// so take() aborts when either fires. linkSignals (not the banned
				// AbortSignal.any) releases its listeners at batch end via `using`. No
				// window → wait on the user signal directly.
				using window =
					batchWindowMs !== undefined
						? linkSignals(signal, AbortSignal.timeout(batchWindowMs))
						: undefined
				let waitSignal = window ? window.signal : signal

				for (;;) {
					let result: IteratorResult<Chunk>
					try {
						// oxlint-disable-next-line no-await-in-loop
						result = await this.#chunks.take(waitSignal)
					} catch (error) {
						// A user cancel propagates; the batch window elapsing just ends
						// accumulation so an idle topic yields an empty batch. Anything
						// else (a failed queue) is a real fault — rethrow it.
						if (signal?.aborted) {
							throw signal.reason
						}
						if (waitSignal?.aborted) {
							break
						}
						throw error
					}
					if (result.done) {
						closed = true
						break
					}
					let chunk = result.value
					// Release the response's credit the moment its chunk is consumed — it
					// has already left the buffer, and nothing downstream (a break, a
					// consumer throw, a signal abort mid-window) may strand it. dispatch()
					// on a closed machine is a safe no-op.
					this.#runtime.machine.dispatch({
						type: 'reader.read_release',
						bytes: chunk.releaseBytes,
					})
					// Skip messages of partitions force-stopped after buffering: the
					// partition already belongs to another reader which re-reads them —
					// delivering here means duplicate processing and commits that reject.
					for (let message of chunk.messages) {
						let session = message.partitionSession.deref()
						if (session !== undefined && !session.isStopped) {
							batch.push(message)
						}
					}
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
		// The TopicTxReader type hides commit(), but the method still exists on the
		// runtime object — enforce the boundary for plain-JS callers too: a manual
		// commit would land outside the transaction and survive its rollback.
		if (this.#transactional) {
			throw new Error(
				'Tx reader commits offsets via the transaction — commit() is not available'
			)
		}
		// One span per commit covers batching, the server ack, and any reconnect in between.
		return traceCommit(this.#scope, () => this.#commitOffsets(input))
	}

	// Debuggers and util.inspect show the constructor name, which cannot tell a tx
	// reader apart — the tag makes it render as TopicReader [TopicTxReader] { ... }.
	get [Symbol.toStringTag](): string {
		return this.#transactional ? 'TopicTxReader' : 'TopicReader'
	}

	async #commitOffsets(input: TopicMessage | TopicMessage[]): Promise<void> {
		if (this.#lastError) {
			throw this.#lastError
		}
		if (this.#closed || this.#closing) {
			throw new Error('Reader is closed — cannot commit')
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

	destroy(reason?: unknown): void {
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
			this.destroy(error)
			throw error
		}
	}

	// Snapshot of the tx read offsets (tx reader only), mapped to the sessions the tx
	// commit hook needs. Read synchronously in the hook via the module-scope
	// txReadOffsetUpdates() accessor — a method here would leak into the public
	// TopicReader type (JSDoc @internal does not hide it).
	#txReadOffsetUpdates(): TxReadOffsetUpdate[] {
		if (!this.#txReadOffsets) {
			return []
		}
		let updates: TxReadOffsetUpdate[] = []
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
								} else if (message.offset > existing.lastOffset) {
									// Grow-only: a mid-tx reconnect redelivers from the committed
									// offset, and a rewound range would commit fewer offsets than
									// the transaction consumed.
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
						// Callback errors are logged via dbg and ignored — a throwing user
						// callback must never break the machine. Async rejections are caught
						// the same way.
						try {
							Promise.resolve(
								this.#options.onPartitionSessionStop(
									session,
									session.partitionCommittedOffset
								)
							).catch((error) => dbg.log('onPartitionSessionStop threw: %O', error))
						} catch (error) {
							dbg.log('onPartitionSessionStop threw: %O', error)
						}
					}
					publishPartitionStopped(this.#scope, output.partitionId, output.reason)
					// Drop the stopped partition's session to keep the map bounded. The tx
					// reader keeps it (its offsets are committed at tx commit) and clears
					// everything on terminal; a re-Started partition re-registers anyway.
					if (!this.#transactional) {
						this.#sessions.delete(output.partitionId)
					}
					break
				}

				case 'reader.partition.committed': {
					let session = this.#sessions.get(output.partitionId)
					if (session && this.#options.onCommittedOffset) {
						// Callback errors are logged via dbg and ignored — a throwing user
						// callback must never break the machine.
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
					publishSessionStarted(this.#scope, output.sessionId)
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
		return new TopicMessage({
			partitionSession: session,
			producer: message.producer,
			payload: this.#decode(session, message),
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

	#decode(session: TopicPartitionSession, message: ReaderMessage): Uint8Array {
		// UNSPECIFIED means "no codec recorded" — the payload is raw bytes (the current
		// server normalizes missing codecs to RAW before delivery; older ones could
		// leave it unset). Decompressing would corrupt it; erroring would kill the
		// reader over absent metadata.
		if (message.codec === Codec.UNSPECIFIED) {
			return message.data
		}
		try {
			let codec = this.#codecs.get(message.codec) ?? getCodec(message.codec as Codec)
			return codec.decompress(message.data)
		} catch (error) {
			// Terminal by design: the protocol has no way to refuse a single partition,
			// and skipping silently would be data loss. Make the error actionable.
			throw new Error(
				`Cannot decode message at offset ${message.offset} of partition ${session.partitionId} (${session.topicPath}): codec ${message.codec} — register it in codecMap`,
				{ cause: error }
			)
		}
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
	// The constructor wires the tx lifecycle. The instance is returned as-is under the
	// TopicTxReader type: offsets are tracked automatically, commit() is hidden by the
	// type and guarded at runtime, and the Symbol.toStringTag renders the tx flavor.
	return new TopicReader(driver, options, { tx })
}
