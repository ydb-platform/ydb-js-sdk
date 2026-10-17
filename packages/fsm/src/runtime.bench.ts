import assert from 'node:assert/strict'

import { bench } from 'vitest'

import { createMachineRuntime } from './runtime.js'

// One operation is a complete N-event burst, including runtime creation and disposal.
// Reported time and hz are wall time per burst and bursts/s, not CPU time or SDK throughput.
let timing = { time: 200, iterations: 3, warmupTime: 50, warmupIterations: 2 }

type Event = { type: 'item' } | { type: 'block' }
type RecordEffect = { type: 'record' }
type WaitEffect = { type: 'wait' }
type Context = { processed: number; recorded: number }

let item: Event = { type: 'item' }
let recorded: { effects: RecordEffect[] } = { effects: [{ type: 'record' }] }
let waiting: { effects: WaitEffect[] } = { effects: [{ type: 'wait' }] }

let transition = (ctx: Context): void => {
	ctx.processed += 1
}

for (let size of [128, 4000, 64000]) {
	bench(
		`raw transition / ${size} events per burst`,
		() => {
			let ctx = { processed: 0, recorded: 0 }
			for (let index = 0; index < size; index++) {
				transition(ctx)
			}
			assert.equal(ctx.processed, size)
		},
		timing
	)

	bench(
		`idle dispatch / ${size} events per burst`,
		async () => {
			await using machine = createMachineRuntime<'ready', Context, {}, Event, never, never>({
				initialState: 'ready',
				ctx: { processed: 0, recorded: 0 },
				env: {},
				transition,
				effects: {},
			})
			for (let index = 0; index < size; index++) {
				machine.dispatch(item)
			}
			await machine.close()
			assert.equal(machine.ctx.processed, size)
		},
		timing
	)

	bench(
		`blocked burst drain / ${size} events per burst`,
		async () => {
			let gate = Promise.withResolvers<void>()
			await using machine = createMachineRuntime<
				'ready',
				Context,
				{},
				Event,
				WaitEffect,
				never
			>({
				initialState: 'ready',
				ctx: { processed: 0, recorded: 0 },
				env: {},
				transition(ctx, event) {
					if (event.type === 'block') {
						return waiting
					}
					ctx.processed += 1
				},
				effects: { wait: () => gate.promise },
			})
			try {
				machine.dispatch({ type: 'block' })
				for (let index = 0; index < size; index++) {
					machine.dispatch(item)
				}
			} finally {
				gate.resolve()
			}
			await machine.close()
			assert.equal(machine.ctx.processed, size)
		},
		timing
	)

	for (let asynchronous of [false, true]) {
		bench(
			`${asynchronous ? 'resolved Promise' : 'sync'} effect / ${size} events per burst`,
			async () => {
				let record = (ctx: Context) => {
					ctx.recorded += 1
				}
				await using machine = createMachineRuntime<
					'ready',
					Context,
					{},
					Event,
					RecordEffect,
					never
				>({
					initialState: 'ready',
					ctx: { processed: 0, recorded: 0 },
					env: {},
					transition(ctx) {
						ctx.processed += 1
						return recorded
					},
					effects: {
						record: asynchronous
							? (ctx) => {
									record(ctx)
									return Promise.resolve()
								}
							: record,
					},
				})
				for (let index = 0; index < size; index++) {
					machine.dispatch(item)
				}
				await machine.close()
				assert.equal(machine.ctx.processed, size)
				assert.equal(machine.ctx.recorded, size)
			},
			timing
		)
	}

	bench(
		`emit and consume / ${size} events per burst`,
		async () => {
			await using machine = createMachineRuntime<'ready', Context, {}, Event, never, number>({
				initialState: 'ready',
				ctx: { processed: 0, recorded: 0 },
				env: {},
				transition(ctx, _event, runtime) {
					ctx.processed += 1
					runtime.emit(1)
				},
				effects: {},
			})
			let consuming = (async () => {
				let total = 0
				for await (let value of machine) {
					total += value
				}
				return total
			})()
			for (let index = 0; index < size; index++) {
				machine.dispatch(item)
			}
			await machine.close()
			assert.equal(await consuming, size)
			assert.equal(machine.ctx.processed, size)
		},
		timing
	)

	bench(
		`ingest and map / ${size} events per burst`,
		async () => {
			let ended = Promise.withResolvers<void>()
			async function* source(): AsyncGenerator<Event> {
				try {
					for (let index = 0; index < size; index++) {
						yield item
					}
				} finally {
					ended.resolve()
				}
			}
			await using machine = createMachineRuntime<'ready', Context, {}, Event, never, never>({
				initialState: 'ready',
				ctx: { processed: 0, recorded: 0 },
				env: {},
				transition,
				effects: {},
			})
			await using ingestion = machine.ingest(source(), (event) => event)
			await ended.promise
			await ingestion[Symbol.asyncDispose]()
			await machine.close()
			assert.equal(machine.ctx.processed, size)
		},
		timing
	)
}
