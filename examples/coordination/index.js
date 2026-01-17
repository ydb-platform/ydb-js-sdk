import { Driver } from '@ydbjs/core'
import { coordination } from '@ydbjs/coordination'

async function main() {
	console.log('YDB Coordination Example')
	console.log('========================\n')

	let connectionString =
		process.env.YDB_CONNECTION_STRING || 'grpc://localhost:2136/local'
	let driver = new Driver(connectionString)

	try {
		let client = coordination(driver)

		let nodePath = '/local/coordination-example'

		console.log('1. Creating coordination node...')
		await client.createNode(nodePath, {
			selfCheckPeriodMillis: 1000,
			sessionGracePeriodMillis: 10000,
		})
		console.log(`   ✓ Coordination node created: ${nodePath}\n`)

		console.log('2. Describing coordination node...')
		let nodeInfo = await client.describeNode(nodePath)
		console.log(
			'   ✓ Node info:',
			JSON.stringify(
				nodeInfo,
				(key, value) =>
					typeof value === 'bigint' ? value.toString() : value,
				2
			),
			'\n'
		)

		console.log('3. Creating coordination session...')
		let session = await client.session(nodePath, {
			timeoutMillis: 10000,
			description: 'Example coordination session',
		})
		console.log(`   ✓ Session created with ID: ${session.sessionId}\n`)

		console.log('4. Session operations...')
		console.log(`   Session ID: ${session.sessionId}`)
		console.log(`   Is closed: ${session.isClosed}\n`)

		console.log('5. Manual semaphore acquire/release...')
		await session.createSemaphore({
			name: 'example-lock',
			limit: 1,
		})
		console.log(`   ✓ Created semaphore 'example-lock' with limit 1`)

		let semaphore = await session.acquireSemaphore({
			name: 'example-lock',
			count: 1,
		})
		console.log(
			`   ✓ Acquired semaphore 'example-lock': ${semaphore.acquired}`
		)

		let released = await session.releaseSemaphore({
			name: 'example-lock',
		})
		console.log(`   ✓ Released semaphore 'example-lock': ${released}`)

		await session.deleteSemaphore({
			name: 'example-lock',
		})
		console.log(`   ✓ Deleted semaphore 'example-lock'\n`)

		console.log('6. Closing session...')
		await session.close()
		console.log('   ✓ Session closed\n')

		console.log('7. Cleaning up - dropping coordination node...')
		await client.dropNode(nodePath)
		console.log(`   ✓ Coordination node dropped: ${nodePath}\n`)

		console.log('Example completed successfully!')
	} catch (error) {
		console.error('Error:', error)
		process.exit(1)
	} finally {
		await driver.close()
	}
}

main()
