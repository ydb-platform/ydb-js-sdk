import { TopicStability } from './topic-stability.ts'

export async function createTopicMemory(
	params: Record<string, string>,
	rps: number,
	maxPendingMessages: number
) {
	let jsc: { heapStats(): { heapSize: number; extraMemorySize: number } } | undefined
	if (process.versions['bun']) {
		let module = 'bun:jsc'
		jsc = await import(module)
	}
	let memory = () => {
		let usage = process.memoryUsage()
		let native = jsc?.heapStats()
		return native
			? { rss: usage.rss, heapSize: native.heapSize, extraMemorySize: native.extraMemorySize }
			: {
					rss: usage.rss,
					heapUsed: usage.heapUsed,
					external: usage.external,
					arrayBuffers: usage.arrayBuffers,
				}
	}
	let stability =
		params['stability'] === 'true'
			? new TopicStability({
					warmupMs: Number(params['warmupSeconds'] ?? 300) * 1000,
					windowMs: Number(params['windowSeconds'] ?? 300) * 1000,
					rps,
					...(rps === 0 && { maxPendingMessages }),
					memoryGrowthBytes: jsc
						? {
								rss: 256 * 1024 ** 2,
								heapSize: 64 * 1024 ** 2,
								extraMemorySize: 64 * 1024 ** 2,
							}
						: {
								rss: 256 * 1024 ** 2,
								heapUsed: 64 * 1024 ** 2,
								external: 64 * 1024 ** 2,
								arrayBuffers: 32 * 1024 ** 2,
							},
				})
			: undefined
	return {
		memory,
		stability,
		runtime: {
			name: jsc ? 'bun' : 'node',
			version: process.versions['bun'] ?? process.version,
		},
	}
}
