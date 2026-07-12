// oxlint-disable no-await-in-loop

import { setTimeout as sleep } from 'node:timers/promises'

import { expect, test } from 'vitest'

import { AsyncQueue } from './queue.js'
import { createMachineRuntime } from './runtime.js'
import type { EffectRuntime } from './types.js'

type TestState = 'ready' | 'error'

type TestEvent = { type: 'add'; value: number } | { type: 'mark_error'; message: string }

type TestEffect = { type: 'record'; value: number }

type TestOutput = { type: 'emitted'; value: number }

type TestCtx = {
	sum: number
	recorded: number[]
	errors: string[]
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	let started = Date.now()

	while (!predicate()) {
		if (Date.now() - started > timeoutMs) {
			throw new Error('waitFor timeout exceeded')
		}
		await sleep(0)
	}
}

// ── drain loop ──────────────────────────────────────────────────────────────────

test('close drains queued events and runs effects before shutdown', async () => {
	let initialCtx: TestCtx = {
		sum: 0,
		recorded: [],
		errors: [],
	}

	let machine = createMachineRuntime<TestState, TestCtx, {}, TestEvent, TestEffect, TestOutput>({
		initialState: 'ready',
		ctx: initialCtx,
		env: {},
		transition(ctx, event, runtime) {
			if (event.type === 'add') {
				ctx.sum += event.value
				runtime.emit({ type: 'emitted', value: event.value })

				return {
					state: runtime.state,
					effects: [{ type: 'record', value: event.value }],
				}
			}

			if (event.type === 'mark_error') {
				ctx.errors.push(event.message)
				return { state: 'error' }
			}

			return undefined
		},
		effects: {
			record(ctx, effect) {
				ctx.recorded.push(effect.value)
			},
		},
	})

	machine.dispatch({ type: 'add', value: 1 })
	machine.dispatch({ type: 'add', value: 2 })
	machine.dispatch({ type: 'add', value: 3 })

	// close() should wait for already queued events/effects
	await machine.close()

	expect(initialCtx.sum).toBe(6)
	expect(initialCtx.recorded).toEqual([1, 2, 3])
})

test('ingests async iterable source and maps input to events', async () => {
	let initialCtx: TestCtx = {
		sum: 0,
		recorded: [],
		errors: [],
	}

	let machine = createMachineRuntime<TestState, TestCtx, {}, TestEvent, never, TestOutput>({
		initialState: 'ready',
		ctx: initialCtx,
		env: {},
		transition(ctx, event) {
			if (event.type === 'add') {
				ctx.sum += event.value
				return { state: 'ready' }
			}

			return undefined
		},
		effects: {},
	})

	async function* source(): AsyncIterable<number> {
		yield 1
		await sleep(0)
		yield 2
		await sleep(0)
		yield 3
	}

	await using _ingest = machine.ingest(source(), (input) => {
		return { type: 'add', value: input }
	})

	await waitFor(() => initialCtx.sum === 6)

	expect(initialCtx.sum).toBe(6)

	await machine.close()
})

test('runtime async iterable completes after close', async () => {
	let initialCtx: TestCtx = {
		sum: 0,
		recorded: [],
		errors: [],
	}

	let machine = createMachineRuntime<TestState, TestCtx, {}, TestEvent, never, TestOutput>({
		initialState: 'ready',
		ctx: initialCtx,
		env: {},
		transition(ctx, event, runtime) {
			if (event.type === 'add') {
				ctx.sum += event.value
				runtime.emit({ type: 'emitted', value: event.value })
				return { state: 'ready' }
			}

			return undefined
		},
		effects: {},
	})

	let received: number[] = []

	let readerTask = (async () => {
		for await (let output of machine) {
			received.push(output.value)
		}
	})()

	machine.dispatch({ type: 'add', value: 4 })
	machine.dispatch({ type: 'add', value: 5 })

	// close() drains the event queue and seals the output queue.
	// readerTask consumes all emitted values before the for-await loop exits.
	// Await readerTask after close() to ensure all output is collected.
	await machine.close()
	await readerTask

	expect(received).toEqual([4, 5])
})

test('destroy aborts signal and disposes active ingest resources', async () => {
	let machine = createMachineRuntime<TestState, TestCtx, {}, TestEvent, never, TestOutput>({
		initialState: 'ready',
		ctx: { sum: 0, recorded: [], errors: [] },
		env: {},
		transition(ctx, event) {
			if (event.type === 'add') {
				ctx.sum += event.value
			}
			return { state: 'ready' }
		},
		effects: {},
	})

	let sourceDisposed = false

	async function* source(signal: AbortSignal): AsyncIterable<number> {
		try {
			let i = 0
			while (!signal.aborted) {
				await sleep(1)
				i += 1
				yield i
			}
		} finally {
			sourceDisposed = true
		}
	}

	machine.ingest(source(machine.signal), (value) => {
		return { type: 'add', value }
	})

	await sleep(5)
	await machine.destroy('test destroy')
	await waitFor(() => sourceDisposed)

	expect(machine.signal.aborted).toBe(true)
	expect(sourceDisposed).toBe(true)
})

test('ingest throws after close and after destroy', async () => {
	let machine = createMachineRuntime<TestState, TestCtx, {}, TestEvent, never, TestOutput>({
		initialState: 'ready',
		ctx: { sum: 0, recorded: [], errors: [] },
		env: {},
		transition(_ctx, _event) {
			return { state: 'ready' }
		},
		effects: {},
	})

	await machine.close('already closed')

	expect(() => {
		machine.ingest(
			(async function* (): AsyncIterable<number> {
				yield 1
			})(),
			(value) => ({ type: 'add', value })
		)
	}).toThrow('Runtime is not accepting new ingests')

	await machine.destroy('already destroyed')
})

test('effect receives merged ctx with both logical and env fields', async () => {
	type Env = { log: string[] }

	let initialCtx: TestCtx = { sum: 0, recorded: [], errors: [] }
	let env: Env = { log: [] }

	let machine = createMachineRuntime<TestState, TestCtx, Env, TestEvent, TestEffect, TestOutput>({
		initialState: 'ready',
		ctx: initialCtx,
		env,
		transition(ctx, event) {
			if (event.type === 'add') {
				ctx.sum += event.value
				return { state: 'ready', effects: [{ type: 'record', value: event.value }] }
			}
			return undefined
		},
		effects: {
			// ctx is LC & RC merged: both sum (from LC) and log (from RC) are accessible
			record(ctx, effect) {
				ctx.log.push(`recorded:${effect.value}`)
			},
		},
	})

	machine.dispatch({ type: 'add', value: 7 })
	machine.dispatch({ type: 'add', value: 3 })

	await machine.close()

	expect(initialCtx.sum).toBe(10)
	expect(env.log).toEqual(['recorded:7', 'recorded:3'])
})

test('dispatch inside effect is processed by the same drain loop iteration', async () => {
	// Events dispatched from within an effect handler are pushed to the queue
	// while the while-loop in #drain is still active. The loop picks them up
	// on the next iteration — no event is ever silently dropped.
	type State = 'idle' | 'ready'
	type Event = { type: 'start' } | { type: 'started' }
	type Effect = { type: 'do_start' }
	type Ctx = { log: string[] }

	let initialCtx: Ctx = { log: [] }

	let machine = createMachineRuntime<State, Ctx, {}, Event, Effect, never>({
		initialState: 'idle',
		ctx: initialCtx,
		env: {},
		transition(ctx, event, runtime) {
			if (runtime.state === 'idle' && event.type === 'start') {
				ctx.log.push('start')
				return { state: 'idle', effects: [{ type: 'do_start' }] }
			}

			if (event.type === 'started') {
				ctx.log.push('started')
				return { state: 'ready' }
			}

			return undefined
		},
		effects: {
			do_start(_ctx, _effect, runtime) {
				// dispatch from within an effect — must not be lost
				runtime.dispatch({ type: 'started' })
			},
		},
	})

	machine.dispatch({ type: 'start' })

	await machine.close()

	expect(machine.state).toBe('ready')
	expect(initialCtx.log).toEqual(['start', 'started'])
})

test('processes an event dispatched inside a transition after the state change', async () => {
	// Regression: a dispatch made synchronously from within a transition must be
	// processed after the current transition's state change is applied — not
	// re-entrantly against the stale (pre-transition) state.
	type S = 'idle' | 'ready'
	type E = { type: 'start' } | { type: 'follow_up' }
	type Ctx = { seenFollowUpIn: S | null }

	let ctx: Ctx = { seenFollowUpIn: null }
	let machine = createMachineRuntime<S, Ctx, {}, E, never, never>({
		initialState: 'idle',
		ctx,
		env: {},
		transition(mctx, event, runtime) {
			if (event.type === 'start') {
				runtime.dispatch({ type: 'follow_up' })
				return { state: 'ready' }
			}
			if (event.type === 'follow_up') {
				mctx.seenFollowUpIn = runtime.state
			}
		},
		effects: {},
	})

	machine.dispatch({ type: 'start' })
	await waitFor(() => ctx.seenFollowUpIn !== null)

	expect(ctx.seenFollowUpIn).toBe('ready')
	expect(machine.state).toBe('ready')

	await machine.destroy()
})

test('close delivers outputs for events dispatched during an in-flight drain', async () => {
	// Regression: close() must wait for an in-flight drain to finish (and drain the
	// tail) before sealing — not early-return via the #draining guard and drop
	// outputs from events queued mid-drain.
	type S = 'x'
	type E = { type: 'a' } | { type: 'b' }
	type FX = { type: 'work' }
	type O = { type: 'o'; v: string }

	let outputs: string[] = []
	let machine = createMachineRuntime<S, {}, {}, E, FX, O>({
		initialState: 'x',
		ctx: {},
		env: {},
		transition(_ctx, event, runtime) {
			if (event.type === 'a') {
				runtime.emit({ type: 'o', v: 'a' })
				runtime.dispatch({ type: 'b' })
				return { effects: [{ type: 'work' }] }
			}
			if (event.type === 'b') {
				runtime.emit({ type: 'o', v: 'b' })
			}
		},
		effects: {
			work: async () => {
				await sleep(0)
			},
		},
	})

	let consume = (async () => {
		for await (let out of machine) {
			outputs.push(out.v)
		}
	})()

	machine.dispatch({ type: 'a' })
	await machine.close()
	await consume

	expect(outputs).toEqual(['a', 'b'])
})

test('output iterator adds no microtask latency over the raw queue', async () => {
	// Regression guard for the coordination createSession race. The reader migration
	// wrapped this iterator in an extra `async *` (to rethrow the stop reason on an
	// internal fault); `yield*` through it costs one extra microtask per emitted
	// output, which delayed a downstream ingest just enough to lose a waitReady timing
	// race (createSession resolved before the session FSM reached 'ready'). The fault
	// path now goes through AsyncQueue.fail(), so the iterator stays a direct queue
	// passthrough. Assert that: an item read through the runtime settles in the same
	// number of microtask turns as one read straight from an AsyncQueue. A wrapper
	// generator makes the runtime strictly slower and fails this.
	let turnsToSettle = async (p: Promise<unknown>): Promise<number> => {
		let settled = false
		p.then(
			() => (settled = true),
			() => (settled = true)
		)

		let turns = 0
		while (!settled && turns < 100) {
			await Promise.resolve()
			turns += 1
		}

		return turns
	}

	// Baseline: one buffered item read straight from an AsyncQueue.
	let baseline = new AsyncQueue<TestOutput>()
	baseline.push({ type: 'emitted', value: 1 })
	let baselineTurns = await turnsToSettle(baseline[Symbol.asyncIterator]().next())

	// Runtime whose transition emits one output synchronously on dispatch.
	let machine = createMachineRuntime<TestState, TestCtx, {}, TestEvent, never, TestOutput>({
		initialState: 'ready',
		ctx: { sum: 0, recorded: [], errors: [] },
		env: {},
		transition(_ctx, event, runtime) {
			if (event.type === 'add') {
				runtime.emit({ type: 'emitted', value: event.value })
			}
			return { state: runtime.state }
		},
		effects: {},
	})

	let iterator = machine[Symbol.asyncIterator]()
	machine.dispatch({ type: 'add', value: 1 })
	let runtimeTurns = await turnsToSettle(iterator.next())

	expect(runtimeTurns).toBe(baselineTurns)

	await machine.close()
})

// Machine builder for the close / final / fault interplay tests below: one 'ready'
// state whose events cover plain emits, suspended effects, `final` transitions,
// and faults — the shapes the topic writer/reader machines rely on.
type LifeState = 'ready'
type LifeEvent =
	| { type: 'emit'; n: number }
	| { type: 'slow' }
	| { type: 'slow_emit_first'; n: number }
	| { type: 'storm'; n: number }
	| { type: 'final_slow' }
	| { type: 'boom' }
	| { type: 'capture' }
type LifeEffect = { type: 'suspend' } | { type: 'grab' } | { type: 'dispatch_late' }
type LifeOutput = { type: 'out'; n: number }

type LifeCtx = {
	gate?: Promise<void>
	captured?: EffectRuntime<LifeState, LifeEvent, LifeOutput>
}

function makeLifecycleMachine(overrides?: {
	onSuspend?: (
		ctx: LifeCtx,
		runtime: EffectRuntime<LifeState, LifeEvent, LifeOutput>
	) => Promise<void>
}) {
	return createMachineRuntime<LifeState, LifeCtx, {}, LifeEvent, LifeEffect, LifeOutput>({
		initialState: 'ready',
		ctx: {},
		env: {},
		transition(_ctx, event, runtime) {
			switch (event.type) {
				case 'emit':
					runtime.emit({ type: 'out', n: event.n })
					return
				case 'slow':
					return { effects: [{ type: 'suspend' }] }
				case 'slow_emit_first':
					runtime.emit({ type: 'out', n: event.n })
					return { effects: [{ type: 'suspend' }] }
				case 'storm': {
					// Queued BEFORE the transition returns `final` — must still drain.
					for (let i = 1; i <= event.n; i++) {
						runtime.dispatch({ type: 'emit', n: i })
					}
					// dispatch_late runs after `final` took effect — its dispatch must
					// be dropped (the contract's replacement for the old post-close drop).
					return {
						final: { reason: new Error('storm final') },
						effects: [{ type: 'dispatch_late' }],
					}
				}
				case 'final_slow':
					return {
						final: { reason: new Error('final first') },
						effects: [{ type: 'suspend' }],
					}
				case 'boom':
					throw new Error('transition boom')
				case 'capture':
					return { effects: [{ type: 'grab' }] }
				default:
					return
			}
		},
		effects: {
			suspend: async (ctx, _effect, runtime) => {
				if (overrides?.onSuspend) {
					await overrides.onSuspend(ctx, runtime)
					return
				}
				await ctx.gate
			},
			grab: (ctx, _effect, runtime) => {
				ctx.captured = runtime
			},
			dispatch_late: (_ctx, _effect, runtime) => {
				// The machine is already closing (`final` applied) — silent no-op.
				runtime.dispatch({ type: 'emit', n: 999 })
			},
		},
	})
}

test('external close during in-flight drain delivers tail outputs then seals once', async () => {
	// close() must wait for a suspended effect, drain the tail events queued behind
	// it, deliver their outputs, then seal. The drain's finally and close()'s own
	// seal race — both must be no-op-idempotent.
	let gate = Promise.withResolvers<void>()
	let machine = makeLifecycleMachine()
	machine.ctx.gate = gate.promise

	let outputs: number[] = []
	let consume = (async () => {
		for await (let output of machine) {
			outputs.push(output.n)
		}
		return 'ended'
	})()

	machine.dispatch({ type: 'slow' })
	await sleep(0) // let the drain suspend inside the effect
	machine.dispatch({ type: 'emit', n: 1 })
	machine.dispatch({ type: 'emit', n: 2 })

	let closeA = machine.close(new Error('external'))
	let closeB = machine.close(new Error('external-second'))

	// close() must not resolve while the effect is suspended
	let early = await Promise.race([closeA.then(() => 'closed'), sleep(50).then(() => 'pending')])
	expect(early).toBe('pending')

	gate.resolve()
	await Promise.all([closeA, closeB])

	let outcome = await Promise.race([consume, sleep(500).then(() => 'hung')])
	expect(outcome).toBe('ended')
	expect(outputs).toEqual([1, 2])
	expect(machine.signal.aborted).toBe(true)

	await machine.destroy()
})

test('destroy during suspended drain drops tail and ends stream gracefully', async () => {
	// destroy() resolves without waiting for the suspended effect (no cycle), drops
	// queued events, delivers outputs emitted BEFORE the destroy, ends the iterator
	// without throwing (graceful, not faulted), and the drain-finally's seal guard
	// holds — no double-terminal.
	let gate = Promise.withResolvers<void>()
	let machine = makeLifecycleMachine()
	machine.ctx.gate = gate.promise

	let outputs: number[] = []
	let ended: 'ended' | 'threw' | null = null
	let consume = (async () => {
		try {
			for await (let output of machine) {
				outputs.push(output.n)
			}
			ended = 'ended'
		} catch {
			ended = 'threw'
		}
	})()

	machine.dispatch({ type: 'slow_emit_first', n: 1 }) // emits 1, then suspends
	await sleep(0)
	machine.dispatch({ type: 'emit', n: 2 }) // queued behind the suspended effect

	let destroyed = machine.destroy(new Error('hard stop'))
	let early = await Promise.race([destroyed.then(() => 'done'), sleep(50).then(() => 'pending')])
	expect(early).toBe('done') // destroy must NOT wait for the suspended effect

	gate.resolve() // let the drain loop resume and bail via the destroyed checks
	await sleep(10)
	await Promise.race([consume, sleep(500)])

	expect(ended).toBe('ended') // graceful destroy: close, not fail
	expect(outputs).toEqual([1]) // pre-destroy output delivered, queued event dropped
	expect(machine.signal.aborted).toBe(true)
})

test('ingest source items after close never leak past the seal', async () => {
	// Ingest racing close: items already ingested before close are delivered, items
	// produced after close never become events, the machine seals cleanly.
	let gate = Promise.withResolvers<void>()
	let machine = makeLifecycleMachine()

	async function* source(): AsyncGenerator<number> {
		yield 1
		await gate.promise
		yield 2
		yield 3
	}

	let handle = machine.ingest(source(), (n) => ({ type: 'emit', n }))

	let outputs: number[] = []
	let consume = (async () => {
		for await (let output of machine) {
			outputs.push(output.n)
		}
		return 'ended'
	})()

	await sleep(10) // item 1 ingested, source parked on the gate
	let closed = machine.close(new Error('bye'))
	gate.resolve() // source now yields 2 and 3 — both must be dropped
	await closed

	let outcome = await Promise.race([consume, sleep(500).then(() => 'hung')])
	expect(outcome).toBe('ended')
	expect(outputs).toEqual([1])

	await handle[Symbol.asyncDispose]()
	await machine.destroy()
})

test('close waiting on drain resolves after destroy without hanging', async () => {
	// close() parked on a suspended drain when destroy() fires: destroy resolves
	// immediately, the drain loop bails on resume, its finally resolves the deferred
	// close() is awaiting (no lost wakeup), and close() returns without re-sealing.
	let gate = Promise.withResolvers<void>()
	let machine = makeLifecycleMachine()
	machine.ctx.gate = gate.promise

	machine.dispatch({ type: 'slow' })
	await sleep(0) // drain suspended in the effect

	let closed = machine.close(new Error('graceful'))
	await machine.destroy(new Error('hard'))

	gate.resolve() // drain resumes, bails via destroyed, finally wakes close()

	let outcome = await Promise.race([closed.then(() => 'closed'), sleep(500).then(() => 'hung')])
	expect(outcome).toBe('closed')
	expect((machine.signal.reason as Error).message).toBe('hard')
})

// ── final & sealing ─────────────────────────────────────────────────────────────

test('seals after a slow effect of a final transition without deadlock', async () => {
	// Successor of review FSM-1. The removed EffectRuntime.close() deadlocked when
	// awaited from a suspended effect (close -> closeTask -> drainTask -> handler ->
	// close). Termination is now declared by the transition returning `final`, and
	// the seal lives in the drain's finally — AFTER every effect of the terminal
	// transition completes. A terminal transition whose later effect suspends still
	// seals cleanly once that effect finishes (and its late emit is still delivered);
	// no promise cycle is possible.
	type S = 'ready'
	type E = { type: 'stop' }
	type FX = { type: 'prepare' } | { type: 'finalize' }
	type O = { type: 'closed' } | { type: 'finalized' }

	let machine = createMachineRuntime<S, { finalized: boolean }, {}, E, FX, O>({
		initialState: 'ready',
		ctx: { finalized: false },
		env: {},
		transition(_ctx, event, runtime) {
			if (event.type === 'stop') {
				runtime.emit({ type: 'closed' })
				return {
					final: { reason: new Error('stop') },
					effects: [{ type: 'prepare' }, { type: 'finalize' }],
				}
			}
		},
		effects: {
			prepare: () => {
				// Sync first effect: the slow one below is a LATER effect of the same
				// terminal transition, matching the topic terminate effect ordering.
			},
			finalize: async (ctx, _effect, runtime) => {
				// Suspend so the drain parks mid-effects with `final` already set.
				await sleep(0)
				ctx.finalized = true
				// Emitted with `final` already applied — the seal waits for this
				// handler, so the output must still be delivered.
				runtime.emit({ type: 'finalized' })
			},
		},
	})

	machine.dispatch({ type: 'stop' })

	let outputs: O[] = []
	let outcome = await Promise.race([
		(async () => {
			for await (let output of machine) {
				outputs.push(output)
			}
			return 'closed'
		})(),
		sleep(500).then(() => 'deadlock'),
	])

	expect(outcome).toBe('closed')
	expect(outputs).toEqual([{ type: 'closed' }, { type: 'finalized' }])
	// The seal waited for the suspended effect — final never preempts cleanup.
	expect(machine.ctx.finalized).toBe(true)
	expect(machine.signal.aborted).toBe(true)
	expect((machine.signal.reason as Error).message).toBe('stop')

	await machine.destroy()
})

test('delivers queued outputs when a terminate transition returns final (topic terminate shape)', async () => {
	// The writer/reader terminate transition, reshaped for declarative termination:
	// emit outputs, return `final` carrying the terminate reason, and run the cleanup
	// effects ([transport.close, finalize] — finalize is never first). Pins the
	// guarantees the topic machines rely on: outputs emitted by the terminating
	// transition AND by events it queued behind itself are all delivered, the
	// iterator then ends, and the terminate reason lands on machine.signal.reason.
	type S = 'ready'
	type E = { type: 'stop' } | { type: 'other' }
	type FX = { type: 'transport_close' } | { type: 'finalize' }
	type O = { type: 'closed' } | { type: 'other_out' }

	let terminateReason = new Error('terminate')
	let machine = createMachineRuntime<S, {}, {}, E, FX, O>({
		initialState: 'ready',
		ctx: {},
		env: {},
		transition(_ctx, event, runtime) {
			if (event.type === 'stop') {
				// Queued before `final` is applied — must still drain and deliver.
				runtime.dispatch({ type: 'other' })
				runtime.emit({ type: 'closed' })
				return {
					final: { reason: terminateReason },
					effects: [{ type: 'transport_close' }, { type: 'finalize' }],
				}
			}
			if (event.type === 'other') {
				runtime.emit({ type: 'other_out' })
			}
		},
		effects: {
			transport_close: () => {
				// sync, like WriterTransport.close()
			},
			finalize: () => {
				// Cleanup that used to fire-and-forget a hook close; termination is
				// now declared by the transition's `final` result.
			},
		},
	})

	let outputs: O[] = []
	let consume = (async () => {
		for await (let output of machine) {
			outputs.push(output)
		}
		return 'ended'
	})()

	machine.dispatch({ type: 'stop' })

	let outcome = await Promise.race([consume, sleep(500).then(() => 'hung')])

	expect(outcome).toBe('ended')
	expect(outputs).toEqual([{ type: 'closed' }, { type: 'other_out' }])
	expect(machine.signal.aborted).toBe(true)
	expect(machine.signal.reason).toBe(terminateReason)
})

test('final from a sync transition still drains queued events', async () => {
	// `final` from the SYNC prefix of the first transition with events queued behind
	// it: the pre-created deferred makes the drain visible, the loop keeps processing
	// pre-final events, outputs are delivered, then it seals. A post-final dispatch
	// from an effect is dropped.
	let machine = makeLifecycleMachine()

	let outputs: number[] = []
	let consume = (async () => {
		for await (let output of machine) {
			outputs.push(output.n)
		}
		return 'ended'
	})()

	machine.dispatch({ type: 'storm', n: 5 })

	let outcome = await Promise.race([consume, sleep(500).then(() => 'hung')])
	expect(outcome).toBe('ended')
	// all 5 pre-final events delivered; the post-final 999 dispatch dropped
	expect(outputs).toEqual([1, 2, 3, 4, 5])
	expect(machine.signal.aborted).toBe(true)
	expect((machine.signal.reason as Error).message).toBe('storm final')

	await machine.destroy()
})

test('resolves external close racing a final transition after a single seal', async () => {
	// `final` applies first, the external close() parks on the in-flight drain and
	// resolves only after the machine sealed — both paths converge on exactly one
	// seal, first reason wins.
	let gate = Promise.withResolvers<void>()
	let machine = makeLifecycleMachine()
	machine.ctx.gate = gate.promise

	let consume = (async () => {
		let count = 0
		for await (let _output of machine) {
			count += 1
		}
		return count
	})()

	machine.dispatch({ type: 'final_slow' }) // final applied, effect suspended on the gate
	await sleep(0)

	let closed = machine.close(new Error('external second'))
	let early = await Promise.race([closed.then(() => 'closed'), sleep(50).then(() => 'pending')])
	expect(early).toBe('pending') // full await semantics preserved on the public handle

	gate.resolve()
	await closed

	let outcome = await Promise.race([consume, sleep(500).then(() => 'hung')])
	expect(outcome).toBe(0)
	expect(machine.signal.aborted).toBe(true)
	// the final transition's reason wins over the later external close
	expect((machine.signal.reason as Error).message).toBe('final first')

	await machine.destroy()
})

test('ignores detached dispatch after seal without unhandled rejection', async () => {
	// Detached closures keep only state/signal/emit/dispatch. Once the machine
	// sealed, a late dispatch from a captured hook runtime is a silent no-op — no
	// output, no revived drain, no unhandled rejection.
	let machine = makeLifecycleMachine()

	machine.dispatch({ type: 'capture' })
	await sleep(10) // drain fully finished; hook runtime captured in ctx

	let captured = machine.ctx.captured
	expect(captured).toBeDefined()

	let unhandled: unknown[] = []
	let onUnhandled = (reason: unknown) => {
		unhandled.push(reason)
	}
	process.on('unhandledRejection', onUnhandled)

	let outputs: number[] = []
	let consume = (async () => {
		for await (let output of machine) {
			outputs.push(output.n)
		}
		return 'ended'
	})()

	await machine.close(new Error('external close'))

	// dispatch after seal must be dropped (from both handles)
	captured!.dispatch({ type: 'emit', n: 7 })
	machine.dispatch({ type: 'emit', n: 8 })

	let outcome = await Promise.race([consume, sleep(500).then(() => 'hung')])
	expect(outcome).toBe('ended')
	expect(outputs).toEqual([])
	expect(machine.signal.aborted).toBe(true)

	await sleep(20) // give a wrongly-enqueued drain a chance to surface
	process.off('unhandledRejection', onUnhandled)
	expect(unhandled).toEqual([])

	await machine.destroy()
})

test('ignores dispatch from a detached closure after destroy', async () => {
	// Mirrors the reader's detached onPartitionSessionStart hook: it settles later
	// and re-enters the machine via dispatch() — possibly after the machine was
	// destroyed. The late dispatch must be a silent no-op.
	type Ev = { type: 'go' } | { type: 'late' }
	type Fx = { type: 'fx.detach' }

	let lateDispatched = Promise.withResolvers<void>()

	let machine = createMachineRuntime<'s', object, object, Ev, Fx, string>({
		initialState: 's',
		ctx: {},
		env: {},
		transition: (_ctx, event, runtime) => {
			runtime.emit(event.type)
			if (event.type === 'go') {
				return { effects: [{ type: 'fx.detach' }] }
			}
			return undefined
		},
		effects: {
			'fx.detach': (_ctx, _fx, runtime) => {
				// Settles later, then dispatches — like a detached hook completion.
				void (async () => {
					await sleep(20)
					runtime.dispatch({ type: 'late' })
					lateDispatched.resolve()
				})()
			},
		},
	})

	let consumed: string[] = []
	let consumer = (async () => {
		try {
			for await (let out of machine) {
				consumed.push(out)
			}
		} catch {
			// destroy() without fault closes; with fault fails — either way no hang.
		}
	})()

	machine.dispatch({ type: 'go' })
	await sleep(5)
	await machine.destroy(new Error('gone'))
	await lateDispatched.promise
	// Give a drain a chance to run if the late dispatch wrongly enqueued.
	await sleep(25)
	await consumer

	expect(consumed).toEqual(['go'])
})

// ── faults ──────────────────────────────────────────────────────────────────────

test('runtime destroys itself when ingest source throws', async () => {
	let machine = createMachineRuntime<TestState, TestCtx, {}, TestEvent, never, TestOutput>({
		initialState: 'ready',
		ctx: { sum: 0, recorded: [], errors: [] },
		env: {},
		transition(_ctx, _event) {
			return { state: 'ready' }
		},
		effects: {},
	})

	async function* brokenSource(): AsyncIterable<number> {
		yield 1
		throw new Error('source boom')
	}

	await using _ingest = machine.ingest(brokenSource(), (value) => {
		return { type: 'add', value }
	})

	await waitFor(() => machine.signal.aborted)

	expect(machine.signal.aborted).toBe(true)
})

test('surfaces an internal effect error to the output iterator', async () => {
	let machine = createMachineRuntime<TestState, TestCtx, {}, TestEvent, TestEffect, TestOutput>({
		initialState: 'ready',
		ctx: { sum: 0, recorded: [], errors: [] },
		env: {},
		transition(_ctx, event, runtime) {
			if (event.type === 'add') {
				return { state: runtime.state, effects: [{ type: 'record', value: event.value }] }
			}
			return undefined
		},
		effects: {
			record(_ctx, effect) {
				throw new Error(`effect boom ${effect.value}`)
			},
		},
	})

	// An internal error must reach the consumer: the output stream ends by throwing
	// the stop reason, not by completing silently (which would strand a facade
	// awaiting a terminal signal).
	let caught: unknown
	let reader = (async () => {
		try {
			for await (let _output of machine) {
				// drain until the iterator throws
			}
		} catch (error) {
			caught = error
		}
	})()

	machine.dispatch({ type: 'add', value: 7 })
	await reader

	expect(machine.signal.aborted).toBe(true)
	expect((caught as Error).message).toBe('effect boom 7')
})

test('transition fault delivers prior outputs then iterator throws the reason', async () => {
	// Fault inside the drain: outputs before the fault are delivered, the iterator
	// THROWS the stop reason, and the internal destroy does not deadlock against the
	// drain it runs inside of.
	let machine = makeLifecycleMachine()

	let outputs: number[] = []
	let thrown: unknown = null
	let consume = (async () => {
		try {
			for await (let output of machine) {
				outputs.push(output.n)
			}
			return 'ended'
		} catch (error) {
			thrown = error
			return 'threw'
		}
	})()

	machine.dispatch({ type: 'emit', n: 1 })
	machine.dispatch({ type: 'boom' })
	machine.dispatch({ type: 'emit', n: 2 }) // queued after the fault — dropped by destroy

	let outcome = await Promise.race([consume, sleep(500).then(() => 'hung')])
	expect(outcome).toBe('threw')
	expect(outputs).toEqual([1])
	expect((thrown as Error).message).toBe('transition boom')
	expect(machine.signal.aborted).toBe(true)
})

test('effect fault delivers prior outputs then iterator throws the reason', async () => {
	// Fault from a suspended EFFECT handler: throwing is the hook's only
	// unrecoverable-error channel now that lifecycle access is gone.
	let machine = makeLifecycleMachine({
		onSuspend: async () => {
			await sleep(0)
			throw new Error('effect boom')
		},
	})

	let outputs: number[] = []
	let thrown: unknown = null
	let consume = (async () => {
		try {
			for await (let output of machine) {
				outputs.push(output.n)
			}
			return 'ended'
		} catch (error) {
			thrown = error
			return 'threw'
		}
	})()

	machine.dispatch({ type: 'emit', n: 1 })
	machine.dispatch({ type: 'slow' })

	let outcome = await Promise.race([consume, sleep(500).then(() => 'hung')])
	expect(outcome).toBe('threw')
	expect(outputs).toEqual([1])
	expect((thrown as Error).message).toBe('effect boom')
})
