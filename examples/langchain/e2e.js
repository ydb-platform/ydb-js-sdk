import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { json } from 'node:stream/consumers'
import { test } from 'node:test'
import { promisify } from 'node:util'

test('searches and deletes documents using embeddings from an OpenAI-compatible endpoint', async () => {
	await using server = createServer(async (request, response) => {
		assert.equal(request.url, '/v1/embeddings')
		let { input, encoding_format } = await json(request)
		let texts = Array.isArray(input) ? input : [input]
		let data = texts.map((text, index) => {
			let embedding = [1, text.length]
			if (encoding_format === 'base64') {
				embedding = Buffer.from(Float32Array.from(embedding).buffer).toString('base64')
			}
			return { object: 'embedding', index, embedding }
		})
		response.writeHead(200, { 'Content-Type': 'application/json' })
		response.end(JSON.stringify({ object: 'list', data }))
	})
	await once(server.listen(0, '127.0.0.1'), 'listening')

	let { stdout } = await promisify(execFile)(process.execPath, ['index.js'], {
		env: {
			...process.env,
			OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
			OPENAI_API_KEY: 'example-key',
		},
	})
	assert.match(stdout, /3 documents/)
	assert.match(stdout, /CosineDistance results[^\n]*\n[^\n]*\balpha\b/)
})
