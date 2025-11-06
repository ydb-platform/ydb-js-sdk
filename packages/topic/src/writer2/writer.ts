import { type ActorRefFrom, type Subscription, createActor } from 'xstate'
import type { Driver } from '@ydbjs/core'
import { abortable } from '@ydbjs/abortable'
import { WriterMachine } from './machine.js'
import { SeqNoManager } from './seqno-manager.js'
import type { SeqNoShiftEvent, TopicWriterOptions } from './types.js'

type SeqNoShiftSegment = {
	start: bigint
	end: bigint
	delta: bigint
}

export class TopicWriter implements AsyncDisposable {
	#actor: ActorRefFrom<typeof WriterMachine>
	#promise: ReturnType<typeof Promise.withResolvers<bigint>> | null = null
	#subscription: Subscription
	#seqNoManager: SeqNoManager
	#isSessionInitialized = false
	#seqNoShifts: SeqNoShiftSegment[] = []

	constructor(driver: Driver, options: TopicWriterOptions) {
		this.#seqNoManager = new SeqNoManager()
		this.#actor = createActor(WriterMachine, { input: { driver, options } })

		// Subscribe to state changes for flush completions
		this.#subscription = this.#actor.subscribe((snapshot) => {
			// When all messages are processed (buffer and inflight empty),
			// resolve current flush promise if it exists
			if (snapshot.context.bufferLength === 0 && snapshot.context.inflightLength === 0) {
				this.#promise?.resolve(this.#seqNoManager.getState().lastSeqNo)
				this.#promise = null
			}
		})

		// Subscribe to emitted events for seqNo management
		this.#actor.on('writer.session', (event) => {
			// State machine already recalculated seqno for all buffered messages
			// event.nextSeqNo is the next seqno that should be used for new messages
			// So lastSeqNo for SeqNoManager should be nextSeqNo - 1
			let lastSeqNo = event.nextSeqNo - 1n
			if (event.seqNoShifts?.length) {
				this.#applySeqNoShifts(event.seqNoShifts)
			}
			this.#seqNoManager.initialize(lastSeqNo)
			this.#isSessionInitialized = true
		})

		// Subscribe to error events
		this.#actor.on('writer.error', (event) => {
			// Reject any pending flush promise
			this.#promise?.reject(event.error)
			this.#promise = null
		})

		// Note: We don't update lastSeqNo from MESSAGES_ACKNOWLEDGED
		// ACKs are just confirmations for messages we already sent
		// lastSeqNo is managed internally when write() is called

		this.#actor.start()
	}

	#applySeqNoShifts(shifts: SeqNoShiftEvent[]): void {
		for (let shift of shifts) {
			this.#applySeqNoShift(shift.startOld, shift.count, shift.delta)
		}
	}

	#applySeqNoShift(startOld: bigint, count: number, delta: bigint): void {
		if (!count || delta === 0n) {
			return
		}

		let oldEnd = startOld + BigInt(count)
		let updatedSegments: SeqNoShiftSegment[] = []
		let coveredOldRanges: Array<{ start: bigint; end: bigint }> = []

		for (let segment of this.#seqNoShifts) {
			let segStart = segment.start
			let segEnd = segment.end
			let segDelta = segment.delta

			let intersectionStart = segStart > startOld - segDelta ? segStart : startOld - segDelta
			let intersectionEnd = segEnd < oldEnd - segDelta ? segEnd : oldEnd - segDelta

			if (intersectionStart < intersectionEnd) {
				if (segStart < intersectionStart) {
					updatedSegments.push({ start: segStart, end: intersectionStart, delta: segDelta })
				}

				updatedSegments.push({ start: intersectionStart, end: intersectionEnd, delta: segDelta + delta })

				if (intersectionEnd < segEnd) {
					updatedSegments.push({ start: intersectionEnd, end: segEnd, delta: segDelta })
				}

				let coveredStartOld = intersectionStart + segDelta
				let coveredEndOld = intersectionEnd + segDelta
				coveredOldRanges.push({ start: coveredStartOld, end: coveredEndOld })
			} else {
				updatedSegments.push({ ...segment })
			}
		}

		this.#seqNoShifts = this.#mergeShiftSegments(updatedSegments)

		let mergedCovered = this.#mergeRanges(coveredOldRanges, startOld, oldEnd)
		let uncovered = this.#invertRanges(mergedCovered, startOld, oldEnd)
		for (let range of uncovered) {
			this.#seqNoShifts.push({ start: range.start, end: range.end, delta })
		}

		this.#seqNoShifts = this.#mergeShiftSegments(this.#seqNoShifts)
	}

	#mergeShiftSegments(segments: SeqNoShiftSegment[]): SeqNoShiftSegment[] {
		if (!segments.length) {
			return []
		}

		let sorted: SeqNoShiftSegment[] = []
		for (let segment of segments) {
			let entry = { ...segment }
			let insertIndex = 0
			while (insertIndex < sorted.length && sorted[insertIndex]!.start <= entry.start) {
				insertIndex++
			}
			sorted.splice(insertIndex, 0, entry)
		}

		let merged: SeqNoShiftSegment[] = []

		for (let segment of sorted) {
			let last = merged[merged.length - 1]
			if (!last) {
				merged.push({ ...segment })
				continue
			}

			if (segment.start <= last.end) {
				if (segment.delta === last.delta) {
					if (segment.end > last.end) {
						last.end = segment.end
					}
					continue
				}

				if (segment.start < last.end) {
					let adjustedStart = last.end
					if (adjustedStart < segment.end) {
						merged.push({ start: adjustedStart, end: segment.end, delta: segment.delta })
					}
					continue
				}
			}

			if (segment.start === last.end && segment.delta === last.delta) {
				last.end = segment.end
			} else {
				merged.push({ ...segment })
			}
		}

		return merged
	}

	#mergeRanges(
		ranges: Array<{ start: bigint; end: bigint }>,
		boundStart: bigint,
		boundEnd: bigint
	): Array<{ start: bigint; end: bigint }> {
		if (!ranges.length) {
			return []
		}

		let filtered = ranges
			.map((range) => {
				let start = range.start > boundStart ? range.start : boundStart
				let end = range.end < boundEnd ? range.end : boundEnd
				return start < end ? { start, end } : null
			})
			.filter((range): range is { start: bigint; end: bigint } => Boolean(range))

		if (!filtered.length) {
			return []
		}

		let sorted: Array<{ start: bigint; end: bigint }> = []
		for (let range of filtered) {
			let entry = { ...range }
			let insertIndex = 0
			while (insertIndex < sorted.length && sorted[insertIndex]!.start <= entry.start) {
				insertIndex++
			}
			sorted.splice(insertIndex, 0, entry)
		}

		let merged: Array<{ start: bigint; end: bigint }> = []

		for (let range of sorted) {
			let last = merged[merged.length - 1]
			if (!last) {
				merged.push({ ...range })
				continue
			}

			if (range.start <= last.end) {
				if (range.end > last.end) {
					last.end = range.end
				}
			} else {
				merged.push({ ...range })
			}
		}

		return merged
	}

	#invertRanges(
		ranges: Array<{ start: bigint; end: bigint }>,
		boundStart: bigint,
		boundEnd: bigint
	): Array<{ start: bigint; end: bigint }> {
		if (boundStart >= boundEnd) {
			return []
		}

		if (!ranges.length) {
			return [{ start: boundStart, end: boundEnd }]
		}

		let result: Array<{ start: bigint; end: bigint }> = []
		let cursor = boundStart

		for (let range of ranges) {
			if (cursor < range.start) {
				result.push({ start: cursor, end: range.start })
			}
			if (cursor < range.end) {
				cursor = range.end
			}
		}

		if (cursor < boundEnd) {
			result.push({ start: cursor, end: boundEnd })
		}

		return result
	}

	/**
	 * Write a message to the topic
	 * @param data Message payload
	 * @param extra Optional message metadata
	 * @returns Sequence number of the message
	 *
	 * **⚠️ WARNING: Do NOT rely on returned seqNo for critical operations!**
	 *
	 * The returned seqNo may be a temporary value that gets recalculated after session initialization.
	 * This can lead to incorrect behavior if used for:
	 * - Message deduplication
	 * - Tracking message delivery
	 * - Database lookups by seqNo
	 * - Any operation that requires accurate seqNo values
	 *
	 * **When seqNo is temporary:**
	 * - Session is not yet initialized (first messages written before connection)
	 * - Writer reconnected after network issues
	 * - Auto-generated seqNo mode (not user-provided)
	 *
	 * **When seqNo is final:**
	 * - User-provided seqNo (via `extra.seqNo`) - always final, never recalculated
	 * - After `flush()` completes - all messages have been sent with final seqNo
	 *
	 * **Recommended usage:**
	 * ```typescript
	 * // ❌ BAD: Storing seqNo immediately
	 * let seqNo = writer.write(data)
	 * await saveToDatabase(seqNo) // May be wrong!
	 *
	 * // ✅ GOOD: Wait for flush to ensure seqNo is final
	 * writer.write(data)
	 * let lastSeqNo = await writer.flush() // All messages up to this seqNo are final
	 * await saveToDatabase(lastSeqNo)
	 *
	 * // ✅ GOOD: Use user-provided seqNo (always final)
	 * let mySeqNo = 100n
	 * writer.write(data, { seqNo: mySeqNo })
	 * // mySeqNo is guaranteed to be final
	 * ```
	 */
	write(
		data: Uint8Array,
		extra?: {
			seqNo?: bigint
			createdAt?: Date
			metadataItems?: Record<string, Uint8Array>
		}
	): bigint {
		// Get seqNo from SeqNoManager (handles auto/manual modes)
		let seqNo = this.#seqNoManager.getNext(extra?.seqNo)
		let seqNoState = this.#seqNoManager.getState()
		// Determine mode for state machine (if not yet determined, determine it now)
		let seqNoMode: 'auto' | 'manual' | undefined =
			seqNoState.mode ?? (extra?.seqNo !== undefined ? 'manual' : 'auto')

		this.#actor.send({
			type: 'writer.write',
			message: {
				data,
				seqNo,
				...(extra?.createdAt && { createdAt: extra.createdAt }),
				...(extra?.metadataItems && { metadataItems: extra.metadataItems }),
			},
			seqNoMode,
		})

		return seqNo
	}

	/**
	 * Resolve final seqNo for a message that was written before session initialization
	 * or was retried after reconnection.
	 *
	 * @param initialSeqNo Temporary seqNo returned by write()
	 * @returns Final seqNo assigned after session re-initialization
	 */
	resolveSeqNo(initialSeqNo: bigint): bigint {
		for (let segment of this.#seqNoShifts) {
			if (initialSeqNo >= segment.start && initialSeqNo < segment.end) {
				return initialSeqNo + segment.delta
			}
		}

		return initialSeqNo
	}

	/**
	 * Flush all buffered messages and wait for acknowledgment
	 * @param signal Optional AbortSignal to cancel the flush operation
	 * @returns Promise that resolves with the last acknowledged sequence number
	 *
	 * **Important:** After `flush()` completes, all messages written before this call
	 * have been sent to the server with their final seqNo values. This is the safe way
	 * to ensure seqNo accuracy for critical operations like deduplication or tracking.
	 *
	 * **Getting final seqNo for specific messages:**
	 * After `flush()` completes, all seqNo values up to the returned `lastSeqNo` are final.
	 * If you need to track individual messages, you can:
	 * - Call `writer.resolveSeqNo(initialSeqNo)` to translate temporary numbers into final ones
	 * - Use the order of `write()` calls to determine final seqNo (sequential after flush)
	 * - Use user-provided seqNo (always final, never recalculated)
	 */
	async flush(signal?: AbortSignal): Promise<bigint> {
		// If there's already a flush in progress, return the same promise
		if (this.#promise) {
			// If signal is provided, wrap existing promise with abortable
			if (signal) {
				return abortable(signal, this.#promise.promise)
			}

			return this.#promise.promise
		}

		// Check if already flushed
		let snapshot = this.#actor.getSnapshot()
		if (snapshot.context.bufferLength === 0 && snapshot.context.inflightLength === 0) {
			// Already flushed, return immediately
			return Promise.resolve(this.#seqNoManager.getState().lastSeqNo)
		}

		// Create new flush promise using Promise.withResolvers()
		this.#promise = Promise.withResolvers<bigint>()

		// Send flush request to state machine
		this.#actor.send({ type: 'writer.flush' })

		// If signal is provided, wrap with abortable
		if (signal) {
			return abortable(signal, this.#promise.promise)
		}

		return this.#promise.promise
	}

	/**
	 * Get current writer statistics
	 */
	get stats() {
		let snapshot = this.#actor.getSnapshot()
		let seqNoState = this.#seqNoManager.getState()

		return {
			state: snapshot.value,
			lastSeqNo: seqNoState.lastSeqNo,
			nextSeqNo: seqNoState.nextSeqNo,
			seqNoMode: seqNoState.mode,
			bufferSize: snapshot.context.bufferSize,
			bufferLength: snapshot.context.bufferLength,
			inflightSize: snapshot.context.inflightSize,
			inflightLength: snapshot.context.inflightLength,
			isSessionInitialized: this.#isSessionInitialized,
		}
	}

	/**
	 * Check if the writer session is initialized
	 * @returns true if session is initialized and seqNo values are final, false if they may be temporary
	 *
	 * **Usage:**
	 * ```typescript
	 * let seqNo = writer.write(data)
	 * if (!writer.isSessionInitialized) {
	 *   // seqNo may be temporary, wait for flush before using it
	 *   await writer.flush()
	 * }
	 * ```
	 */
	get isSessionInitialized(): boolean {
		return this.#isSessionInitialized
	}

	/**
	 * Close the writer gracefully, waiting for all messages to be sent
	 */
	async close(signal?: AbortSignal): Promise<void> {
		let snapshot = this.#actor.getSnapshot()

		// If already closed, return immediately
		if (snapshot.value === 'closed') {
			return
		}

		// If actor is stopped, return immediately
		if (snapshot.status === 'stopped') {
			return
		}

		let { promise, resolve } = Promise.withResolvers<void>()
		let subscription = this.#actor.subscribe((snapshot) => {
			if (snapshot.value === 'closed' || snapshot.status === 'stopped') {
				resolve()
			}
		})

		// Check again before sending (actor might have stopped between checks)
		snapshot = this.#actor.getSnapshot()
		if (snapshot.value === 'closed' || snapshot.status === 'stopped') {
			subscription.unsubscribe()
			return
		}

		this.#actor.send({ type: 'writer.close' })

		return (signal ? abortable(signal, promise) : promise).finally(() => {
			subscription.unsubscribe()
		})
	}

	/**
	 * Destroy the writer immediately without waiting
	 */
	destroy(reason?: Error): void {
		// Reject any pending flush
		this.#promise?.reject(new Error('Writer was destroyed'))
		this.#promise = null
		this.#seqNoShifts = []

		// Send destroy event (optional - for cleanup logic)
		this.#actor.send({ type: 'writer.destroy', ...(reason && { reason }) })

		// Immediately stop the actor
		this.#actor.stop()

		// Clean up subscription
		this.#subscription.unsubscribe()
	}

	/**
	 * AsyncDisposable implementation - graceful close with resource cleanup
	 */
	async [Symbol.asyncDispose](): Promise<void> {
		// Try graceful close first
		try {
			await this.close()
		} catch (error) {
			// If close fails, force destroy
			this.destroy(error as Error)
			throw error
		}
		// After successful close, the actor is already stopped in closed state
		// Just clean up subscription
		this.#subscription.unsubscribe()
	}
}
