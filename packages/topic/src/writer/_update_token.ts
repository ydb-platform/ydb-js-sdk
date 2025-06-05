import { EventEmitter } from "node:events";

import { create } from "@bufbuild/protobuf";
import { StreamWriteMessage_FromClientSchema } from "@ydbjs/api/topic";
import type { OutgoingEventMap } from "./types.ts";

export function _send_update_token_request(ctx: {
	readonly ee: EventEmitter<OutgoingEventMap>;
	readonly token: string
}) {
	return ctx.ee.emit('message', create(StreamWriteMessage_FromClientSchema, {
		clientMessage: {
			case: 'updateTokenRequest',
			value: {
				token: ctx.token
			}
		}
	}));
}
