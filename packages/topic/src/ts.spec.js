/* oxlint-disable */

import { AnonymousAuthService, Driver as YDB } from 'ydb-sdk'

const db = new YDB({
	connectionString: 'grpc://localhost:2136?database=/local',
	authService: new AnonymousAuthService(),
})

let sql = query(db)

await sql`SELECT 1`

// let multiTopicReader = createTopicReader(
//     db,
//     'my-consumer',
//     {
//         topics: [
//             {path: '/', maxLagMs: 0},
//             {path: '/', partitions: [1, 2, 3], maxLagMs: 0, readFrom: new Date('2025-01-01')},
//         ],
//         deserialize: (value) => Buffer.from(value).toString('utf-8'),
//         receiveBufferSizeInBytes: 1024 * 1024,
//     } |
//         {
//             path: '/',
//             partitions: [1, 2, 3],

//             deserialize: (value) => Buffer.from(value).toString('utf-8'),
//             receiveBufferSizeInBytes: 1024 * 1024,
//             maxLagMs: 0,
//             readFrom: new Date('2025-01-01'),
//         },
// );

let multiTopicReader1 = createTopicReader(db, 'consumer', 'topicName', {
	deserialize: (value) => Buffer.from(value).toString('utf-8'),
})

let multiTopicReader2 = createTopicReader(
	db,
	'consumer',
	{ path: 'topicName', partitions: [1, 2, 3] },
	{
		deserialize: (value) => Buffer.from(value).toString('utf-8'),
	}
)

let multiTopicReader3 = createTopicReader(
	db,
	'consumer',
	[
		{ path: 'topicName', partitions: [1, 2, 3] },
		{ path: 'topicName', partitions: [1, 2, 3] },
	], // topics description
	{
		deserialize: (value) => Buffer.from(value).toString('utf-8'),
	}
)

let multiTopicReader4 = createTopicReader(db, 'consumer', 'topicName', {
	deserialize: (value) => Buffer.from(value).toString('utf-8'),
})

// ???
{
	/**tx*/

	createTopicTxReader(multiTopicReader1, tx)
}

sql.begin(
	async (tx) => {
		await tx`select 1`

		let writer = createTopicTxWriter(db, tx, 'topic', {
			producer: 'my-producer', // producerId отражает какую-то уникальную сущность
			partion: 10, // генерирует сервер, можно получить с сервера по describe topic
			codec: 'RAW',
			serialize: (value) => Buffer.from(value, 'utf-8'),
		})
		// TODO: add option for linger (like kafka): minBytes, minDelayMs, lingerBytes lingerMs, lingerCount // FUTURE!!!

		// TODO: Добавить ключкоторый будет означать дедупликацию
		// Если пользователь не указал producerId = генерим guid
		// Если мы в режиме no deduplication и не указали producerId = отправляем пустой

		let msg = new Message({
			payload: new Uint8Array([1, 2, 3]),
		})

		writer.write(new Uint8Array([1, 2, 3])) // send and in bg verify msg. Acc messages into internal buffer before send.
		writer.write([new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])])

		await writer.write(msg) // Wait ack, seqNo >= seqNo msg
		await writer.write([msg, msg, msg, msg])

		writer.flush() // send all messages in buffer to server // FUTURE!!!
		await writer.flush() // send all messages in buffer to server and wait ack

		/// READER

		// WARN IF IN TX

		await topicReader.readTx(tx)
		await topicReader.readBatchTx(tx, /** maxMessages */ 5)

		for await (let message of topicReader) {
			console.log(message)

			if (Math.random() > 0.5) {
				await topicReader.close()
			}
		}

		await topicReader.close()
	} /** WAIT ALL ACS, COMMIT */
)

sql.do(async (session) => {
	let tx = session.beginTransaction()

	await tx`select 1`

	let writer = createTopicTxWriter(db, tx, 'topic', {
		producerId, // ?
		serialize: (value) => Buffer.from(chunk, 'utf-8'),
	})

	writer.write(new Uint8Array([1, 2, 3]))

	writer.flush()

	await writer.close()

	/// READER
	let res = await topicReader.readTx(tx, /** maxMessages */ 5)
	await topicReader.readBatchTx(tx, /** maxMessages */ 5)

	await tx.commit()
})
