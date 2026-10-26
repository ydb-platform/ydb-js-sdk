import { randomUUID } from 'node:crypto'

import type { TopicWorkerData } from './worker-api.ts'

export function topicOptions(params: Record<string, string>): Omit<TopicWorkerData, 'name'> {
	let integer = function integer(
		key: string,
		fallback: number,
		min: number,
		max: number
	): number {
		let value = Number(params[key] ?? fallback)
		if (!Number.isSafeInteger(value) || value < min || value > max) {
			throw new RangeError(`${key} must be an integer between ${min} and ${max}`)
		}
		return value
	}
	let partitions = integer('partitions', 10, 1, 100)
	let messageBytes = integer('size', 1024, 64, 8 * 1024 * 1024)
	let rps = integer('rps', 100, 1, 100_000)
	let drainTimeoutMs = integer('drainTimeoutMs', 120_000, 1, 600_000)
	let stallTimeoutMs = integer('stallTimeoutMs', 120_000, 1, 600_000)
	let runId = randomUUID()
	let topic = `${params['topic'] ?? 'slo-topic'}-${runId}`
	let consumer = params['consumer'] ?? 'slo-consumer'
	let codec = params['codec'] ?? 'mixed'
	if (codec !== 'mixed' && !['raw', 'gzip', 'zstd'].includes(codec))
		throw new Error(`Unsupported codec: ${codec}`)
	return {
		runId,
		topic,
		consumer,
		partitions,
		messageBytes,
		rps,
		codec,
		drainTimeoutMs,
		stallTimeoutMs,
		params,
	}
}
