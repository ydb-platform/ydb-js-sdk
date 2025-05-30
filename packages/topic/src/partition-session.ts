import { EventEmitter } from "node:stream"

type TopicPartitionSessionEmitterMap = {
	"stop": []
	"end": []
}

export class TopicPartitionSession extends EventEmitter<TopicPartitionSessionEmitterMap> {
	/**
	 * Partition session identifier.
	 */
	readonly partitionSessionId: bigint
	/**
	 * Partition identifier.
	 */
	readonly partitionId: bigint
	/**
	 * Topic path.
	 */
	readonly topicPath: string
	/**
	 * Partition offsets.
	 */
	partitionOffsets = { start: 0n, end: 0n }
	/**
	 * Offset of the last committed message from the partition.
	 */
	partitionCommittedOffset: bigint = 0n
	/**
	 * Flag indicating whether the session is currently active.
	 */
	#stopped: boolean = false
	/**
	 * Flag indicating whether the session has ended.
	 */
	#ended: boolean = false

	/**
	 * Creates a new instance of TopicPartitionSession.
	 * @param partitionSessionId - The identifier of the partition session.
	 * @param partitionId - The identifier of the partition.
	 * @param topicPath - The path of the topic.
	 */
	constructor(partitionSessionId: bigint, partitionId: bigint, topicPath: string) {
		super();

		this.partitionSessionId = partitionSessionId;
		this.partitionId = partitionId;
		this.topicPath = topicPath;
	}

	get isStopped(): boolean {
		return this.#stopped;
	}

	get isEnded(): boolean {
		return this.#ended;
	}

	stop(): void {
		this.emit("stop");
		this.#stopped = true;
	}

	end(): void {
		this.emit("end");
		this.#ended = true;
	}
}
