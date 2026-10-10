import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

import { create } from '@bufbuild/protobuf'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	Codec,
	CreateTopicRequestSchema,
	DropTopicRequestSchema,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'

import { installSafetyHandlers } from '../../lib/safety.ts'
import { type TopicWorkerResult, runTopicWorkers } from '../../lib/topic-workers.ts'
import { type WorkerData, abortOnStop } from '../../lib/worker-api.ts'

let { params } = workerData as WorkerData
let integer = function integer(key: string, fallback: number, min: number, max: number): number {
	let value = Number(params[key] ?? fallback)
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new RangeError(`${key} must be an integer between ${min} and ${max}`)
	}
	return value
}
let partitions = integer('partitions', 10, 1, 100)
let messageBytes = integer('size', 1024, 64, 8 * 1024 * 1024)
let rps = integer('rps', 100, 1, 100_000)
let drainTimeoutMs = integer('drainTimeoutMs', 120_000, 1, 600_000)
let stallTimeoutMs = integer('stallTimeoutMs', 120_000, 1, 600_000)
let runId = randomUUID()
let topic = `${params['topic'] ?? 'slo-topic'}-${runId}`
let consumer = 'slo-consumer'
let codec = params['codec'] ?? 'mixed'
if (codec !== 'mixed' && !['raw', 'gzip', 'zstd'].includes(codec))
	throw new Error(`Unsupported codec: ${codec}`)
let stopping = new AbortController()
let io = new AbortController()
let failure: Error | undefined
let results: { read: TopicWorkerResult; write: TopicWorkerResult } | undefined
let startedAt = Date.now()
let phase = 'starting'
let fail = (error: unknown) => {
	failure ??= error instanceof Error ? error : new Error(String(error))
	console.error('[topic.run] FAIL:', failure)
	parentPort!.postMessage({ type: 'workload-result', success: false, error: failure.message })
	stopping.abort()
	io.abort(failure)
}
installSafetyHandlers('log', (_, error) => fail(error))
using _ = abortOnStop(stopping)
let startup = setTimeout(() => fail(new Error('Topic startup timed out')), 60_000)
try {
	using driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
	await driver.ready(io.signal)
	let service = driver.createClient(TopicServiceDefinition)
	let created = await service.createTopic(
		create(CreateTopicRequestSchema, {
			path: topic,
			partitioningSettings: {
				minActivePartitions: BigInt(partitions),
				maxActivePartitions: BigInt(partitions),
			},
			supportedCodecs: { codecs: [Codec.RAW, Codec.GZIP, Codec.ZSTD] },
			consumers: [{ name: consumer }],
		}),
		{ signal: io.signal }
	)
	if (!created.operation?.ready || created.operation.status !== StatusIds_StatusCode.SUCCESS) {
		throw new Error(
			`Topic creation failed: ${created.operation?.status}, ${JSON.stringify(created.operation?.issues)}`
		)
	}
	clearTimeout(startup)
	phase = 'running'
	console.info(
		'[topic.run] %s',
		JSON.stringify({
			runId,
			topic,
			partitions,
			rps,
			messageBytes,
			codec,
			drainTimeoutMs,
			stallTimeoutMs,
		})
	)
	results = await runTopicWorkers(
		{
			read: new URL('./topic.read.js', import.meta.url),
			write: new URL('./topic.write.js', import.meta.url),
		},
		{
			runId,
			topic,
			consumer,
			partitions,
			messageBytes,
			rps,
			codec,
			drainTimeoutMs,
			stallTimeoutMs,
			params,
		},
		stopping.signal
	)
	io.signal.throwIfAborted()
	let dropped = await service.dropTopic(create(DropTopicRequestSchema, { path: topic }), {
		signal: io.signal,
	})
	if (!dropped.operation?.ready || dropped.operation.status !== StatusIds_StatusCode.SUCCESS)
		throw new Error(`Topic cleanup failed: ${dropped.operation?.status}`)
	phase = 'complete'
} catch (error) {
	fail(error)
} finally {
	clearTimeout(startup)
}
let summary = {
	...results?.read.summary,
	topic,
	codec,
	rps,
	phase,
	startedAt: new Date(startedAt).toISOString(),
	elapsedMs: Date.now() - startedAt,
	reconnects: { writer: results?.write.reconnects ?? 0, reader: results?.read.reconnects ?? 0 },
}
let success = !failure && summary.complete === true && phase === 'complete'
console.info('[topic.result] %s', JSON.stringify({ success, ...summary }))
try {
	let resultPath = process.env['TOPIC_RESULT_FILE']
	if (resultPath) {
		await mkdir(dirname(resultPath), { recursive: true })
		await writeFile(
			`${resultPath}.tmp`,
			JSON.stringify({ success, ...summary }, null, 2) + '\n'
		)
		await rename(`${resultPath}.tmp`, resultPath)
	}
} catch (error) {
	success = false
	console.error('[topic.run] cannot save result:', error)
}
parentPort!.postMessage({ type: 'workload-result', success, summary })
process.exit(success ? 0 : 1)
