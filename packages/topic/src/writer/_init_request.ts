import { EventEmitter } from "node:events";

import { create } from "@bufbuild/protobuf";
import { StreamWriteMessage_FromClientSchema } from "@ydbjs/api/topic";
import type { OutgoingEventMap } from "./types.ts";

export function _send_init_request(ctx: {
	readonly ee: EventEmitter<OutgoingEventMap>;
	readonly topic: string;
	readonly producer?: string;
	readonly getLastSeqNo?: boolean;
}) {
	return ctx.ee.emit('message', create(StreamWriteMessage_FromClientSchema, {
		clientMessage: {
			case: 'initRequest',
			value: {
				path: ctx.topic,
				producerId: ctx.producer,
				getLastSeqNo: ctx.getLastSeqNo,
			}
		}
	}));
}
