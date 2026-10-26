import type { Worker } from 'node:worker_threads'

import type { TopicOracleSnapshot } from './topic-oracle.ts'
import type { TopicWorkerData, TopicWriteCheckpoint } from './worker-api.ts'

export type TopicWorkerResult = {
	success: boolean
	error?: string
	checkpoint?: TopicWriteCheckpoint
	summary?: TopicOracleSnapshot
	reconnects: number
}

export type TopicWorker = Pick<Worker, 'postMessage' | 'terminate'> & {
	on(event: 'error', listener: (error: Error) => void): void
	on(event: 'message', listener: (message: TopicWorkerMessage) => void): void
	once(event: 'exit', listener: (code: number) => void): void
}

type TopicWorkerMessage =
	| { type: 'checkpoint'; checkpoint: TopicWriteCheckpoint }
	| ({ type: 'result' } & TopicWorkerResult)

export async function runTopicWorkers(
	{ read, write }: { read: TopicWorker; write: TopicWorker },
	options: Pick<TopicWorkerData, 'partitions' | 'drainTimeoutMs'>,
	signal: AbortSignal
): Promise<{ read: TopicWorkerResult; write: TopicWorkerResult }> {
	let results: Partial<Record<'read' | 'write', TopicWorkerResult>> = {}
	let timedOut = Promise.withResolvers<never>()
	let timer: ReturnType<typeof setTimeout> | undefined
	let stop = () => {
		write.postMessage({ type: 'stop' })
		timer = setTimeout(
			() => timedOut.reject(new Error('Topic workers exceeded the drain deadline')),
			options.drainTimeoutMs
		)
	}
	let finished = (role: 'read' | 'write', worker: TopicWorker) =>
		new Promise<void>((resolve, reject) => {
			worker.on('error', reject)
			worker.on('message', (message: TopicWorkerMessage) => {
				try {
					if (role === 'write' && message.type === 'checkpoint') {
						read.postMessage({
							type: 'checkpoint',
							checkpoint: message.checkpoint,
							final: false,
						})
					} else if (message.type === 'result') {
						if (!message.success) {
							throw new Error(`${role}: ${message.error ?? 'worker failed'}`)
						}
						if (!signal.aborted) {
							throw new Error(`${role} finished before producer stop`)
						}
						if (results[role]) throw new Error(`${role} sent a second result`)
						if (role === 'read' && !results.write) {
							throw new Error('Reader finished before final writer checkpoint')
						}
						results[role] = message
						if (role === 'write') {
							let checkpoint = message.checkpoint
							if (
								!checkpoint ||
								checkpoint.accepted.length !== options.partitions ||
								checkpoint.acknowledged.length !== options.partitions ||
								checkpoint.accepted.some(
									(count, partition) =>
										!Number.isSafeInteger(count) ||
										count < 1 ||
										count !== checkpoint.acknowledged[partition]
								)
							) {
								throw new Error('Writer did not acknowledge every accepted message')
							}
							read.postMessage({ type: 'checkpoint', checkpoint, final: true })
						}
					}
				} catch (error) {
					reject(error)
				}
			})
			worker.once('exit', (code) => {
				if (code !== 0) {
					reject(new Error(`${role} exited with code ${code}`))
				} else if (!results[role]) {
					reject(new Error(`${role} exited without a successful result`))
				} else {
					resolve()
				}
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
		return { read: results.read!, write: results.write! }
	} finally {
		clearTimeout(timer)
		signal.removeEventListener('abort', stop)
		await Promise.all([read.terminate(), write.terminate()])
	}
}
