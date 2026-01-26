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
	 * Start offset for the next commit range.
	 * Initialized from server's committedOffset in StartPartitionSessionRequest.
	 * Updated after each commit to the end of committed range.
	 *
	 * This fills gaps between committedOffset and first message offset
	 * when messages are deleted by retention policy.
	 */
	nextCommitStartOffset = 0n
	/**
	 * Flag indicating whether the session is currently active.
	 */
	#stopped = false
	/**
	 * Flag indicating whether the session has ended.
	 */
	#ended = false

	/**
	 * Creates a new instance of TopicPartitionSession.
	 * @param partitionSessionId - The identifier of the partition session.
	 * @param partitionId - The identifier of the partition.
	 * @param topicPath - The path of the topic.
	 */
	constructor(
		partitionSessionId: bigint,
		partitionId: bigint,
		topicPath: string
	) {
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

	stop(): void {
		this.#stopped = true
	}

	end(): void {
		this.#ended = true
	}
}
