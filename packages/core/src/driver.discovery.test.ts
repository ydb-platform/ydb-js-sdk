import { channel } from 'node:diagnostics_channel'
import { setTimeout as delay } from 'node:timers/promises'

import { create } from '@bufbuild/protobuf'
import { anyPack } from '@bufbuild/protobuf/wkt'
import { DiscoveryServiceDefinition, ListEndpointsResultSchema } from '@ydbjs/api/discovery'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { createServer } from 'nice-grpc'
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
			first: createServer(),
			second: createServer(),
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
					return {
						operation: {
							ready: true,
							status: StatusIds_StatusCode.SUCCESS,
							result: anyPack(
								ListEndpointsResultSchema,
								create(ListEndpointsResultSchema, { endpoints })
							),
						},
					}
				},
				async whoAmI() {
					if (++callsOnOriginal === 1) {
						entered.resolve()
						await release.promise
					}
					return { operation: { id: 'original' } }
				},
			}
		)
		servers.second.add(
			{ whoAmI: DiscoveryServiceDefinition.whoAmI },
			{
				async whoAmI() {
					return { operation: { id: 'replacement' } }
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
