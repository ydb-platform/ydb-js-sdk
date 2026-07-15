import { status as Status, connectivityState } from '@grpc/grpc-js'
import type { InterceptingListener } from '@grpc/grpc-js'
import { expect, test, vi } from 'vitest'

import { BalancedChannel } from './channel.ts'
import type { Connection } from './conn.ts'
import type { EndpointPool } from './endpoints/endpoints-runtime.ts'
import { EMPTY_SNAPSHOT } from './endpoints/snapshot.ts'
import type { EndpointRef, RoutingSnapshot } from './endpoints/snapshot.ts'

// A drivable fake EndpointPool + Connection. The fake call records the wrapped
// listener BalancedChannel installs, so a test can fire onReceiveStatus directly.
let makeFakePool = function makeFakePool(state: EndpointRef['state'] = 'active') {
	let started: bigint[] = []
	let ended: bigint[] = []
	let reported: Array<{ nodeId: bigint; ok: boolean }> = []

	let ref = { nodeId: 7n, address: 'h:1', location: 'A', state } as EndpointRef
	let byNodeId = new Map<bigint, EndpointRef>([[7n, ref]])
	let snapshot = {
		byNodeId,
		prefer: [ref],
		fallback: [],
		pinned: new Map(),
		selfLocation: '',
		pileStatesPresent: false,
		pessimizedCount: state === 'pessimized' ? 1 : 0,
	} as unknown as RoutingSnapshot

	let installedListener: InterceptingListener | undefined
	let conn = {
		endpoint: { nodeId: 7n, address: 'h:1', location: 'A' },
		channel: {
			createCall: () => ({
				start(_metadata: unknown, listener: InterceptingListener) {
					installedListener = listener
				},
			}),
		},
	} as unknown as Connection

	let acquiredHard: bigint[] = []
	let pool = {
		snapshot,
		acquire: () => conn,
		acquireNode: (nodeId: bigint, opts?: { hard?: boolean }) => {
			if (opts?.hard) acquiredHard.push(nodeId)
			return conn
		},
		callStarted: (nodeId: bigint) => started.push(nodeId),
		callEnded: (nodeId: bigint) => ended.push(nodeId),
		penalize: (nodeId: bigint) => reported.push({ nodeId, ok: false }),
		recover: (nodeId: bigint) => reported.push({ nodeId, ok: true }),
	} as unknown as EndpointPool

	return {
		pool,
		started,
		ended,
		reported,
		acquiredHard,
		getListener: () => installedListener!,
	}
}

// Drive a full createCall → start → onReceiveStatus cycle with the given status.
let driveStatus = function driveStatus(
	fake: ReturnType<typeof makeFakePool>,
	code: number
): { propagated: number } {
	let bc = new BalancedChannel(fake.pool)
	let call = bc.createCall('/S/M', null, 'host', null, 0) as unknown as {
		start(m: unknown, l: InterceptingListener): void
	}
	let propagated = -1
	let downstream = {
		onReceiveMetadata() {},
		onReceiveMessage() {},
		onReceiveStatus(status: { code: number }) {
			propagated = status.code
		},
	} as unknown as InterceptingListener
	call.start({}, downstream)
	fake.getListener().onReceiveStatus({ code } as never)
	return { propagated }
}

test('reports node bad on UNAVAILABLE', () => {
	let fake = makeFakePool()
	driveStatus(fake, Status.UNAVAILABLE)
	expect(fake.reported).toEqual([{ nodeId: 7n, ok: false }])
})

test('reports node bad on DEADLINE_EXCEEDED', () => {
	let fake = makeFakePool()
	driveStatus(fake, Status.DEADLINE_EXCEEDED)
	expect(fake.reported).toEqual([{ nodeId: 7n, ok: false }])
})

test('does not report on a non-pessimizing error', () => {
	let fake = makeFakePool()
	driveStatus(fake, Status.INVALID_ARGUMENT)
	expect(fake.reported).toEqual([])
})

test('optimistically un-bans a pessimized node on OK', () => {
	let fake = makeFakePool('pessimized')
	driveStatus(fake, Status.OK)
	expect(fake.reported).toEqual([{ nodeId: 7n, ok: true }])
})

test('does not dispatch a per-RPC event when an active node succeeds', () => {
	let fake = makeFakePool('active')
	driveStatus(fake, Status.OK)
	expect(fake.reported).toEqual([])
})

test('releases the in-flight slot on every terminal status', () => {
	let fake = makeFakePool()
	driveStatus(fake, Status.OK)
	expect(fake.started).toEqual([7n])
	expect(fake.ended).toEqual([7n])
})

test('reports the outcome before propagating the status downstream', () => {
	let fake = makeFakePool()
	let order: string[] = []
	let bc = new BalancedChannel(fake.pool)
	let call = bc.createCall('/S/M', null, 'host', null, 0) as unknown as {
		start(m: unknown, l: InterceptingListener): void
	}
	let downstream = {
		onReceiveMetadata() {},
		onReceiveMessage() {},
		onReceiveStatus() {
			order.push('propagate')
		},
	} as unknown as InterceptingListener
	// Wrap penalize to record ordering relative to propagation (UNAVAILABLE below).
	let origPenalize = fake.pool.penalize.bind(fake.pool)
	;(fake.pool as { penalize: EndpointPool['penalize'] }).penalize = (nodeId) => {
		order.push('report')
		origPenalize(nodeId)
	}
	call.start({}, downstream)
	fake.getListener().onReceiveStatus({ code: Status.UNAVAILABLE } as never)
	expect(order).toEqual(['report', 'propagate'])
})

test('getConnectivityState is READY with endpoints and TRANSIENT_FAILURE without', () => {
	let fake = makeFakePool()
	let bc = new BalancedChannel(fake.pool)
	expect(bc.getConnectivityState(false)).toBe(connectivityState.READY)

	let empty = makeFakePool()
	;(empty.pool as { snapshot: RoutingSnapshot }).snapshot = EMPTY_SNAPSHOT
	let bc2 = new BalancedChannel(empty.pool)
	expect(bc2.getConnectivityState(false)).toBe(connectivityState.TRANSIENT_FAILURE)
})

// Reduce the fake pool's snapshot to only the given refs, with empty balanced tiers.
let degenerateSnapshot = function degenerateSnapshot(
	fake: ReturnType<typeof makeFakePool>,
	refs: Array<Partial<EndpointRef> & { nodeId: bigint }>,
	pinned: bigint[] = []
): void {
	let byNodeId = new Map(refs.map((r) => [r.nodeId, r as EndpointRef]))
	;(fake.pool as { snapshot: RoutingSnapshot }).snapshot = {
		byNodeId,
		prefer: [],
		fallback: [],
		pinned: new Map(pinned.map((id) => [id, byNodeId.get(id)!])),
		selfLocation: '',
		pileStatesPresent: false,
		pessimizedCount: refs.filter((r) => r.state === 'pessimized').length,
	} as unknown as RoutingSnapshot
}

test('reports TRANSIENT_FAILURE for a balanced channel when only pinned refs exist', () => {
	let fake = makeFakePool()
	degenerateSnapshot(fake, [{ nodeId: 9n, state: 'pinned' }], [9n])
	let bc = new BalancedChannel(fake.pool)
	// Balanced selection can never return a pinned-only ref — acquire() would throw.
	expect(bc.getConnectivityState(false)).toBe(connectivityState.TRANSIENT_FAILURE)
})

test('reports TRANSIENT_FAILURE for a balanced channel when only retired refs exist', () => {
	let fake = makeFakePool()
	degenerateSnapshot(fake, [{ nodeId: 1n, state: 'retired' }])
	let bc = new BalancedChannel(fake.pool)
	expect(bc.getConnectivityState(false)).toBe(connectivityState.TRANSIENT_FAILURE)
})

test('reports READY for a balanced channel when only pessimized refs exist', () => {
	let fake = makeFakePool()
	degenerateSnapshot(fake, [{ nodeId: 1n, state: 'pessimized' }])
	let bc = new BalancedChannel(fake.pool)
	// The last-resort tier still routes to a pessimized node.
	expect(bc.getConnectivityState(false)).toBe(connectivityState.READY)
})

test('reports READY for a soft-affinity channel when its node is known', () => {
	let fake = makeFakePool()
	// node 7 is in byNodeId — the soft-affinity tier resolves it even before the
	// balanced tiers are consulted.
	expect(new BalancedChannel(fake.pool, {}, 7n).getConnectivityState(false)).toBe(
		connectivityState.READY
	)
})

test('exposes the grpc-js Channel identity stubs', () => {
	let bc = new BalancedChannel(makeFakePool().pool)
	expect(bc.getTarget()).toBe('ydb-balanced-channel')
	expect(bc.getChannelzRef()).toMatchObject({ kind: 'channel', name: 'BalancedChannel' })
	let notified = false
	bc.watchConnectivityState(connectivityState.IDLE, 0, () => {
		notified = true
	})
	return new Promise<void>((resolve) => setImmediate(resolve)).then(() =>
		expect(notified).toBe(true)
	)
})

test('reports connectivity for a hard channel by its exact node only', () => {
	let fake = makeFakePool()
	degenerateSnapshot(fake, [{ nodeId: 9n, state: 'pinned' }], [9n])
	// The pinned node exists → the hard channel to it is READY...
	expect(new BalancedChannel(fake.pool, {}, 9n, true).getConnectivityState(false)).toBe(
		connectivityState.READY
	)
	// ...but a hard channel to an absent node is down even with healthy peers.
	let healthy = makeFakePool()
	expect(new BalancedChannel(healthy.pool, {}, 99n, true).getConnectivityState(false)).toBe(
		connectivityState.TRANSIENT_FAILURE
	)
})

test('a throwing onCall hook does not prevent the RPC from being created', () => {
	let fake = makeFakePool()
	let bc = new BalancedChannel(fake.pool, {
		onCall() {
			throw new Error('hook boom')
		},
	})
	// createCall must still return a usable call despite the throwing hook.
	expect(() => bc.createCall('/S/M', null, 'host', null, 0)).not.toThrow()
	expect(fake.started).toEqual([7n])
})

test('a hard channel routes every call through acquireNode({hard})', () => {
	let fake = makeFakePool()
	let bc = new BalancedChannel(fake.pool, {}, 7n, true)
	bc.createCall('/S/M', null, 'host', null, 0)
	expect(fake.acquiredHard).toEqual([7n])
})

test('a soft channel does not hard-acquire', () => {
	let fake = makeFakePool()
	let bc = new BalancedChannel(fake.pool, {}, 7n, false)
	bc.createCall('/S/M', null, 'host', null, 0)
	expect(fake.acquiredHard).toEqual([])
})

test('onComplete receives the grpc status code', () => {
	let fake = makeFakePool()
	let complete = vi.fn()
	let bc = new BalancedChannel(fake.pool, {
		onCall: () => complete,
	})
	let call = bc.createCall('/S/M', null, 'host', null, 0) as unknown as {
		start(m: unknown, l: InterceptingListener): void
	}
	call.start({}, {
		onReceiveMetadata() {},
		onReceiveMessage() {},
		onReceiveStatus() {},
	} as unknown as InterceptingListener)
	fake.getListener().onReceiveStatus({ code: Status.OK } as never)
	expect(complete).toHaveBeenCalledWith(expect.objectContaining({ grpcStatusCode: Status.OK }))
})
