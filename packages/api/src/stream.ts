import { once } from 'node:events'

import type {
	ClientDuplexStream,
	ClientReadableStream,
	ClientUnaryCall,
	ClientWritableStream,
	requestCallback,
} from '@grpc/grpc-js'

import type { ClientCallOptions } from './client.js'

function observe(call: ClientUnaryCall, options: ClientCallOptions): void {
	// Cancellation can emit an error after the consumer has returned.
	call.on('error', () => {})
	if (options.onHeader) {
		call.on('metadata', options.onHeader)
	}
	if (options.onTrailer) {
		call.on('status', (status) => options.onTrailer!(status.metadata))
	}
}

export function unaryCall<Response>(
	start: (callback: requestCallback<Response>) => ClientUnaryCall | ClientWritableStream<unknown>,
	options: ClientCallOptions,
	input?: AsyncIterable<unknown>
): Promise<Response> {
	return new Promise((resolve, reject) => {
		let signal = options.signal
		if (signal?.aborted) {
			reject(signal.reason)
			return
		}

		let call: ClientUnaryCall | ClientWritableStream<unknown> | undefined
		let writing = input ? new AbortController() : undefined
		let settled = false
		let cleanup = () => {
			settled = true
			signal?.removeEventListener('abort', onAbort)
			writing?.abort()
		}
		let fail = (error: unknown) => {
			if (settled) {
				return
			}

			cleanup()
			reject(error)
			call?.cancel()
		}
		let onAbort = () => fail(signal?.reason)
		signal?.addEventListener('abort', onAbort, { once: true })

		try {
			call = start((error, response) => {
				if (settled) {
					return
				}

				cleanup()
				if (error) {
					reject(error)
				} else {
					resolve(response!)
				}
			})
			observe(call, options)
			if (signal?.aborted) {
				onAbort()
				call.cancel()
			}
			if (input && !settled) {
				void writeInput(
					input,
					call as ClientWritableStream<unknown>,
					writing!.signal
				).catch(fail)
			}
		} catch (error) {
			fail(error)
		}
	})
}

export async function* readCall<Response>(
	start: () => ClientReadableStream<Response> | ClientDuplexStream<unknown, Response>,
	options: ClientCallOptions,
	input?: AsyncIterable<unknown>
): AsyncGenerator<Response, void, undefined> {
	let signal = options.signal
	signal?.throwIfAborted()

	let call = start()
	let writing = input ? new AbortController() : undefined
	let inputFailed = false
	let inputError: unknown
	let onAbort = () => {
		writing?.abort()
		call.cancel()
	}
	observe(call, options)
	if (writing) {
		call.once('status', () => writing.abort())
	}
	signal?.addEventListener('abort', onAbort, { once: true })

	try {
		signal?.throwIfAborted()
		if (input) {
			void writeInput(
				input,
				call as ClientDuplexStream<unknown, Response>,
				writing!.signal
			).catch((error) => {
				if (!writing!.signal.aborted) {
					inputFailed = true
					inputError = error
					call.cancel()
				}
			})
		}

		for await (let response of call) {
			signal?.throwIfAborted()
			if (inputFailed) {
				throw inputError
			}

			yield response
		}
		signal?.throwIfAborted()
		if (inputFailed) {
			throw inputError
		}
	} catch (error) {
		signal?.throwIfAborted()
		if (inputFailed) {
			throw inputError
		}
		throw error
	} finally {
		signal?.removeEventListener('abort', onAbort)
		writing?.abort()
		call.cancel()
	}
}

async function writeInput<Request>(
	input: AsyncIterable<Request>,
	call: ClientWritableStream<Request>,
	signal: AbortSignal
): Promise<void> {
	signal.throwIfAborted()
	let iterator = input[Symbol.asyncIterator]()
	let completed = false
	let closeInput = () => {
		if (completed) {
			return
		}

		completed = true
		try {
			// A producer's pending next() may prevent return() from ever settling.
			void Promise.resolve(iterator.return?.()).catch(() => {})
		} catch {
			// The RPC's failure or cancellation already determines its result.
		}
	}
	signal.addEventListener('abort', closeInput, { once: true })

	try {
		while (true) {
			signal.throwIfAborted()
			// oxlint-disable-next-line no-await-in-loop
			let item = await iterator.next()
			signal.throwIfAborted()
			if (item.done) {
				completed = true
				call.end()
				return
			}

			if (!call.write(item.value)) {
				// oxlint-disable-next-line no-await-in-loop
				await once(call, 'drain', { signal })
			}
		}
	} finally {
		signal.removeEventListener('abort', closeInput)
		closeInput()
	}
}
