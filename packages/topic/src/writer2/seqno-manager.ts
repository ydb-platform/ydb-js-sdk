/**
 * Sequence Number Manager for TopicWriter
 *
 * Handles two modes:
 * 1. Auto mode: Automatically generates sequential seqNo starting from lastSeqNo + 1
 * 2. Manual mode: User provides all seqNo values, validates they are strictly increasing
 */
export class SeqNoManager {
	#mode: 'auto' | 'manual' | null = null
	#nextSeqNo: bigint = 1n
	#lastSeqNo: bigint = 0n
	#highestUserSeqNo: bigint = 0n

	constructor(initialSeqNo: bigint = 0n) {
		this.#nextSeqNo = initialSeqNo + 1n
		this.#lastSeqNo = initialSeqNo
	}

	/**
	 * Initialize with server's last seqNo from STREAM_INIT_RESPONSE
	 */
	initialize(serverLastSeqNo: bigint): void {
		this.#lastSeqNo = serverLastSeqNo
		this.#nextSeqNo = serverLastSeqNo + 1n
	}

	/**
	 * Get next sequence number for a message
	 * @param userSeqNo Optional user-provided seqNo
	 * @returns Final seqNo to use for the message
	 */
	getNext(userSeqNo?: bigint): bigint {
		// Determine mode on first call
		if (this.#mode === null) {
			this.#mode = userSeqNo !== undefined ? 'manual' : 'auto'
		}

		if (this.#mode === 'auto') {
			if (userSeqNo !== undefined) {
				throw new Error('Cannot mix auto and manual seqNo modes. Once auto mode is started, all messages must use auto seqNo.')
			}

			let seqNo = this.#nextSeqNo
			this.#nextSeqNo++
			this.#lastSeqNo = seqNo // Update lastSeqNo when we write
			return seqNo
		} else {
			// Manual mode
			if (userSeqNo === undefined) {
				throw new Error('Cannot mix manual and auto seqNo modes. Once manual mode is started, all messages must provide seqNo.')
			}

			// Validate strictly increasing
			if (userSeqNo <= this.#highestUserSeqNo) {
				throw new Error(`SeqNo must be strictly increasing. Provided: ${userSeqNo}, highest seen: ${this.#highestUserSeqNo}`)
			}

			this.#highestUserSeqNo = userSeqNo
			this.#lastSeqNo = userSeqNo // Update lastSeqNo when we write
			return userSeqNo
		}
	}

	/**
	 * Get current state
	 */
	getState() {
		return {
			mode: this.#mode,
			nextSeqNo: this.#nextSeqNo,
			lastSeqNo: this.#lastSeqNo,
			highestUserSeqNo: this.#highestUserSeqNo,
		}
	}
}
