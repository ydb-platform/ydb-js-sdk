import type { Worker } from 'node:worker_threads'

import type { TopicStability } from './topic-stability.ts'
import type { TopicOracleSnapshot } from './topic-oracle.ts'
import type { TopicWorkerData, TopicWriteCheckpoint } from './worker-api.ts'

export type TopicWorkerResult = {
	success: boolean
	error?: string
	checkpoint?: TopicWriteCheckpoint
	summary?: TopicOracleSnapshot
	tokenRenewal?:
		| { streams: number; renewed: number; updates: number; changes: number }
		| undefined
	reconnects: number
	stability?: ReturnType<TopicStability['finish']>
	runtime?: { name: string; version: string }
	drainedMemory?: Record<string, number>
}

export type TopicWorker = Pick<Worker, 'postMessage' | 'terminate'> & {
	on(event: 'error', listener: (error: Error) => void): void
	on(event: 'message', listener: (message: TopicWorkerMessage) => void): void
	once(event: 'exit', listener: (code: number) => void): void
}

type TopicWorkerMessage =
	| { type: 'checkpoint'; checkpoint: TopicWriteCheckpoint }
	| { type: 'committed'; counts: number[] }
	| ({ type: 'result' } & TopicWorkerResult)

export async function runTopicWorkers(
	{ read, write: writers }: { read: TopicWorker; write: TopicWorker[] },
	options: Pick<TopicWorkerData, 'partitions' | 'drainTimeoutMs' | 'writerCount'>,
	signal: AbortSignal
): Promise<{ read: TopicWorkerResult; write: TopicWorkerResult[] }> {
	let readerResult: TopicWorkerResult | undefined
	let writerResults: (TopicWorkerResult | undefined)[] = Array(options.writerCount).fill(
		undefined
	)
	let checkpoints: TopicWriteCheckpoint[] = writers.map(() => ({
		accepted: Array(options.partitions).fill(0),
		acknowledged: Array(options.partitions).fill(0),
	}))
	let combined = (): TopicWriteCheckpoint => ({
		accepted: Array.from(
			{ length: options.partitions },
			(_, partition) => checkpoints[partition % options.writerCount]!.accepted[partition]!
		),
		acknowledged: Array.from(
			{ length: options.partitions },
			(_, partition) => checkpoints[partition % options.writerCount]!.acknowledged[partition]!
		),
	})
	let timedOut = Promise.withResolvers<never>()
	let timer: ReturnType<typeof setTimeout> | undefined
	let stop = () => {
		for (let writer of writers) {
			writer.postMessage({ type: 'stop' })
		}
		timer = setTimeout(
			() => timedOut.reject(new Error('Topic workers exceeded the drain deadline')),
			options.drainTimeoutMs
		)
	}
	let finished = (worker: TopicWorker, writerIndex?: number) =>
		new Promise<void>((resolve, reject) => {
			let role =
				writerIndex === undefined
					? 'read'
					: writers.length === 1
						? 'write'
						: `write.${writerIndex}`
			let result: TopicWorkerResult | undefined
			worker.on('error', reject)
			worker.on('message', (message: TopicWorkerMessage) => {
				try {
					if (writerIndex === undefined && message.type === 'committed') {
						for (let writer of writers) {
							writer.postMessage(message)
						}
					} else if (writerIndex !== undefined && message.type === 'checkpoint') {
						checkpoints[writerIndex] = message.checkpoint
						read.postMessage({
							type: 'checkpoint',
							checkpoint: combined(),
							final: false,
						})
					} else if (message.type === 'result') {
						if (!message.success) {
							throw new Error(`${role}: ${message.error ?? 'worker failed'}`)
						}
						if (!signal.aborted) {
							throw new Error(`${role} finished before producer stop`)
						}
						if (result) {
							throw new Error(`${role} sent a second result`)
						}
						result = message
						if (writerIndex === undefined) {
							if (writerResults.some((writer) => !writer)) {
								throw new Error('Reader finished before final writer checkpoint')
							}
							readerResult = message
						} else {
							let checkpoint = message.checkpoint
							if (
								!checkpoint ||
								checkpoint.accepted.length !== options.partitions ||
								checkpoint.acknowledged.length !== options.partitions ||
								checkpoint.accepted.some(
									(count, partition) =>
										!Number.isSafeInteger(count) ||
										(partition % options.writerCount === writerIndex
											? count < 1
											: count !== 0) ||
										count !== checkpoint.acknowledged[partition]
								)
							) {
								throw new Error('Writer did not acknowledge every accepted message')
							}
							writerResults[writerIndex] = message
							checkpoints[writerIndex] = checkpoint
							read.postMessage({
								type: 'checkpoint',
								checkpoint: combined(),
								final: writerResults.every(Boolean),
							})
						}
					}
				} catch (error) {
					reject(error)
				}
			})
			worker.once('exit', (code) => {
				if (code !== 0) {
					reject(new Error(`${role} exited with code ${code}`))
				} else if (!result) {
					reject(new Error(`${role} exited without a successful result`))
				} else {
					resolve()
				}
			})
		})
	let workers = Promise.all([
		finished(read),
		...writers.map((writer, index) => finished(writer, index)),
	])
	try {
		signal.addEventListener('abort', stop, { once: true })
		if (signal.aborted) {
			stop()
		}
		await Promise.race([workers, timedOut.promise])
		let summary = readerResult?.summary
		let checkpoint = combined()
		if (
			!summary?.complete ||
			summary.failureCount !== 0 ||
			summary.producers.length !== options.partitions ||
			summary.producers.some((producer, partition) =>
				[
					producer.accepted,
					producer.acknowledged,
					producer.delivered,
					producer.committed,
				].some((count) => count !== checkpoint.accepted[partition])
			)
		) {
			throw new Error('Reader did not reconcile the final writer checkpoint')
		}
		return { read: readerResult!, write: writerResults as TopicWorkerResult[] }
	} finally {
		clearTimeout(timer)
		signal.removeEventListener('abort', stop)
		await Promise.all([read.terminate(), ...writers.map((writer) => writer.terminate())])
	}
}
