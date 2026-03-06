// oxlint-disable no-await-in-loop

import { setTimeout as sleep } from 'node:timers/promises'

import { expect, test } from 'vitest'

import { createMachineRuntime } from './runtime.js'

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
	}).toThrow('runtime is not accepting new ingests')

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
