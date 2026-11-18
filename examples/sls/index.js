import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

export async function handler(_event) {
	let credentialsProvider = new MetadataCredentialsProvider()
	let driver = new Driver(process.env.YDB_CONNECTION_STRING, {
		credentialsProvider,
		'ydb.sdk.enable_discovery': false,
	})

	try {
		await driver.ready()
		let sql = query(driver)

		try {
			let resultSets = await sql`SELECT 1 + 1 AS sum`
			return { statusCode: 200, body: { resultSets } }
		} finally {
			await sql.close()
		}
	} finally {
		driver.close()
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	handler({})
		.then((result) => {
			console.log('Result:', result)
		})
		.catch((error) => {
			console.error('Error:', error)
			process.exitCode = 1
		})
}
