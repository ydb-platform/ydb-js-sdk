import { AsyncLocalStorage, createHook } from 'node:async_hooks'
import { setImmediate, setTimeout as sleep } from 'node:timers/promises'

import { abortable } from '@ydbjs/abortable'

import { expect, test } from 'vitest'

import { createMachineRuntime } from './runtime.js'

// async_hooks counts instrumented PROMISE resources, not physical heap allocations.
function promiseResourceCounter() {
	let count = 0
	let hook = createHook({
		init(_id, type) {
			if (type === 'PROMISE') {
				count += 1
			}
		},
	})

	return {
		hook,
		get count() {
			return count
		},
	}
}

function promiseHookWitness(): number {
	let counter = promiseResourceCounter()
	counter.hook.enable()
	try {
		Promise.resolve()
	} finally {
		counter.hook.disable()
	}
	return counter.count
}

test.skipIf(Boolean(process.versions.bun))(
	'idle dispatch does not create PROMISE resources for each synchronous transition',
	async () => {
		let witnessed = promiseHookWitness()
		expect(
			witnessed,
			'PROMISE async_hooks must observe a newly created promise'
		).toBeGreaterThan(0)

		let measure = async (count: number): Promise<number> => {
			await using machine = createMachineRuntime({
				initialState: 'ready',
				ctx: { processed: 0 },
				env: {},
				transition(ctx) {
					ctx.processed += 1
				},
				effects: {},
			})
			let counter = promiseResourceCounter()
			let event = { type: 'item' }

			counter.hook.enable()
			try {
				for (let index = 0; index < count; index++) {
					machine.dispatch(event)
				}
			} finally {
				counter.hook.disable()
			}

			expect(machine.ctx.processed).toBe(count)
			return counter.count
		}

		let small = await measure(1)
		let large = await measure(4000)
		expect(large).toBeLessThanOrEqual(small + 1)
	}
)

test.skipIf(Boolean(process.versions.bun))(
	'synchronous effects create at most one PROMISE resource per effect in a busy drain',
	async () => {
		let witnessed = promiseHookWitness()
		expect(
			witnessed,
			'PROMISE async_hooks must observe a newly created promise'
		).toBeGreaterThan(0)

		let measure = async (count: number): Promise<number> => {
			let effects = { effects: [{ type: 'record' as const }] }
			await using machine = createMachineRuntime({
				initialState: 'ready',
				ctx: { processed: 0, recorded: 0 },
				env: {},
				transition(ctx) {
					ctx.processed += 1
					return effects
				},
				effects: {
					record(ctx) {
						ctx.recorded += 1
					},
				},
			})
			let counter = promiseResourceCounter()
			let event = { type: 'item' }
			let checkpoint = setImmediate()

			counter.hook.enable()
			try {
				for (let index = 0; index < count; index++) {
					machine.dispatch(event)
				}
				await checkpoint
			} finally {
				counter.hook.disable()
			}

			expect(machine.ctx.processed).toBe(count)
			expect(machine.ctx.recorded).toBe(count)
			return counter.count
		}

		let small = await measure(64)
		let large = await measure(4096)
		// The event-loop checkpoint and runner may add a fixed number of PROMISE resources.
		expect(large - small).toBeLessThanOrEqual(4096 - 64 + 16)
	}
)

test('releases caller async context after a completed drain while the runtime remains alive', async (tc) => {
	let storage = new AsyncLocalStorage<Uint8Array>()
	let gate = Promise.withResolvers<void>()
	let entered = Promise.withResolvers<void>()
	let collected = false
	let registry = new FinalizationRegistry<void>(() => {
		collected = true
	})
	let effects = {
		effects: [{ type: 'record' }, { type: 'wait' }, { type: 'record' }],
	}
	await using machine = createMachineRuntime({
		initialState: 'ready',
		ctx: { recorded: 0, contextual: 0 },
		env: {},
		transition: () => effects,
		effects: {
			record(ctx) {
				ctx.recorded += 1
				if (storage.getStore()) {
					ctx.contextual += 1
				}
			},
			wait() {
				entered.resolve()
				return gate.promise
			},
		},
	})
	let dispatch = () => machine.dispatch({ type: 'item' })
	let start = () => {
		let payload = new Uint8Array(8 * 1024 * 1024)
		registry.register(payload.buffer, undefined)
		storage.run(payload, dispatch)
	}

	try {
		start()
		await abortable(tc.signal, entered.promise)
		gate.resolve()
		await machine.close()
		expect(machine.ctx.contextual).toBe(2)

		// The runtime stays reachable; only the completed drain's caller context can be collected.
		// oxlint-disable-next-line no-unmodified-loop-condition
		for (let attempt = 0; attempt < 40 && !collected; attempt++) {
			globalThis.gc!()
			// oxlint-disable-next-line no-await-in-loop
			await sleep(10, undefined, { signal: tc.signal })
		}
		expect(collected).toBe(true)
		expect(machine.ctx.recorded).toBe(2)
		expect(machine.signal.aborted).toBe(true)
	} finally {
		gate.resolve()
		storage.disable()
	}
})
