// @ts-check
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { Driver } from '@ydbjs/core'
import { YDBError } from '@ydbjs/error'
import { query } from '@ydbjs/query'
import { defaultRetryConfig, retry } from '@ydbjs/retry'

let driver = new Driver(process.env.YDB_CONNECTION_STRING || 'grpc://localhost:2136/local')
let sql = query(driver)

let result = await retry(defaultRetryConfig, async () => {
	let [[result]] = await sql`SELECT CAST(version() as Text) as version;`

	if (Math.random() > 0.5) {
		throw new YDBError(StatusIds_StatusCode.UNAVAILABLE, [])
	}

	return result
})

console.log(`Result:`, result) // { version: 'stable-24-3' }
