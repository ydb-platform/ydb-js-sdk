import type {
	StreamWriteMessage_FromClient,
	StreamWriteMessage_InitResponse,
	StreamWriteMessage_WriteRequest_MessageData,
} from '@ydbjs/api/topic'
import type { CompressionCodec } from '../codec.js'
import type { AsyncPriorityQueue } from '../queue.js'
import type { TX } from '../tx.js'
import { _flush } from './_flush.js'
import type { ThroughputSettings } from './types.js'

export const _on_init_response = function on_init_response(
	ctx: {
		readonly tx?: TX
		readonly queue: AsyncPriorityQueue<StreamWriteMessage_FromClient>
		readonly codec: CompressionCodec // Codec to use for compression
		readonly buffer: StreamWriteMessage_WriteRequest_MessageData[] // Array of messages in the buffer
		readonly inflight: StreamWriteMessage_WriteRequest_MessageData[] // Array of messages that are currently in-flight
		readonly lastSeqNo?: bigint // The last sequence number acknowledged by the server
		readonly throughputSettings: ThroughputSettings // Current throughput settings for the writer
		readonly isSeqNoProvided?: boolean // Whether user provided seqNo (manual mode)
		updateLastSeqNo: (seqNo: bigint) => void
		updateBufferSize: (bytes: bigint) => void // Function to update the buffer size
	},
	input: StreamWriteMessage_InitResponse
) {
	let serverLastSeqNo = input.lastSeqNo || 0n
	let currentLastSeqNo = ctx.lastSeqNo
	let isFirstInit = currentLastSeqNo === undefined
	let lastSeqNoChanged = isFirstInit || currentLastSeqNo !== serverLastSeqNo

	// Return inflight messages to buffer
	while (ctx.inflight.length > 0) {
		const message = ctx.inflight.pop()
		if (!message) {
			continue
		}

		ctx.buffer.unshift(message)
		ctx.updateBufferSize(BigInt(message.data.length))
	}

	// If this is the first initialization or server provided a new lastSeqNo, and we're in auto seqNo mode,
	// renumber all messages in buffer to continue from serverLastSeqNo + 1
	// Always renumber on first init, even if currentLastSeqNo === serverLastSeqNo (messages written before init)
	// Also renumber if there are messages in buffer that were written before init (their seqNo start from 1, not serverLastSeqNo + 1)
	let finalLastSeqNo = serverLastSeqNo
	let shouldRenumber = false
	// Only renumber in auto mode (when user didn't provide seqNo)
	if (!ctx.isSeqNoProvided && ctx.buffer.length > 0) {
		if (isFirstInit) {
			// First initialization: always renumber messages written before init
			shouldRenumber = true
		} else if (lastSeqNoChanged) {
			// Reconnection: renumber if server's lastSeqNo changed
			shouldRenumber = true
		} else if (ctx.buffer.length > 0) {
			// Check if messages in buffer were written before init (seqNo start from 1, not serverLastSeqNo + 1)
			// If first message's seqNo is <= serverLastSeqNo, it was written before init and needs renumbering
			let firstMessageSeqNo = ctx.buffer[0]?.seqNo
			if (
				firstMessageSeqNo !== undefined &&
				firstMessageSeqNo <= serverLastSeqNo
			) {
				shouldRenumber = true
			}
		}
	}

	if (shouldRenumber) {
		let nextSeqNo = serverLastSeqNo + 1n
		// Renumber all messages in buffer sequentially starting from serverLastSeqNo + 1
		for (let message of ctx.buffer) {
			message.seqNo = nextSeqNo
			nextSeqNo++
		}
		// Update lastSeqNo to the last renumbered seqNo so flush() returns correct value
		finalLastSeqNo = nextSeqNo - 1n
		ctx.updateLastSeqNo(finalLastSeqNo)
	} else if (lastSeqNoChanged) {
		// Store the last sequence number from the server if we didn't renumber
		ctx.updateLastSeqNo(serverLastSeqNo)
	}

	// Flush the buffer to send any pending messages
	_flush(ctx)
}
