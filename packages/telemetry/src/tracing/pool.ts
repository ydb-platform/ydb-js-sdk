import { safeSubscribe } from '../safe.js'
import { SpanKind } from '../tracing.js'
import type { TracingSetup } from '../context-manager.js'

type ConnectionAddedMsg = { nodeId: bigint; address: string; location: string }
type ConnectionPessimizedMsg = { nodeId: bigint; address: string; location: string; until: number }
type ConnectionUnpessimizedMsg = {
	nodeId: bigint
	address: string
	location: string
	duration: number
}
type ConnectionRetiredMsg = { nodeId: bigint; address: string; location: string; reason: string }
type ConnectionRemovedMsg = { nodeId: bigint; address: string; location: string; reason: string }

/**
 * Subscribes to pool connection event channels and emits zero-duration child
 * spans under the currently active subscriber span.
 */
export function subscribePoolTracing(setup: TracingSetup): () => void {
	let { enterLeaf, finishOk, base } = setup

	let unsubAdded = safeSubscribe('ydb:pool.connection.added', (msg) => {
		let m = msg as ConnectionAddedMsg
		enterLeaf(m, 'ydb.pool.connection.added', {
			kind: SpanKind.INTERNAL,
			attributes: {
				...base,
				'ydb.node.id': Number(m.nodeId),
				'ydb.node.dc': m.location,
				'network.peer.address': m.address,
			},
		})
		finishOk(m)
	})

	let unsubPessimized = safeSubscribe('ydb:pool.connection.pessimized', (msg) => {
		let m = msg as ConnectionPessimizedMsg
		enterLeaf(m, 'ydb.pool.connection.pessimized', {
			kind: SpanKind.INTERNAL,
			attributes: {
				...base,
				'ydb.node.id': Number(m.nodeId),
				'ydb.node.dc': m.location,
				'network.peer.address': m.address,
			},
		})
		finishOk(m)
	})

	let unsubUnpessimized = safeSubscribe('ydb:pool.connection.unpessimized', (msg) => {
		let m = msg as ConnectionUnpessimizedMsg
		enterLeaf(m, 'ydb.pool.connection.unpessimized', {
			kind: SpanKind.INTERNAL,
			attributes: {
				...base,
				'ydb.node.id': Number(m.nodeId),
				'ydb.node.dc': m.location,
				'network.peer.address': m.address,
				'ydb.pool.pessimization.duration_ms': m.duration,
			},
		})
		finishOk(m)
	})

	let unsubRetired = safeSubscribe('ydb:pool.connection.retired', (msg) => {
		let m = msg as ConnectionRetiredMsg
		enterLeaf(m, 'ydb.pool.connection.retired', {
			kind: SpanKind.INTERNAL,
			attributes: {
				...base,
				'ydb.node.id': Number(m.nodeId),
				'ydb.node.dc': m.location,
				'network.peer.address': m.address,
				'ydb.pool.retire.reason': m.reason,
			},
		})
		finishOk(m)
	})

	let unsubRemoved = safeSubscribe('ydb:pool.connection.removed', (msg) => {
		let m = msg as ConnectionRemovedMsg
		enterLeaf(m, 'ydb.pool.connection.removed', {
			kind: SpanKind.INTERNAL,
			attributes: {
				...base,
				'ydb.node.id': Number(m.nodeId),
				'ydb.node.dc': m.location,
				'network.peer.address': m.address,
				'ydb.pool.remove.reason': m.reason,
			},
		})
		finishOk(m)
	})

	return () => {
		unsubAdded()
		unsubPessimized()
		unsubUnpessimized()
		unsubRetired()
		unsubRemoved()
	}
}
