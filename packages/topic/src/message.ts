export interface TopicMessage<Payload = Uint8Array> {
	partitionSessionId?: bigint;
	partitionId: bigint;
	producerId: string;

	seqNo: bigint;
	offset?: bigint;
	payload: Payload;

	createdAt?: Date;
	writtenAt?: Date;
	metadataItems?: Record<string, Uint8Array>;
}
