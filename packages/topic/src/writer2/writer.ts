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
			this.#seqNoManager.initialize(event.lastSeqNo)
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
	 * @returns Sequence number of the message
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
		})

		return seqNo
	}

	/**
	 * Flush all buffered messages and wait for acknowledgment
	 * @param signal Optional AbortSignal to cancel the flush operation
	 * @returns Promise that resolves with the last acknowledged sequence number
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
	 */ get stats() {
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
		}
	}

	/**
	 * Close the writer gracefully, waiting for all messages to be sent
	 */
	async close(signal?: AbortSignal): Promise<void> {
		let { promise, resolve } = Promise.withResolvers<void>()
		let subscription = this.#actor.subscribe((snapshot) => {
			if (snapshot.value === 'closed') {
				resolve()
			}
		})

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
		await this.close()
		this.destroy()
	}
}
