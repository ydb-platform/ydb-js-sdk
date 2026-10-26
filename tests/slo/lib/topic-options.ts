import { randomUUID } from 'node:crypto'

import type { TopicWorkerData } from './worker-api.ts'

export function topicOptions(
	params: Record<string, string>
): Omit<TopicWorkerData, 'name' | 'writerIndex'> {
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
	let writerCount = integer('writers', 1, 1, partitions)
	let messageBytes = integer('size', 1024, 64, 8 * 1024 * 1024)
	let rps = integer('rps', 100, 0, 100_000)
	let maxPendingMessages = integer('inFlight', 8192, partitions, 1_000_000)
	let drainTimeoutMs = integer('drainTimeoutMs', 120_000, 1, 600_000)
	let stallTimeoutMs = integer('stallTimeoutMs', 120_000, 1, 600_000)
	let writeSpeedBytesPerSecond = integer('writeSpeedBytesPerSecond', 0, 0, 1024 ** 3)
	let retentionSeconds = integer('retentionSeconds', 86400, 600, 86400)
	let retentionStorageMb = integer('retentionStorageMb', 0, 0, 1024 * 1024)
	integer('warmupSeconds', 300, 0, 3600)
	integer('windowSeconds', 300, 10, 3600)
	if (params['stability'] !== undefined && !['true', 'false'].includes(params['stability'])) {
		throw new Error('stability must be true or false')
	}
	let runId = randomUUID()
	let topic = `${params['topic'] ?? 'slo-topic'}-${runId}`
	let consumer = params['consumer'] ?? 'slo-consumer'
	if (params['auth'] !== undefined && params['auth'] !== 'login') {
		throw new Error('auth must be login when specified')
	}

	let codec = params['codec'] ?? 'mixed'
	if (codec !== 'mixed' && !['raw', 'gzip', 'zstd'].includes(codec)) {
		throw new Error(`Unsupported codec: ${codec}`)
	}
	return {
		runId,
		topic,
		consumer,
		partitions,
		messageBytes,
		rps,
		codec,
		maxPendingMessages,
		writerCount,
		drainTimeoutMs,
		stallTimeoutMs,
		writeSpeedBytesPerSecond,
		retentionSeconds,
		retentionStorageMb,
		params,
	}
}
