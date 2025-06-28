import type { StreamWriteMessage_WriteRequest_MessageData } from "@ydbjs/api/topic";
import { MAX_BATCH_SIZE } from "./constants.js";

export const _batch_messages = function batch_messages(
	messages: StreamWriteMessage_WriteRequest_MessageData[],
): StreamWriteMessage_WriteRequest_MessageData[][] {
	let batches: StreamWriteMessage_WriteRequest_MessageData[][] = [];

	// Build batch until size limit or no more messages
	while (messages.length > 0) {
		let batch: StreamWriteMessage_WriteRequest_MessageData[] = [];
		let batchSize = 0n;

		// Build batch until size limit or no more messages
		while (messages.length > 0) {
			let message = messages[0]!;

			// Check if adding this message would exceed the batch size limit
			if (batchSize + BigInt(message.data.length) > MAX_BATCH_SIZE) {
				// If the batch already has messages, send it
				if (batch.length > 0) {
					break;
				}

				// If this is a single message exceeding the limit, we still need to send it
				batch.push(messages.shift()!);
				break;
			}

			// Add message to current batch
			batch.push(messages.shift()!);
			batchSize += BigInt(message.data.length);
		}

		// If the batch is not empty, add it to the batches array
		// This ensures that we always send at least one message, even if it exceeds the batch size limit.
		if (batch.length > 0) {
			batches.push(batch);
		}
	}

	return batches;
}
