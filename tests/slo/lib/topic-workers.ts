import { Worker } from 'node:worker_threads'

import type { TopicStability } from './topic-stability.ts'
import type { TopicOracleSnapshot } from './topic-oracle.ts'
import type { TopicWorkerData, TopicWriteCheckpoint } from './worker-api.ts'

export type TopicWorkerResult = {
	success: boolean
	error?: string
	checkpoint?: TopicWriteCheckpoint
	summary?: TopicOracleSnapshot
	reconnects: number
	stability?: ReturnType<TopicStability['finish']>
	runtime?: { name: string; version: string }
	drainedMemory?: Record<string, number>
}

export async function runTopicWorkers(
	urls: { read: URL; write: URL },
	data: Omit<TopicWorkerData, 'name'>,
	signal: AbortSignal
): Promise<{ read: TopicWorkerResult; write: TopicWorkerResult }> {
	let read = new Worker(urls.read, { workerData: { ...data, name: 'topic.read' } })
	let write = new Worker(urls.write, { workerData: { ...data, name: 'topic.write' } })
	let results: Partial<Record<'read' | 'write', TopicWorkerResult>> = {}
	let timedOut = Promise.withResolvers<never>()
	let timer: ReturnType<typeof setTimeout> | undefined
	let stop = () => {
		write.postMessage({ type: 'stop' })
		timer = setTimeout(
			() => timedOut.reject(new Error('Topic workers exceeded the drain deadline')),
			data.drainTimeoutMs
		)
	}
	let finished = (role: 'read' | 'write', worker: Worker) =>
		new Promise<void>((resolve, reject) => {
			worker.on('error', reject)
			worker.on('message', (message) => {
				try {
					if (role === 'write' && message.type === 'checkpoint') {
						read.postMessage({
							type: 'checkpoint',
							checkpoint: message.checkpoint,
							final: false,
						})
					} else if (message.type === 'result') {
						if (!message.success)
							throw new Error(`${role}: ${message.error ?? 'worker failed'}`)
						if (!signal.aborted)
							throw new Error(`${role} finished before producer stop`)
						if (results[role]) throw new Error(`${role} sent a second result`)
						if (role === 'read' && !results.write)
							throw new Error('Reader finished before final writer checkpoint')
						results[role] = message
						if (role === 'write') {
							let checkpoint: TopicWriteCheckpoint = message.checkpoint
							if (
								checkpoint.accepted.length !== data.partitions ||
								checkpoint.acknowledged.length !== data.partitions ||
								checkpoint.accepted.some(
									(count, partition) =>
										!Number.isSafeInteger(count) ||
										count < 1 ||
										count !== checkpoint.acknowledged[partition]
								)
							)
								throw new Error('Writer did not acknowledge every accepted message')
							read.postMessage({ type: 'checkpoint', checkpoint, final: true })
						}
					}
				} catch (error) {
					reject(error)
				}
			})
			worker.once('exit', (code) => {
				if (code !== 0 || !results[role])
					reject(
						new Error(`${role} exited with code ${code} without a successful result`)
					)
				else resolve()
			})
		})
	let workers = Promise.all([finished('read', read), finished('write', write)])
	try {
		signal.addEventListener('abort', stop, { once: true })
		if (signal.aborted) stop()
		await Promise.race([workers, timedOut.promise])
		let summary = results.read?.summary
		let checkpoint = results.write!.checkpoint!
		if (
			!summary?.complete ||
			summary.failureCount !== 0 ||
			summary.producers.length !== data.partitions ||
			summary.producers.some((producer, partition) =>
				[
					producer.accepted,
					producer.acknowledged,
					producer.delivered,
					producer.committed,
				].some((count) => count !== checkpoint.accepted[partition])
			)
		)
			throw new Error('Reader did not reconcile the final writer checkpoint')
		return { read: results.read!, write: results.write! }
	} finally {
		clearTimeout(timer)
		signal.removeEventListener('abort', stop)
		await Promise.all([read.terminate(), write.terminate()])
	}
}
