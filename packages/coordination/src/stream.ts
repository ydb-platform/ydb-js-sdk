import { abortable } from '@ydbjs/abortable'
import { loggers } from '@ydbjs/debug'

let dbg = loggers.driver.extend('coordination').extend('stream')

/**
 * Pending request waiting for response
 */
interface PendingRequest<T, TRequest> {
	resolve: (value: T | null) => void
	reject: (error: Error) => void
	request: TRequest
}

/**
 * Async queue that can be used as AsyncIterable
 */
class AsyncQueue<T> implements AsyncIterable<T> {
	#queue: T[] = []
	#waiter: (() => void) | null = null
	#closed: boolean = false

	push(item: T): void {
		if (this.#closed) {
			throw new Error('Queue is closed')
		}
		this.#queue.push(item)
		if (this.#waiter) {
			this.#waiter()
			this.#waiter = null
		}
	}

	close(): void {
		this.#closed = true
		if (this.#waiter) {
			this.#waiter()
			this.#waiter = null
		}
	}

	get isClosed(): boolean {
		return this.#closed
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (!this.#closed || this.#queue.length > 0) {
			if (this.#queue.length > 0) {
				yield this.#queue.shift()!
			} else if (!this.#closed) {
				// eslint-disable-next-line no-await-in-loop
				await new Promise<void>((resolve) => {
					this.#waiter = resolve
				})
			}
		}
	}
}

/**
 * Generic bidirectional stream handler
 *
 * Manages request/response flow for gRPC bidirectional streaming:
 * - Sends requests through an async queue
 * - Processes responses in background
 * - Matches responses to requests by ID
 * - Handles errors and cleanup
 */
export class BidirectionalStream<TRequest, TResponse, TResult = TResponse> {
	#responseStream: AsyncIterable<TResponse> | null = null
	#requestQueue: AsyncQueue<TRequest> = new AsyncQueue<TRequest>()
	#pendingRequests = new Map<bigint, PendingRequest<TResult, TRequest>>()
	#fireAndForgetRequests: TRequest[] = []
	#processorPromise: Promise<void> | null = null
	#abortController: AbortController | null = null
	#closed: boolean = false

	// Callbacks for handling different aspects
	#onResponse: (response: TResponse) => void
	#extractReqId: (response: TResponse) => bigint | null
	#extractResult: (response: TResponse) => TResult | null

	constructor(options: {
		/**
		 * Callback to handle each response
		 */
		onResponse: (response: TResponse) => void

		/**
		 * Extract request ID from response (for matching)
		 */
		extractReqId: (response: TResponse) => bigint | null

		/**
		 * Extract result from response (for resolving promises)
		 */
		extractResult: (response: TResponse) => TResult | null
	}) {
		this.#onResponse = options.onResponse
		this.#extractReqId = options.extractReqId
		this.#extractResult = options.extractResult
	}

	/**
	 * Starts the bidirectional stream
	 */
	start(
		createStream: (
			requests: AsyncIterable<TRequest>,
			signal?: AbortSignal
		) => AsyncIterable<TResponse>,
		initialRequest: TRequest,
		signal?: AbortSignal
	): void {
		dbg.log('starting bidirectional stream')

		// In case of reconnecting reopen stream
		this.#closed = false

		// Create fresh request queue for this stream
		this.#requestQueue = new AsyncQueue<TRequest>()

		this.#abortController = new AbortController()

		// If external signal provided, forward abort to our controller
		if (signal) {
			signal.addEventListener('abort', () =>
				this.#abortController?.abort()
			)
		}

		this.#requestQueue.push(initialRequest)

		// Create bidirectional stream with request queue
		this.#responseStream = createStream(
			this.#requestQueue,
			this.#abortController.signal
		)

		// Start background response processor
		this.#processorPromise = this.#processResponses()

		// Retry pending requests from previous stream in case of reconnecting
		if (this.#pendingRequests.size > 0) {
			dbg.log('retrying %d pending requests', this.#pendingRequests.size)
			for (let [reqId, pending] of this.#pendingRequests) {
				try {
					this.#requestQueue.push(pending.request)
					dbg.log('retried request: %s: %O', reqId, pending.request)
				} catch (error) {
					dbg.log('failed to retry request %s: %O', reqId, error)
				}
			}
		}

		// Retry fire-and-forget requests from previous stream
		if (this.#fireAndForgetRequests.length > 0) {
			dbg.log(
				'retrying %d fire-and-forget requests',
				this.#fireAndForgetRequests.length
			)
			for (let request of this.#fireAndForgetRequests) {
				try {
					this.#requestQueue.push(request)
					dbg.log('retried fire-and-forget request: %O', request)
				} catch (error) {
					dbg.log(
						'failed to retry fire-and-forget request: %O',
						error
					)
				}
			}
			this.#fireAndForgetRequests = []
		}

		dbg.log('bidirectional stream started')
	}

	/**
	 * Processes responses from the server
	 */
	async #processResponses(): Promise<void> {
		if (!this.#responseStream) {
			throw new Error('Response stream not initialized')
		}

		try {
			for await (let response of this.#responseStream) {
				if (this.#closed) {
					break
				}

				// Call response handler (may throw to trigger reconnection)
				this.#onResponse(response)

				// Try to match response to pending request
				let reqId = this.#extractReqId(response)
				if (reqId !== null) {
					let pendingRequest = this.#pendingRequests.get(reqId)
					if (pendingRequest) {
						this.#pendingRequests.delete(reqId)

						// Wrap extractResult in try-catch to properly reject the request promise on error
						try {
							pendingRequest.resolve(
								this.#extractResult(response)
							)
						} catch (error) {
							pendingRequest.reject(
								error instanceof Error
									? error
									: new Error(String(error))
							)
						}
					}
				}
			}
		} catch (error) {
			dbg.log('error processing responses: %O', error)
			this.#closed = true
			this.#requestQueue.close()
			if (this.#abortController) {
				this.#abortController.abort()
				this.#abortController = null
			}
		}
	}

	/**
	 * Sends a request and waits for response
	 *
	 * @param reqId - Unique request identifier
	 * @param request - Request to send
	 * @param signal - Optional AbortSignal to cancel the operation
	 *
	 * Note: Aborting removes the request from retry queue, but if the request
	 * was already sent to the server, it may still be processed.
	 */
	async sendRequest(
		reqId: bigint,
		request: TRequest,
		signal?: AbortSignal
	): Promise<TResult | null> {
		dbg.log('sending request with reqId: %s', reqId)

		let resultPromise = new Promise<TResult | null>((resolve, reject) => {
			this.#pendingRequests.set(reqId, { resolve, reject, request })
		})

		// During reconnection queue may be closed
		// request will be retried after reconnection in start method
		if (!this.#requestQueue.isClosed) {
			this.#requestQueue.push(request)
		}

		// If signal provided, wrap with abortable and cleanup on abort
		if (signal) {
			try {
				return await abortable(signal, resultPromise)
			} catch (error) {
				let pending = this.#pendingRequests.get(reqId)
				if (pending) {
					this.#pendingRequests.delete(reqId)
					pending.reject(error as Error)
					dbg.log('request %s aborted by signal', reqId)
				}
			}
		}

		return resultPromise
	}

	/**
	 * Sends a request without waiting for response (fire-and-forget)
	 *
	 * Request will be retried after reconnection if queue is closed.
	 */
	send(request: TRequest): void {
		if (!this.#requestQueue.isClosed) {
			this.#requestQueue.push(request)
		} else {
			// Queue is closed during reconnection - save for retry
			this.#fireAndForgetRequests.push(request)
			dbg.log('queued fire-and-forget request for retry')
		}
	}

	/**
	 * Waits for processor to finish and cleans up
	 */
	async #waitForProcessor(): Promise<void> {
		if (this.#processorPromise) {
			await this.#processorPromise
		}
	}

	/**
	 * Closes the stream
	 */
	async close(): Promise<void> {
		if (this.#closed) {
			return
		}

		dbg.log('closing bidirectional stream')

		this.#closed = true
		this.#requestQueue.close()

		// Abort the stream to unblock processor
		if (this.#abortController) {
			this.#abortController.abort()
			this.#abortController = null
		}

		// Reject all pending requests - stream is being closed explicitly
		for (let [_, pendingRequest] of this.#pendingRequests) {
			pendingRequest.reject(new Error('Stream closed'))
		}
		this.#pendingRequests.clear()
		this.#fireAndForgetRequests = []

		// Wait for processor to finish
		await this.#waitForProcessor()
		this.#processorPromise = null
		this.#responseStream = null

		dbg.log('bidirectional stream closed')
	}

	/**
	 * Waits for the stream to close
	 */
	async waitForClose(): Promise<void> {
		if (this.#closed) {
			return
		}

		await this.#waitForProcessor()
	}

	/**
	 * Forces stream disconnection by aborting the current stream
	 *
	 * This triggers reconnection logic in the connection loop.
	 * Pending requests are preserved and will be retried on reconnect.
	 *
	 * @internal This method is intended for testing purposes only
	 */
	forceDisconnect(): void {
		if (this.#closed) {
			return
		}

		dbg.log('forcing stream disconnect via abort')

		// Abort the stream - this will cause #processResponses to throw
		// which closes the queue and preserves pending requests for retry
		if (this.#abortController) {
			this.#abortController.abort()
		}
	}
}
