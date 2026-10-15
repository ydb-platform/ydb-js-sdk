import {
	DiscoveryServiceDefinition,
	ListEndpointsResponseSchema,
	ListEndpointsResultSchema,
	WhoAmIResponseSchema,
} from '@ydbjs/api/discovery'
import { setImmediate } from 'node:timers/promises'

import { create } from '@bufbuild/protobuf'
import { anyPack } from '@bufbuild/protobuf/wkt'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { createTestServer } from '../../../tests/grpc-server.ts'
import { expect, test } from 'vitest'

import { Driver } from './driver.ts'

// Controlled discovery keeps the pinned node absent; a real cluster may discover it and hide the race.
async function pinFixture() {
	let discovery = createTestServer()
	let direct = createTestServer()
	let discoveryPort = 0
	let calls = 0

	discovery.add(
		{
			listEndpoints: DiscoveryServiceDefinition.listEndpoints,
			whoAmI: DiscoveryServiceDefinition.whoAmI,
		},
		{
			async listEndpoints() {
				return create(ListEndpointsResponseSchema, {
					operation: {
						status: StatusIds_StatusCode.SUCCESS,
						ready: true,
						result: anyPack(
							ListEndpointsResultSchema,
							create(ListEndpointsResultSchema, {
								endpoints: [
									{ nodeId: 1, address: '127.0.0.1', port: discoveryPort },
								],
							})
						),
					},
				})
			},
			async whoAmI() {
				return create(WhoAmIResponseSchema, { operation: { id: 'discovery' } })
			},
		}
	)

	direct.add(
		{ whoAmI: DiscoveryServiceDefinition.whoAmI },
		{
			async whoAmI() {
				calls++
				return create(WhoAmIResponseSchema, { operation: { id: 'direct' } })
			},
		}
	)

	discoveryPort = await discovery.listen('127.0.0.1:0')
	let port = await direct.listen('127.0.0.1:0')
	let driver = new Driver(`grpc://127.0.0.1:${discoveryPort}/local`)

	return {
		driver,
		discoveryPort,
		target: { nodeId: 9n, hard: true, endpoint: { host: '127.0.0.1', port } },
		get calls() {
			return calls
		},
		async [Symbol.asyncDispose]() {
			driver.close()
			await Promise.all([discovery.shutdown(), direct.shutdown()])
		},
	}
}

test.for([true, false])(
	'routes the first RPC immediately after creating an undiscovered pin (hard: %s)',
	async (hard, tc) => {
		await using fixture = await pinFixture()
		await fixture.driver.ready(tc.signal)

		using client = await fixture.driver.createPinnedClient(DiscoveryServiceDefinition, {
			...fixture.target,
			hard,
		})
		let response = await client.whoAmI({}, { signal: tc.signal })
		expect(response.operation?.id).toBe('direct')
	}
)

test('disposing one client preserves another client pin to the same node', async (tc) => {
	await using fixture = await pinFixture()
	await fixture.driver.ready(tc.signal)

	using first = await fixture.driver.createPinnedClient(
		DiscoveryServiceDefinition,
		fixture.target
	)
	using second = await fixture.driver.createPinnedClient(
		DiscoveryServiceDefinition,
		fixture.target
	)
	await setImmediate()
	await first.whoAmI({}, { signal: tc.signal })

	first[Symbol.dispose]()
	first[Symbol.dispose]()
	await setImmediate()

	let response = await second.whoAmI({}, { signal: tc.signal })
	expect(response.operation?.id).toBe('direct')

	second[Symbol.dispose]()
	await setImmediate()

	let unpinned = fixture.driver.createClient(DiscoveryServiceDefinition, {
		nodeId: 9n,
		hard: true,
	})
	await expect(unpinned.whoAmI({}, { signal: tc.signal })).rejects.toThrow(/No endpoint/)
})

test('disposing before the first RPC releases the original target after caller mutation', async (tc) => {
	await using fixture = await pinFixture()
	await fixture.driver.ready(tc.signal)

	using client = await fixture.driver.createPinnedClient(
		DiscoveryServiceDefinition,
		fixture.target
	)

	fixture.target.nodeId = 10n
	client[Symbol.dispose]()
	await setImmediate()
	await expect(client.whoAmI({}, { signal: tc.signal })).rejects.toThrow('Client is closed')
	expect(fixture.calls).toBe(0)

	let unpinned = fixture.driver.createClient(DiscoveryServiceDefinition, {
		nodeId: 9n,
		hard: true,
	})
	await expect(unpinned.whoAmI({}, { signal: tc.signal })).rejects.toThrow(/No endpoint/)
})

test('closing the driver rejects a pending client pin', async (tc) => {
	await using fixture = await pinFixture()
	await fixture.driver.ready(tc.signal)

	let pending = fixture.driver.createPinnedClient(
		DiscoveryServiceDefinition,
		fixture.target,
		tc.signal
	)
	fixture.driver.close()

	await expect(pending).rejects.toThrow(/(Driver is closed|Endpoints (destroyed|closed))/)
	expect(fixture.calls).toBe(0)
})

test('cancelling the first RPC leaves the client pin available for another call', async (tc) => {
	await using fixture = await pinFixture()
	await fixture.driver.ready(tc.signal)

	using client = await fixture.driver.createPinnedClient(
		DiscoveryServiceDefinition,
		fixture.target
	)
	let controller = new AbortController()

	let pending = client.whoAmI({}, { signal: controller.signal })
	controller.abort(new Error('Caller cancelled'))
	await expect(pending).rejects.toThrow(/aborted|Caller cancelled/i)

	let response = await client.whoAmI({}, { signal: tc.signal })
	expect(response.operation?.id).toBe('direct')
	expect(fixture.calls).toBe(1)
})

test('disposing an older client preserves a replacement pin address', async (tc) => {
	await using fixture = await pinFixture()
	await fixture.driver.ready(tc.signal)

	using first = await fixture.driver.createPinnedClient(
		DiscoveryServiceDefinition,
		fixture.target
	)
	await setImmediate()
	await first.whoAmI({}, { signal: tc.signal })

	using replacement = await fixture.driver.createPinnedClient(DiscoveryServiceDefinition, {
		...fixture.target,
		endpoint: { host: '127.0.0.1', port: fixture.discoveryPort, generation: 1 },
	})
	let response = await replacement.whoAmI({}, { signal: tc.signal })
	expect(response.operation?.id).toBe('discovery')

	first[Symbol.dispose]()
	await setImmediate()
	response = await replacement.whoAmI({}, { signal: tc.signal })
	expect(response.operation?.id).toBe('discovery')
})

test('disposing a retired handle again preserves a newly created pin', async (tc) => {
	await using fixture = await pinFixture()
	await fixture.driver.ready(tc.signal)

	using first = await fixture.driver.createPinnedClient(
		DiscoveryServiceDefinition,
		fixture.target
	)
	await first.whoAmI({}, { signal: tc.signal })

	first[Symbol.dispose]()

	using next = await fixture.driver.createPinnedClient(DiscoveryServiceDefinition, fixture.target)
	await next.whoAmI({}, { signal: tc.signal })

	first[Symbol.dispose]()
	await setImmediate()

	let response = await next.whoAmI({}, { signal: tc.signal })
	expect(response.operation?.id).toBe('direct')
})

test('keeps pin confirmations ordered when an earlier client is disposed', async (tc) => {
	await using fixture = await pinFixture()
	await fixture.driver.ready(tc.signal)

	using first = await fixture.driver.createPinnedClient(
		DiscoveryServiceDefinition,
		fixture.target
	)
	using second = await fixture.driver.createPinnedClient(DiscoveryServiceDefinition, {
		nodeId: 10n,
		hard: true,
		endpoint: { host: '127.0.0.1', port: fixture.discoveryPort },
	})

	first[Symbol.dispose]()
	let response = await second.whoAmI({}, { signal: tc.signal })

	expect(response.operation?.id).toBe('discovery')
	expect(fixture.calls).toBe(0)
})

test.for([false, true])(
	'routes pinned and discovered clients independently (pin first: %s)',
	async (pinFirst, tc) => {
		await using fixture = await pinFixture()
		await fixture.driver.ready(tc.signal)

		let discovered = fixture.driver.createClient(DiscoveryServiceDefinition, 1n)
		using pinned = await fixture.driver.createPinnedClient(DiscoveryServiceDefinition, {
			...fixture.target,
			nodeId: 1n,
		})

		let clients = pinFirst ? [pinned, discovered] : [discovered, pinned]
		let responses = []

		for (let client of clients) {
			// oxlint-disable-next-line no-await-in-loop
			let response = await client.whoAmI({}, { signal: tc.signal })
			responses.push(response.operation?.id)
		}

		expect(responses).toEqual(pinFirst ? ['direct', 'discovery'] : ['discovery', 'direct'])

		pinned[Symbol.dispose]()
		await setImmediate()

		let response = await discovered.whoAmI({}, { signal: tc.signal })
		expect(response.operation?.id).toBe('discovery')
	}
)

test('aborting pin acquisition releases the pending endpoint registration', async (tc) => {
	await using fixture = await pinFixture()
	await fixture.driver.ready(tc.signal)
	let controller = new AbortController()
	let pending = fixture.driver.createPinnedClient(
		DiscoveryServiceDefinition,
		fixture.target,
		controller.signal
	)

	controller.abort(new Error('pin cancelled'))
	await expect(pending).rejects.toThrow('pin cancelled')
	await setImmediate()

	let client = fixture.driver.createClient(DiscoveryServiceDefinition, { nodeId: 9n, hard: true })
	await expect(client.whoAmI({}, { signal: tc.signal })).rejects.toThrow(/No endpoint/)
	expect(fixture.calls).toBe(0)
})

test('service client close releases only its own pin and is idempotent with dispose', async (tc) => {
	await using fixture = await pinFixture()
	await fixture.driver.ready(tc.signal)
	using first = await fixture.driver.createPinnedClient(
		DiscoveryServiceDefinition,
		fixture.target,
		tc.signal
	)
	using second = await fixture.driver.createPinnedClient(
		DiscoveryServiceDefinition,
		fixture.target,
		tc.signal
	)

	first.close()
	first[Symbol.dispose]()
	await setImmediate()

	await expect(first.whoAmI({}, { signal: tc.signal })).rejects.toThrow('Client is closed')
	let response = await second.whoAmI({}, { signal: tc.signal })
	expect(response.operation?.id).toBe('direct')
})
