import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { topic } from '@ydbjs/topic'

let cs = process.env['YDB_CONNECTION_STRING'] || 'grpc://localhost:2136/local'
let driver = new Driver(cs)
let signal = AbortSignal.timeout(30_000)
let topicPath = 'demo-topic'

try {
	await driver.ready(signal)

	console.log('Connected to', cs)

	let t = topic(driver)
	let reader = t.createReader({
		topic: topicPath,
		consumer: 'demo-consumer',
	})

	try {
		let writer = t.createWriter({
			topic: topicPath,
			producer: 'demo-producer',
		})

		try {
			// Leave one message for the transactional reader below.
			writer.write(new TextEncoder().encode('hello'))
			writer.write(new TextEncoder().encode('transaction input'))
			await writer.flush(signal)

			for await (let batch of reader.read({ limit: 1, signal })) {
				if (batch.length === 0) {
					continue
				}

				console.log('read batch size:', batch.length)
				await reader.commit(batch)
				break
			}
		} finally {
			await writer.close()
		}
	} finally {
		await reader.close()
	}

	let sql = query(driver)

	try {
		await sql.begin({ signal }, async (tx, attemptSignal) => {
			let txReader = t.createTxReader(tx, {
				topic: topicPath,
				consumer: 'demo-consumer',
			})

			for await (let batch of txReader.read({ limit: 1, signal: attemptSignal })) {
				if (batch.length === 0) {
					continue
				}

				console.log('transactional batch size:', batch.length)
				break
			}

			let txWriter = t.createTxWriter(tx, {
				topic: topicPath,
				producer: 'tx-producer',
			})

			txWriter.write(new TextEncoder().encode('in tx'))
			// Transaction hooks commit offsets, drain writes and close both clients.
		})
	} finally {
		await sql.close()
	}
} finally {
	driver.close()
}

console.log('Done')
