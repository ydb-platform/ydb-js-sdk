type OffsetRange = { first: number; last: number; offset: bigint }

// Consecutive business sequences usually occupy consecutive partition offsets.
// Keep gaps explicit so historical redelivery can still be checked exactly.
export class TopicOffsets {
	#ranges: OffsetRange[] = []

	get size(): number {
		return this.#ranges.reduce((sum, range) => sum + range.last - range.first + 1, 0)
	}

	get rangeCount(): number {
		return this.#ranges.length
	}

	get(sequence: number): bigint | undefined {
		let range = this.#ranges[this.#position(sequence)]
		if (!range || sequence < range.first) return undefined
		return range.offset + BigInt(sequence - range.first)
	}

	has(sequence: number): boolean {
		return this.get(sequence) !== undefined
	}

	set(sequence: number, offset: bigint): void {
		let index = this.#position(sequence)
		let next = this.#ranges[index]
		let previous = this.#ranges[index - 1]
		if (next && sequence >= next.first) throw new Error('Sequence already recorded')
		let range = { first: sequence, last: sequence, offset }
		if (
			previous?.last === sequence - 1 &&
			previous.offset + BigInt(sequence - previous.first) === offset
		) {
			previous.last = sequence
			range = previous
		} else {
			if (this.#ranges.length >= 10_000)
				throw new Error('Verifier offset history exceeded 10000 disjoint ranges')
			this.#ranges.splice(index++, 0, range)
		}
		if (next?.first === sequence + 1 && next.offset === offset + 1n) {
			range.last = next.last
			this.#ranges.splice(index, 1)
		}
	}

	missing(first: number, last: number): { count: number; examples: number[] } {
		let count = 0
		let examples: number[] = []
		let cursor = first
		let add = (end: number) => {
			count += Math.max(0, end - cursor + 1)
			for (; cursor <= end && examples.length < 10; cursor++) examples.push(cursor)
		}
		for (let range of this.#ranges) {
			if (range.last < cursor) continue
			if (range.first > last) break
			add(range.first - 1)
			cursor = range.last + 1
		}
		add(last)
		return { count, examples }
	}

	#position(sequence: number): number {
		let low = 0
		let high = this.#ranges.length
		while (low < high) {
			let middle = (low + high) >>> 1
			if (this.#ranges[middle]!.last < sequence) low = middle + 1
			else high = middle
		}
		return low
	}
}
