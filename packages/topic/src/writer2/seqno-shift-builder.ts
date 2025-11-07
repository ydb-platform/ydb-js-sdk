import type { SeqNoShift } from './types.js'

/**
 * Builder for collecting sequence number shifts during message renumbering.
 *
 * Accumulates consecutive shifts with the same delta into compact ranges,
 * reducing the number of shift segments that need to be tracked.
 */
export class SeqNoShiftBuilder {
	#shifts: SeqNoShift[] = []
	#currentStart: bigint | null = null
	#currentDelta: bigint | null = null
	#currentCount = 0

	/**
	 * Add a shift for a single message.
	 * Automatically merges consecutive shifts with the same delta.
	 *
	 * @param oldSeqNo Original sequence number
	 * @param newSeqNo New sequence number after recalculation
	 */
	addShift(oldSeqNo: bigint, newSeqNo: bigint): void {
		if (oldSeqNo === newSeqNo) {
			this.flush()
			return
		}

		let delta = newSeqNo - oldSeqNo
		if (
			this.#currentStart !== null &&
			this.#currentDelta === delta &&
			oldSeqNo === this.#currentStart + BigInt(this.#currentCount)
		) {
			// Continue current shift range
			this.#currentCount++
		} else {
			// Start new shift range
			this.flush()
			this.#currentStart = oldSeqNo
			this.#currentDelta = delta
			this.#currentCount = 1
		}
	}

	/**
	 * Flush current shift range to the shifts array.
	 * Called automatically when starting a new range or when build() is called.
	 */
	flush(): void {
		if (this.#currentStart !== null && this.#currentDelta !== null && this.#currentCount > 0) {
			this.#shifts.push({
				start: this.#currentStart,
				end: this.#currentStart + BigInt(this.#currentCount),
				delta: this.#currentDelta,
			})
		}
		this.#currentStart = null
		this.#currentDelta = null
		this.#currentCount = 0
	}

	/**
	 * Build final array of shifts.
	 * Flushes any pending shift range before returning.
	 *
	 * @returns Array of shift ranges
	 */
	build(): SeqNoShift[] {
		this.flush()
		return this.#shifts
	}

	/**
	 * Reset builder to initial state.
	 */
	reset(): void {
		this.#shifts = []
		this.#currentStart = null
		this.#currentDelta = null
		this.#currentCount = 0
	}
}
