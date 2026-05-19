import type { ClientMiddleware, MethodDescriptor } from 'nice-grpc'
import { expect, test } from 'vitest'

import { addClientMiddleware, getRegisteredClientMiddlewares } from './middleware.ts'

test('appends middleware to the registry and removes it on dispose', () => {
	let before = getRegisteredClientMiddlewares().length
	let mw: ClientMiddleware = async function* (call, options) {
		return yield* call.next(call.request, options)
	}

	let handle = addClientMiddleware(mw)
	expect(getRegisteredClientMiddlewares()).toContain(mw)
	expect(getRegisteredClientMiddlewares().length).toBe(before + 1)

	handle[Symbol.dispose]()
	expect(getRegisteredClientMiddlewares()).not.toContain(mw)
	expect(getRegisteredClientMiddlewares().length).toBe(before)
})

test('passes outgoing calls through registered middleware', async () => {
	let seen: string | undefined
	using _ = addClientMiddleware(async function* (call, options) {
		seen = call.method.path
		return yield* call.next(call.request, options)
	})

	// Drive the registered middleware directly to confirm it fires when
	// composed into a chain. (Driver-level integration is covered by the
	// telemetry package's propagation test.)
	let mw = getRegisteredClientMiddlewares()[0]!
	let call = {
		method: { path: '/test/Method' } as unknown as MethodDescriptor,
		request: undefined,
		async *next() {
			yield undefined
		},
	}

	let gen = (mw as any)(call, {}) as AsyncGenerator
	for await (let chunk of gen) void chunk

	expect(seen).toBe('/test/Method')
})
