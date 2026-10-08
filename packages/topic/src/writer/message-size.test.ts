import { create, toBinary } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import { StreamWriteMessage_WriteRequestSchema } from '@ydbjs/api/topic'
import { expect, test } from 'vitest'

import { MAX_SEQ_NO, messageSizes } from './message-size.ts'

// Compare accounting with the actual protobuf encoder, including varint boundaries.
test.each([0, 1, 127, 128, 16383, 16384])(
	'bounds the protobuf contribution of a %i-byte message',
	(size) => {
		let message = {
			data: new Uint8Array(size),
			seqNo: MAX_SEQ_NO,
			uncompressedSize: BigInt(size),
			createdAt: new Date(-1234),
			metadataItems: { ключ: new Uint8Array(size), empty: new Uint8Array() },
		}
		let request = create(StreamWriteMessage_WriteRequestSchema, {
			messages: [
				{
					...message,
					createdAt: timestampFromDate(message.createdAt),
					metadataItems: Object.entries(message.metadataItems).map(([key, value]) => ({
						key,
						value,
					})),
				},
			],
		})
		expect(messageSizes(message).wireSize).toBe(
			BigInt(toBinary(StreamWriteMessage_WriteRequestSchema, request).length)
		)
	}
)
