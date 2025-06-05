import type { StreamWriteMessage_FromClient } from "@ydbjs/api/topic";

export type OutgoingEventMap = {
	'message': [StreamWriteMessage_FromClient],
	'close': [void],
}
