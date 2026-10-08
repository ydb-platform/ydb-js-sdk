import { timestampDate } from '@bufbuild/protobuf/wkt'
import { Codec } from '@ydbjs/api/topic'

import { type CodecMap, getCodec } from '../codec.js'
import { TopicMessage } from '../message.js'
import type { TopicPartitionSession } from '../partition-session.js'
import { type OffsetRange, type ReaderMessage, mergeRanges, partitionKey } from './reader-state.js'

// Pure facade helpers — no instance state, no I/O. Extracted from TopicReader so the
// wire→user mapping, commit-range building and tx offset accounting are directly
// unit-testable without a fake driver.

export type TxReadOffsets = {
	session: TopicPartitionSession
	firstOffset: bigint
	lastOffset: bigint
}

export type TxReadOffsetUpdate = {
	partitionSession: TopicPartitionSession
	offsetRange: { firstOffset: bigint; lastOffset: bigint }
}

export let decodePayload = function decodePayload(
	codecs: CodecMap,
	session: TopicPartitionSession,
	message: ReaderMessage
): Uint8Array {
	// UNSPECIFIED means "no codec recorded" — the payload is raw bytes (the current
	// server normalizes missing codecs to RAW before delivery; older ones could
	// leave it unset). Decompressing would corrupt it; erroring would kill the
	// reader over absent metadata.
	if (message.codec === Codec.UNSPECIFIED) {
		return message.data
	}
	try {
		let codec = codecs.get(message.codec) ?? getCodec(message.codec as Codec)
		return codec.decompress(message.data)
	} catch (error) {
		// Terminal by design: the protocol has no way to refuse a single partition,
		// and skipping silently would be data loss. Make the error actionable.
		throw new Error(
			`Cannot decode message at offset ${message.offset} of partition ${session.partitionId} (${session.topicPath}): codec ${message.codec} — register it in codecMap`,
			{ cause: error }
		)
	}
}

export let toTopicMessage = function toTopicMessage(
	codecs: CodecMap,
	session: TopicPartitionSession,
	message: ReaderMessage
): TopicMessage {
	return new TopicMessage({
		partitionSession: session,
		producer: message.producer,
		payload: decodePayload(codecs, session, message),
		codec: message.codec as Codec,
		seqNo: message.seqNo,
		offset: message.offset,
		uncompressedSize: message.uncompressedSize,
		commitRangeStart: message.commitRangeStart,
		...(message.createdAt && { createdAt: timestampDate(message.createdAt).getTime() }),
		...(message.writtenAt && { writtenAt: timestampDate(message.writtenAt).getTime() }),
		...(message.metadataItems.length > 0 && {
			metadataItems: Object.fromEntries(
				message.metadataItems.map((item) => [item.key, item.value])
			),
		}),
	})
}

// Group commit input by the stable partitionKey — partition ids alone collide across
// the topics of a multi-topic reader. Each message acknowledges its own stitched
// range: the offset itself plus the server-side hole immediately preceding it — never
// other delivered messages (the server commits gap-free ACKED intervals only). The
// per-partition ranges come back merged, ready for the wire.
export let buildCommitRanges = function buildCommitRanges(
	messages: TopicMessage[],
	isOwned: (session: TopicPartitionSession) => boolean
): Map<string, OffsetRange[]> {
	let byPartition = new Map<string, OffsetRange[]>()

	for (let message of messages) {
		let session = message.partitionSession.deref()
		if (!session || session.isStopped) {
			throw new Error('Cannot commit a message from a stopped or expired partition session')
		}
		// Ownership: a message from another reader would be committed against this
		// reader's consumer and anchor — silently corrupting both consumers' progress.
		if (!isOwned(session)) {
			throw new Error(
				`Cannot commit a message from a foreign reader's partition session (partition ${session.partitionId} of ${session.topicPath})`
			)
		}
		if (message.offset === undefined) {
			throw new Error('Cannot commit a message without an offset')
		}
		let key = partitionKey(session.topicPath, session.partitionId)
		let ranges = byPartition.get(key)
		let range = { start: message.commitRangeStart, end: message.offset + 1n }
		if (ranges === undefined) {
			byPartition.set(key, [range])
		} else {
			ranges.push(range)
		}
	}

	for (let [key, ranges] of byPartition) {
		byPartition.set(key, mergeRanges(ranges))
	}
	return byPartition
}

// Record delivered offsets for the tx commit hook — at yield time, never at
// buffering: a tx commit must cover exactly what the consumer saw. No-op for
// non-transactional readers (no map).
export let growTxOffsets = function growTxOffsets(
	offsets: Map<string, TxReadOffsets> | undefined,
	messages: TopicMessage[]
): void {
	if (!offsets) {
		return
	}
	for (let message of messages) {
		let session = message.partitionSession.deref()
		if (!session) {
			continue
		}
		let offset = message.offset ?? message.commitRangeStart
		let key = partitionKey(session.topicPath, session.partitionId)
		let existing = offsets.get(key)
		if (existing === undefined) {
			offsets.set(key, {
				session,
				firstOffset: message.commitRangeStart,
				lastOffset: offset,
			})
		} else if (offset > existing.lastOffset) {
			// Grow-only: a mid-tx reconnect redelivers from the committed offset, and
			// a rewound range would commit fewer offsets than the transaction consumed.
			existing.lastOffset = offset
		}
	}
}

// Snapshot of the tx read offsets, mapped to the sessions the tx commit hook needs.
// The session is embedded in each record, so the snapshot stays valid after close()
// (a closed tx reader still binds its offsets at tx commit).
export let txOffsetUpdates = function txOffsetUpdates(
	offsets: Map<string, TxReadOffsets> | undefined
): TxReadOffsetUpdate[] {
	if (!offsets) {
		return []
	}
	let updates: TxReadOffsetUpdate[] = []
	for (let record of offsets.values()) {
		updates.push({
			partitionSession: record.session,
			offsetRange: { firstOffset: record.firstOffset, lastOffset: record.lastOffset },
		})
	}
	return updates
}
