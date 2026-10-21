import { workerData } from 'node:worker_threads'

import { create } from '@bufbuild/protobuf'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { DropTopicRequestSchema, TopicServiceDefinition } from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'

import { installSafetyHandlers } from '../../lib/safety.ts'
import type { TopicWorkerData } from '../../lib/worker-api.ts'

installSafetyHandlers()

let { topic } = workerData as TopicWorkerData
{
	using driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
	let signal = AbortSignal.timeout(60_000)
	await driver.ready(signal)
	let service = driver.createClient(TopicServiceDefinition)
	let response = await service.dropTopic(create(DropTopicRequestSchema, { path: topic }), {
		signal,
	})
	if (!response.operation?.ready || response.operation.status !== StatusIds_StatusCode.SUCCESS) {
		throw new Error(`Topic cleanup failed: ${response.operation?.status}`)
	}
	console.info('[topic.teardown] dropped %s', topic)
}
process.exit(0)
