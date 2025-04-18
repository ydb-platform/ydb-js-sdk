// @ts-check
import * as assert from 'node:assert'

import { anyUnpack } from '@bufbuild/protobuf/wkt'
import { DiscoveryServiceDefinition, ListEndpointsResultSchema, WhoAmIResultSchema } from '@ydbjs/api/discovery'
import { StaticCredentialsProvider } from '@ydbjs/auth/static'
import { Driver } from '@ydbjs/core'

let connectionString = process.env.YDB_CONNECTION_STRING || 'grpc://localhost:2136/local'
let driver = new Driver(connectionString, {
	credentialsProvier: new StaticCredentialsProvider({ username: 'root', password: '1234' }, connectionString),
})

await driver.ready()
let discovery = driver.createClient(DiscoveryServiceDefinition)

{
	let response = await discovery.listEndpoints({ database: driver.database })

	assert.ok(response.operation, 'Operation is not defined')
	assert.ok(response.operation.result, 'Result is not defined')

	console.log('Endpoints:', anyUnpack(response.operation.result, ListEndpointsResultSchema))
}

{
	let response = await discovery.whoAmI({})

	assert.ok(response.operation, 'Operation is not defined')
	assert.ok(response.operation.result, 'Result is not defined')

	console.log('WhoAmI:', anyUnpack(response.operation.result, WhoAmIResultSchema))
}

driver.close()
