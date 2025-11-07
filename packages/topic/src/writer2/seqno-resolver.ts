import type { SeqNoShift } from './types.js'

/**
 * Resolves temporary sequence numbers to final sequence numbers.
 *
 * When messages are written before session initialization or after reconnection,
 * their seqNo values may be temporary and get recalculated. This resolver maintains
 * a collection of shifts that describe how temporary seqNo map to final seqNo.
 *
 * Example:
 *   shift { start: 10n, end: 13n, delta: 100n }
 *   means temporary seqNo 10, 11, 12 were finally stored as 110, 111, 112 respectively.
 */
export class SeqNoResolver {
	#shifts: SeqNoShift[] = []

	/**
	 * Apply new shifts from state machine.
	 * Merges new shifts with existing ones, handling overlaps and intersections.
	 */
	applyShifts(newShifts: SeqNoShift[]): void {
		for (let shift of newShifts) {
			this.applyShift(shift)
		}
	}

	/**
	 * Apply a single shift.
	 *
	 * Invariant: shifts are emitted strictly in order of old seqNo, without overlaps.
	 */
	applyShift(shift: SeqNoShift): void {
		let { start, end, delta } = shift
		if (start >= end || delta === 0n) {
			return
		}

		let last = this.#shifts[this.#shifts.length - 1]
		if (!last) {
			this.#shifts.push({ start, end, delta })
			return
		}

		if (start < last.end) {
			throw new Error('Internal error: overlapping seqNo shifts detected')
		}

		if (start === last.end && delta === last.delta) {
			last.end = end
			return
		}

		this.#shifts.push({ start, end, delta })
	}

	/**
	 * Resolve final seqNo for a temporary seqNo.
	 * @param initialSeqNo Temporary seqNo returned by write()
	 * @returns Final seqNo assigned after session re-initialization
	 */
	resolveSeqNo(initialSeqNo: bigint): bigint {
		let result = initialSeqNo

		while (true) {
			let matched = false

			for (let segment of this.#shifts) {
				if (result >= segment.start && result < segment.end) {
					let next = result + segment.delta
					if (next === result) {
						return result
					}
					result = next
					matched = true
					break
				}
			}

			if (!matched) {
				break
			}
		}

		return result
	}

	/**
	 * Clear all shifts.
	 */
	reset(): void {
		this.#shifts = []
	}

	/**
	 * Get current shifts (for testing/debugging).
	 */
	getShifts(): readonly SeqNoShift[] {
		return this.#shifts
	}
}
