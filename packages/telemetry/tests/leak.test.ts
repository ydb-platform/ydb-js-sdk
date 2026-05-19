// oxlint-disable no-await-in-loop
import { tracingChannel } from 'node:diagnostics_channel'
import { afterEach, expect, test } from 'vitest'

import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

import { YdbInstrumentation } from '../src/index.ts'

let exporter = new InMemorySpanExporter()
let provider = new NodeTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(exporter)],
})
provider.register()

let active: YdbInstrumentation | undefined
afterEach(() => {
	active?.disable()
	active = undefined
	exporter.reset()
})

async function settle() {
	// Two GC + microtask cycles flush WeakRef deref reliably across V8 idle work.
	for (let i = 0; i < 5; i++) {
		global.gc!()
		await new Promise((r) => setImmediate(r))
	}
}

test('reclaims tracing channel ctx after tracePromise completes', async () => {
	active = new YdbInstrumentation()
	active.enable()

	let ch = tracingChannel('tracing:ydb:query.execute')
	let ref: WeakRef<object>

	await (async () => {
		let ctx = {
			text: 'SELECT 1',
			sessionId: 'leak-1',
			nodeId: 1n,
			idempotent: true,
			isolation: 'serializableReadWrite',
		}
		ref = new WeakRef(ctx)
		await ch.tracePromise(async () => {}, ctx)
	})()

	await settle()
	expect(ref!.deref()).toBeUndefined()
})

test('reclaims ctx via WeakMap on orphaned start without asyncEnd', async () => {
	active = new YdbInstrumentation()
	active.enable()

	let startCh = tracingChannel('tracing:ydb:query.execute')
	let ref: WeakRef<object>

	;(() => {
		let ctx = {
			text: 'SELECT 1',
			sessionId: 'leak-orphan',
			nodeId: 1n,
			idempotent: true,
			isolation: 'serializableReadWrite',
		}
		ref = new WeakRef(ctx)
		// Publish only `start` — asyncEnd / error never fire. WeakMap should
		// still let ctx be reclaimed once the local reference goes out of scope.
		startCh.start.publish(ctx)
	})()

	await settle()
	expect(ref!.deref()).toBeUndefined()
})

test('releases channel handler references after disable', async () => {
	let ref: WeakRef<YdbInstrumentation>

	;(() => {
		let inst = new YdbInstrumentation()
		inst.enable()
		inst.disable()
		ref = new WeakRef(inst)
	})()

	await settle()
	expect(ref!.deref()).toBeUndefined()
})

test('does not retain ctx across 1k tracePromise iterations', async () => {
	active = new YdbInstrumentation()
	active.enable()

	let ch = tracingChannel('tracing:ydb:query.execute')
	let lastRef: WeakRef<object> | undefined

	for (let i = 0; i < 1000; i++) {
		await (async () => {
			let ctx = {
				text: 'SELECT 1',
				sessionId: `s-${i}`,
				nodeId: 1n,
				idempotent: true,
				isolation: 'serializableReadWrite',
			}
			if (i === 999) lastRef = new WeakRef(ctx)
			await ch.tracePromise(async () => {}, ctx)
		})()
	}

	await settle()
	expect(lastRef!.deref()).toBeUndefined()
})

test('clears spanStorage ALS frame at tracePromise boundaries', async () => {
	active = new YdbInstrumentation()
	active.enable()

	let tx = tracingChannel('tracing:ydb:query.transaction')

	// Inside tx scope getActiveSubscriberSpan returns the Transaction span;
	// after tx.tracePromise resolves there must be no active span.
	let { getActiveSubscriberSpan } = await import('../src/context.ts')

	expect(getActiveSubscriberSpan()).toBeUndefined()

	await tx.tracePromise(async () => {}, {
		isolation: 'serializableReadWrite',
		idempotent: false,
	})

	expect(getActiveSubscriberSpan()).toBeUndefined()
})
