import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

export async function handler() {
	const provider = new MetadataCredentialsProvider({})

	const driver = new Driver(
		'grpcs://ydb.serverless.yandexcloud.net:2135/ru-central1/b1gh9qpnleo6mg7ov83v/etndqej6hqst8mklliso',
		{
			credentialsProvider: provider,
			'ydb.sdk.enable_discovery': false,
		}
	)

	await driver.ready()
	const sql = query(driver)
	const resultSets = await sql`SELECT 1 + 1 AS sum`
	console.log(resultSets) // [ [ { sum: 2 } ] ]

	return {
		statusCode: 200,
		body: resultSets,
	}
}
