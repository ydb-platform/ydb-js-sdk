import { expect, test } from 'vitest'

import {
	type DiscoveredEndpoint,
	type EndpointsCtx,
	type EndpointsEffect,
	type EndpointsEvent,
	type EndpointsOutput,
	type EndpointsState,
	createEndpointsCtx,
	endpointsTransition,
} from './endpoints-state.ts'

type Harness = {
	ctx: EndpointsCtx
	state: EndpointsState
	emitted: EndpointsOutput[]
	effects: EndpointsEffect[]
	dispatched: EndpointsEvent[]
	final: boolean
}

let harness = function harness(state: EndpointsState = 'idle', ctx?: EndpointsCtx): Harness {
	return {
		ctx: ctx ?? createEndpointsCtx(),
		state,
		emitted: [],
		effects: [],
		dispatched: [],
		final: false,
	}
}

let step = function step(h: Harness, event: EndpointsEvent): void {
	h.emitted = []
	let runtime = {
		state: h.state,
		signal: new AbortController().signal,
		emit: (o: EndpointsOutput) => h.emitted.push(o),
		dispatch: (e: EndpointsEvent) => h.dispatched.push(e),
	}
	let result = endpointsTransition(h.ctx, event, runtime)
	if (result?.state !== undefined) h.state = result.state
	h.effects = result?.effects ?? []
	if (result?.final !== undefined) h.final = true
}

let ep = function ep(nodeId: number, over: Partial<DiscoveredEndpoint> = {}): DiscoveredEndpoint {
	return {
		nodeId: BigInt(nodeId),
		host: `n${nodeId}`,
		port: 2136,
		location: 'A',
		loadFactor: 0,
		sslTargetNameOverride: '',
		ipV4: [],
		ipV6: [],
		bridgePileName: '',
		services: [],
		...over,
	}
}

let round = function round(endpoints: DiscoveredEndpoint[]): EndpointsEvent {
	return {
		type: 'endpoints.discovery.round_succeeded',
		endpoints,
		selfLocation: 'A',
		pileStates: [],
	}
}

let outputs = function outputs<T extends EndpointsOutput['type']>(
	h: Harness,
	type: T
): Extract<EndpointsOutput, { type: T }>[] {
	return h.emitted.filter((o) => o.type === type) as Extract<EndpointsOutput, { type: T }>[]
}

let effectTypes = function effectTypes(h: Harness): string[] {
	return h.effects.map((e) => e.type)
}

let toReady = function toReady(endpoints: DiscoveredEndpoint[]): Harness {
	let h = harness()
	step(h, { type: 'endpoints.discovery.start' })
	step(h, round(endpoints))
	return h
}

// ── discovery lifecycle ──────────────────────────────────────────────────────

test('start moves idle to discovering and runs a round', () => {
	let h = harness()
	step(h, { type: 'endpoints.discovery.start' })
	expect(h.state).toBe('discovering')
	expect(effectTypes(h)).toContain('endpoints.effect.run_discovery_round')
	expect(h.ctx.roundInFlight).toBe(true)
})

test('first successful round becomes ready and emits ready once', () => {
	let h = toReady([ep(1), ep(2)])
	expect(h.state).toBe('ready')
	expect(outputs(h, 'endpoints.ready')).toHaveLength(1)
	expect(outputs(h, 'endpoints.added')).toHaveLength(2)
	expect(outputs(h, 'endpoints.snapshot')).toHaveLength(1)
	expect(outputs(h, 'endpoints.discovery_completed')).toHaveLength(1)
	expect(effectTypes(h)).toContain('endpoints.effect.timer.schedule')
})

test('a second successful round does not re-emit ready', () => {
	let h = toReady([ep(1)])
	step(h, round([ep(1), ep(2)]))
	expect(outputs(h, 'endpoints.ready')).toHaveLength(0)
	expect(outputs(h, 'endpoints.added')).toHaveLength(1)
})

test('retryable initial failure stays discovering and arms backoff', () => {
	let h = harness()
	step(h, { type: 'endpoints.discovery.start' })
	step(h, {
		type: 'endpoints.discovery.round_failed',
		error: new Error('unavailable'),
		retryable: true,
	})
	expect(h.state).toBe('discovering')
	expect(h.ctx.attempts).toBe(1)
	expect(effectTypes(h)).toContain('endpoints.effect.timer.schedule')
	expect(outputs(h, 'endpoints.discovery_failed')).toHaveLength(1)
})

test('non-retryable initial failure is terminal and emits failed', () => {
	let h = harness()
	step(h, { type: 'endpoints.discovery.start' })
	step(h, {
		type: 'endpoints.discovery.round_failed',
		error: new Error('access denied'),
		retryable: false,
	})
	expect(h.state).toBe('closed')
	expect(h.final).toBe(true)
	expect(outputs(h, 'endpoints.failed')).toHaveLength(1)
})

test('background round failure after ready is not terminal', () => {
	let h = toReady([ep(1)])
	step(h, {
		type: 'endpoints.discovery.round_failed',
		error: new Error('transient'),
		retryable: true,
	})
	expect(h.state).toBe('ready')
	expect(h.final).toBe(false)
	expect(outputs(h, 'endpoints.discovery_failed')).toHaveLength(1)
})

// ── registry mutations ───────────────────────────────────────────────────────

test('a node dropped from discovery is retired, keeping its channel', () => {
	let h = toReady([ep(1), ep(2)])
	step(h, round([ep(1)]))
	let retired = outputs(h, 'endpoints.retired')
	expect(retired).toHaveLength(1)
	expect(retired[0]!.nodeId).toBe(2n)
	expect(retired[0]!.reason).toBe('stale_active')
	expect(effectTypes(h)).toContain('endpoints.effect.retire_channel')
	expect(h.ctx.byNodeId.get(2n)!.subState).toBe('retired')
})

test('a reappearing retired node is revived in place, never closed', () => {
	let h = toReady([ep(1), ep(2)])
	step(h, round([ep(1)])) // node 2 retired
	step(h, round([ep(1), ep(2)])) // node 2 back
	expect(h.ctx.byNodeId.get(2n)!.subState).toBe('active')
	expect(outputs(h, 'endpoints.added')).toHaveLength(0) // revived, not re-added
	expect(effectTypes(h)).not.toContain('endpoints.effect.close_channel')
})

// ── pessimization (no timer) ─────────────────────────────────────────────────

test('rpc_failed pessimizes an active node and rebuilds the snapshot', () => {
	let h = toReady([ep(1), ep(2)])
	step(h, { type: 'endpoints.rpc_failed', nodeId: 1n })
	expect(h.ctx.byNodeId.get(1n)!.subState).toBe('pessimized')
	expect(outputs(h, 'endpoints.pessimized')).toHaveLength(1)
	expect(outputs(h, 'endpoints.snapshot')).toHaveLength(1)
})

test('rpc_failed on an already-pessimized node is a no-op', () => {
	let h = toReady([ep(1), ep(2)])
	step(h, { type: 'endpoints.rpc_failed', nodeId: 1n })
	step(h, { type: 'endpoints.rpc_failed', nodeId: 1n })
	expect(outputs(h, 'endpoints.pessimized')).toHaveLength(0)
	expect(outputs(h, 'endpoints.snapshot')).toHaveLength(0)
})

test('rpc_ok optimistically un-bans a pessimized node', () => {
	let h = toReady([ep(1), ep(2)])
	step(h, { type: 'endpoints.rpc_failed', nodeId: 1n })
	step(h, { type: 'endpoints.rpc_ok', nodeId: 1n })
	expect(h.ctx.byNodeId.get(1n)!.subState).toBe('active')
	expect(outputs(h, 'endpoints.unpessimized')).toHaveLength(1)
})

test('rpc_ok on an already-active node emits no snapshot (rebuild only on change)', () => {
	let h = toReady([ep(1), ep(2)])
	step(h, { type: 'endpoints.rpc_ok', nodeId: 1n })
	expect(outputs(h, 'endpoints.snapshot')).toHaveLength(0)
	expect(outputs(h, 'endpoints.unpessimized')).toHaveLength(0)
})

test('discovery blanket-un-bans a pessimized node', () => {
	let h = toReady([ep(1), ep(2)])
	step(h, { type: 'endpoints.rpc_failed', nodeId: 1n })
	step(h, round([ep(1), ep(2)]))
	expect(h.ctx.byNodeId.get(1n)!.subState).toBe('active')
	expect(outputs(h, 'endpoints.unpessimized')).toHaveLength(1)
})

test('crossing the degraded threshold forces a rediscovery round', () => {
	let h = toReady([ep(1), ep(2)]) // 2 active, threshold 0.5
	step(h, { type: 'endpoints.rpc_failed', nodeId: 1n }) // 1/2 pessimized == 0.5, not > 0.5
	expect(h.state).toBe('ready')
	step(h, { type: 'endpoints.rpc_failed', nodeId: 2n }) // 2/2 == 1.0 > 0.5
	expect(h.state).toBe('degraded')
	expect(effectTypes(h)).toContain('endpoints.effect.run_discovery_round')
})

// ── idle sweep + retired close ───────────────────────────────────────────────

test('idle_sweep timer produces an idle_sweep effect', () => {
	let h = toReady([ep(1)])
	step(h, { type: 'endpoints.timer.idle_sweep' })
	expect(effectTypes(h)).toContain('endpoints.effect.idle_sweep')
})

test('channel_closeable removes a retired node and closes its channel', () => {
	let h = toReady([ep(1), ep(2)])
	step(h, round([ep(1)])) // node 2 retired
	step(h, { type: 'endpoints.channel_closeable', nodeId: 2n })
	expect(h.ctx.byNodeId.has(2n)).toBe(false)
	let removed = outputs(h, 'endpoints.removed')
	expect(removed).toHaveLength(1)
	expect(removed[0]!.reason).toBe('idle')
	expect(effectTypes(h)).toContain('endpoints.effect.close_channel')
})

// ── direct-IO pins ───────────────────────────────────────────────────────────

test('pin adds a pinned entry and rebuilds the snapshot', () => {
	let h = toReady([ep(1)])
	step(h, {
		type: 'endpoints.pin',
		nodeId: 9n,
		host: 'n9',
		port: 2136,
		location: '',
		sslTargetNameOverride: '',
		ipV4: [],
		ipV6: [],
		generation: 1,
	})
	expect(h.ctx.pinned.get(9n)!.subState).toBe('pinned')
	expect(outputs(h, 'endpoints.snapshot')).toHaveLength(1)
})

test('invalidate removes a pin and closes its channel', () => {
	let h = toReady([ep(1)])
	step(h, {
		type: 'endpoints.pin',
		nodeId: 9n,
		host: 'n9',
		port: 2136,
		location: '',
		sslTargetNameOverride: '',
		ipV4: [],
		ipV6: [],
		generation: 1,
	})
	step(h, { type: 'endpoints.invalidate', nodeId: 9n })
	expect(h.ctx.pinned.has(9n)).toBe(false)
	expect(effectTypes(h)).toContain('endpoints.effect.close_channel')
})

// ── terminal ─────────────────────────────────────────────────────────────────

test('close with live channels drains via closing then finalizes on deadline', () => {
	let h = toReady([ep(1)])
	step(h, { type: 'endpoints.close' })
	expect(h.state).toBe('closing')
	expect(effectTypes(h)).toContain('endpoints.effect.timer.schedule')
	step(h, { type: 'endpoints.timer.close_deadline' })
	expect(h.state).toBe('closed')
	expect(h.final).toBe(true)
})

test('destroy is immediate and closes every channel', () => {
	let h = toReady([ep(1), ep(2)])
	step(h, { type: 'endpoints.destroy' })
	expect(h.state).toBe('closed')
	expect(h.final).toBe(true)
	expect(outputs(h, 'endpoints.removed')).toHaveLength(2)
	expect(effectTypes(h).filter((t) => t === 'endpoints.effect.close_channel')).toHaveLength(2)
})

test('events after closed are ignored with no effects', () => {
	let h = toReady([ep(1)])
	step(h, { type: 'endpoints.destroy' })
	step(h, { type: 'endpoints.rpc_failed', nodeId: 1n })
	expect(h.effects).toHaveLength(0)
	expect(h.emitted).toHaveLength(0)
})

test('idle close (no channels) finalizes immediately', () => {
	let h = harness()
	step(h, { type: 'endpoints.discovery.start' })
	step(h, { type: 'endpoints.close' })
	expect(h.state).toBe('closed')
	expect(h.final).toBe(true)
})
