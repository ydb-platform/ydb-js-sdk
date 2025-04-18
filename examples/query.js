/**
 * How to start
 * 1. Install YDB https://ydb.tech/docs/en/quickstart
 * 2. Start YDB
 * 3. Run this example with node.js
 * 4. Make sure to set the YDB_CONNECTION_STRING environment variable to your YDB connection string
 * 5. Run the example with `node examples/query.js`
 * 6. You should see the output `Count: 3`
 *
 * With DEBUG=* you can see the debug output
 * 7. You can also run the example with `DEBUG=ydbjs:* node examples/query.js`
 * 8. You should see the debug output
 */

import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { Json, Text, Uint8 } from '@ydbjs/value/primitive'
import { Optional } from '@ydbjs/value/optional'
import { fromJs } from '@ydbjs/value'

let connectionString = 'grpc://localhost:2136/local'
let driver = new Driver(connectionString)
let sql = query(driver)

await driver.ready()

sql`SELECT $myP1, $myP2, $myP3, $myP4`
	.param('myP1', new Text('Hello World'))
	.param('myP2', new Uint8(8))
	.param('myP3', new Optional(new Json({ hello: 'world' })))
	.param('myP4', fromJs([{ key: 1, value: 'Hello' }, { key: 2, value: null }, { key: 3 }]))

// Create your first table
await sql`CREATE TABLE example (
    key UInt64,
    value String,
    PRIMARY KEY (key)
);`

// Add sample data
let data = [
	{ key: 1, value: 'Hello' },
	{ key: 2, value: 'World' },
	{ key: 3, value: '!' },
]

await sql`INSERT INTO example SELECT * FROM AS_TABLE(${data})`

// Query the data
let [[result]] = await sql`SELECT COUNT(*) as count FROM example;`
console.log(`Result:`, result) // {count: 3}

// Clean up
await sql`DROP TABLE example;`
driver.close()
