import { setTimeout as sleep } from 'node:timers/promises'

import type { Driver } from '@ydbjs/core'
import { type TestContext, expect, test } from 'vitest'

import { RAW_CODEC } from '../codec.ts'
import { initResponse, makeFakeTopicDriver, writeResponse } from './writer.fixtures.ts'
import { type TopicWriter, createTopicWriter } from './writer.ts'

let capturingWriter = function capturingWriter(
	driver: Driver,
	owner: 'onAck' | 'codec',
	registry: FinalizationRegistry<void>,
	acks: bigint[]
): TopicWriter {
	let captured = new Uint8Array(16 * 1024 * 1024)
	registry.register(captured.buffer, undefined)
	return createTopicWriter(driver, {
		topic: '/t',
		onAck:
			owner === 'onAck'
				? (seqNo) => {
						if (captured[0] !== 0) {
							throw new Error('Unexpected callback state')
						}
						acks.push(seqNo)
					}
				: (seqNo) => {
						acks.push(seqNo)
					},
		codec:
			owner === 'codec'
				? {
						codec: RAW_CODEC.codec,
						compress(data) {
							if (captured[0] !== 0) {
								throw new Error('Unexpected codec state')
							}
							return data
						},
						decompress: RAW_CODEC.decompress,
					}
				: RAW_CODEC,
	})
}

// The fake releases the final ACK deterministically; the assertion measures reachability,
// independent of gRPC allocations, RSS caching, or whether the writer itself gets collected.
let verifyReleasedCapture = async function verifyReleasedCapture(
	owner: 'onAck' | 'codec',
	tc: TestContext
): Promise<{ collected: boolean; acks: bigint[]; writer: TopicWriter }> {
	let collected = false
	let registry = new FinalizationRegistry<void>(() => {
		collected = true
	})
	let { driver, waitForNextStream } = makeFakeTopicDriver()
	let acks: bigint[] = []
	using writer = capturingWriter(driver, owner, registry, acks)
	let stream = await waitForNextStream()
	stream.respond(initResponse(0n))
	writer.write(new Uint8Array([1]))
	let closed = writer.close(tc.signal)
	await stream.waitForWrite()
	stream.respond(writeResponse([{ seqNo: 1n }]))
	await closed

	// The registry callback updates this condition between GC rounds.
	// oxlint-disable-next-line no-unmodified-loop-condition
	for (let attempt = 0; attempt < 40 && !collected; attempt++) {
		globalThis.gc!()
		// oxlint-disable-next-line no-await-in-loop
		await sleep(10, undefined, { signal: tc.signal })
	}
	await writer.close(tc.signal)
	return { collected, acks, writer }
}

test('releases onAck captures while a closed writer remains reachable', async (tc) => {
	let result = await verifyReleasedCapture('onAck', tc)
	expect(result).toMatchObject({ collected: true, acks: [1n] })
	await expect(result.writer.close(tc.signal)).resolves.toBeUndefined()
})

test('releases custom codec captures while a closed writer remains reachable', async (tc) => {
	let result = await verifyReleasedCapture('codec', tc)
	expect(result).toMatchObject({ collected: true, acks: [1n] })
	await expect(result.writer.close(tc.signal)).resolves.toBeUndefined()
})
