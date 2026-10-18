import { anyUnpack } from '@bufbuild/protobuf/wkt'
import { DiscoveryServiceDefinition, ListEndpointsResultSchema } from '@ydbjs/api/discovery'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { ScriptingServiceDefinition } from '@ydbjs/api/scripting'
import { expect, inject, test } from 'vitest'

import { Client, createServiceClient } from '../src/index.ts'

function connection() {
	let url = new URL(inject('connectionString'))

	return {
		authority: `${url.protocol === 'grpcs:' ? 'https:' : 'http:'}//${url.host}`,
		database: url.pathname,
	}
}

test('discovers real YDB endpoints through the standalone transport', async (tc) => {
	let { authority, database } = connection()
	using transport = new Client(authority)
	await transport.connect(tc.signal)
	let client = createServiceClient(DiscoveryServiceDefinition, transport)
	let response = await client.listEndpoints(
		{ database },
		{
			signal: tc.signal,
			metadata: { 'x-ydb-database': database },
		}
	)

	expect(response.operation?.status).toBe(StatusIds_StatusCode.SUCCESS)
	let result = anyUnpack(response.operation!.result!, ListEndpointsResultSchema)
	expect(result?.endpoints.length).toBeGreaterThan(0)
})

test('streams a real YDB query without a driver or grpc-js client', async (tc) => {
	let { authority, database } = connection()
	using transport = new Client(authority)
	let client = createServiceClient(ScriptingServiceDefinition, transport)
	let rows = 0

	for await (let response of client.streamExecuteYql(
		{ script: 'SELECT 42 AS value;' },
		{
			signal: tc.signal,
			metadata: { 'x-ydb-database': database },
		}
	)) {
		expect(response.status).toBe(StatusIds_StatusCode.SUCCESS)
		rows += response.result?.resultSet?.rows.length ?? 0
	}

	expect(rows).toBe(1)
})
