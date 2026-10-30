import type { SessionCloseReason } from './session.js'

export type PoolState = 'starting' | 'open' | 'draining' | 'closing' | 'closed' | 'destroyed'
type SessionSlot = 'idle' | 'leased' | 'closing' | { request: number }
type RequestSlot = 'waiting' | { creation: number } | { session: number }

export interface PoolContext {
	maxSize: number
	minSize: number
	maxWaiters: number
	rootOperations: number
	continuingOperations: number
	nextCreation: number
	sessions: Map<number, SessionSlot>
	idle: number[]
	requests: Map<number, RequestSlot>
	waiters: Set<number>
	creates: Map<number, number | undefined>
	leases: Set<number>
}

export type PoolEvent =
	| { type: 'start' | 'progress' | 'close' | 'destroy' }
	| { type: 'acquire'; request: number }
	| { type: 'cancel'; request: number; reason: unknown }
	| { type: 'created'; creation: number }
	| { type: 'create_failed'; creation: number; error: unknown }
	| { type: 'accept'; request: number }
	| { type: 'handoff_failed'; request: number; session: number; error: unknown }
	| { type: 'release'; session: number; serverId: string; nodeId: bigint }
	| { type: 'lost'; session: number; reason: SessionCloseReason; error: unknown }
	| { type: 'session_closed'; session: number }

export type PoolCommand =
	| { type: 'opened' | 'abort' | 'closed' }
	| { type: 'create'; creation: number; request: number | undefined }
	| { type: 'cancel_create'; creation: number; reason: unknown }
	| { type: 'created'; session: number }
	| { type: 'offer' | 'deliver'; request: number; session: number }
	| { type: 'reject'; request: number; error: unknown }
	| { type: 'queued' | 'dequeued'; request: number }
	| { type: 'released'; serverId: string; nodeId: bigint }
	| {
			type: 'retire'
			session: number
			reason: SessionCloseReason
			mode: 'close' | 'destroy' | 'forget'
			announce: boolean
	  }
	| { type: 'forget'; session: number }

export interface PoolStep {
	state: PoolState
	commands: PoolCommand[]
	final: boolean
}

export function poolContext(maxSize: number, minSize: number, maxWaiters: number): PoolContext {
	return {
		maxSize,
		minSize,
		maxWaiters,
		rootOperations: 0,
		continuingOperations: 0,
		nextCreation: 0,
		sessions: new Map(),
		idle: [],
		requests: new Map(),
		waiters: new Set(),
		creates: new Map(),
		leases: new Set(),
	}
}

// Admission must be reserved before a queued actor effect can call user diagnostics.
// These are the only writes to the operation counters; the actor owns subsequent draining.
export function reservePoolOperation(
	context: PoolContext,
	continuing: boolean,
	admissionClosed: boolean
): 'closed' | 'full' | undefined {
	if (admissionClosed && !continuing) return 'closed'
	if (continuing) context.continuingOperations++
	else {
		if (context.rootOperations >= context.maxSize + context.maxWaiters) return 'full'
		context.rootOperations++
	}
	return undefined
}

export function finishPoolOperation(context: PoolContext, continuing: boolean): void {
	let key: 'continuingOperations' | 'rootOperations' = continuing
		? 'continuingOperations'
		: 'rootOperations'
	if (context[key] === 0)
		throw new Error('Session pool operation ended without matching admission.')
	context[key]--
}

function active(state: PoolState): boolean {
	return state === 'open' || state === 'draining'
}

function takeWaiter(context: PoolContext, commands: PoolCommand[]): number | undefined {
	let next = context.waiters.values().next()
	if (next.done) return undefined
	context.waiters.delete(next.value)
	commands.push({ type: 'dequeued', request: next.value })
	return next.value
}

function offer(
	context: PoolContext,
	request: number,
	session: number,
	commands: PoolCommand[]
): void {
	context.requests.set(request, { session })
	context.sessions.set(session, { request })
	commands.push({ type: 'offer', request, session })
}

function createSession(
	context: PoolContext,
	request: number | undefined,
	commands: PoolCommand[]
): void {
	let creation = context.nextCreation++
	context.creates.set(creation, request)
	if (request !== undefined) context.requests.set(request, { creation })
	commands.push({ type: 'create', creation, request })
}

function pump(context: PoolContext, state: PoolState, commands: PoolCommand[]): void {
	if (!active(state)) return
	while (context.waiters.size) {
		let session = context.idle.pop()
		if (session !== undefined) {
			offer(context, takeWaiter(context, commands)!, session, commands)
			continue
		}
		if (context.sessions.size + context.creates.size >= context.maxSize) return
		createSession(context, takeWaiter(context, commands)!, commands)
	}
}

function warm(context: PoolContext, state: PoolState, commands: PoolCommand[]): void {
	if (state !== 'open') return
	while (context.sessions.size + context.creates.size < context.minSize)
		createSession(context, undefined, commands)
}

function returnSession(
	context: PoolContext,
	state: PoolState,
	session: number,
	commands: PoolCommand[]
): void {
	let slot = context.sessions.get(session)
	if (slot === undefined || slot === 'closing') return
	context.sessions.set(session, 'idle')
	context.idle.push(session)
	pump(context, state, commands)
}

function rejectRequests(context: PoolContext, error: unknown, commands: PoolCommand[]): void {
	for (let request of context.waiters) commands.push({ type: 'dequeued', request })
	context.waiters.clear()
	for (let request of context.requests.keys()) commands.push({ type: 'reject', request, error })
	context.requests.clear()
}

export function transitionPool(
	context: PoolContext,
	state: PoolState,
	event: PoolEvent,
	closedError: unknown,
	fullError: unknown
): PoolStep {
	let commands: PoolCommand[] = []
	switch (event.type) {
		case 'start':
			if (state !== 'starting') break
			state = 'open'
			commands.push({ type: 'opened' })
			warm(context, state, commands)
			break
		case 'acquire': {
			if (!active(state)) {
				commands.push({ type: 'reject', request: event.request, error: closedError })
				break
			}
			let session = context.idle.pop()
			if (session !== undefined) offer(context, event.request, session, commands)
			else if (context.sessions.size + context.creates.size < context.maxSize)
				createSession(context, event.request, commands)
			else if (context.waiters.size >= context.maxWaiters)
				commands.push({ type: 'reject', request: event.request, error: fullError })
			else {
				context.requests.set(event.request, 'waiting')
				context.waiters.add(event.request)
				commands.push({ type: 'queued', request: event.request })
			}
			break
		}
		case 'cancel': {
			let request = context.requests.get(event.request)
			if (request === undefined) break
			context.requests.delete(event.request)
			if (request === 'waiting') {
				context.waiters.delete(event.request)
				commands.push({ type: 'dequeued', request: event.request })
			} else if ('creation' in request) {
				context.creates.set(request.creation, undefined)
				commands.push({
					type: 'cancel_create',
					creation: request.creation,
					reason: event.reason,
				})
			} else returnSession(context, state, request.session, commands)
			commands.push({ type: 'reject', request: event.request, error: event.reason })
			break
		}
		case 'created': {
			let known = context.creates.has(event.creation)
			let request = context.creates.get(event.creation)
			context.creates.delete(event.creation)
			if (!known || !active(state)) {
				commands.push({
					type: 'retire',
					session: event.creation,
					reason: 'pool_close',
					mode: 'destroy',
					announce: false,
				})
				break
			}
			context.sessions.set(event.creation, 'idle')
			commands.push({ type: 'created', session: event.creation })
			if (request !== undefined && context.requests.has(request))
				offer(context, request, event.creation, commands)
			else {
				context.idle.push(event.creation)
				pump(context, state, commands)
			}
			pump(context, state, commands)
			break
		}
		case 'create_failed': {
			let request = context.creates.get(event.creation)
			context.creates.delete(event.creation)
			if (request !== undefined && context.requests.delete(request))
				commands.push({ type: 'reject', request, error: event.error })
			pump(context, state, commands)
			break
		}
		case 'accept': {
			let request = context.requests.get(event.request)
			if (request === undefined || request === 'waiting' || !('session' in request)) break
			context.requests.delete(event.request)
			context.sessions.set(request.session, 'leased')
			context.leases.add(request.session)
			commands.push({ type: 'deliver', request: event.request, session: request.session })
			break
		}
		case 'handoff_failed':
			context.leases.delete(event.session)
			returnSession(context, state, event.session, commands)
			commands.push({ type: 'reject', request: event.request, error: event.error })
			break
		case 'release':
			if (!context.leases.delete(event.session)) break
			commands.push({ type: 'released', serverId: event.serverId, nodeId: event.nodeId })
			returnSession(context, state, event.session, commands)
			break
		case 'lost': {
			let slot = context.sessions.get(event.session)
			if (slot === undefined || slot === 'closing') break
			context.sessions.delete(event.session)
			let index = context.idle.indexOf(event.session)
			if (index !== -1) context.idle.splice(index, 1)
			if (typeof slot === 'object') {
				context.requests.delete(slot.request)
				commands.push({ type: 'reject', request: slot.request, error: event.error })
			}
			commands.push({
				type: 'retire',
				session: event.session,
				reason: event.reason,
				mode: 'forget',
				announce: true,
			})
			pump(context, state, commands)
			warm(context, state, commands)
			break
		}
		case 'session_closed':
			if (context.sessions.get(event.session) === 'closing')
				context.sessions.delete(event.session)
			commands.push({ type: 'forget', session: event.session })
			break
		case 'close':
			if (state === 'open' || state === 'starting') state = 'draining'
			break
		case 'destroy':
			if (state === 'destroyed') break
			commands.push({ type: 'abort' })
			rejectRequests(context, closedError, commands)
			for (let [session, slot] of context.sessions)
				commands.push({
					type: 'retire',
					session,
					reason: 'pool_close',
					mode: 'destroy',
					announce: slot !== 'closing',
				})
			context.sessions.clear()
			context.idle.length = 0
			if (state !== 'closed') commands.push({ type: 'closed' })
			state = 'destroyed'
			break
		case 'progress':
			break
	}
	if (state === 'draining' && context.rootOperations + context.continuingOperations === 0) {
		state = 'closing'
		commands.push({ type: 'abort' })
		rejectRequests(context, closedError, commands)
		context.idle.length = 0
		for (let session of context.sessions.keys()) {
			context.sessions.set(session, 'closing')
			commands.push({
				type: 'retire',
				session,
				reason: 'pool_close',
				mode: 'close',
				announce: true,
			})
		}
	}
	if (state === 'closing' && context.creates.size === 0 && context.sessions.size === 0) {
		state = 'closed'
		commands.push({ type: 'closed' })
	}
	return {
		state,
		commands,
		final:
			(state === 'closed' || state === 'destroyed') &&
			context.creates.size === 0 &&
			context.leases.size === 0 &&
			context.rootOperations + context.continuingOperations === 0,
	}
}
