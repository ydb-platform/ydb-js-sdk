import { expect, test } from 'vitest'

import { verifyMemoryProfile } from '../tests/memory-profile.ts'
import type { MemoryReport } from '../tests/memory-worker.ts'

let scenarios = ['steady', 'reconnect', 'replace']
let runtimes = ['node', 'bun'] as const

function memoryReport(runtime: 'node' | 'bun'): MemoryReport {
	return {
		runtime: { name: runtime, version: 'fixture', supportsActiveResources: runtime === 'node' },
		node: 'fixture',
		platform: 'fixture',
		arch: 'fixture',
		epochs: 9,
		epochPauseMs: 0,
		payloadBytes: 32 * 1024,
		messagesPerEpoch: 128,
		accepted: [1],
		acknowledged: [1],
		delivered: [1],
		committed: [1],
		reconnects: { reader: 1, writer: 1 },
		closedClientsAlive: 0,
		retainedControlBytes: 0,
		samples: scenarios.flatMap((scenario) =>
			Array.from({ length: 9 }, (_, epoch) => ({
				phase: 'drained',
				scenario,
				epoch,
				rss: 128 * 1024 * 1024,
				heapUsed: 16 * 1024 * 1024,
				heapTotal: 32 * 1024 * 1024,
				external: 4 * 1024 * 1024,
				arrayBuffers: 4 * 1024 * 1024,
				activeResources: [],
				jsc: {
					heapSize: 16 * 1024 * 1024,
					extraMemorySize: 4 * 1024 * 1024,
					objectCount: 100,
				},
			}))
		),
	}
}

test.for(runtimes.flatMap((runtime) => scenarios.map((scenario) => ({ runtime, scenario }))))(
	'rejects RSS growth with stable heap and buffers in $runtime/$scenario',
	({ runtime, scenario }) => {
		let report = memoryReport(runtime)
		expect(() => verifyMemoryProfile(report, 1)).not.toThrow()

		for (let sample of report.samples) {
			if (sample.scenario === scenario && sample.epoch >= 6) {
				sample.rss += 1024 * 1024 * 1024
			}
		}

		expect(() => verifyMemoryProfile(report, 1)).toThrow(`${scenario} rss grew beyond 64 MiB`)
	}
)

test.for(runtimes)('allows bounded RSS growth after allocator warmup on %s', (runtime) => {
	let report = memoryReport(runtime)

	for (let sample of report.samples) {
		if (sample.epoch < 3) {
			sample.rss += 1024 * 1024 * 1024
		} else if (sample.epoch >= 6) {
			sample.rss += 32 * 1024 * 1024
		}
	}

	report.samples.push({ ...report.samples.at(-1)!, phase: 'loaded', rss: 2 * 1024 * 1024 * 1024 })

	expect(() => verifyMemoryProfile(report, 1)).not.toThrow()
})
