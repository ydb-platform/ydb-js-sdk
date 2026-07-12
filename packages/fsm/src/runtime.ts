import { linkSignals } from '@ydbjs/abortable'

import { AsyncQueue } from './queue.js'
import type {
	EffectRuntime,
	IngestHandle,
	MachineEffect,
	MachineEvent,
	MachineRuntime,
	RuntimeOptions,
} from './types.js'

// What HookRuntime needs from its owning Runtime; the Runtime class never leaves
// this module, so nothing external gains access.
type HookHost<S, E extends MachineEvent, O> = {
	readonly state: S
	readonly signal: AbortSignal
	emit(output: O): void
	dispatch(event: E): void
}

// The runtime handle passed to transitions and effect handlers. Hooks have no
// lifecycle access: a machine terminates by returning `final` from a transition,
// and an effect that hits an unrecoverable error throws (destroying the machine).
// Handing hooks the full runtime would invite `await runtime.close()` from inside
// the drain loop — a structural promise-cycle deadlock.
class HookRuntime<S, E extends MachineEvent, O> implements EffectRuntime<S, E, O> {
	#host: HookHost<S, E, O>

	constructor(host: HookHost<S, E, O>) {
		this.#host = host
	}

	get state(): S {
		return this.#host.state
	}

	get signal(): AbortSignal {
		return this.#host.signal
	}

	emit(output: O): void {
		this.#host.emit(output)
	}

	dispatch(event: E): void {
		this.#host.dispatch(event)
	}
}

class Runtime<
	S,
	LC extends object,
	RC extends object,
	E extends MachineEvent,
	FX extends MachineEffect,
	O,
>
	// Deliberately NOT an EffectRuntime: hooks must receive the HookRuntime view,
	// whose close() cannot deadlock the drain loop they run in.
	implements MachineRuntime<S, LC, E, O>
{
	#ac = new AbortController()

	#state: S
	#ctx: LC & RC
	#effects: RuntimeOptions<S, LC, RC, E, FX, O>['effects']
	#transition: RuntimeOptions<S, LC, RC, E, FX, O>['transition']

	// Assigned synchronously BEFORE the drain loop body runs its first transition
	// (via a pre-created deferred), so every observer — a nested dispatch, close(),
	// an external drain — sees the in-flight drain and waits for it instead of
	// starting a second loop against stale (pre-transition) state or sealing the
	// output queue mid-drain.
	#drainTask: Promise<void> | null = null

	#eventQueue: E[] = []
	#outputQueue = new AsyncQueue<O>()

	#closing = false
	#closed = false
	#destroyed = false
	// Set when the machine is torn down by an internal error (a transition, effect,
	// or ingest source threw) rather than a graceful close/destroy. destroy() then
	// fails the output queue instead of closing it, so the iterator throws the stop
	// reason and consumers observe the failure instead of a silent end (which would
	// strand a facade waiting on a terminal signal).
	#faulted = false

	#closeTask: Promise<void> | null = null
	#destroyTask: Promise<void> | null = null

	#stopReason: unknown = null

	#hookRuntime: HookRuntime<S, E, O>

	constructor(options: RuntimeOptions<S, LC, RC, E, FX, O>) {
		this.#state = options.initialState
		// Merge env into ctx once at construction so both LC and RC fields
		// live on the same object reference. Mutations in effects are reflected immediately.
		this.#ctx = Object.assign(options.ctx, options.env) as unknown as LC & RC
		this.#effects = options.effects
		this.#transition = options.transition
		this.#hookRuntime = new HookRuntime(this)
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

	// The runtime stops accepting input once shutdown has begun in any form.
	get #stopped(): boolean {
		return this.#closing || this.#closed || this.#destroyed
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
		if (this.#stopped) {
			throw new Error('Runtime is not accepting new ingests')
		}

		let ac = new AbortController()
		let task = (async () => {
			using combined = linkSignals(this.#ac.signal, ac.signal, signal)

			try {
				for await (let input of source) {
					if (combined.signal.aborted) {
						return
					}

					if (this.#stopped) {
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

				if (this.#stopped) {
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
				ac.abort(new Error('Ingest disposed'))

				await task.catch(() => {
					// Ingest task errors are handled by runtime error path.
				})
			},
		}
	}

	dispatch(event: E): void {
		if (this.#stopped) {
			return
		}

		this.#eventQueue.push(event)

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
			this.#markClosing(reason)

			// Drain first so all outputs emitted during pending transitions are
			// delivered before the output queue is sealed. A drain may already be
			// in flight — wait for that loop to finish, then drain any tail.
			while (this.#drainTask) {
				// oxlint-disable-next-line no-await-in-loop
				await this.#drainTask
			}
			await this.#drain()

			if (this.#destroyed) {
				return
			}

			this.#seal()
		})()

		await this.#closeTask
	}

	// Set closing (first caller's reason wins) so no new events are enqueued past
	// this point.
	#markClosing(reason?: unknown): void {
		if (this.#closing) {
			return
		}
		this.#closing = true
		this.#stopReason = reason ?? new Error('Runtime closed')
	}

	// Idempotent terminal step of a graceful close: seal the output stream, then
	// abort the signal — ingest loops and signal listeners are notified only once
	// all pending output has been delivered.
	#seal(): void {
		if (this.#closed || this.#destroyed) {
			return
		}
		this.#closed = true
		this.#outputQueue.close()
		this.#ac.abort(this.#stopReason)
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
			this.#stopReason = reason ?? new Error('Runtime destroyed')

			this.#ac.abort(this.#stopReason)

			// Hard shutdown: drop queued events immediately.
			this.#eventQueue.length = 0

			// Release pending iterators. An internal fault makes the output iterator
			// throw the stop reason (so consumers observe the failure instead of a
			// silent end); a graceful teardown just ends the stream.
			if (this.#faulted) {
				this.#outputQueue.fail(this.#stopReason)
			} else {
				this.#outputQueue.close()
			}
		})()

		await this.#destroyTask
	}

	[Symbol.asyncIterator](): AsyncIterator<O> {
		return this.#outputQueue[Symbol.asyncIterator]()
	}

	// Graceful async disposal first, then hard finalization.
	async [Symbol.asyncDispose](): Promise<void> {
		await this.close(new Error('Runtime async disposed'))
		await this.destroy(new Error('Runtime async disposed'))
	}

	async #drain(): Promise<void> {
		// Loop rather than branch: multiple callers may be waiting on the same
		// drainTask. When it resolves they all wake up simultaneously — the loop
		// ensures each re-checks whether a new task was already started before
		// creating another one. A drain re-entered from a transition or effect
		// (via dispatch) also lands here: the event is already in the shared queue
		// and the running loop will pick it up, so waiting is correct — starting a
		// second loop would process it against stale (pre-transition) state.
		while (this.#drainTask) {
			// oxlint-disable-next-line no-await-in-loop
			await this.#drainTask
		}

		if (this.#destroyed || this.#eventQueue.length === 0) {
			return
		}

		// Assign the task via a pre-created deferred BEFORE the body runs its first
		// (synchronous) transition, so a close()/dispatch issued from within that
		// transition already observes the in-flight drain.
		let { promise, resolve } = Promise.withResolvers<void>()
		this.#drainTask = promise

		try {
			while (this.#eventQueue.length > 0 && !this.#destroyed) {
				let event = this.#eventQueue.shift()!
				let result = this.#transition(this.#ctx, event, this.#hookRuntime)

				if (!result) {
					continue
				}

				if (result.state !== undefined) {
					this.#state = result.state
				}

				// A terminal transition: stop accepting events now; the seal happens in
				// the finally below, after this transition's effects (cleanup) run and
				// the already-queued tail drains (terminal states ignore it).
				if (result.final) {
					this.#markClosing(result.final.reason)
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
						throw new Error(`Missing effect handler for effect type "${effect.type}"`)
					}

					// oxlint-disable-next-line no-await-in-loop
					await handler(this.#ctx, effect as never, this.#hookRuntime)
				}
			}
		} catch (error) {
			await this.#handleError(error)
		} finally {
			this.#drainTask = null
			resolve()
			// A close requested from within this drain (hook close()) seals here,
			// after every queued event's outputs made it into the queue. dispatch()
			// rejects new events once #closing is set, so the queue is empty unless
			// the loop bailed on destroy — where sealing is destroy()'s job.
			if (this.#closing && !this.#destroyed && this.#eventQueue.length === 0) {
				this.#seal()
			}
		}
	}

	async #handleError(error: unknown): Promise<void> {
		if (this.#destroyed) {
			return
		}

		this.#faulted = true
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
