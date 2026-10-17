import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import { isMainThread, threadId } from 'node:worker_threads'

import { afterEach } from 'vitest'

let runtime = process.versions.bun ? 'bun' : 'node'
let version = process.versions.bun ?? process.versions.node
let expectedRuntime = process.env.GRPC_TEST_RUNTIME
let expectedVersion = process.env.GRPC_TEST_VERSION
let output = process.env.GRPC_TEST_WITNESS

if (
	!output ||
	runtime !== expectedRuntime ||
	(version !== expectedVersion &&
		!(runtime === 'node' && version.split('.')[0] === expectedVersion))
) {
	throw new Error(
		`Expected ${expectedRuntime} ${expectedVersion} worker, got ${runtime} ${version}`
	)
}

afterEach((context) => {
	appendFileSync(
		output,
		JSON.stringify({
			file: relative(process.cwd(), context.task.file.filepath),
			name: context.task.name,
			runtime,
			version,
			executable: process.execPath,
			pid: process.pid,
			threadId,
			isMainThread,
			platform: process.platform,
			arch: process.arch,
		}) + '\n'
	)
})
