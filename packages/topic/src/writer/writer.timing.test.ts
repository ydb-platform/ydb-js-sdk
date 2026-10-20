import { expect, test, vi } from 'vitest'
import { createTopicWriter } from './writer.ts'
import { WriterTransport } from './transport.ts'
import { initResponse, makeFakeTopicDriver, settle, writeResponse } from './writer.fixtures.ts'

let bytes = (...values: number[]) => new Uint8Array(values)

// The fake fixes timer/ACK ordering without adding socket scheduling to the clock assertions.
test('cleans up the stream and timers when a runtime effect throws', async () => {
	// A thrown effect is an internal fault; a real server cannot trigger it deterministically.
	vi.useFakeTimers()
	let failure = new Error('send effect failed')
	let send = vi.spyOn(WriterTransport.prototype, 'sendBatch').mockImplementationOnce(() => {
		throw failure
	})
	try {
		let { driver, waitForNextStream } = makeFakeTopicDriver()
		using writer = createTopicWriter(driver, { topic: '/t', producer: 'p' })
		let stream = await waitForNextStream()
		stream.respond(initResponse(0n))
		await settle()
		expect(vi.getTimerCount()).toBeGreaterThan(0)
		writer.write(bytes(1))
		await expect(writer.flush()).rejects.toBe(failure)
		await settle()
		expect(stream.wasAborted()).toBe(true)
		expect(vi.getTimerCount()).toBe(0)
		await expect(writer.close()).rejects.toBe(failure)
	} finally {
		send.mockRestore()
		vi.clearAllTimers()
		vi.useRealTimers()
	}
})

test('cancels a stale reconnect backoff when a late init arrives during close', async () => {
	// The server init must land between the connection watchdog and its retry timer.
	vi.useFakeTimers()
	try {
		let { driver, waitForNextStream } = makeFakeTopicDriver()
		using writer = createTopicWriter(driver, {
			topic: '/t',
			producer: 'p',
			gracefulShutdownTimeoutMs: 60_000,
		})
		writer.write(bytes(1))
		let closed = writer.close()
		void closed.catch(() => {})
		let stream = await waitForNextStream()
		await stream.waitForInit()
		await vi.advanceTimersByTimeAsync(30_000)
		stream.respond(initResponse(0n))
		await stream.waitForWrite()
		await vi.advanceTimersByTimeAsync(50)
		expect(stream.wasAborted()).toBe(false)
		stream.respond(writeResponse([{ seqNo: 1n }]))
		await closed
	} finally {
		vi.clearAllTimers()
		vi.useRealTimers()
	}
})

test('flushes isolated messages on their interval even after a long idle period', async () => {
	vi.useFakeTimers()
	try {
		let { driver, waitForNextStream } = makeFakeTopicDriver()
		using writer = createTopicWriter(driver, {
			topic: '/t',
			producer: 'p',
			flushIntervalMs: 1000,
		})
		let stream = await waitForNextStream()
		stream.respond(initResponse(0n))
		await settle()
		let sent = () =>
			stream.sent.flatMap((frame) =>
				frame.clientMessage.case === 'writeRequest'
					? frame.clientMessage.value.messages.map((message) => message.seqNo)
					: []
			)
		writer.write(bytes(1))
		await settle()
		expect(sent()).toEqual([])
		await vi.advanceTimersByTimeAsync(999)
		expect(sent()).toEqual([])
		await vi.advanceTimersByTimeAsync(1)
		expect(sent()).toEqual([1n])
		stream.respond(writeResponse([{ seqNo: 1n }]))
		await settle()
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
		writer.write(bytes(2))
		await settle()
		expect(sent()).toEqual([1n])
		await vi.advanceTimersByTimeAsync(999)
		expect(sent()).toEqual([1n])
		await vi.advanceTimersByTimeAsync(1)
		expect(sent()).toEqual([1n, 2n])
	} finally {
		vi.clearAllTimers()
		vi.useRealTimers()
	}
})

test('keeps the partial byte-limited batch buffered until its flush interval', async () => {
	// A fake transport exposes sends immediately; socket delivery cannot prove their absence.
	vi.useFakeTimers()
	try {
		let { driver, waitForNextStream } = makeFakeTopicDriver()
		using writer = createTopicWriter(driver, {
			topic: '/t',
			producer: 'p',
			flushIntervalMs: 1000,
		})
		let stream = await waitForNextStream()
		stream.respond(initResponse(0n))
		await settle()
		let sentSequences = () =>
			stream.sent.flatMap((frame) =>
				frame.clientMessage.case === 'writeRequest'
					? frame.clientMessage.value.messages.map((message) => message.seqNo)
					: []
			)

		// Two 25 MiB messages exceed the 48 MiB batch limit.
		writer.write(new Uint8Array(25 * 1024 * 1024))
		await settle()
		expect(sentSequences()).toEqual([])

		writer.write(new Uint8Array(25 * 1024 * 1024))
		await stream.waitForWrite()
		await settle()
		expect(sentSequences()).toEqual([1n])

		await vi.advanceTimersByTimeAsync(999)
		expect(sentSequences()).toEqual([1n])
		await vi.advanceTimersByTimeAsync(1)
		expect(sentSequences()).toEqual([1n, 2n])
	} finally {
		vi.clearAllTimers()
		vi.useRealTimers()
	}
})

test('sends an overdue partial batch as soon as acknowledgments free the window', async () => {
	vi.useFakeTimers()
	try {
		let { driver, waitForNextStream } = makeFakeTopicDriver()
		using writer = createTopicWriter(driver, {
			topic: '/t',
			producer: 'p',
			maxInflightCount: 2,
			flushIntervalMs: 1000,
		})
		let stream = await waitForNextStream()
		stream.respond(initResponse(0n))
		writer.write(bytes(1))
		writer.write(bytes(2))
		await stream.waitForWrite()
		writer.write(bytes(3))
		await vi.advanceTimersByTimeAsync(1000)
		let sent = () =>
			stream.sent.flatMap((frame) =>
				frame.clientMessage.case === 'writeRequest'
					? frame.clientMessage.value.messages.map((message) => message.seqNo)
					: []
			)
		expect(sent()).toEqual([1n, 2n])
		stream.respond(writeResponse([{ seqNo: 1n }, { seqNo: 2n }]))
		await settle()
		expect(sent()).toEqual([1n, 2n, 3n])
	} finally {
		vi.clearAllTimers()
		vi.useRealTimers()
	}
})

test('retains an overdue batch across reconnect without sending before initialization', async () => {
	vi.useFakeTimers()
	try {
		let { driver, waitForNextStream } = makeFakeTopicDriver()
		using writer = createTopicWriter(driver, {
			topic: '/t',
			producer: 'p',
			maxInflightCount: 2,
			flushIntervalMs: 1000,
		})
		let first = await waitForNextStream()
		first.respond(initResponse(0n))
		writer.write(bytes(1))
		writer.write(bytes(2))
		await first.waitForWrite()
		writer.write(bytes(3))
		await vi.advanceTimersByTimeAsync(1000)
		first.disconnect()
		await settle()
		await vi.advanceTimersByTimeAsync(50)
		let second = await waitForNextStream()
		await second.waitForInit()
		await vi.advanceTimersByTimeAsync(1000)
		expect(
			second.sent.filter((frame) => frame.clientMessage.case === 'writeRequest')
		).toHaveLength(0)
		second.respond(initResponse(2n))
		await settle()
		let request = await second.waitForWrite()
		expect(request.messages.map((message) => message.seqNo)).toEqual([3n])
	} finally {
		vi.clearAllTimers()
		vi.useRealTimers()
	}
})

test('sends a buffered partial batch despite reconnects shorter than the flush interval', async () => {
	// Each stream ends before its flush tick, making timer postponement deterministic.
	vi.useFakeTimers()
	try {
		let { driver, waitForNextStream } = makeFakeTopicDriver()
		using writer = createTopicWriter(driver, {
			topic: '/t',
			producer: 'p',
			flushIntervalMs: 1000,
		})
		let stream = await waitForNextStream()
		let streams = [stream]
		stream.respond(initResponse(0n))
		await settle()
		writer.write(bytes(1))

		for (let attempt = 0; attempt < 3; attempt++) {
			// oxlint-disable-next-line no-await-in-loop
			await vi.advanceTimersByTimeAsync(450)
			stream.disconnect()
			// oxlint-disable-next-line no-await-in-loop
			await settle()
			// oxlint-disable-next-line no-await-in-loop
			await vi.advanceTimersByTimeAsync(50)
			// oxlint-disable-next-line no-await-in-loop
			stream = await waitForNextStream()
			streams.push(stream)
			stream.respond(initResponse(0n))
			// oxlint-disable-next-line no-await-in-loop
			await settle()
		}

		let sent = streams.flatMap((connection) =>
			connection.sent.filter((frame) => frame.clientMessage.case === 'writeRequest')
		)
		expect(sent.length).toBeGreaterThan(0)
	} finally {
		vi.clearAllTimers()
		vi.useRealTimers()
	}
})
