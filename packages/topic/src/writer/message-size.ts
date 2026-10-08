import { create, toBinary } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import { StreamWriteMessage_WriteRequest_MessageDataSchema } from '@ydbjs/api/topic'

import type { BufferedMessage } from './writer-state.js'

// Accounting reserves bound the number of retained objects as well as payload bytes.
// They are budget units, not measurements of a particular JavaScript engine's heap.
export let MESSAGE_OVERHEAD_BYTES = 256n
export let METADATA_OVERHEAD_BYTES = 64n
export let MAX_SEQ_NO = (1n << 63n) - 1n

let varintSize = function varintSize(value: bigint): bigint {
	let size = 1n
	while (value >= 128n) {
		value >>= 7n
		size += 1n
	}
	return size
}

// All length-delimited fields used by MessageData and its envelopes have one-byte tags.
let fieldSize = function fieldSize(bytes: bigint): bigint {
	return 1n + varintSize(bytes) + bytes
}

export let messageSizes = function messageSizes(
	message: Omit<BufferedMessage, 'bufferedSize' | 'wireSize'>
): { bufferedSize: bigint; wireSize: bigint } {
	let payloadBytes = BigInt(message.data.length)
	let bufferedSize = MESSAGE_OVERHEAD_BYTES + payloadBytes
	// Serialize only the small scalar header. Reserving the largest valid seqNo
	// keeps auto-numbered messages within the limit before their number is assigned.
	let header = create(StreamWriteMessage_WriteRequest_MessageDataSchema, {
		seqNo: MAX_SEQ_NO,
		createdAt: timestampFromDate(message.createdAt),
		uncompressedSize: message.uncompressedSize,
	})
	let messageBytes = BigInt(
		toBinary(StreamWriteMessage_WriteRequest_MessageDataSchema, header).length
	)
	if (payloadBytes > 0n) {
		messageBytes += fieldSize(payloadBytes)
	}
	for (let [key, value] of Object.entries(message.metadataItems ?? {})) {
		let keyBytes = BigInt(Buffer.byteLength(key))
		let valueBytes = BigInt(value.length)
		bufferedSize += METADATA_OVERHEAD_BYTES + keyBytes + valueBytes
		let entryBytes =
			(keyBytes > 0n ? fieldSize(keyBytes) : 0n) +
			(valueBytes > 0n ? fieldSize(valueBytes) : 0n)
		messageBytes += fieldSize(entryBytes)
	}
	return { bufferedSize, wireSize: fieldSize(messageBytes) }
}
