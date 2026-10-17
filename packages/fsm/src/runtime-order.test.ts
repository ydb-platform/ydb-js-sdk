import { AsyncLocalStorage } from 'node:async_hooks'

import { abortable } from '@ydbjs/abortable'

import { expect, test } from 'vitest'

import { createMachineRuntime } from './runtime.js'

type Event = { type: string }
type Effect = { type: string }

function markMicrotasks(trace: string[], label: string): void {
	queueMicrotask(() => trace.push(`${label}:queue`))
	void Promise.resolve().then(() => trace.push(`${label}:promise`))
}

test('finishes effect-free transitions and state updates before dispatch returns', async () => {
	let trace: string[] = []
	await using machine = createMachineRuntime<number, {}, {}, Event, never, string>({
		initialState: 0,
		ctx: {},
		env: {},
		transition(_ctx, event, runtime) {
			trace.push(`${event.type}:${runtime.state}`)
			runtime.emit(event.type)
			return { state: runtime.state + 1 }
		},
		effects: {},
	})

	machine.dispatch({ type: 'first' })
	trace.push(`returned:${machine.state}`)
	machine.dispatch({ type: 'second' })
	trace.push(`returned:${machine.state}`)

	expect(trace).toEqual(['first:0', 'returned:1', 'second:1', 'returned:2'])
	await machine.close()
	let outputs: string[] = []
	for await (let output of machine) {
		outputs.push(output)
	}
	expect(outputs).toEqual(['first', 'second'])
})

test('drains reentrant effect-free events before dispatch returns', async () => {
	let trace: string[] = []
	await using machine = createMachineRuntime<number, {}, {}, Event, never, never>({
		initialState: 0,
		ctx: {},
		env: {},
		transition(_ctx, event, runtime) {
			trace.push(`${event.type}:${runtime.state}`)
			if (event.type === 'first') {
				runtime.dispatch({ type: 'second' })
				trace.push('first:after nested dispatch')
				return { state: 1 }
			}
		},
		effects: {},
	})

	machine.dispatch({ type: 'first' })
	trace.push('returned')
	expect(trace).toEqual(['first:0', 'first:after nested dispatch', 'second:1', 'returned'])
})

test('preserves one microtask boundary after each synchronous effect across queued events', async (tc) => {
	let trace: string[] = []
	let finished = Promise.withResolvers<void>()
	await using machine = createMachineRuntime<string, {}, {}, Event, Effect, never>({
		initialState: 'idle',
		ctx: {},
		env: {},
		transition(_ctx, event) {
			trace.push(`transition:${event.type}`)
			if (event.type === 'done') {
				finished.resolve()
				return
			}
			return { effects: [{ type: `${event.type}:1` }, { type: `${event.type}:2` }] }
		},
		effects: {
			'a:1': () => {
				trace.push('effect:a:1')
				markMicrotasks(trace, 'a:1')
			},
			'a:2': () => {
				trace.push('effect:a:2')
				markMicrotasks(trace, 'a:2')
			},
			'b:1': () => {
				trace.push('effect:b:1')
				markMicrotasks(trace, 'b:1')
			},
			'b:2': () => {
				trace.push('effect:b:2')
				markMicrotasks(trace, 'b:2')
			},
		},
	})

	machine.dispatch({ type: 'a' })
	machine.dispatch({ type: 'b' })
	machine.dispatch({ type: 'done' })
	trace.push('returned')
	markMicrotasks(trace, 'caller')
	await abortable(tc.signal, finished.promise)

	expect(trace).toEqual([
		'transition:a',
		'effect:a:1',
		'returned',
		'a:1:queue',
		'a:1:promise',
		'effect:a:2',
		'caller:queue',
		'caller:promise',
		'a:2:queue',
		'a:2:promise',
		'transition:b',
		'effect:b:1',
		'b:1:queue',
		'b:1:promise',
		'effect:b:2',
		'b:2:queue',
		'b:2:promise',
		'transition:done',
	])
})

test('resumes after a fulfilled native Promise at the same microtask boundary', async (tc) => {
	let trace: string[] = []
	let finished = Promise.withResolvers<void>()
	await using machine = createMachineRuntime<string, {}, {}, Event, Effect, never>({
		initialState: 'idle',
		ctx: {},
		env: {},
		transition() {
			return { effects: [{ type: 'first' }, { type: 'second' }] }
		},
		effects: {
			first: () => {
				trace.push('first')
				markMicrotasks(trace, 'effect')
				return Promise.resolve()
			},
			second: () => {
				trace.push('second')
				finished.resolve()
			},
		},
	})

	machine.dispatch({ type: 'start' })
	trace.push('returned')
	markMicrotasks(trace, 'caller')
	await abortable(tc.signal, finished.promise)
	expect(trace).toEqual([
		'first',
		'returned',
		'effect:queue',
		'effect:promise',
		'second',
		'caller:queue',
		'caller:promise',
	])
})

test('waits for a pending native Promise before its remaining effects', async (tc) => {
	let trace: string[] = []
	let gate = Promise.withResolvers<void>()
	let finished = Promise.withResolvers<void>()
	await using machine = createMachineRuntime<string, {}, {}, Event, Effect, never>({
		initialState: 'idle',
		ctx: {},
		env: {},
		transition() {
			return { effects: [{ type: 'first' }, { type: 'second' }] }
		},
		effects: {
			first: () => {
				trace.push('first')
				return gate.promise
			},
			second: () => {
				trace.push('second')
				finished.resolve()
			},
		},
	})

	try {
		machine.dispatch({ type: 'start' })
		await Promise.resolve()
		expect(trace).toEqual(['first'])
		markMicrotasks(trace, 'before release')
		gate.resolve()
		markMicrotasks(trace, 'after release')
		await abortable(tc.signal, finished.promise)
		expect(trace).toEqual([
			'first',
			'before release:queue',
			'before release:promise',
			'second',
			'after release:queue',
			'after release:promise',
		])
	} finally {
		gate.resolve()
	}
})

test('queues effect-dispatched events after events already accepted by the owner', async (tc) => {
	let trace: string[] = []
	let gate = Promise.withResolvers<void>()
	let finished = Promise.withResolvers<void>()
	await using machine = createMachineRuntime<string, {}, {}, Event, Effect, never>({
		initialState: 'idle',
		ctx: {},
		env: {},
		transition(_ctx, event) {
			trace.push(event.type)
			if (event.type === 'start') {
				return { effects: [{ type: 'block' }, { type: 'dispatch' }] }
			}
			if (event.type === 'nested') {
				finished.resolve()
			}
		},
		effects: {
			block: () => gate.promise,
			dispatch: (_ctx, _effect, runtime) => {
				trace.push('effect')
				runtime.dispatch({ type: 'nested' })
				trace.push('effect returned')
			},
		},
	})

	try {
		machine.dispatch({ type: 'start' })
		machine.dispatch({ type: 'queued' })
		gate.resolve()
		await abortable(tc.signal, finished.promise)
		expect(trace).toEqual(['start', 'effect', 'effect returned', 'queued', 'nested'])
	} finally {
		gate.resolve()
	}
})

test('aborts synchronously when a synchronous effect throws and preserves earlier output', async () => {
	let trace: string[] = []
	let failure = new Error('effect failed')
	await using machine = createMachineRuntime<string, {}, {}, Event, Effect, string>({
		initialState: 'idle',
		ctx: {},
		env: {},
		transition(_ctx, event, runtime) {
			trace.push(event.type)
			runtime.emit('accepted')
			runtime.dispatch({ type: 'queued' })
			return { effects: [{ type: 'fail' }, { type: 'unreachable' }] }
		},
		effects: {
			fail: () => {
				trace.push('fail')
				throw failure
			},
			unreachable: () => {
				trace.push('unreachable')
			},
		},
	})
	machine.signal.addEventListener('abort', () => trace.push('abort'), { once: true })

	expect(() => machine.dispatch({ type: 'start' })).not.toThrow()
	trace.push('returned')
	expect(trace).toEqual(['start', 'fail', 'abort', 'returned'])
	expect(machine.signal.reason).toBe(failure)
	let iterator = machine[Symbol.asyncIterator]()
	expect(await iterator.next()).toEqual({ value: 'accepted', done: false })
	await expect(iterator.next()).rejects.toBe(failure)
})

test('aborts on the rejection microtask when an effect returns a rejected Promise', async () => {
	let trace: string[] = []
	let failure = new Error('effect rejected')
	await using machine = createMachineRuntime<string, {}, {}, Event, Effect, never>({
		initialState: 'idle',
		ctx: {},
		env: {},
		transition(_ctx, event) {
			trace.push(event.type)
			return { effects: [{ type: 'fail' }, { type: 'unreachable' }] }
		},
		effects: {
			fail: () => {
				trace.push('fail')
				return Promise.reject(failure)
			},
			unreachable: () => {
				trace.push('unreachable')
			},
		},
	})
	machine.signal.addEventListener('abort', () => trace.push('abort'), { once: true })

	machine.dispatch({ type: 'start' })
	machine.dispatch({ type: 'queued' })
	trace.push('returned')
	expect(machine.signal.aborted).toBe(false)
	markMicrotasks(trace, 'caller')
	await expect(machine[Symbol.asyncIterator]().next()).rejects.toBe(failure)
	expect(trace).toEqual(['start', 'fail', 'returned', 'abort', 'caller:queue', 'caller:promise'])
})

test('closes after a pending effect and the accepted tail while refusing later input', async (tc) => {
	let trace: string[] = []
	let gate = Promise.withResolvers<void>()
	let reason = new Error('close')
	await using machine = createMachineRuntime<string, {}, {}, Event, Effect, string>({
		initialState: 'idle',
		ctx: {},
		env: {},
		transition(_ctx, event, runtime) {
			trace.push(event.type)
			runtime.emit(event.type)
			if (event.type === 'start') {
				return { effects: [{ type: 'block' }, { type: 'finish' }] }
			}
		},
		effects: {
			block: () => gate.promise,
			finish: () => {
				trace.push('finish')
				markMicrotasks(trace, 'finish')
			},
		},
	})
	machine.signal.addEventListener('abort', () => trace.push('abort'), { once: true })

	try {
		machine.dispatch({ type: 'start' })
		machine.dispatch({ type: 'queued' })
		let closing = machine.close(reason)
		machine.dispatch({ type: 'ignored' })
		expect(trace).toEqual(['start'])
		expect(machine.signal.aborted).toBe(false)
		gate.resolve()
		await abortable(tc.signal, closing)
		expect(trace).toEqual([
			'start',
			'finish',
			'finish:queue',
			'finish:promise',
			'queued',
			'abort',
		])
		expect(machine.signal.reason).toBe(reason)
		let outputs: string[] = []
		for await (let output of machine) {
			outputs.push(output)
		}
		expect(outputs).toEqual(['start', 'queued'])
	} finally {
		gate.resolve()
	}
})

test('runs terminal cleanup and the accepted tail before aborting', async (tc) => {
	let trace: string[] = []
	let initialGate = Promise.withResolvers<void>()
	let finalGate = Promise.withResolvers<void>()
	let terminalStarted = Promise.withResolvers<void>()
	let reason = new Error('terminal')
	await using machine = createMachineRuntime<string, {}, {}, Event, Effect, never>({
		initialState: 'idle',
		ctx: {},
		env: {},
		transition(_ctx, event, runtime) {
			trace.push(`${event.type}:${runtime.state}`)
			if (event.type === 'start') {
				return { effects: [{ type: 'block' }] }
			}
			if (event.type === 'terminal') {
				return { state: 'done', final: { reason }, effects: [{ type: 'cleanup' }] }
			}
		},
		effects: {
			block: () => initialGate.promise,
			cleanup: () => {
				trace.push('cleanup')
				terminalStarted.resolve()
				return finalGate.promise
			},
		},
	})
	machine.signal.addEventListener('abort', () => trace.push('abort'), { once: true })

	try {
		machine.dispatch({ type: 'start' })
		machine.dispatch({ type: 'terminal' })
		machine.dispatch({ type: 'tail' })
		initialGate.resolve()
		await abortable(tc.signal, terminalStarted.promise)
		machine.dispatch({ type: 'ignored' })
		expect(machine.state).toBe('done')
		expect(machine.signal.aborted).toBe(false)
		finalGate.resolve()
		await abortable(tc.signal, machine.close())
		expect(trace).toEqual(['start:idle', 'terminal:idle', 'cleanup', 'tail:done', 'abort'])
		expect(machine.signal.reason).toBe(reason)
	} finally {
		initialGate.resolve()
		finalGate.resolve()
	}
})

test('destroys immediately while an effect is pending and drops its remaining work', async (tc) => {
	let trace: string[] = []
	let gate = Promise.withResolvers<void>()
	let reason = new Error('destroy')
	await using machine = createMachineRuntime<string, {}, {}, Event, Effect, never>({
		initialState: 'idle',
		ctx: {},
		env: {},
		transition(_ctx, event) {
			trace.push(event.type)
			return { effects: [{ type: 'block' }, { type: 'unreachable' }] }
		},
		effects: {
			block: () => gate.promise,
			unreachable: () => {
				trace.push('unreachable')
			},
		},
	})
	machine.signal.addEventListener('abort', () => trace.push('abort'), { once: true })

	try {
		machine.dispatch({ type: 'start' })
		machine.dispatch({ type: 'queued' })
		let destroying = machine.destroy(reason)
		expect(trace).toEqual(['start', 'abort'])
		expect(machine.signal.reason).toBe(reason)
		await abortable(tc.signal, destroying)
		gate.resolve()
		await Promise.resolve()
		expect(trace).toEqual(['start', 'abort'])
		expect(await machine[Symbol.asyncIterator]().next()).toEqual({
			done: true,
			value: undefined,
		})
	} finally {
		gate.resolve()
	}
})

test('honors close requested through a transition closure after its effects finish', async (tc) => {
	let trace: string[] = []
	let gate = Promise.withResolvers<void>()
	let closing: Promise<void> | undefined
	let reason = new Error('transition close')
	await using machine = createMachineRuntime<string, {}, {}, Event, Effect, never>({
		initialState: 'idle',
		ctx: {},
		env: {},
		transition() {
			trace.push('transition')
			closing = machine.close(reason)
			trace.push('close returned')
			return { state: 'updated', effects: [{ type: 'block' }, { type: 'finish' }] }
		},
		effects: {
			block: () => gate.promise,
			finish: () => {
				trace.push('finish')
			},
		},
	})
	machine.signal.addEventListener('abort', () => trace.push('abort'), { once: true })

	try {
		machine.dispatch({ type: 'start' })
		trace.push(`dispatch returned:${machine.state}`)
		expect(machine.signal.aborted).toBe(false)
		gate.resolve()
		await abortable(tc.signal, closing!)
		expect(trace).toEqual([
			'transition',
			'close returned',
			'dispatch returned:updated',
			'finish',
			'abort',
		])
		expect(machine.signal.reason).toBe(reason)
	} finally {
		gate.resolve()
	}
})

test('keeps the drain owner context when another context queues and resolves work', async (tc) => {
	let context = new AsyncLocalStorage<string>()
	let trace: string[] = []
	let gate = Promise.withResolvers<void>()
	let finished = Promise.withResolvers<void>()
	await using machine = createMachineRuntime<string, {}, {}, Event, Effect, never>({
		initialState: 'idle',
		ctx: {},
		env: {},
		transition(_ctx, event) {
			trace.push(`${event.type}:${context.getStore()}`)
			if (event.type === 'start') {
				return { effects: [{ type: 'block' }, { type: 'finish' }] }
			}
			finished.resolve()
		},
		effects: {
			block: () => gate.promise,
			finish: () => {
				trace.push(`effect:${context.getStore()}`)
			},
		},
	})

	try {
		context.run('owner', () => machine.dispatch({ type: 'start' }))
		context.run('caller', () => machine.dispatch({ type: 'queued' }))
		context.run('resolver', () => gate.resolve())
		await abortable(tc.signal, finished.promise)
		expect(trace).toEqual(['start:owner', 'effect:owner', 'queued:owner'])
		expect(context.getStore()).toBeUndefined()
	} finally {
		gate.resolve()
		context.disable()
	}
})

test('captures context changed by a synchronous effect for the next effect', async (tc) => {
	let context = new AsyncLocalStorage<string>()
	let trace: string[] = []
	let finished = Promise.withResolvers<void>()
	await using machine = createMachineRuntime<string, {}, {}, Event, Effect, never>({
		initialState: 'idle',
		ctx: {},
		env: {},
		transition() {
			return { effects: [{ type: 'first' }, { type: 'second' }] }
		},
		effects: {
			first: () => {
				trace.push(`first:${context.getStore()}`)
				context.enterWith('changed')
			},
			second: () => {
				trace.push(`second:${context.getStore()}`)
				finished.resolve()
			},
		},
	})

	try {
		context.run('owner', () => machine.dispatch({ type: 'start' }))
		expect(context.getStore()).toBeUndefined()
		await abortable(tc.signal, finished.promise)
		expect(trace).toEqual(['first:owner', 'second:changed'])
	} finally {
		context.disable()
	}
})

test('preserves Promise subclass assimilation before continuing effects', async (tc) => {
	let trace: string[] = []
	let finished = Promise.withResolvers<void>()
	let fulfilled = new (class extends Promise<void> {})((resolve) => resolve())
	void fulfilled.then(() => trace.push('subclass observer'))
	await using machine = createMachineRuntime<string, {}, {}, Event, Effect, never>({
		initialState: 'idle',
		ctx: {},
		env: {},
		transition() {
			return { effects: [{ type: 'first' }, { type: 'second' }] }
		},
		effects: {
			first: () => {
				trace.push('first')
				markMicrotasks(trace, 'effect')
				return fulfilled
			},
			second: () => {
				trace.push('second')
				finished.resolve()
			},
		},
	})

	machine.dispatch({ type: 'start' })
	trace.push('returned')
	markMicrotasks(trace, 'caller')
	await abortable(tc.signal, finished.promise)
	expect(trace).toEqual([
		'first',
		'returned',
		'subclass observer',
		'effect:queue',
		'effect:promise',
		'caller:queue',
		'caller:promise',
		'second',
	])
})

test('reads a thenable immediately and invokes it on the assimilation microtask', async (tc) => {
	let trace: string[] = []
	let finished = Promise.withResolvers<void>()
	let thenable = {
		get then() {
			trace.push('get then')
			return (resolve: () => void) => {
				trace.push('call then')
				resolve()
			}
		},
	} as unknown as Promise<void>
	await using machine = createMachineRuntime<string, {}, {}, Event, Effect, never>({
		initialState: 'idle',
		ctx: {},
		env: {},
		transition() {
			return { effects: [{ type: 'first' }, { type: 'second' }] }
		},
		effects: {
			first: () => {
				trace.push('first')
				return thenable
			},
			second: () => {
				trace.push('second')
				finished.resolve()
			},
		},
	})

	machine.dispatch({ type: 'start' })
	trace.push('returned')
	markMicrotasks(trace, 'caller')
	await abortable(tc.signal, finished.promise)
	expect(trace).toEqual([
		'first',
		'get then',
		'returned',
		'call then',
		'caller:queue',
		'caller:promise',
		'second',
	])
})

test('awaits a native Promise without invoking its replaced then method', async (tc) => {
	let trace: string[] = []
	let finished = Promise.withResolvers<void>()
	let gate = Promise.withResolvers<void>()
	Object.defineProperty(gate.promise, 'then', {
		value: () => {
			throw new Error('native await does not call this method')
		},
	})
	await using machine = createMachineRuntime<string, {}, {}, Event, Effect, never>({
		initialState: 'idle',
		ctx: {},
		env: {},
		transition() {
			return { effects: [{ type: 'first' }, { type: 'second' }] }
		},
		effects: {
			first: () => gate.promise,
			second: () => {
				trace.push('second')
				finished.resolve()
			},
		},
	})

	try {
		machine.dispatch({ type: 'start' })
		gate.resolve()
		await abortable(tc.signal, finished.promise)
		expect(trace).toEqual(['second'])
		expect(machine.signal.aborted).toBe(false)
	} finally {
		gate.resolve()
	}
})

test('preserves transition result getter order before running terminal effects', async () => {
	let trace: string[] = []
	let stateReads = 0
	let finalReads = 0
	let effectReads = 0
	let reason = new Error('terminal getter')
	await using machine = createMachineRuntime<number, {}, {}, Event, Effect, never>({
		initialState: 0,
		ctx: {},
		env: {},
		transition() {
			trace.push('transition')
			return {
				get state() {
					stateReads += 1
					trace.push(`state:${stateReads}`)
					return stateReads
				},
				get final() {
					finalReads += 1
					trace.push(`final:${finalReads}`)
					return {
						get reason() {
							trace.push('reason')
							return reason
						},
					}
				},
				get effects() {
					effectReads += 1
					trace.push(`effects:${effectReads}`)
					return [{ type: 'finish' }]
				},
			}
		},
		effects: {
			finish: (_ctx, _effect, runtime) => {
				trace.push(`effect:${runtime.state}`)
			},
		},
	})
	machine.signal.addEventListener('abort', () => trace.push('abort'), { once: true })

	machine.dispatch({ type: 'start' })
	trace.push('returned')
	await machine.close()
	expect(trace).toEqual([
		'transition',
		'state:1',
		'state:2',
		'final:1',
		'final:2',
		'reason',
		'effects:1',
		'effects:2',
		'effects:3',
		'effect:2',
		'returned',
		'abort',
	])
	expect(machine.signal.reason).toBe(reason)
})

test('resumes a waiting close before microtasks scheduled by abort listeners', async (tc) => {
	let trace: string[] = []
	let gate = Promise.withResolvers<void>()
	let observed = Promise.withResolvers<void>()
	await using machine = createMachineRuntime<string, {}, {}, Event, Effect, never>({
		initialState: 'idle',
		ctx: {},
		env: {},
		transition() {
			return { effects: [{ type: 'wait' }] }
		},
		effects: { wait: () => gate.promise },
	})
	machine.signal.addEventListener(
		'abort',
		() => {
			trace.push('abort')
			let step = 0
			function checkpoint(): void {
				step += 1
				trace.push(`abort microtask:${step}`)
				if (step === 5) {
					observed.resolve()
				} else {
					queueMicrotask(checkpoint)
				}
			}
			queueMicrotask(checkpoint)
		},
		{ once: true }
	)

	try {
		machine.dispatch({ type: 'start' })
		let closing = machine.close().then(() => {
			trace.push('closed')
			return undefined
		})
		gate.resolve()
		await abortable(tc.signal, observed.promise)
		await closing
		expect(trace).toEqual([
			'abort',
			'abort microtask:1',
			'abort microtask:2',
			'abort microtask:3',
			'closed',
			'abort microtask:4',
			'abort microtask:5',
		])
	} finally {
		gate.resolve()
	}
})
