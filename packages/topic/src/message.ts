import type { Codec } from "@ydbjs/api/topic";
import type { TopicPartitionSession } from "./partition-session.js";

type TopicMessageOptions = {
	partitionSession: TopicPartitionSession;
	producer: string;
	payload: Uint8Array;
	codec: Codec;
	seqNo: bigint;
	offset?: bigint;
	uncompressedSize?: bigint;

	createdAt?: number;
	writtenAt?: number;
	metadataItems?: Record<string, Uint8Array>;
}

export class TopicMessage {
	readonly partitionSession: WeakRef<TopicPartitionSession>;
	readonly producer: string;
	readonly payload: Uint8Array;
	readonly codec: Codec;
	readonly seqNo: bigint;
	readonly offset?: bigint;
	readonly uncompressedSize?: bigint;
	readonly createdAt?: number;
	readonly writtenAt?: number;
	readonly metadataItems?: Record<string, Uint8Array>;

	constructor(options: TopicMessageOptions) {
		this.partitionSession = new WeakRef(options.partitionSession);
		this.producer = options.producer;
		this.codec = options.codec;
		this.seqNo = options.seqNo;
		this.offset = options.offset ?? 0n;
		this.payload = options.payload;
		this.uncompressedSize = options.uncompressedSize ?? 0n;
	}

	get alive(): boolean {
		const session = this.partitionSession.deref();
		return session ? !session.isStopped : false;
	}
}
