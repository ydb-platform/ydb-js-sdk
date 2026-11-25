import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { topic } from '@ydbjs/topic'

using driver = new Driver(process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2136/local')
await using sql = query(driver)
let name = 'demo-topic-' + randomUUID()
let path = sql.identifier(name)
await sql`CREATE TOPIC ${path} (CONSUMER \`demo-consumer\`)`
try {
	process.env.YDB_TOPIC = name
	await import('./index.js')

	await using reader = topic(driver).createReader({ topic: name, consumer: 'demo-consumer' })
	let payload
	for await (let batch of reader.read({ limit: 1, signal: AbortSignal.timeout(10_000) })) {
		payload = new TextDecoder().decode(batch[0].payload)
		break
	}
	assert.equal(payload, 'in tx')
} finally {
	await sql`DROP TOPIC ${path}`
}
