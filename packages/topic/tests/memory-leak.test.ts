import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { expect, inject, test } from 'vitest'
import { runMemoryProfile, verifyMemoryProfile } from './memory-profile.ts'
import type { MemoryReport } from './memory-worker.ts'

let execute = promisify(execFile)

test(
	'releases topic memory after drain, reconnect and client replacement',
	{ timeout: Number(process.env['YDB_MEMORY_TIMEOUT_MS'] ?? 180_000) },
	async (tc) => {
		await using files = {
			path: await mkdtemp(join(tmpdir(), 'topic-memory-')),
			[Symbol.asyncDispose]() {
				return rm(this.path, { recursive: true, force: true })
			},
		}
		let bundle = join(files.path, 'memory-worker.mjs')
		await execute(
			'bun',
			[
				'build',
				fileURLToPath(new URL('./memory-worker.ts', import.meta.url)),
				'--target=node',
				'--conditions=development',
				`--outfile=${bundle}`,
			],
			{ signal: tc.signal }
		)
		let { report, cuts } = await runMemoryProfile(
			inject('connectionString'),
			bundle,
			join(files.path, 'report.json'),
			tc.signal
		)
		if (process.env['YDB_MEMORY_REPORT_FILE']) {
			await writeFile(
				process.env['YDB_MEMORY_REPORT_FILE'],
				JSON.stringify(report, null, 2) + '\n'
			)
		}
		let expected = 3 * report.epochs * report.messagesPerEpoch
		expect(report.accepted).toEqual([expected, expected, expected])
		verifyMemoryProfile(report, cuts)
	}
)

test('rejects Bun buffer retention even when arrayBuffers reports zero', () => {
	let report: MemoryReport = {
		runtime: { name: 'bun', version: 'fixture', supportsActiveResources: false },
		node: 'compatibility-version',
		platform: 'fixture',
		arch: 'fixture',
		epochs: 9,
		epochPauseMs: 0,
		payloadBytes: 32 * 1024,
		messagesPerEpoch: 128,
		accepted: [1, 1, 1],
		acknowledged: [1, 1, 1],
		delivered: [1, 1, 1],
		committed: [1, 1, 1],
		reconnects: { reader: 1, writer: 1 },
		closedClientsAlive: 0,
		retainedControlBytes: 0,
		samples: ['steady', 'reconnect', 'replace'].flatMap((scenario) =>
			Array.from({ length: 9 }, (_, epoch) => ({
				phase: 'drained',
				scenario,
				epoch,
				rss: 0,
				heapUsed: 1024,
				heapTotal: 1024,
				external: 0,
				arrayBuffers: 0,
				activeResources: [],
				jsc: { heapSize: 1024, extraMemorySize: 1024, objectCount: 100 },
			}))
		),
	}
	expect(() => verifyMemoryProfile(report, 1)).not.toThrow()
	for (let sample of report.samples) {
		if (sample.epoch >= 6) sample.jsc!.extraMemorySize += 16 * 1024 * 1024
	}
	expect(() => verifyMemoryProfile(report, 1)).toThrow(/jsc.extraMemorySize grew/)
})
