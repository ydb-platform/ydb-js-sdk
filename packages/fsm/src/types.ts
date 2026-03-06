/** A value that is either synchronous or wrapped in a Promise. */
export type Awaitable<T> = T | Promise<T>

/** Base constraint for all events dispatched to the machine. */
export type MachineEvent = {
	type: string
}

/** Base constraint for all effects returned by a transition. */
export type MachineEffect = {
	type: string
}

/**
 * Restricted runtime handle passed to {@link TransitionFn}.
 *
 * Intentionally limited: transitions may only read current state, emit outputs,
 * and dispatch new events. Lifecycle control and runtime resources are not accessible —
 * use effect handlers for any side-effectful operations.
 */
export interface TransitionRuntime<S, E extends MachineEvent, O> {
	/** Current machine state at the time the transition is called. */
	readonly state: S
	/** Aborted when the machine is closed or destroyed. */
	readonly signal: AbortSignal
	/** Pushes a value to the machine's output iterable. */
	emit(output: O): void
	/** Schedules an event to be processed after the current transition completes. */
	dispatch(event: E): void
}

/**
 * Full runtime handle passed to {@link EffectHandler}.
 *
 * Extends {@link TransitionRuntime} with lifecycle operations that effects may need,
 * such as closing or destroying the machine in response to an unrecoverable error.
 */
export interface EffectRuntime<S, E extends MachineEvent, O> extends TransitionRuntime<S, E, O> {
	/** Gracefully drains pending events then shuts down the machine. */
	close(reason?: unknown): Promise<void>
	/** Immediately halts the machine, dropping any pending events. */
	destroy(reason?: unknown): Promise<void>
}

/**
 * Value returned by a {@link TransitionFn} to describe what should happen next.
 *
 * Both fields are optional: omitting `state` keeps the current state,
 * omitting `effects` produces no side effects.
 */
export type TransitionResult<S, FX extends MachineEffect> = {
	/** Next state to transition to. Omit to stay in the current state. */
	state?: S
	/** List of effects to execute after the state is updated. */
	effects?: FX[]
}

/**
 * Pure function that decides how the machine reacts to an event.
 *
 * Given the current logical context and an event, returns the next state
 * and a list of effects to execute — or `void` to ignore the event.
 *
 * **Must be synchronous.** Any async logic belongs in {@link EffectHandler}.
 * The current state is available via `runtime.state`.
 *
 * @param ctx - Logical context: flags and values owned by the transition layer.
 * @param event - The event being processed.
 * @param runtime - Restricted handle for reading state, emitting outputs, and dispatching events.
 */
export type TransitionFn<
	S,
	LC extends object,
	E extends MachineEvent,
	FX extends MachineEffect,
	O,
> = (ctx: LC, event: E, runtime: TransitionRuntime<S, E, O>) => TransitionResult<S, FX> | void

/**
 * Async handler that executes a single effect produced by a {@link TransitionFn}.
 *
 * This is the only place in the machine where side-effectful operations are allowed:
 * starting timers, opening streams, resolving promises, etc.
 *
 * The `ctx` parameter is the full merged context (`LC & RC`), so both logical flags
 * and runtime resources are accessible in one place.
 *
 * @param ctx - Merged context: logical flags (`LC`) and runtime resources (`RC`) combined.
 * @param effect - The effect descriptor returned by the transition.
 * @param runtime - Full runtime handle, including lifecycle operations.
 */
export type EffectHandler<
	S,
	LC extends object,
	RC extends object,
	E extends MachineEvent,
	FX extends MachineEffect,
	O,
> = (ctx: LC & RC, effect: FX, runtime: EffectRuntime<S, E, O>) => Awaitable<void>

/**
 * Map of effect type strings to their corresponding {@link EffectHandler} functions.
 *
 * TypeScript enforces that every effect type produced by the transition has a handler.
 * For machines with no effects (`FX = never`), this type resolves to `{}`.
 */
export type EffectHandlers<
	S,
	LC extends object,
	RC extends object,
	E extends MachineEvent,
	FX extends MachineEffect,
	O,
> = {
	[K in FX['type']]: EffectHandler<S, LC, RC, E, Extract<FX, { type: K }>, O>
}

/**
 * Configuration passed to {@link createMachineRuntime}.
 *
 * @example
 * ```ts
 * createMachineRuntime({
 *   initialState: 'idle',
 *   ctx: { retries: 0 },
 *   env: { timer: null },
 *   transition(ctx, event, runtime) {
 *     if (event.type === 'start') {
 *       return { state: 'running', effects: [{ type: 'start_timer' }] }
 *     }
 *   },
 *   effects: {
 *     start_timer(ctx, effect, runtime) {
 *       ctx.timer = setTimeout(() => runtime.dispatch({ type: 'tick' }), 1000)
 *     }
 *   }
 * })
 * ```
 */
export type RuntimeOptions<
	S,
	LC extends object,
	RC extends object,
	E extends MachineEvent,
	FX extends MachineEffect,
	O,
> = {
	/** State the machine starts in. */
	initialState: S
	/**
	 * Logical context mutated by the transition function.
	 * Contains only pure flags, counters, and identifiers — no I/O handles.
	 * Accessible in transitions and (merged with `env`) in effect handlers.
	 */
	ctx: LC
	/**
	 * Runtime environment passed exclusively to effect handlers.
	 * Contains I/O handles: timers, streams, abort controllers, deferred promises, etc.
	 * Merged with `ctx` at construction — mutations in effects are reflected immediately.
	 */
	env: RC
	/** See {@link TransitionFn}. */
	transition: TransitionFn<S, LC, E, FX, O>
	/**
	 * Handlers for every effect type the transition can produce.
	 * For machines with no effects, pass `{}`.
	 */
	effects: EffectHandlers<S, LC, RC, E, FX, O>
}

/** Handle returned by {@link MachineRuntime.ingest} — dispose to stop ingestion. */
export interface IngestHandle extends AsyncDisposable {}

/**
 * A running finite state machine.
 *
 * Processes events one at a time, executing effects after each transition.
 * Implements `AsyncIterable<O>` — iterate to consume outputs emitted by transitions.
 *
 * Lifecycle:
 * - `close()` — drains pending events gracefully, then seals the output iterable.
 * - `destroy()` — drops pending events immediately and halts.
 * - `[Symbol.asyncDispose]()` — calls `close()` then `destroy()`.
 */
export interface MachineRuntime<S, LC, E extends MachineEvent, O>
	extends AsyncDisposable, AsyncIterable<O> {
	/** Current machine state. */
	readonly state: S
	/** Logical context. Contains only the `LC` slice — runtime resources are not exposed. */
	readonly ctx: LC
	/** Aborted when the machine is closed or destroyed. */
	readonly signal: AbortSignal

	/** Enqueues an event for processing. Ignored if the machine is closed or destroyed. */
	dispatch(event: E): void
	/**
	 * Ingests an async iterable source, mapping each item to an event (or `null` to skip).
	 * Stops automatically when the machine closes, the source ends, or the returned handle is disposed.
	 *
	 * @throws If the machine is already closed or destroyed.
	 */
	ingest<T>(
		source: AsyncIterable<T>,
		map: (input: T) => E | null,
		signal?: AbortSignal
	): IngestHandle
	/** Drains pending events then closes the output iterable. Idempotent. */
	close(reason?: unknown): Promise<void>
	/** Drops pending events and halts immediately. Idempotent. */
	destroy(reason?: unknown): Promise<void>
}
