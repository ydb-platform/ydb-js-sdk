import { workerData } from 'node:worker_threads'

import { create } from '@bufbuild/protobuf'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { Codec, CreateTopicRequestSchema, TopicServiceDefinition } from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'

import { installSafetyHandlers } from '../../lib/safety.ts'
import type { TopicWorkerData } from '../../lib/worker-api.ts'

installSafetyHandlers()

let { topic, consumer, partitions } = workerData as TopicWorkerData
{
	using driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
	let signal = AbortSignal.timeout(60_000)
	await driver.ready(signal)
	let service = driver.createClient(TopicServiceDefinition)
	let response = await service.createTopic(
		create(CreateTopicRequestSchema, {
			path: topic,
			partitioningSettings: {
				minActivePartitions: BigInt(partitions),
				maxActivePartitions: BigInt(partitions),
			},
			supportedCodecs: { codecs: [Codec.RAW, Codec.GZIP, Codec.ZSTD] },
			consumers: [{ name: consumer }],
		}),
		{ signal }
	)
	if (!response.operation?.ready || response.operation.status !== StatusIds_StatusCode.SUCCESS) {
		throw new Error(
			`Topic creation failed: ${response.operation?.status}, ${JSON.stringify(response.operation?.issues)}`
		)
	}
	console.info(
		'[topic.setup] created %s (%d partitions, consumer %s)',
		topic,
		partitions,
		consumer
	)
}
process.exit(0)
