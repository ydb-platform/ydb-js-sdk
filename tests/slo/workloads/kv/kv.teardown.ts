import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

import { installSafetyHandlers } from '../../lib/safety.ts'

installSafetyHandlers()

let driver = new Driver(process.env['YDB_CONNECTION_STRING']!)
await driver.ready()
let sql = query(driver)

console.log('[kv.teardown] dropping test table')
await sql`DROP TABLE IF EXISTS test;`
console.log('[kv.teardown] done')

driver.close()
process.exit(0)
