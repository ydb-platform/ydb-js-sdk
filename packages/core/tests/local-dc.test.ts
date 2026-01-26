import { create } from '@bufbuild/protobuf'
import { EndpointInfoSchema } from '@ydbjs/api/discovery'
import { expect, test } from 'vitest'
import { detectLocalDC } from '../src/local-dc.js'

test('returns single location when only one DC', async () => {
	let endpoints = [
		create(EndpointInfoSchema, {
			address: 'ydb-1.vla.example.com',
			port: 2135,
			nodeId: 1,
			location: 'VLA',
		}),
		create(EndpointInfoSchema, {
			address: 'ydb-2.vla.example.com',
			port: 2135,
			nodeId: 2,
			location: 'VLA',
		}),
	]

	let localDC = await detectLocalDC(endpoints, 5000)
	expect(localDC).toBe('VLA')
})

test('returns null when no endpoints', async () => {
	let localDC = await detectLocalDC([], 5000)
	expect(localDC).toBeNull()
})

test("returns null when couldn't compute rtt for any of the endpoints", async () => {
	let endpoints = [
		create(EndpointInfoSchema, {
			address: 'ydb-1.vla.example.com',
			port: 2135,
			nodeId: 1,
			location: 'VLA',
		}),
		create(EndpointInfoSchema, {
			address: 'ydb-2.vla.example.com',
			port: 2135,
			nodeId: 2,
			location: 'VLA',
		}),
		create(EndpointInfoSchema, {
			address: 'ydb-1.sas.example.com',
			port: 2135,
			nodeId: 3,
			location: 'SAS',
		}),
	]

	let localDC = await detectLocalDC(endpoints, 0)

	expect(localDC).toBeNull()
})
