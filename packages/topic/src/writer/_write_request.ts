import { create } from "@bufbuild/protobuf";
import { Codec, type StreamWriteMessage_FromClient, StreamWriteMessage_FromClientSchema, type StreamWriteMessage_WriteRequest_MessageData } from "@ydbjs/api/topic";
import { type CompressionCodec } from "../codec.js";
import type { PQueue } from "../queue.js";
import type { TX } from "../tx.js";

export function _emit_write_request(ctx: {
	readonly tx?: TX
	readonly queue: PQueue<StreamWriteMessage_FromClient>,
	readonly codec?: CompressionCodec, // Codec to use for compression
}, messages: StreamWriteMessage_WriteRequest_MessageData[]) {
	return ctx.queue.push(create(StreamWriteMessage_FromClientSchema, {
		clientMessage: {
			case: 'writeRequest',
			value: {
				messages,
				codec: ctx.codec?.codec || Codec.RAW,
				tx: ctx.tx ? {
					id: ctx.tx.transactionId,
					session: ctx.tx.sessionId
				} : undefined
			}
		}
	}));
}
