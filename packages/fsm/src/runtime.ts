import { linkSignals } from '@ydbjs/abortable'

import { AsyncQueue } from './queue.js'
import type {
	EffectRuntime,
	IngestHandle,
	MachineEffect,
	MachineEvent,
	MachineRuntime,
	RuntimeOptions,
	TransitionRuntime,
} from './types.js'

type InternalEventEnvelope<E> = {
	event: E
}

class Runtime<
	S,
	LC extends object,
	RC extends object,
	E extends MachineEvent,
	FX extends MachineEffect,
	O,
>
	implements MachineRuntime<S, LC, E, O>, EffectRuntime<S, E, O>
{
	#ac = new AbortController()

	#state: S
	#ctx: LC & RC
	#effects: RuntimeOptions<S, LC, RC, E, FX, O>['effects']
	#transition: RuntimeOptions<S, LC, RC, E, FX, O>['transition']

	#drainTask: Promise<void> | null = null

	#eventQueue: Array<InternalEventEnvelope<E>> = []
	#outputQueue = new AsyncQueue<O>()

	#closing = false
	#closed = false
	#destroyed = false

	#closeTask: Promise<void> | null = null
	#destroyTask: Promise<void> | null = null

	#stopReason: unknown = null

	constructor(options: RuntimeOptions<S, LC, RC, E, FX, O>) {
		this.#state = options.initialState
		// Merge env into ctx once at construction so both LC and RC fields
		// live on the same object reference. Mutations in effects are reflected immediately.
		this.#ctx = Object.assign(options.ctx, options.env) as unknown as LC & RC
		this.#effects = options.effects
		this.#transition = options.transition
	}

	get state(): S {
		return this.#state
	}

	get ctx(): LC {
		return this.#ctx
	}

	get signal(): AbortSignal {
		return this.#ac.signal
	}

	emit(output: O): void {
		if (this.#outputQueue.isClosed) {
			return
		}

		try {
			this.#outputQueue.push(output)
		} catch {
			// Queue may close concurrently during shutdown — ignore.
		}
	}

	ingest<T>(
		source: AsyncIterable<T>,
		map: (input: T) => E | null,
		signal?: AbortSignal
	): IngestHandle {
		if (this.#closing || this.#closed || this.#destroyed) {
			throw new Error('runtime is not accepting new ingests')
		}

		let ac = new AbortController()
		let task = (async () => {
			using combined = linkSignals(this.#ac.signal, ac.signal, signal)

			try {
				for await (let input of source) {
					if (combined.signal.aborted) {
						return
					}

					if (this.#closing || this.#closed || this.#destroyed) {
						return
					}

					let event = map(input)
					if (event !== null) {
						this.dispatch(event)
					}
				}
			} catch (error) {
				if (combined.signal.aborted) {
					return
				}

				if (this.#closing || this.#closed || this.#destroyed) {
					return
				}

				await this.#handleError(error)
			}
		})()

		let disposed = false

		return {
			async [Symbol.asyncDispose](): Promise<void> {
				if (disposed) {
					return
				}

				disposed = true
				ac.abort(new Error('ingest disposed'))

				await task.catch(() => {
					// Ingest task errors are handled by runtime error path.
				})
			},
		}
	}

	dispatch(event: E): void {
		if (this.#closing || this.#closed || this.#destroyed) {
			return
		}

		this.#eventQueue.push({ event })

		// Drain handles errors internally (via #handleError → destroy).
		// Suppress the rejected promise so Node does not surface it as
		// an unhandled rejection when dispatch is fire-and-forget.
		this.#drain().catch(() => {})
	}

	async close(reason?: unknown): Promise<void> {
		if (this.#closed || this.#destroyed) {
			return
		}

		if (this.#closeTask) {
			await this.#closeTask
			return
		}

		this.#closeTask = (async () => {
			this.#closing = true
			this.#stopReason = reason ?? new Error('runtime closed')

			// Drain first so all outputs emitted during pending transitions
			// are delivered before the output queue is sealed.
			await this.#drain()

			if (this.#destroyed) {
				return
			}

			this.#closed = true
			this.#outputQueue.close()

			// Abort the signal after sealing — ingest loops and signal listeners
			// are notified only once all pending output has been delivered.
			this.#ac.abort(this.#stopReason)
		})()

		await this.#closeTask
	}

	async destroy(reason?: unknown): Promise<void> {
		if (this.#destroyed) {
			return
		}

		if (this.#destroyTask) {
			await this.#destroyTask
			return
		}

		this.#destroyTask = (async () => {
			this.#destroyed = true
			this.#closing = false
			this.#closed = true
			this.#stopReason = reason ?? new Error('runtime destroyed')

			this.#ac.abort(this.#stopReason)

			// Hard shutdown: drop queued events immediately.
			this.#eventQueue.length = 0

			// Close output iterable and release pending iterators.
			this.#outputQueue.close()
		})()

		await this.#destroyTask
	}

	[Symbol.asyncIterator](): AsyncIterator<O> {
		return this.#outputQueue[Symbol.asyncIterator]()
	}

	// Graceful async disposal first, then hard finalization.
	async [Symbol.asyncDispose](): Promise<void> {
		await this.close(new Error('runtime async disposed'))
		await this.destroy(new Error('runtime async disposed'))
	}

	async #drain(): Promise<void> {
		// Loop rather than branch: multiple callers may be waiting on the same
		// drainTask. When it resolves they all wake up simultaneously — the loop
		// ensures each re-checks whether a new task was already started before
		// creating another one.
		while (this.#drainTask) {
			// oxlint-disable-next-line no-await-in-loop
			await this.#drainTask
		}

		if (this.#destroyed || this.#eventQueue.length === 0) {
			return
		}

		this.#drainTask = (async () => {
			try {
				while (this.#eventQueue.length > 0 && !this.#destroyed) {
					let envelope = this.#eventQueue.shift()
					if (!envelope) {
						continue
					}

					let result = this.#transition(
						this.#ctx,
						envelope.event,
						this as TransitionRuntime<S, E, O>
					)

					if (!result) {
						continue
					}

					if (result.state !== undefined) {
						this.#state = result.state
					}

					if (!result.effects || result.effects.length === 0) {
						continue
					}

					for (let effect of result.effects) {
						if (this.#destroyed) {
							return
						}

						let handler = this.#effects[effect.type as FX['type']]
						if (!handler) {
							throw new Error(
								`Missing effect handler for effect type "${effect.type}".`
							)
						}

						// oxlint-disable-next-line no-await-in-loop
						await handler(this.#ctx, effect as never, this)
					}
				}
			} catch (error) {
				await this.#handleError(error)
			}
		})()

		try {
			await this.#drainTask
		} finally {
			this.#drainTask = null
		}
	}

	async #handleError(error: unknown): Promise<void> {
		if (this.#destroyed) {
			return
		}

		await this.destroy(error)
	}
}

export function createMachineRuntime<
	S,
	LC extends object,
	RC extends object,
	E extends MachineEvent,
	FX extends MachineEffect,
	O,
>(options: RuntimeOptions<S, LC, RC, E, FX, O>): MachineRuntime<S, LC, E, O> {
	return new Runtime(options)
}
