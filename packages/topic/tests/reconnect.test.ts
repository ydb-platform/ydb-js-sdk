import { channel } from 'node:diagnostics_channel'
import { once } from 'node:events'
import { type Socket, createConnection, createServer } from 'node:net'

import { create } from '@bufbuild/protobuf'
import {
	CreateTopicRequestSchema,
	DropTopicRequestSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { expect, inject, test } from 'vitest'

import { createTopicReader } from '../src/reader/index.ts'
import { createTopicWriter } from '../src/writer/index.ts'

test(
	'reconciles writes and commits after TCP disconnects with server responses withheld',
	{ timeout: 30_000 },
	async (tc) => {
		let upstream = new URL(inject('connectionString'))
		let sockets = new Set<Socket>()
		let responses = new Set<Socket>()
		let requestBytes = 0
		let proxy = createServer((client) => {
			let server = createConnection({ host: upstream.hostname, port: Number(upstream.port) })
			sockets.add(client)
			sockets.add(server)
			responses.add(server)
			client.on('data', (data) => {
				requestBytes += data.length
			})
			client.on('error', () => server.destroy())
			server.on('error', () => client.destroy())
			client.on('close', () => {
				sockets.delete(client)
				server.destroy()
			})
			server.on('close', () => {
				sockets.delete(server)
				responses.delete(server)
				client.destroy()
			})
			client.pipe(server).pipe(client)
		})
		let cut = () => {
			let count = sockets.size
			for (let socket of sockets) {
				socket.destroy()
			}
			return count
		}
		await using fault = {
			cut,
			async [Symbol.asyncDispose]() {
				cut()
				await proxy[Symbol.asyncDispose]()
			},
		}
		let disconnectAfterRequest = async (previousBytes: number) => {
			await expect.poll(() => requestBytes).toBeGreaterThan(previousBytes)
			expect(fault.cut()).toBeGreaterThan(0)
		}
		proxy.listen(0, '127.0.0.1')
		await once(proxy, 'listening', { signal: tc.signal })
		let address = proxy.address()
		if (!address || typeof address === 'string') {
			throw new Error('Expected TCP proxy address')
		}

		using admin = new Driver(upstream.toString(), { 'ydb.sdk.enable_discovery': false })
		await admin.ready(tc.signal)
		let service = admin.createClient(TopicServiceDefinition)
		await using topic = {
			path: `topic-tcp-reconnect-${Date.now()}`,
			async [Symbol.asyncDispose]() {
				await service.dropTopic(create(DropTopicRequestSchema, { path: topic.path }))
			},
		}
		await service.createTopic(
			create(CreateTopicRequestSchema, {
				path: topic.path,
				partitioningSettings: { minActivePartitions: 1n, maxActivePartitions: 1n },
				consumers: [{ name: 'consumer' }],
			}),
			{ signal: tc.signal }
		)

		using driver = new Driver(`grpc://127.0.0.1:${address.port}${upstream.pathname}`, {
			'ydb.sdk.enable_discovery': false,
		})
		await driver.ready(tc.signal)
		let readerEvents = channel('ydb:topic.reader.reconnecting')
		let writerEvents = channel('ydb:topic.writer.reconnecting')
		let onReaderReconnect = (event: unknown) => {
			if ((event as { driver: unknown }).driver === driver.identity) {
				reconnects.read++
			}
		}
		let onWriterReconnect = (event: unknown) => {
			if ((event as { driver: unknown }).driver === driver.identity) {
				reconnects.write++
			}
		}
		readerEvents.subscribe(onReaderReconnect)
		writerEvents.subscribe(onWriterReconnect)
		using reconnects = {
			read: 0,
			write: 0,
			[Symbol.dispose]() {
				readerEvents.unsubscribe(onReaderReconnect)
				writerEvents.unsubscribe(onWriterReconnect)
			},
		}
		await using writer = createTopicWriter(driver, { topic: topic.path, producer: 'producer' })
		await using reader = createTopicReader(driver, { topic: topic.path, consumer: 'consumer' })
		let committed = new Set<number>()
		let commitInterrupted = false
		let readTask = (async () => {
			for await (let batch of reader.read({ signal: tc.signal })) {
				if (!commitInterrupted && batch.some((message) => message.payload[0]! >= 20)) {
					commitInterrupted = true
					for (let server of responses) {
						server.pause()
					}
					let sentBefore = requestBytes
					let pending = reader.commit(batch)
					void pending.catch(() => {})
					await disconnectAfterRequest(sentBefore)
					await pending
				} else {
					await reader.commit(batch)
				}
				for (let message of batch) {
					committed.add(message.payload[0]!)
				}
				if (committed.size === 30) {
					break
				}
			}
		})()
		// Await the task below; attach its rejection handler before producing traffic.
		void readTask.catch(() => {})

		for (let round = 0; round < 3; round++) {
			let sentBefore = requestBytes
			if (round === 1) {
				for (let server of responses) {
					server.pause()
				}
			}
			for (let index = round * 10; index < (round + 1) * 10; index++) {
				writer.write(new Uint8Array([index]))
			}
			let flushed = writer.flush(tc.signal)
			void flushed.catch(() => {})
			if (round === 1) {
				// oxlint-disable-next-line no-await-in-loop
				await disconnectAfterRequest(sentBefore)
			}
			// oxlint-disable-next-line no-await-in-loop
			await expect(flushed).resolves.toBe(BigInt((round + 1) * 10))
			// oxlint-disable-next-line no-await-in-loop
			await expect.poll(() => committed.size).toBe((round + 1) * 10)
		}
		await readTask
		expect(commitInterrupted).toBe(true)
		expect([...committed].sort((a, b) => a - b)).toEqual(
			Array.from({ length: 30 }, (_, index) => index)
		)
		expect(reconnects.read).toBeGreaterThanOrEqual(2)
		expect(reconnects.write).toBeGreaterThanOrEqual(2)
	}
)
