import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { topic } from '@ydbjs/topic'

let cs = process.env.YDB_CONNECTION_STRING || 'grpc://localhost:2136/local'
let topicPath = process.env.YDB_TOPIC || 'demo-topic'
let signal = AbortSignal.timeout(30_000)
using driver = new Driver(cs)
await driver.ready(signal)

console.log('Connected to', cs)

// Basic non-transactional reader/writer
{
	let t = topic(driver)
	await using reader = t.createReader({
		topic: topicPath,
		consumer: 'demo-consumer',
	})
	await using writer = t.createWriter({
		topic: topicPath,
		producer: 'demo-producer',
	})

	writer.write(new TextEncoder().encode('hello'))
	writer.write(new TextEncoder().encode('transaction input'))
	await writer.flush(signal)

	for await (let batch of reader.read({ limit: 1, signal })) {
		console.log('read batch size:', batch.length)
		await reader.commit(batch)
		break
	}
}

// Transactional reader/writer
{
	let t = topic(driver)
	await using sql = query(driver)

	await sql.begin({ signal }, async (tx, attemptSignal) => {
		let reader = t.createTxReader(tx, {
			topic: topicPath,
			consumer: 'demo-consumer',
		})

		for await (let batch of reader.read({ limit: 1, signal: attemptSignal })) {
			console.log('transactional batch size:', batch.length)
			break
		}

		let writer = t.createTxWriter(tx, {
			topic: topicPath,
			producer: 'tx-producer',
		})
		writer.write(new TextEncoder().encode('in tx'))
		// writer will flush on tx.onCommit
	})
}

console.log('Done')
