import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { topic } from '@ydbjs/topic'

let cs = process.env.YDB_CONNECTION_STRING || 'grpc://localhost:2136/local'
let driver = new Driver(cs)
await driver.ready()

console.log('Connected to', cs)

// Basic non-transactional reader/writer
{
	let t = topic(driver)
	await using reader = t.createReader({ topic: '/Root/demo-topic', consumer: 'demo-consumer' })
	await using writer = t.createWriter({ topic: '/Root/demo-topic', producer: 'demo-producer' })

	writer.write(new TextEncoder().encode('hello'))
	await writer.flush()

	for await (let batch of reader.read()) {
		console.log('read batch size:', batch.length)
		await reader.commit(batch)
		break
	}
}

// Transactional reader/writer
{
	let t = topic(driver)
	let sql = query(driver)

	await sql.begin(async (tx) => {
		let reader = t.createTxReader(tx, driver, { topic: '/Root/demo-topic', consumer: 'demo-consumer' })

		for await (let batch of reader.read({ waitMs: 100 })) {
			console.log('read batch size:', batch.length)
			break
		}

		let writer = t.createTxWriter(tx, driver, { topic: '/Root/demo-topic', producer: 'tx-producer' })
		writer.write(new TextEncoder().encode('in tx'))
		// writer will flush on tx.onCommit
	})
}

driver.close()
console.log('Done')
