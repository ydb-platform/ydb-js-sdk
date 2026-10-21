import { constants } from 'node:http2'
import { setImmediate } from 'node:timers/promises'

import { expect, test, vi } from 'vitest'

import { collect, deferred, service } from '../tests/fixtures.ts'
import { nodePeer } from '../tests/node-peer.ts'
import { Client } from './client.ts'
import { Status } from './error.ts'

// The peer controls flow windows and reset ordering, which real YDB cannot reproduce deterministically.

test('receives concurrent response headers while a large request is blocked by flow control', async (tc) => {
	let send = deferred()
	let serialized = deferred()
	let payload = new Uint8Array(16 * 1024 * 1024)
	await using peer = await nodePeer({ type: 'flow-control' }, tc.signal)
	using client = new Client(peer.authority)
	let controller = new AbortController()
	let reason = new Error('stop blocked request')
	async function* input() {
		await send.promise
		yield payload
	}
	let method = {
		...service.bidi,
		path: '/test.Transport/Large',
		requestDeserialize: (bytes: Uint8Array) => bytes,
		requestSerialize(value: Uint8Array) {
			serialized.resolve()
			return value
		},
	}
	let call = client.call(method, input(), {
		signal: AbortSignal.any([tc.signal, controller.signal]),
	})
	let blocked = collect(call).catch((error: unknown) => error)
	await peer.wait('large-started')
	let response = collect(client.call(service.unary, '', { signal: tc.signal }))
	await peer.wait('small-started')
	send.resolve()
	await serialized.promise
	await peer.command('reply-small')

	await expect(response).resolves.toEqual(['concurrent response'])
	expect((await peer.snapshot()).sessions).toBe(1)
	controller.abort(reason)
	expect(await blocked).toBe(reason)
	expect((await peer.snapshot()).errors).toEqual([])
})

for (let [name, reset, status] of [
	['refused stream', constants.NGHTTP2_REFUSED_STREAM, Status.UNAVAILABLE],
	['cancellation', constants.NGHTTP2_CANCEL, Status.CANCELLED],
	['resource exhaustion', constants.NGHTTP2_ENHANCE_YOUR_CALM, Status.RESOURCE_EXHAUSTED],
	['inadequate security', constants.NGHTTP2_INADEQUATE_SECURITY, Status.PERMISSION_DENIED],
	['protocol error', constants.NGHTTP2_PROTOCOL_ERROR, Status.INTERNAL],
	['flow control error', constants.NGHTTP2_FLOW_CONTROL_ERROR, Status.INTERNAL],
	['internal error', constants.NGHTTP2_INTERNAL_ERROR, Status.INTERNAL],
] as const) {
	for (let streaming of [false, true]) {
		test(`maps HTTP/2 ${name} after ${streaming ? 'streaming' : 'unary'} requests`, async (tc) => {
			await using peer = await nodePeer({ type: 'reset', code: reset, streaming }, tc.signal)
			using client = new Client(peer.authority)
			let release = deferred()
			async function* input() {
				yield 'request'
				await release.promise
			}
			let statuses: number[] = []
			try {
				let method = streaming ? service.bidi : service.unary
				let request = streaming ? input() : 'request'
				let call = client.call(method, request, {
					signal: tc.signal,
					onStatus: (result) => statuses.push(result.code),
				})
				let responses = collect(call)

				await expect(responses).rejects.toMatchObject({ code: status })
				expect(statuses).toEqual([status])
				expect(await peer.wait('reset-sent')).toBe(reset)
				expect((await peer.snapshot()).attemptedResets).toEqual([reset])
			} finally {
				release.resolve()
			}
		})
	}
}

for (let status of [Status.OK, Status.PERMISSION_DENIED]) {
	for (let code of [
		constants.NGHTTP2_NO_ERROR,
		constants.NGHTTP2_CANCEL,
		constants.NGHTTP2_INTERNAL_ERROR,
	]) {
		test(`drains buffered responses with status ${status} after HTTP/2 reset ${code}`, async (tc) => {
			let trailers = deferred()
			let producerWaiting = deferred()
			let release = deferred()
			await using peer = await nodePeer({ type: 'terminal-reset', status, code }, tc.signal)
			using client = new Client(peer.authority)
			async function* input() {
				yield 'request'
				producerWaiting.resolve()
				await release.promise
			}
			let statuses: number[] = []
			let response = client.call(service.bidi, input(), {
				signal: tc.signal,
				onTrailer: () => trailers.resolve(),
				onStatus: (result) => statuses.push(result.code),
			})
			let responses = response[Symbol.asyncIterator]()
			try {
				expect((await responses.next()).value).toBe('first')
				await producerWaiting.promise
				await peer.command('send-terminal-tail')
				await trailers.promise
				await peer.command('reset-terminal')
				expect(await peer.wait('reset-sent')).toBe(code)
				expect((await peer.snapshot()).attemptedResets).toEqual([code])
				expect((await responses.next()).value).toBe('second')
				expect((await responses.next()).value).toBe('last')
				let terminal = await responses.next().then(
					(result) => ({ done: result.done, code: Status.OK }),
					(error) => ({ done: true, code: error.code })
				)
				expect(terminal).toEqual({ done: true, code: status })
				expect(statuses).toEqual([status])
			} finally {
				release.resolve()
			}
		})
	}
}

test('drains complete responses before reporting missing status after a normal HTTP/2 close', async (tc) => {
	await using peer = await nodePeer({ type: 'missing-status' }, tc.signal)
	using client = new Client(peer.authority)
	let response = client.call(service.serverStream, '', { signal: tc.signal })
	let iterator = response[Symbol.asyncIterator]()

	expect((await iterator.next()).value).toBe('first')
	await peer.wait('stream-closed')
	await peer.command('ping')
	await setImmediate(undefined, { signal: tc.signal })

	expect((await iterator.next()).value).toBe('second')
	await expect(iterator.next()).rejects.toMatchObject({
		code: Status.UNKNOWN,
		details: 'RPC ended without grpc-status',
	})
})

for (let [name, expired] of [
	['reports deadline expiry when a peer CANCEL arrives before the local timer runs', true],
	['preserves peer cancellation while the absolute deadline is still pending', false],
] as const) {
	test(`${name}`, async (tc) => {
		await using peer = await nodePeer(
			{ type: 'reset', code: constants.NGHTTP2_CANCEL, streaming: false },
			tc.signal
		)
		using client = new Client(peer.authority)
		using clock = vi.spyOn(Date, 'now')
		let deadline = Date.now() + 60_000
		let statuses: number[] = []
		let expected = expired ? Status.DEADLINE_EXCEEDED : Status.CANCELLED
		let method = {
			...service.unary,
			requestSerialize(value: string) {
				// Serialization follows deadline setup; changing the clock does not run its timer.
				clock.mockReturnValue(expired ? deadline + 1 : deadline - 1)
				return Buffer.from(value)
			},
		}
		let call = client.call(method, 'request', {
			signal: tc.signal,
			deadline,
			onStatus: (status) => statuses.push(status.code),
		})
		let response = collect(call)

		await expect(response).rejects.toMatchObject({ code: expected })
		expect(statuses).toEqual([expected])
		expect(await peer.wait('reset-sent')).toBe(constants.NGHTTP2_CANCEL)
		expect((await peer.snapshot()).attemptedResets).toEqual([constants.NGHTTP2_CANCEL])
	})
}
