import type { Timestamp } from '@bufbuild/protobuf/wkt'
import { Codec } from '@ydbjs/api/topic'
import { expect, test } from 'vitest'

import { type CodecMap, type CompressionCodec, GZIP_CODEC } from '../codec.js'
import { TopicMessage } from '../message.js'
import { TopicPartitionSession } from '../partition-session.js'
import {
	type TxReadOffsets,
	buildCommitRanges,
	decodePayload,
	growTxOffsets,
	toTopicMessage,
	txOffsetUpdates,
} from './reader-internals.js'
import type { ReaderMessage } from './reader-state.js'

let bytes = function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

let text = function text(payload: Uint8Array): string {
	return new TextDecoder().decode(payload)
}

let session = function session(partitionId = 0n, path = '/t', sessionId = 1n): TopicPartitionSession {
	return new TopicPartitionSession(sessionId, partitionId, path)
}

let raw = function raw(overrides: Partial<ReaderMessage> = {}): ReaderMessage {
	return {
		offset: 0n,
		seqNo: 1n,
		data: bytes('payload'),
		uncompressedSize: 7n,
		producer: 'p',
		codec: Codec.RAW,
		commitRangeStart: 0n,
		metadataItems: [],
		...overrides,
	}
}

// XOR with a constant is its own inverse — a cheap stand-in for a user codec.
let xorCodec = function xorCodec(id: number): CompressionCodec {
	let transform = (payload: Uint8Array) => payload.map((byte) => byte ^ 0x2a)
	return { codec: id, compress: transform, decompress: transform }
}

// ── decodePayload ────────────────────────────────────────────────────────────────

test('passes UNSPECIFIED payloads through untouched', () => {
	let payload = bytes('as-is')
	let out = decodePayload(new Map(), session(), raw({ codec: Codec.UNSPECIFIED, data: payload }))
	expect(out).toBe(payload)
})

test('decompresses with a registered custom codec', () => {
	let codecs: CodecMap = new Map([[10013, xorCodec(10013)]])
	let data = xorCodec(10013).compress(bytes('secret'))
	let out = decodePayload(codecs, session(), raw({ codec: 10013, data }))
	expect(text(out)).toBe('secret')
})

test('falls back to built-in codecs when the map lacks an entry', () => {
	// An empty codec map does not disable the built-ins: unknown ids fall back to
	// getCodec, so GZIP data decodes even with nothing registered.
	let data = GZIP_CODEC.compress(bytes('zipped'))
	let out = decodePayload(new Map(), session(), raw({ codec: Codec.GZIP, data }))
	expect(text(out)).toBe('zipped')
})

test('names the offset, partition and remedy for an unknown codec', () => {
	expect(() =>
		decodePayload(new Map(), session(7n, '/orders'), raw({ codec: Codec.LZOP, offset: 42n }))
	).toThrow(/offset 42 of partition 7 \(\/orders\).*codec 3.*register it in codecMap/)
})

test('wraps a corrupt payload failure with the decode context', () => {
	let corrupt = bytes('not gzip at all')
	let err: unknown
	try {
		decodePayload(new Map(), session(), raw({ codec: Codec.GZIP, data: corrupt }))
	} catch (caught) {
		err = caught
	}
	expect(String(err)).toMatch(/Cannot decode message/)
	expect((err as Error).cause).toBeInstanceOf(Error)
})

// ── toTopicMessage ───────────────────────────────────────────────────────────────

test('maps wire timestamps to epoch milliseconds', () => {
	let createdAt = { seconds: 1700000000n, nanos: 500_000_000 } as Timestamp
	let writtenAt = { seconds: 1700000001n, nanos: 0 } as Timestamp
	let message = toTopicMessage(new Map(), session(), raw({ createdAt, writtenAt }))
	expect(message.createdAt).toBe(1700000000500)
	expect(message.writtenAt).toBe(1700000001000)
})

test('leaves absent timestamps undefined', () => {
	let message = toTopicMessage(new Map(), session(), raw())
	expect(message.createdAt).toBeUndefined()
	expect(message.writtenAt).toBeUndefined()
})

test('converts metadata items to a record with last-wins duplicate keys', () => {
	// The wire format is a repeated list and other SDKs can emit duplicate keys;
	// Object.fromEntries keeps the last occurrence.
	let message = toTopicMessage(
		new Map(),
		session(),
		raw({
			metadataItems: [
				{ key: 'trace', value: bytes('first') },
				{ key: 'lane', value: bytes('a') },
				{ key: 'trace', value: bytes('second') },
			],
		})
	)
	expect(Object.keys(message.metadataItems!)).toEqual(['trace', 'lane'])
	expect(text(message.metadataItems!['trace']!)).toBe('second')
})

test('carries identity and offsets through to the message', () => {
	let s = session(3n, '/events')
	let message = toTopicMessage(
		new Map(),
		s,
		raw({ offset: 15n, seqNo: 9n, uncompressedSize: 100n, commitRangeStart: 12n, producer: 'writer-1' })
	)
	expect(message.partitionSession.deref()).toBe(s)
	expect(message.producer).toBe('writer-1')
	expect(message.seqNo).toBe(9n)
	expect(message.offset).toBe(15n)
	expect(message.uncompressedSize).toBe(100n)
	expect(message.commitRangeStart).toBe(12n)
	expect(text(message.payload)).toBe('payload')
})

// ── buildCommitRanges ────────────────────────────────────────────────────────────

let deliveredMessage = function deliveredMessage(
	s: TopicPartitionSession,
	offset: bigint,
	commitRangeStart = offset
): TopicMessage {
	return new TopicMessage({
		partitionSession: s,
		producer: 'p',
		payload: bytes('x'),
		codec: Codec.RAW,
		seqNo: offset + 1n,
		offset,
		commitRangeStart,
	})
}

test('keeps equal partition ids of different topics in separate groups', () => {
	let a = session(0n, '/a', 1n)
	let b = session(0n, '/b', 2n)
	let ranges = buildCommitRanges(
		[deliveredMessage(a, 5n), deliveredMessage(b, 100n)],
		() => true
	)
	expect([...ranges.keys()].sort()).toEqual(['/a|0', '/b|0'])
	expect(ranges.get('/a|0')).toEqual([{ start: 5n, end: 6n }])
	expect(ranges.get('/b|0')).toEqual([{ start: 100n, end: 101n }])
})

test('builds each message its own stitched range and merges adjacent ones', () => {
	let s = session()
	// Offsets 3..5 delivered contiguously plus a head gap stitched onto offset 3.
	let ranges = buildCommitRanges(
		[deliveredMessage(s, 3n, 0n), deliveredMessage(s, 4n), deliveredMessage(s, 5n)],
		() => true
	)
	expect(ranges.get('/t|0')).toEqual([{ start: 0n, end: 6n }])
})

test('keeps non-adjacent ranges of one partition separate', () => {
	let s = session()
	let ranges = buildCommitRanges([deliveredMessage(s, 1n), deliveredMessage(s, 8n)], () => true)
	expect(ranges.get('/t|0')).toEqual([
		{ start: 1n, end: 2n },
		{ start: 8n, end: 9n },
	])
})

test('rejects a message from a stopped partition session', () => {
	let s = session()
	let message = deliveredMessage(s, 0n)
	s.stop()
	expect(() => buildCommitRanges([message], () => true)).toThrow(
		/stopped or expired partition session/
	)
})

test('rejects a message from a foreign partition session', () => {
	let s = session(4n, '/orders')
	expect(() => buildCommitRanges([deliveredMessage(s, 0n)], () => false)).toThrow(
		/foreign reader's partition session \(partition 4 of \/orders\)/
	)
})

// ── growTxOffsets / txOffsetUpdates ──────────────────────────────────────────────

test('seeds the tx range from the first delivered message and its head gap', () => {
	let s = session()
	let offsets = new Map<string, TxReadOffsets>()
	growTxOffsets(offsets, [deliveredMessage(s, 5n, 2n)])
	expect(offsets.get('/t|0')).toMatchObject({ firstOffset: 2n, lastOffset: 5n })
})

test('grows the tx range forward only', () => {
	let s = session()
	let offsets = new Map<string, TxReadOffsets>()
	growTxOffsets(offsets, [deliveredMessage(s, 5n)])
	// A mid-tx reconnect redelivers earlier offsets: the range must not rewind.
	growTxOffsets(offsets, [deliveredMessage(s, 3n)])
	growTxOffsets(offsets, [deliveredMessage(s, 8n)])
	expect(offsets.get('/t|0')).toMatchObject({ firstOffset: 5n, lastOffset: 8n })
})

test('tracks tx offsets per topic when partition ids collide', () => {
	let a = session(0n, '/a', 1n)
	let b = session(0n, '/b', 2n)
	let offsets = new Map<string, TxReadOffsets>()
	growTxOffsets(offsets, [deliveredMessage(a, 5n), deliveredMessage(b, 100n)])
	expect(offsets.get('/a|0')).toMatchObject({ firstOffset: 5n, lastOffset: 5n })
	expect(offsets.get('/b|0')).toMatchObject({ firstOffset: 100n, lastOffset: 100n })
})

test('ignores tx recording when no offsets map is bound', () => {
	expect(() => growTxOffsets(undefined, [deliveredMessage(session(), 0n)])).not.toThrow()
})

test('converts tx records to per-session updates', () => {
	let s = session(2n, '/events')
	let offsets = new Map<string, TxReadOffsets>([
		['/events|2', { session: s, firstOffset: 3n, lastOffset: 9n }],
	])
	expect(txOffsetUpdates(offsets)).toEqual([
		{ partitionSession: s, offsetRange: { firstOffset: 3n, lastOffset: 9n } },
	])
	expect(txOffsetUpdates(undefined)).toEqual([])
})
