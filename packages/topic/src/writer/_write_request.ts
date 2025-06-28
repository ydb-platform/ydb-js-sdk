import { create } from "@bufbuild/protobuf";
import { Codec, type StreamWriteMessage_FromClient, StreamWriteMessage_FromClientSchema, type StreamWriteMessage_WriteRequest_MessageData } from "@ydbjs/api/topic";
import { type CompressionCodec } from "../codec.js";
import type { AsyncPriorityQueue } from "../queue.js";
import type { TX } from "../tx.js";

export const _emit_write_request = function emit_write_request(ctx: {
	readonly tx?: TX
	readonly queue: AsyncPriorityQueue<StreamWriteMessage_FromClient>,
	readonly codec: CompressionCodec, // Codec to use for compression
}, messages: StreamWriteMessage_WriteRequest_MessageData[]) {
	return ctx.queue.push(create(StreamWriteMessage_FromClientSchema, {
		clientMessage: {
			case: 'writeRequest',
			value: {
				messages,
				codec: ctx.codec.codec || Codec.RAW,
				...(ctx.tx && {
					tx: {
						id: ctx.tx.transactionId,
						session: ctx.tx.sessionId
					}
				})
			}
		}
	}));
}
