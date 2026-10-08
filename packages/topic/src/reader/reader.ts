import { create } from '@bufbuild/protobuf'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
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

import { type CodecMap, defaultCodecMap } from '../codec.js'
import type { TopicMessage } from '../message.js'
import type { TopicPartitionSession } from '../partition-session.js'
import type { TX } from '../tx.js'
import { parseReadSettings } from './read-settings.js'
import {
	type TxReadOffsetUpdate,
	type TxReadOffsets,
	buildCommitRanges,
	growTxOffsets,
	toTopicMessage,
	txOffsetUpdates,
} from './reader-internals.js'
import {
	type ReaderScope,
	publishBufferChanged,
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
import { type OffsetRange, type ReaderMessage, partitionKey } from './reader-state.js'
import type { TopicReadOptions, TopicReaderOptions, TopicTxReader } from './types.js'

let dbg = loggers.topic.extend('reader')

// Read credit bounds encoded bytes. Keep the grant alive until its buffered
// messages are delivered, including after a clean close.
type Chunk = {
	messages: Array<ReaderMessage & { session: TopicPartitionSession }>
	releaseBytes: bigint
}
type ReadBatch = { messages: TopicMessage[]; releaseBytes: bigint }

type CommitBatch = {
	messages: TopicMessage[]
	completion: PromiseWithResolvers<void>
	promise: Promise<void>
}

// Bind the read offsets to the transaction via UpdateOffsetsInTransaction, so they
// become committed if and only if the transaction commits. Called from the tx.onCommit
// hook the constructor wires; a throw here fails the commit, and the offsets roll
// back with it.
let commitTxOffsets = async function commitTxOffsets(
	tx: TX,
	driver: Driver,
	consumer: string,
	updates: TxReadOffsetUpdate[],
	signal?: AbortSignal
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

	let client = driver.createClient(TopicServiceDefinition, tx.nodeId)
	let response = await client.updateOffsetsInTransaction(request, signal ? { signal } : undefined)
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
	#callbacks: Pick<TopicReaderOptions, 'onPartitionSessionStop' | 'onCommittedOffset'>
	#codecs: CodecMap
	#runtime: ReaderRuntime

	#chunks = new AsyncQueue<Chunk>()
	#bufferedBytes = 0n

	// waiterId -> commit() promise; the FSM only carries the id, never the callback.
	#waiters = new Map<number, PromiseWithResolvers<void>>()
	#nextWaiterId = 1
	#commitBatch: CommitBatch | undefined

	// Every partition session this reader ever created — the commit() ownership
	// check. A WeakSet so retired sessions do not leak.
	#ownedSessions = new WeakSet<TopicPartitionSession>()

	// ReadResponses pulled off the chunk queue but not yet fully yielded to the
	// consumer. Keeping the response boundary preserves its flow-control credit until
	// the last message from that response passes through the async iterable.
	#carry: Chunk[] = []

	// tx read offsets per stable partitionKey, recorded ONLY when a batch is yielded
	// to the consumer — a tx must never bind offsets of messages the app never saw.
	// firstOffset is the first delivered message's stitched commitRangeStart, so the
	// committed range starts at the server committed offset across a head gap.
	// Undefined for a non-tx reader.
	#txReadOffsets?: Map<string, TxReadOffsets>

	// Shadow of the FSM's terminal error: set by the #consume drain on `reader.error`
	// (or a machine fault), then consulted synchronously by read()/commit()/close() to
	// surface it to the caller — the FSM cannot reject an already-running read() promise.
	#lastError: unknown = undefined
	#closing = false
	#reading = false // read() is single-consumer
	#scope: ReaderScope
	#closedDeferred = Promise.withResolvers<void>()

	constructor(driver: Driver, options: TopicReaderOptions, runtimeOptions?: { tx?: TX }) {
		options = { ...options }
		this.#callbacks = {
			...(options.onPartitionSessionStop && {
				onPartitionSessionStop: options.onPartitionSessionStop,
			}),
			...(options.onCommittedOffset && { onCommittedOffset: options.onCommittedOffset }),
		}
		if (runtimeOptions?.tx !== undefined) {
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
			tx.onCommit(async (signal) => {
				// Bind the read offsets to the tx; on failure the commit (and thus the
				// offsets) roll back, and the reader is torn down by onClose below.
				await commitTxOffsets(
					tx,
					driver,
					this.#scope.consumer,
					txOffsetUpdates(this.#txReadOffsets),
					signal
				)
				// Release the partition once offsets are committed. A tx reader left open
				// keeps the consumer's partition assigned server-side, so a later reader on
				// the same consumer never gets a partition session — it hangs until its
				// read deadline.
				await this.close()
			})
			tx.onRollback(() => {
				this.#txReadOffsets?.clear()
				this.destroy(new Error('Transaction rolled back'))
			})
			tx.onClose((committed) => {
				this.#txReadOffsets?.clear()
				if (!committed) {
					this.destroy(new Error('Transaction closed without commit'))
				}
			})
		}
	}

	// Server-accounted bytes retained by the reader and not yet fully delivered through
	// read(). This can exceed maxBufferBytes when a single server response overdraws the
	// credit window.
	get bufferedBytes(): bigint {
		return this.#bufferedBytes
	}

	read(options?: TopicReadOptions): AsyncIterable<TopicMessage[]> {
		// Validate eagerly — an async generator would defer the throw to the first
		// next(), and a zero/negative limit would otherwise spin an infinite
		// empty-slice loop instead of failing.
		let limit = options?.limit
		if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
			throw new RangeError(`read limit must be a positive integer, got ${limit}`)
		}
		// `waitMs` is the deprecated alias for `batchWindowMs`.
		let batchWindowMs = options?.batchWindowMs ?? options?.waitMs
		if (batchWindowMs !== undefined && (!Number.isFinite(batchWindowMs) || batchWindowMs < 0)) {
			throw new RangeError(
				`batchWindowMs must be a non-negative finite number, got ${batchWindowMs}`
			)
		}
		return this.#readLoop(limit, batchWindowMs, options?.signal)
	}

	commit(input: TopicMessage | TopicMessage[]): Promise<void> {
		// The TopicTxReader type hides commit(), but the method still exists on the
		// runtime object — enforce the boundary for plain-JS callers too: a manual
		// commit would land outside the transaction and survive its rollback.
		if (this.#txReadOffsets !== undefined) {
			throw new Error(
				'Tx reader commits offsets via the transaction — commit() is not available'
			)
		}
		let batch = this.#commitBatch ?? this.#createCommitBatch()
		let messages = Array.isArray(input) ? input : [input]
		for (let message of messages) {
			batch.messages.push(message)
		}
		return batch.promise
	}

	async close(): Promise<void> {
		if (this.#chunks.isClosed) {
			if (this.#lastError !== undefined) {
				throw this.#lastError
			}
			return
		}
		// Preserve call order when commit() and close() happen in the same turn: dispatch
		// the queued commit before the close transition starts draining pending work.
		if (this.#commitBatch) {
			this.#flushCommitBatch(this.#commitBatch)
		}
		this.#closing = true
		this.#runtime.machine.dispatch({ type: 'reader.close' })
		await this.#closedDeferred.promise
		if (this.#lastError !== undefined) {
			throw this.#lastError
		}
	}

	destroy(reason?: unknown): void {
		if (this.#chunks.isClosed) {
			this.#discardBuffers()
			return
		}
		this.#closing = true
		let error = reason ?? new Error('Reader destroyed')
		this.#lastError ??= error
		this.#txReadOffsets?.clear()
		this.#discardBuffers()
		this.#runtime.machine.dispatch({ type: 'reader.destroy', reason: error })
	}

	async [Symbol.asyncDispose](): Promise<void> {
		try {
			await this.close()
		} catch (error) {
			this.destroy(error)
			throw error
		}
	}

	[Symbol.dispose](): void {
		this.destroy()
	}

	// Debuggers and util.inspect show the constructor name, which cannot tell a tx
	// reader apart — the tag makes it render as TopicReader [TopicTxReader] { ... }.
	get [Symbol.toStringTag](): string {
		return this.#txReadOffsets !== undefined ? 'TopicTxReader' : 'TopicReader'
	}

	async *#readLoop(
		limit: number | undefined,
		batchWindowMs: number | undefined,
		signal: AbortSignal | undefined
	): AsyncIterable<TopicMessage[]> {
		// Single-consumer: two concurrent read() loops would race the shared chunk
		// iterator and double-release flow-control credit.
		if (this.#reading) {
			throw new Error('read() is already in progress — the reader is single-consumer')
		}
		this.#reading = true

		try {
			for (;;) {
				if (this.#lastError !== undefined) {
					throw this.#lastError
				}
				signal?.throwIfAborted()

				// Accumulate a batch of up to `limit` messages, waiting at most
				// `batchWindowMs` (a batch is yielded — possibly empty — once the window
				// elapses so an idle topic never hangs the consumer). With no
				// `batchWindowMs`, block for one chunk. Starts from the carry-over of a
				// previously aborted call — those messages were dequeued but never
				// delivered.
				let chunks: Chunk[] = this.#takeCarry()
				let batchLength = chunks.reduce((count, chunk) => count + chunk.messages.length, 0)
				let closed = false

				{
					// The batch window is a cancellation source: link it with the user signal
					// so take() aborts when either fires. linkSignals (not the banned
					// AbortSignal.any) releases its listeners at batch end via `using`. No
					// window → wait on the user signal directly.
					using window =
						batchWindowMs !== undefined
							? linkSignals(signal, AbortSignal.timeout(batchWindowMs))
							: undefined
					let waitSignal = window ? window.signal : signal

					// Carried messages satisfy a no-window read on their own — blocking for
					// one more chunk with deliverable messages in hand would stall the
					// consumer.
					let wantMore = () =>
						(batchLength === 0 || batchWindowMs !== undefined) &&
						(limit === undefined || batchLength < limit)
					while (wantMore()) {
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
						if (this.#lastError !== undefined) {
							if (!result.done) result.value.messages.length = 0
							throw this.#lastError
						}
						if (result.done) {
							closed = true
							break
						}
						let chunk = this.#filterChunk(result.value)
						if (chunk) {
							chunks.push(chunk)
							batchLength += chunk.messages.length
						}
						if (
							(limit !== undefined && batchLength >= limit) ||
							batchWindowMs === undefined
						) {
							break
						}
					}

					if (batchLength > 0) {
						while (chunks.length > 0) {
							signal?.throwIfAborted()
							let batch = this.#takeBatch(chunks, limit)
							if (this.#lastError !== undefined) throw this.#lastError
							growTxOffsets(this.#txReadOffsets, batch.messages)
							if (batch.releaseBytes > 0n) {
								this.#releaseReadBytes(batch.releaseBytes)
							}
							if (batch.messages.length > 0) {
								yield batch.messages
							}
						}
					} else if (batchWindowMs !== undefined && !closed) {
						// Idle-window tick: yield an empty batch so the consumer can act.
						yield []
					}
				}

				if (closed) {
					// A terminal error must not look like a clean end-of-stream.
					if (this.#lastError !== undefined) {
						throw this.#lastError
					}
					return
				}
			}
		} finally {
			this.#reading = false
		}
	}

	#releaseReadBytes(bytes: bigint): void {
		this.#bufferedBytes -= bytes
		if (this.#bufferedBytes < 0n) {
			this.#bufferedBytes = 0n
		}
		publishBufferChanged(this.#scope, this.#bufferedBytes)
		this.#runtime.machine.dispatch({ type: 'reader.read_release', bytes })
		if (this.#chunks.isClosed && this.#bufferedBytes === 0n) this.#codecs = defaultCodecMap
	}

	// Remove up to `limit` messages while retaining the response boundary. Credit for
	// a response is returned only by the batch containing its final message.
	#takeBatch(chunks: Chunk[], limit: number | undefined): ReadBatch {
		let messages: TopicMessage[] = []
		let releaseBytes = 0n
		let remaining = limit ?? Infinity
		while (chunks.length > 0 && remaining > 0) {
			let chunk = chunks[0]!
			let count = Math.min(chunk.messages.length, remaining)
			for (let message of chunk.messages.splice(0, count)) {
				if (!message.session.isStopped) {
					try {
						messages.push(toTopicMessage(this.#codecs, message.session, message))
					} catch (error) {
						this.#lastError ??= error
						this.#txReadOffsets?.clear()
						this.destroy(error)
						throw error
					}
					remaining--
				}
			}
			if (chunk.messages.length === 0) {
				releaseBytes += chunk.releaseBytes
				chunks.shift()
			}
		}
		return { messages, releaseBytes }
	}

	// A force-stopped partition is re-read by its new owner. If filtering consumes the
	// whole response, there is no user-visible message to gate its credit on.
	#filterChunk(chunk: Chunk): Chunk | undefined {
		chunk.messages = chunk.messages.filter((message) => !message.session.isStopped)
		if (chunk.messages.length === 0) {
			this.#releaseReadBytes(chunk.releaseBytes)
			return undefined
		}
		return chunk
	}

	// A partition may have been lost between the aborted call and this one.
	#takeCarry(): Chunk[] {
		for (let i = 0; i < this.#carry.length; ) {
			let filtered = this.#filterChunk(this.#carry[i]!)
			if (filtered) {
				this.#carry[i++] = filtered
			} else {
				this.#carry.splice(i, 1)
			}
		}
		return this.#carry
	}

	#createCommitBatch(): CommitBatch {
		let completion = Promise.withResolvers<void>()
		let batch: CommitBatch = {
			messages: [],
			completion,
			promise: traceCommit(this.#scope, () => completion.promise),
		}
		this.#commitBatch = batch
		queueMicrotask(() => this.#flushCommitBatch(batch))
		return batch
	}

	#flushCommitBatch(batch: CommitBatch): void {
		if (this.#commitBatch !== batch) {
			return
		}
		this.#commitBatch = undefined
		void this.#commitOffsets(batch.messages).then(
			batch.completion.resolve,
			batch.completion.reject
		)
	}

	async #commitOffsets(messages: TopicMessage[]): Promise<void> {
		if (this.#lastError !== undefined) {
			throw this.#lastError
		}
		if (this.#chunks.isClosed || this.#closing) {
			throw new Error('Reader is closed — cannot commit')
		}

		// Commits are independent per partition. A stopped session in a mixed batch
		// must not suppress a live partition: skipping its range creates a permanent
		// gap that prevents every later commit watermark from advancing.
		let messagesByPartition = new Map<string | symbol, TopicMessage[]>()
		for (let message of messages) {
			let session = message.partitionSession.deref()
			let key = session
				? partitionKey(session.topicPath, session.partitionId)
				: Symbol('expired partition session')
			let partitionMessages = messagesByPartition.get(key)
			if (partitionMessages === undefined) {
				partitionMessages = []
				messagesByPartition.set(key, partitionMessages)
			}
			partitionMessages.push(message)
		}

		let byPartition = new Map<string, OffsetRange[]>()
		let errors: unknown[] = []
		for (let partitionMessages of messagesByPartition.values()) {
			try {
				for (let [key, ranges] of buildCommitRanges(partitionMessages, (session) =>
					this.#ownedSessions.has(session)
				)) {
					byPartition.set(key, ranges)
				}
			} catch (error) {
				errors.push(error)
			}
		}

		// One waiter per partition; the call resolves only when every partition's
		// offsets are acknowledged. Sessions of one partition share the stable
		// partitionKey, so a batch spanning a re-grant still lands on one waiter.
		let promises: Promise<void>[] = []
		for (let [key, ranges] of byPartition) {
			let waiterId = this.#nextWaiterId++
			let waiter = Promise.withResolvers<void>()
			this.#waiters.set(waiterId, waiter)
			this.#runtime.machine.dispatch({
				type: 'reader.commit',
				partitionKey: key,
				ranges,
				waiterId,
			})
			promises.push(waiter.promise)
		}

		// Settle every valid partition before reporting invalid ones so a rejected
		// call never leaves hidden commit work running behind the caller.
		let results = await Promise.allSettled(promises)
		for (let result of results) {
			if (result.status === 'rejected') {
				errors.push(result.reason)
			}
		}
		if (errors.length === 1) {
			throw errors[0]
		}
		if (errors.length > 1) {
			throw new AggregateError(errors, 'Cannot commit one or more partitions')
		}
	}

	// ── internals ────────────────────────────────────────────────────────────────

	async #consume(): Promise<void> {
		for await (let output of this.#runtime.machine) {
			switch (output.type) {
				case 'reader.messages': {
					// tx read-offset tracking happens at read() yield time, not here — a tx
					// must never bind offsets of messages the consumer never saw.
					if (this.#lastError !== undefined) break
					let messages: Chunk['messages'] = []
					for (let group of output.groups) {
						for (let message of group.messages) {
							messages.push({ ...message, session: group.session })
						}
					}
					this.#bufferedBytes += output.releaseBytes
					publishBufferChanged(this.#scope, this.#bufferedBytes)
					this.#chunks.push({ messages, releaseBytes: output.releaseBytes })
					break
				}

				case 'reader.partition.started':
					this.#ownedSessions.add(output.session)
					publishPartitionStarted(
						this.#scope,
						output.partitionId,
						output.partitionSessionId,
						output.committedOffset
					)
					break

				case 'reader.partition.stopped': {
					// For a graceful stop the runtime already ran onPartitionSessionStop as
					// the awaited pre-response hook (the session was still committable) —
					// invoking it again here would double-notify. Forced stops and
					// end-of-partition are after-the-fact notifications.
					if (
						(output.reason === 'lost' || output.reason === 'ended') &&
						this.#callbacks.onPartitionSessionStop
					) {
						// Callback errors are logged via dbg and ignored — a throwing user
						// callback must never break the machine. Async rejections are caught
						// the same way.
						try {
							Promise.resolve(
								this.#callbacks.onPartitionSessionStop(
									output.session,
									output.session.partitionCommittedOffset
								)
							).catch((error) => dbg.log('onPartitionSessionStop threw: %O', error))
						} catch (error) {
							dbg.log('onPartitionSessionStop threw: %O', error)
						}
					}
					publishPartitionStopped(this.#scope, output.partitionId, output.reason)
					break
				}

				case 'reader.partition.committed': {
					// Every server-confirmed advance reports here — commit acks, the
					// watermark carried by a stop request, and commitOffset overrides alike;
					// also for ended/stopped partitions (a consumer tracking offsets
					// externally needs the final ack).
					if (this.#callbacks.onCommittedOffset) {
						// Callback errors are logged via dbg and ignored — a throwing user
						// callback must never break the machine.
						try {
							this.#callbacks.onCommittedOffset(
								output.session,
								output.committedOffset
							)
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
					this.#discardBuffers()
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
		if (!this.#chunks.isClosed) {
			this.#fail(
				this.#runtime.machine.signal.reason ?? new Error('Reader stopped unexpectedly')
			)
		}
	}

	#markClosed(): void {
		if (this.#lastError !== undefined) {
			this.#txReadOffsets?.clear()
			this.#discardBuffers()
		} else {
			this.#chunks.close()
			if (this.#bufferedBytes === 0n) this.#codecs = defaultCodecMap
		}
		this.#callbacks = {}
		// #txReadOffsets is deliberately kept: a tx reader closed before the tx commits
		// still binds the offsets it delivered — clearing here would silently commit
		// the transaction with no offsets and redeliver everything after it.
		// The FSM's terminate() already rejects outstanding commits via
		// reader.commit.rejected; this settles any that slipped through, avoiding leaks.
		for (let waiter of this.#waiters.values()) {
			waiter.reject(this.#lastError ?? new Error('Reader closed'))
		}
		this.#waiters.clear()
		this.#closedDeferred.resolve()
	}

	#fail(error: unknown): void {
		this.#lastError ??= error
		this.#markClosed()
	}

	#discardBuffers(): void {
		this.#chunks.destroy()
		for (let chunk of this.#carry) chunk.messages.length = 0
		this.#carry.length = 0
		this.#codecs = defaultCodecMap
		if (this.#bufferedBytes !== 0n) {
			this.#bufferedBytes = 0n
			publishBufferChanged(this.#scope, 0n)
		}
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
