export class TopicPartitionSession {
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
	partitionCommittedOffset = 0n
	/**
	 * Flag indicating whether the session is currently active.
	 */
	#stopped = false
	/**
	 * Flag indicating whether the session has ended.
	 */
	#ended = false
	/**
	 * Partitions formed by the split/merge that ended this one (autopartitioning).
	 */
	#childPartitionIds: bigint[] = []
	/**
	 * Partitions merged with this one (autopartitioning).
	 */
	#adjacentPartitionIds: bigint[] = []

	/**
	 * Creates a new instance of TopicPartitionSession.
	 * @param partitionSessionId - The identifier of the partition session.
	 * @param partitionId - The identifier of the partition.
	 * @param topicPath - The path of the topic.
	 */
	constructor(partitionSessionId: bigint, partitionId: bigint, topicPath: string) {
		this.partitionSessionId = partitionSessionId
		this.partitionId = partitionId
		this.topicPath = topicPath
	}

	get isStopped(): boolean {
		return this.#stopped
	}

	get isEnded(): boolean {
		return this.#ended
	}

	/**
	 * Partitions formed by the split/merge that ended this one. Empty until the
	 * session ends (autopartitioning topics only).
	 */
	get childPartitionIds(): readonly bigint[] {
		return this.#childPartitionIds
	}

	/**
	 * Partitions merged with this one. Empty until the session ends
	 * (autopartitioning topics only).
	 */
	get adjacentPartitionIds(): readonly bigint[] {
		return this.#adjacentPartitionIds
	}

	stop(): void {
		this.#stopped = true
	}

	end(childPartitionIds: bigint[] = [], adjacentPartitionIds: bigint[] = []): void {
		this.#ended = true
		this.#childPartitionIds = childPartitionIds
		this.#adjacentPartitionIds = adjacentPartitionIds
	}
}
