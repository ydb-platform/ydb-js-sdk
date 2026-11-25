import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handler } from './index.js'

test('invokes the serverless handler with metadata credentials', async (t) => {
	let metadata = t.mock.method(globalThis, 'fetch', (url, options) => {
		assert.equal(
			new URL(url).pathname,
			'/computeMetadata/v1/instance/service-accounts/default/token'
		)
		assert.equal(new Headers(options.headers).get('Metadata-Flavor'), 'Google')
		return Promise.resolve(Response.json({ access_token: 'root@builtin', expires_in: 3600 }))
	})

	let { statusCode, body } = await handler({})
	assert.equal(statusCode, 200)
	assert.equal(body.resultSets[0][0].sum, 2)
	assert.ok(metadata.mock.callCount() > 0)
})
