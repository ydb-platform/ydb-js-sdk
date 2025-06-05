import type { Codec } from "@ydbjs/api/topic";

export interface TopicMessage<Payload = Uint8Array> {
	partitionSessionId?: bigint;
	partitionId: bigint;
	producerId: string;

	codec: Codec,
	seqNo: bigint;
	offset?: bigint;
	payload: Payload;
	uncompressedSize?: bigint;

	createdAt?: Date;
	writtenAt?: Date;
	metadataItems?: Record<string, Uint8Array>;
}
