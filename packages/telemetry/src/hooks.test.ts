import type { CallStartEvent } from '@ydbjs/core'
import { expect, test, vi } from 'vitest'

import { createTracingHooks } from './hooks.js'
import { tracingContext } from './tracing-context.js'
import { SPAN_NAMES } from './tracing.js'

function makeCallStartEvent(overrides?: Partial<CallStartEvent>): CallStartEvent {
	return {
		method: '/Ydb.Query.V1.QueryService/ExecuteQuery',
		endpoint: {
			nodeId: 42n,
			address: '10.1.2.3:2135',
			location: 'sas',
		},
		preferred: false,
		pool: {
			activeCount: 1,
			pessimizedCount: 0,
		},
		...overrides,
	}
}

function makeTracer() {
	const setAttribute = vi.fn()
	const setAttributes = vi.fn()
	const recordException = vi.fn()
	const setStatus = vi.fn()
	const end = vi.fn()
	const span = {
		setAttribute,
		setAttributes,
		recordException,
		setStatus,
		end,
		spanContext: () => ({ traceId: 'trace-id', spanId: 'span-id', traceFlags: 1 }),
		getId: () => '',
		runInContext: <T>(fn: () => T) => fn(),
	}
	const startSpan = vi.fn(() => span)
	const tracer = { startSpan }

	return { tracer, startSpan, span, setAttribute, setAttributes, recordException, setStatus, end }
}

test('onCall creates span and sets endpoint attributes', () => {
	const { tracer, startSpan, setAttribute, end } = makeTracer()
	const hooks = createTracingHooks('localhost', 2135, '/local', tracer)
	const complete = hooks.onCall?.(makeCallStartEvent())

	expect(startSpan).toHaveBeenCalledWith(
		SPAN_NAMES.ExecuteQuery,
		expect.objectContaining({ kind: 1 })
	)
	expect(setAttribute).toHaveBeenCalledWith('ydb.node.id', 42)
	expect(setAttribute).toHaveBeenCalledWith('ydb.node.dc', 'sas')
	expect(setAttribute).toHaveBeenCalledWith('network.peer.address', '10.1.2.3')
	expect(setAttribute).toHaveBeenCalledWith('network.peer.port', 2135)
	expect(typeof complete).toBe('function')
	complete?.({ grpcStatusCode: 0, duration: 25 })
	expect(end).toHaveBeenCalledTimes(1)
})

test('onBeforeCall injects traceparent when active span exists', () => {
	const { tracer } = makeTracer()
	const hooks = createTracingHooks('localhost', 2135, '/local', tracer)
	const metadata = { set: vi.fn() }

	tracingContext.run(
		{
			span: {
				getId: () => '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
			},
		},
		() => hooks.onBeforeCall?.(makeCallStartEvent(), metadata as any)
	)

	expect(metadata.set).toHaveBeenCalledWith(
		'traceparent',
		'00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'
	)
})

test('onCall ignores methods outside instrumented set', () => {
	const { tracer, startSpan } = makeTracer()
	const hooks = createTracingHooks('localhost', 2135, '/local', tracer)
	const complete = hooks.onCall?.(
		makeCallStartEvent({ method: '/Ydb.Scripting.V1.ScriptingService/ExplainYqlScript' })
	)
	expect(complete).toBeUndefined()
	expect(startSpan).not.toHaveBeenCalled()
})

test('rpc.grpc.status_code is set and error is finalized on grpc failure', () => {
	const { tracer, setAttribute, setAttributes, recordException, setStatus, end } = makeTracer()
	const hooks = createTracingHooks('localhost', 2135, '/local', tracer)
	const complete = hooks.onCall?.(makeCallStartEvent())

	expect(typeof complete).toBe('function')
	complete?.({ grpcStatusCode: 14, duration: 1 })
	expect(setAttribute).toHaveBeenCalledWith('rpc.grpc.status_code', 14)
	expect(setAttributes).toHaveBeenCalled()
	expect(recordException).toHaveBeenCalled()
	expect(setStatus).toHaveBeenCalled()
	expect(end).toHaveBeenCalledTimes(1)
})

test('onCall skips dc and peer parsing when endpoint data is not parseable', () => {
	const { tracer, setAttribute } = makeTracer()
	const hooks = createTracingHooks('localhost', 2135, '/local', tracer)
	const complete = hooks.onCall?.(
		makeCallStartEvent({
			endpoint: {
				nodeId: 7n,
				address: 'localhost',
				location: '',
			},
		})
	)

	expect(setAttribute).toHaveBeenCalledWith('ydb.node.id', 7)
	expect(setAttribute).not.toHaveBeenCalledWith('ydb.node.dc', expect.anything())
	expect(setAttribute).not.toHaveBeenCalledWith('network.peer.address', expect.anything())
	expect(setAttribute).not.toHaveBeenCalledWith('network.peer.port', expect.anything())
	expect(typeof complete).toBe('function')
})

test('onCall adds db.query.text when present in context', () => {
	const { tracer, setAttribute } = makeTracer()
	const hooks = createTracingHooks('localhost', 2135, '/local', tracer)

	tracingContext.run({ queryText: 'SELECT 1' }, () => {
		hooks.onCall?.(makeCallStartEvent())
	})

	expect(setAttribute).toHaveBeenCalledWith('db.query.text', 'SELECT 1')
})
