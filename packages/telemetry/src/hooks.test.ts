import type { CallStartEvent } from '@ydbjs/core'
import { expect, test, vi } from 'vitest'

import { createTracingHooks } from './driver-hooks.js'
import { tracingContext } from './tracing-context.js'

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

test('onCall does nothing when no span in context', () => {
	const hooks = createTracingHooks()
	const complete = tracingContext.run({}, () => hooks.onCall?.(makeCallStartEvent()))

	expect(complete).toBeUndefined()
})

test('onCall sets endpoint attributes and completion status', () => {
	const setAttribute = vi.fn()
	const span = { setAttribute }
	const hooks = createTracingHooks()

	const complete = tracingContext.run({ span }, () => hooks.onCall?.(makeCallStartEvent()))

	expect(setAttribute).toHaveBeenCalledWith('ydb.node.id', 42)
	expect(setAttribute).toHaveBeenCalledWith('ydb.node.dc', 'sas')
	expect(setAttribute).toHaveBeenCalledWith('network.peer.address', '10.1.2.3')
	expect(setAttribute).toHaveBeenCalledWith('network.peer.port', 2135)
	expect(typeof complete).toBe('function')

	complete?.({ grpcStatusCode: 14, duration: 25 })

	expect(setAttribute).toHaveBeenCalledWith('rpc.grpc.status_code', 14)
})

test('rpc.grpc.status_code is set only after completion callback call', () => {
	const setAttribute = vi.fn()
	const span = { setAttribute }
	const hooks = createTracingHooks()

	const complete = tracingContext.run({ span }, () => hooks.onCall?.(makeCallStartEvent()))
	expect(typeof complete).toBe('function')

	expect(setAttribute).not.toHaveBeenCalledWith('rpc.grpc.status_code', expect.anything())

	complete?.({ grpcStatusCode: 0, duration: 1 })

	expect(setAttribute).toHaveBeenCalledWith('rpc.grpc.status_code', 0)
})

test('onCall skips dc and peer parsing when endpoint data is not parseable', () => {
	const setAttribute = vi.fn()
	const span = { setAttribute }
	const hooks = createTracingHooks()

	const complete = tracingContext.run({ span }, () =>
		hooks.onCall?.(
			makeCallStartEvent({
				endpoint: {
					nodeId: 7n,
					address: 'localhost',
					location: '',
				},
			})
		)
	)

	expect(setAttribute).toHaveBeenCalledWith('ydb.node.id', 7)
	expect(setAttribute).not.toHaveBeenCalledWith('ydb.node.dc', expect.anything())
	expect(setAttribute).not.toHaveBeenCalledWith('network.peer.address', expect.anything())
	expect(setAttribute).not.toHaveBeenCalledWith('network.peer.port', expect.anything())
	expect(typeof complete).toBe('function')
})
