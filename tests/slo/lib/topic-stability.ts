export type StabilitySample = {
	elapsedMs: number
	started: number
	completed: number
	memory: Record<string, number>
}

export type StabilityOptions = {
	warmupMs: number
	windowMs: number
	rps: number
	memoryGrowthBytes: Record<string, number>
}

export class TopicStability {
	#options: StabilityOptions
	#first: StabilitySample | undefined
	#minimum: Record<string, number> = {}
	#baseline: Record<string, number> | undefined
	#windows = 0
	#lastElapsedMs = -1
	#failure: string | undefined
	#maxLatencyMs = 0

	constructor(options: StabilityOptions) {
		if (
			![options.warmupMs, options.windowMs, options.rps].every(Number.isFinite) ||
			options.warmupMs < 0 ||
			options.windowMs <= 0 ||
			options.rps <= 0 ||
			Object.values(options.memoryGrowthBytes).some(
				(value) => !Number.isFinite(value) || value < 0
			)
		)
			throw new Error('Invalid stability profile')
		this.#options = options
	}

	observe(sample: StabilitySample): Record<string, unknown> | undefined {
		if (this.#failure) throw new Error(this.#failure)
		let { warmupMs, windowMs, rps, memoryGrowthBytes } = this.#options
		if (
			!Number.isFinite(sample.elapsedMs) ||
			sample.elapsedMs <= this.#lastElapsedMs ||
			!Number.isSafeInteger(sample.started) ||
			!Number.isSafeInteger(sample.completed) ||
			sample.started < 0 ||
			sample.completed < 0 ||
			sample.completed > sample.started
		)
			this.#fail('Invalid stability sample')
		if (this.#lastElapsedMs >= warmupMs && sample.elapsedMs - this.#lastElapsedMs > 10_000)
			this.#fail('More than 10 seconds without a stability sample')
		this.#lastElapsedMs = sample.elapsedMs
		for (let key of Object.keys(memoryGrowthBytes)) {
			if (!Number.isFinite(sample.memory[key]) || sample.memory[key]! < 0)
				this.#fail(`Missing or invalid memory counter: ${key}`)
		}
		if (sample.memory['rss']! > 2 * 1024 ** 3)
			this.#fail('RSS exceeds the 2 GiB stability budget')
		if (sample.elapsedMs < warmupMs) return
		if (sample.started - sample.completed > rps * 10)
			this.#fail(
				`Backlog exceeds 10 seconds of traffic: ${sample.started - sample.completed}`
			)
		this.#first ??= sample
		for (let key of Object.keys(memoryGrowthBytes))
			this.#minimum[key] = Math.min(this.#minimum[key] ?? Infinity, sample.memory[key]!)
		let durationMs = sample.elapsedMs - this.#first.elapsedMs
		if (durationMs < windowMs) return
		let startedPerSecond = ((sample.started - this.#first.started) * 1000) / durationMs
		let completedPerSecond = ((sample.completed - this.#first.completed) * 1000) / durationMs
		let pending = sample.started - sample.completed
		let growth = Object.fromEntries(
			Object.keys(memoryGrowthBytes).map((key) => [
				key,
				this.#minimum[key]! - (this.#baseline?.[key] ?? this.#minimum[key]!),
			])
		)
		if (startedPerSecond < rps * 0.9 || completedPerSecond < rps * 0.9)
			this.#fail(
				`Throughput below 90% of ${rps} messages/s: started=${startedPerSecond}, completed=${completedPerSecond}`
			)
		for (let [key, limit] of Object.entries(memoryGrowthBytes)) {
			if (growth[key]! > limit)
				this.#fail(`${key} grew by ${growth[key]} bytes (limit ${limit})`)
		}
		this.#baseline ??= { ...this.#minimum }
		this.#windows++
		let result = {
			elapsedMs: sample.elapsedMs,
			startedPerSecond,
			completedPerSecond,
			pending,
			minimum: this.#minimum,
			growth,
			maxLatencyMs: this.#maxLatencyMs,
		}
		this.#maxLatencyMs = 0
		this.#first = sample
		this.#minimum = { ...sample.memory }
		return result
	}

	recordLatency(milliseconds: number): void {
		if (!Number.isFinite(milliseconds) || milliseconds < 0)
			this.#fail(`Invalid operation latency: ${milliseconds}ms`)
		if (this.#lastElapsedMs - milliseconds < this.#options.warmupMs) return
		if (milliseconds > 10_000)
			this.#fail(`Operation latency exceeds 10 seconds or is invalid: ${milliseconds}ms`)
		this.#maxLatencyMs = Math.max(this.#maxLatencyMs, milliseconds)
	}

	finish(): { windows: number; baseline: Record<string, number> } {
		if (this.#failure) throw new Error(this.#failure)
		if (this.#windows < 2)
			this.#fail('Stability run needs a baseline and at least one comparison window')
		return { windows: this.#windows, baseline: this.#baseline! }
	}

	#fail(message: string): never {
		this.#failure = message
		throw new Error(message)
	}
}
