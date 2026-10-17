import {
	DiscoveryServiceDefinition,
	ListEndpointsResponseSchema,
	ListEndpointsResultSchema,
	WhoAmIResponseSchema,
} from '@ydbjs/api/discovery'
import { channel } from 'node:diagnostics_channel'
import { setTimeout as delay } from 'node:timers/promises'

import { create } from '@bufbuild/protobuf'
import { anyPack } from '@bufbuild/protobuf/wkt'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { createTestServer } from '../../../tests/grpc-server.ts'
import { expect, test } from 'vitest'

import { Driver } from './driver.ts'

// Controlled discovery can remove a node while its real RPC remains live.
test.for([false, true])(
	'rediscovery preserves the active call and reroutes new calls (GOAWAY: %s)',
	{ timeout: 10_000 },
	async (goaway, tc) => {
		let entered = Promise.withResolvers<void>()
		let release = Promise.withResolvers<void>()
		await using servers = {
			first: createTestServer(),
			second: createTestServer(),
			async [Symbol.asyncDispose]() {
				release.resolve()
				await Promise.all([this.first.shutdown(), this.second.shutdown()])
			},
		}
		let callsOnOriginal = 0
		let endpoints: { nodeId: number; address: string; port: number }[] = []
		servers.first.add(
			{
				listEndpoints: DiscoveryServiceDefinition.listEndpoints,
				whoAmI: DiscoveryServiceDefinition.whoAmI,
			},
			{
				async listEndpoints() {
					return create(ListEndpointsResponseSchema, {
						operation: {
							ready: true,
							status: StatusIds_StatusCode.SUCCESS,
							result: anyPack(
								ListEndpointsResultSchema,
								create(ListEndpointsResultSchema, { endpoints })
							),
						},
					})
				},
				async whoAmI() {
					if (++callsOnOriginal === 1) {
						entered.resolve()
						await release.promise
					}
					return create(WhoAmIResponseSchema, { operation: { id: 'original' } })
				},
			}
		)
		servers.second.add(
			{ whoAmI: DiscoveryServiceDefinition.whoAmI },
			{
				async whoAmI() {
					return create(WhoAmIResponseSchema, { operation: { id: 'replacement' } })
				},
			}
		)
		let firstPort = await servers.first.listen('127.0.0.1:0')
		let secondPort = await servers.second.listen('127.0.0.1:0')
		endpoints = [{ nodeId: 1, address: '127.0.0.1', port: firstPort }]
		using driver = new Driver(`grpc://127.0.0.1:${firstPort}/local`, {
			'ydb.sdk.discovery_interval_ms': 200,
			'ydb.sdk.discovery_timeout_ms': 100,
			'ydb.sdk.connection_idle_interval_ms': 10,
			'ydb.sdk.connection_idle_timeout_ms': 0,
		})
		await driver.ready(tc.signal)
		let retired = channel('ydb:driver.connection.retired')
		let onRetired = (event: unknown) => {
			let info = event as { driver: unknown; nodeId: bigint }
			if (info.driver === driver.identity && info.nodeId === 1n) {
				observed.retired = true
			}
		}
		using observed = {
			retired: false,
			[Symbol.dispose]() {
				retired.unsubscribe(onRetired)
			},
		}
		retired.subscribe(onRetired)

		let client = driver.createClient(DiscoveryServiceDefinition)
		let completed = false
		let original = client.whoAmI({}, { signal: tc.signal })
		void original.then(
			() => {
				completed = true
				return true
			},
			() => {
				completed = true
				return true
			}
		)
		await entered.promise
		endpoints = [{ nodeId: 2, address: '127.0.0.1', port: secondPort }]
		await expect.poll(() => observed.retired, { timeout: 5000 }).toBe(true)

		let replacement = await client.whoAmI({}, { signal: tc.signal })
		expect(replacement.operation?.id).toBe('replacement')
		let shutdown = goaway ? servers.first.shutdown() : undefined
		// Let retirement sweeps run after GOAWAY while the existing RPC is still active.
		await delay(100, undefined, { signal: tc.signal })
		expect(completed).toBe(false)
		release.resolve()
		await expect(original).resolves.toMatchObject({ operation: { id: 'original' } })
		await shutdown
	}
)

// A controlled server can finish while the response consumer deliberately stays paused.
test.for(['drain', 'return', 'abort'] as const)(
	'graceful driver disposal waits for a buffered response consumer to %s',
	async (mode, tc) => {
		await using server = createTestServer()
		let port = 0
		let service = {
			messages: {
				path: '/test.Messages/Read',
				requestStream: false as const,
				responseStream: true as const,
				requestSerialize: () => Buffer.alloc(0),
				requestDeserialize: () => ({}),
				responseSerialize: (message: string) => Buffer.from(message),
				responseDeserialize: (bytes: Uint8Array) => Buffer.from(bytes).toString(),
			},
		}
		server.add(
			{ listEndpoints: DiscoveryServiceDefinition.listEndpoints, ...service },
			{
				async listEndpoints() {
					return create(ListEndpointsResponseSchema, {
						operation: {
							ready: true,
							status: StatusIds_StatusCode.SUCCESS,
							result: anyPack(
								ListEndpointsResultSchema,
								create(ListEndpointsResultSchema, {
									endpoints: [{ nodeId: 1, address: '127.0.0.1', port }],
								})
							),
						},
					})
				},
				async *messages() {
					yield 'first'
					yield 'second'
					yield 'third'
				},
			}
		)
		port = await server.listen('127.0.0.1:0')
		using driver = new Driver(`grpc://127.0.0.1:${port}/local`)
		await driver.ready(tc.signal)
		let client = driver.createClient(service)
		let controller = new AbortController()
		let terminal = Promise.withResolvers<void>()
		let statuses: number[] = []
		let stream = client.messages(
			{},
			{
				signal: AbortSignal.any([tc.signal, controller.signal]),
				onStatus(status) {
					statuses.push(status.code)
					terminal.resolve()
				},
			}
		)
		let responses = stream[Symbol.asyncIterator]()
		expect(await responses.next()).toMatchObject({ value: 'first', done: false })
		await terminal.promise
		expect(statuses).toEqual([0])

		let disposed = false
		let closing = driver[Symbol.asyncDispose]().then(() => {
			disposed = true
			return true
		})
		try {
			await delay(20, undefined, { signal: tc.signal })
			expect(disposed).toBe(false)
			let reason = new Error('Caller stopped after wire status')
			let outcome: unknown
			if (mode === 'drain') {
				outcome = [await responses.next(), await responses.next(), await responses.next()]
			} else if (mode === 'abort') {
				controller.abort(reason)
				outcome = await responses.next().catch((error: unknown) => error)
			} else {
				outcome = await responses.return?.()
			}
			let expected = {
				drain: [
					{ value: 'second', done: false },
					{ value: 'third', done: false },
					{ value: undefined, done: true },
				],
				abort: reason,
				return: { value: undefined, done: true },
			}
			expect(outcome).toEqual(expected[mode])
			await closing
			expect(disposed).toBe(true)
			expect(statuses).toEqual([0])
		} finally {
			await responses.return?.()
			await closing
		}
	}
)
