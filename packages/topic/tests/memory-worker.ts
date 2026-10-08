import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { channel } from 'node:diagnostics_channel'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { setTimeout as sleep, setImmediate as turn } from 'node:timers/promises'

import { create } from '@bufbuild/protobuf'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	Codec,
	CreateTopicRequestSchema,
	DropTopicRequestSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { GZIP_CODEC, RAW_CODEC, ZSTD_CODEC } from '../src/codec.ts'
import { type TopicReader, createTopicReader } from '../src/reader/index.ts'
import { type TopicWriter, createTopicWriter } from '../src/writer/index.ts'
import type { TopicMessage } from '../src/message.ts'

type JscMemory = { heapSize: number; extraMemorySize: number; objectCount: number }
export type MemoryRuntime = {
	name: 'node' | 'bun'
	version: string
	supportsActiveResources: boolean
}
export type MemorySample = ReturnType<typeof process.memoryUsage> & {
	phase: string
	scenario: string
	epoch: number
	activeResources: string[]
	jsc?: JscMemory
}
type ClosedClientLabel = {
	role: 'reader' | 'writer'
	generation: number
	partition?: number
	scenario: string
	epoch: number
}
export type MemoryReport = {
	runtime?: MemoryRuntime
	node: string
	platform: string
	arch: string
	epochs: number
	epochPauseMs: number
	payloadBytes: number
	messagesPerEpoch: number
	accepted: number[]
	acknowledged: number[]
	delivered: number[]
	committed: number[]
	reconnects: { reader: number; writer: number }
	closedClientsAlive: number
	closedClientsRemaining?: ClosedClientLabel[]
	retainedControlBytes: number
	samples: MemorySample[]
}
type Clients = {
	reader: TopicReader
	writers: TopicWriter[]
	close(scenario: string, epoch: number): Promise<void>
	destroy(): void
}

let payloadBytes = 32 * 1024
let messagesPerEpoch = 128
let epochs = Number(process.env['YDB_MEMORY_EPOCHS'] ?? 15)
assert(Number.isSafeInteger(epochs) && epochs >= 9 && epochs <= 1000)
let epochPauseMs = Number(process.env['YDB_MEMORY_EPOCH_PAUSE_MS'] ?? 0)
assert(Number.isSafeInteger(epochPauseMs) && epochPauseMs >= 0 && epochPauseMs <= 5000)
let bun = (globalThis as { Bun?: { version: string; gc(full: boolean): unknown } }).Bun
let runtime: MemoryRuntime = bun
	? { name: 'bun', version: bun.version, supportsActiveResources: false }
	: { name: 'node', version: process.version, supportsActiveResources: true }
let jscHeapStats: (() => JscMemory) | undefined
if (bun) {
	// Keep the Bun-only module out of the Node bundle's static dependency graph.
	let moduleName = 'bun:jsc'
	jscHeapStats = ((await import(moduleName)) as { heapStats: () => JscMemory }).heapStats
} else {
	assert.equal(typeof globalThis.gc, 'function', 'Memory worker requires --expose-gc')
}
let collect = () => (bun ? bun.gc(true) : globalThis.gc!())
let memorySample = (): Omit<MemorySample, 'phase' | 'scenario' | 'epoch'> => {
	let usage = process.memoryUsage()
	let jsc = jscHeapStats?.()
	return {
		...usage,
		activeResources: process.getActiveResourcesInfo(),
		...(jsc && {
			jsc: {
				heapSize: jsc.heapSize,
				extraMemorySize: jsc.extraMemorySize,
				objectCount: jsc.objectCount,
			},
		}),
	}
}
// SDK reconnect timers are unref'ed; the harness owns this process until the run finishes.
process.channel?.ref()
let signal = new AbortController()
process.once('SIGTERM', () => signal.abort(new Error('Memory workload interrupted')))
let codecs = [RAW_CODEC, GZIP_CODEC, ZSTD_CODEC]
let topic = `memory-${randomUUID()}`
let consumer = 'memory-consumer'
let producers = codecs.map((_, partition) => `${topic}-${partition}`)
let accepted = codecs.map(() => 0)
let acknowledged = codecs.map(() => 0)
let delivered = codecs.map(() => 0)
let committed = codecs.map(() => 0)
let reconnects = { reader: 0, writer: 0 }
let closedClients: Array<ClosedClientLabel & { ref: WeakRef<object> }> = []
let generation = 0
let retained: Uint8Array[] = []
let samples: MemorySample[] = []

let checkpoint = async (phase: string, epoch: number, scenario = 'closed') => {
	for (let pass = 0; pass < 3; pass++) {
		collect()
		// Buffer finalizers and socket shutdown callbacks run between collections.
		// oxlint-disable-next-line no-await-in-loop
		await turn()
	}
	let sample = { phase, scenario, epoch, ...memorySample() }
	samples.push(sample)
	console.log(JSON.stringify({ runtime, ...sample }))
}

let createPayload = (partition: number, sequence: number): Uint8Array => {
	let data = new Uint8Array(payloadBytes).fill((partition + sequence) % 251)
	let view = new DataView(data.buffer)
	view.setUint32(0, partition)
	view.setBigUint64(8, BigInt(sequence))
	return data
}

// End the read iterator frame before measuring drained or closed client reachability.
async function consumeEpoch(reader: TopicReader): Promise<void> {
	let batches: AsyncIterable<TopicMessage[]> = reader.read({
		limit: 16,
		signal: signal.signal,
	})
	// oxlint-disable-next-line no-await-in-loop
	for await (let batch of batches) {
		for (let message of batch) {
			let data = message.payload
			assert.equal(data.byteLength, payloadBytes)
			let view = new DataView(data.buffer, data.byteOffset, data.byteLength)
			let partition = view.getUint32(0)
			let sequence = Number(view.getBigUint64(8))
			assert.equal(sequence, delivered[partition]! + 1)
			assert.equal(message.producer, producers[partition])
			assert.equal(message.offset, BigInt(sequence - 1))
			assert.equal(message.partitionSession.deref()?.partitionId, BigInt(partition))
			let expected = (partition + sequence) % 251
			for (let index = 4; index < data.length; index++) {
				if (index >= 8 && index < 16) continue
				if (data[index] !== expected) throw new Error(`Payload mismatch at byte ${index}`)
			}
			delivered[partition] = sequence
		}
		// oxlint-disable-next-line no-await-in-loop
		await reader.commit(batch)
		committed = [...delivered]
		if (committed.every((count, partition) => count === accepted[partition])) break
	}
}

async function run() {
	await using driver = new Driver(process.env['YDB_CONNECTION_STRING']!, {
		'ydb.sdk.enable_discovery': false,
	})
	await driver.ready(signal.signal)
	let service = driver.createClient(TopicServiceDefinition)
	let result = await service.createTopic(
		create(CreateTopicRequestSchema, {
			path: topic,
			partitioningSettings: { minActivePartitions: 3n, maxActivePartitions: 3n },
			consumers: [{ name: consumer }],
			supportedCodecs: { codecs: [Codec.RAW, Codec.GZIP, Codec.ZSTD] },
		}),
		{ signal: signal.signal }
	)
	assert.equal(result.operation?.status, StatusIds_StatusCode.SUCCESS)
	let readerChannel = channel('ydb:topic.reader.reconnecting')
	let writerChannel = channel('ydb:topic.writer.reconnecting')
	let onReader = (event: unknown) => {
		if ((event as { driver: unknown }).driver === driver.identity) reconnects.reader++
	}
	let onWriter = (event: unknown) => {
		if ((event as { driver: unknown }).driver === driver.identity) reconnects.writer++
	}
	readerChannel.subscribe(onReader)
	writerChannel.subscribe(onWriter)
	using _ = {
		[Symbol.dispose]() {
			readerChannel.unsubscribe(onReader)
			writerChannel.unsubscribe(onWriter)
		},
	}

	let openClients = (): Clients => {
		let clientGeneration = generation++
		let reader = createTopicReader(driver, { topic, consumer, maxBufferBytes: 256n * 1024n })
		let writers = codecs.map((codec, partition) =>
			createTopicWriter(driver, {
				topic,
				producer: producers[partition]!,
				partitionId: BigInt(partition),
				codec,
				maxInflightCount: 16,
				maxBufferBytes: 8n * 1024n * 1024n,
			})
		)
		return {
			reader,
			writers,
			async close(scenario, epoch) {
				await reader.close()
				await Promise.all(writers.map((writer) => writer.close(signal.signal)))
				closedClients.push({
					ref: new WeakRef(reader),
					role: 'reader',
					generation: clientGeneration,
					scenario,
					epoch,
				})
				for (let [partition, writer] of writers.entries()) {
					closedClients.push({
						ref: new WeakRef(writer),
						role: 'writer',
						generation: clientGeneration,
						partition,
						scenario,
						epoch,
					})
				}
			},
			destroy() {
				reader.destroy()
				for (let writer of writers) writer.destroy()
			},
		}
	}
	let clients: Clients | undefined = openClients()
	let enqueue = () => {
		for (let partition = 0; partition < codecs.length; partition++) {
			for (let index = 0; index < messagesPerEpoch; index++) {
				let sequence = accepted[partition]! + 1
				let payload = createPayload(partition, sequence)
				clients!.writers[partition]!.write(payload, {
					metadataItems: { source: new Uint8Array([partition]) },
				})
				accepted[partition] = sequence
				// Intentional leak control for validating this fixture's memory verdict.
				if (process.env['YDB_MEMORY_RETAIN_PAYLOADS'] === '1') retained.push(payload)
			}
		}
	}
	try {
		for (let scenario of ['steady', 'reconnect', 'replace']) {
			for (let epoch = 0; epoch < epochs; epoch++) {
				enqueue()
				// oxlint-disable-next-line no-await-in-loop
				await Promise.all(
					clients!.writers.map(async (writer, partition) => {
						assert.equal(
							await writer.flush(signal.signal),
							BigInt(accepted[partition]!)
						)
						acknowledged[partition] = accepted[partition]!
					})
				)
				samples.push({
					phase: 'loaded',
					scenario,
					epoch,
					...memorySample(),
				})
				// oxlint-disable-next-line no-await-in-loop
				await consumeEpoch(clients!.reader)
				// oxlint-disable-next-line no-await-in-loop
				await checkpoint('drained', epoch, scenario)
				if (scenario === 'replace' && epoch + 1 < epochs) {
					// oxlint-disable-next-line no-await-in-loop
					await clients!.close(scenario, epoch)
					clients = undefined
					// oxlint-disable-next-line no-await-in-loop
					await sleep(10, undefined, { signal: signal.signal })
					// oxlint-disable-next-line no-await-in-loop
					await checkpoint('replaced', epoch, scenario)
					clients = openClients()
				} else if (scenario === 'reconnect' && epoch + 1 < epochs) {
					let disconnected = once(process, 'message', { signal: signal.signal })
					process.send!({ type: 'disconnect' })
					// oxlint-disable-next-line no-await-in-loop
					await disconnected
				}
				if (epochPauseMs > 0) {
					// oxlint-disable-next-line no-await-in-loop
					await sleep(epochPauseMs, undefined, { signal: signal.signal })
				}
			}
		}
		await clients!.close('final', epochs - 1)
		clients = undefined
	} finally {
		clients?.destroy()
		await service.dropTopic(create(DropTopicRequestSchema, { path: topic }), {
			signal: AbortSignal.timeout(5000),
		})
	}
	driver.close()
	await sleep(25)
	await checkpoint('closed', epochs)
}

try {
	await run()
	await checkpoint('released', epochs)
	let closedClientsRemaining = closedClients
		.filter(({ ref }) => ref.deref() !== undefined)
		.map((client) => {
			let label: ClosedClientLabel = {
				role: client.role,
				generation: client.generation,
				scenario: client.scenario,
				epoch: client.epoch,
			}
			if (client.partition !== undefined) label.partition = client.partition
			return label
		})
	let report: MemoryReport = {
		runtime,
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		epochs,
		epochPauseMs,
		payloadBytes,
		messagesPerEpoch,
		accepted,
		acknowledged,
		delivered,
		committed,
		reconnects,
		closedClientsAlive: closedClientsRemaining.length,
		closedClientsRemaining,
		retainedControlBytes: retained.reduce((bytes, payload) => bytes + payload.byteLength, 0),
		samples,
	}
	await writeFile(process.env['MEMORY_REPORT_FILE']!, JSON.stringify(report))
} catch (error) {
	console.error(error)
	process.exitCode = 1
} finally {
	process.disconnect?.()
}
