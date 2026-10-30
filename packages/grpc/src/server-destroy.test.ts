import { abortable } from '@ydbjs/abortable'
import { expect, test } from 'vitest'

import { service } from '../tests/fixtures.ts'
import { Client } from './client.ts'
import { Server } from './server.ts'

test('destroy finishes after a paused response is cancelled and its client closes', async (tc) => {
	let stopped = Promise.withResolvers<void>()
	using server = new Server()
	server.add(service, {
		async *serverStream(_request, context) {
			try {
				yield 'first'
				await abortable(context.signal, new Promise<void>(() => {}))
			} finally {
				stopped.resolve()
			}
		},
	})
	let port = await server.listen('127.0.0.1:0')
	using client = new Client(`http://127.0.0.1:${port}`)
	let caller = new AbortController()
	let stream = client.call(service.serverStream, '', { signal: caller.signal })
	expect((await stream.next()).value).toBe('first')
	let reason = new Error('consumer cancelled')
	caller.abort(reason)
	await expect(stream.next()).rejects.toBe(reason)
	await abortable(tc.signal, stopped.promise)
	client.close()
	server.destroy()
	await abortable(tc.signal, server.close())
})
