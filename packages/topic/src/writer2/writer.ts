import { type ActorRefFrom, type Subscription, createActor } from 'xstate'
import type { Driver } from '@ydbjs/core'
import { abortable } from '@ydbjs/abortable'
import { WriterMachine } from './machine.js'
import { SeqNoManager } from './seqno-manager.js'
import type { TopicWriterOptions } from './types.js'

export class TopicWriter implements AsyncDisposable {
	#actor: ActorRefFrom<typeof WriterMachine>
	#promise: ReturnType<typeof Promise.withResolvers<bigint>> | null = null
	#subscription: Subscription
	#seqNoManager: SeqNoManager
	#isSessionInitialized = false

	constructor(driver: Driver, options: TopicWriterOptions) {
		this.#seqNoManager = new SeqNoManager()
		this.#actor = createActor(WriterMachine, { input: { driver, options } })

		// Subscribe to state changes for flush completions
		this.#subscription = this.#actor.subscribe((snapshot) => {
			// When all messages are processed (buffer and inflight empty),
			// resolve current flush promise if it exists
			if (
				snapshot.context.bufferLength === 0 &&
				snapshot.context.inflightLength === 0
			) {
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

	/**
	 * Write a message to the topic
	 * @param data Message payload
	 * @param extra Optional message metadata
	 */
	write(
		data: Uint8Array,
		extra?: {
			seqNo?: bigint
			createdAt?: Date
			metadataItems?: Record<string, Uint8Array>
		}
	): void {
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
				...(extra?.metadataItems && {
					metadataItems: extra.metadataItems,
				}),
			},
			seqNoMode,
		})
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
	 * **Getting final seqNo for messages:**
	 * After `flush()` completes, all seqNo values up to the returned `lastSeqNo` are final.
	 * If you need to track individual messages, you can:
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
		if (
			snapshot.context.bufferLength === 0 &&
			snapshot.context.inflightLength === 0
		) {
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
	 * @returns true if session is initialized, false otherwise
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
