import { workerData } from 'node:worker_threads'

import { create } from '@bufbuild/protobuf'
import { DropTopicRequestSchema, TopicServiceDefinition } from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'

import { installSafetyHandlers } from '../../lib/safety.ts'
import type { WorkerData } from '../../lib/worker-api.ts'

installSafetyHandlers()

let { params } = workerData as WorkerData
let topic = params['topic'] ?? 'slo-topic'

{
	using driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
	await driver.ready()
	let service = driver.createClient(TopicServiceDefinition)

	console.log('[topic.teardown] dropping topic %s', topic)
	try {
		await service.dropTopic(create(DropTopicRequestSchema, { path: topic }))
	} catch {
		// topic did not exist
	}
	console.log('[topic.teardown] done')
}

process.exit(0)
