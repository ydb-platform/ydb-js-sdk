import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { type TestContext, afterAll, beforeAll, expect, test } from 'vitest'

let runFile = promisify(execFile)
let directory: string
let endpoint: string
let built: Promise<unknown> | undefined
let exporter = createServer((request, response) => {
	request.resume()
	response.writeHead(200, { 'content-type': 'application/json' })
	response.end('{}')
})

beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), 'ydb-slo-supervisor-'))
	await writeFile(path.join(directory, 'package.json'), '{"type":"module"}')

	await new Promise<void>((resolve) => exporter.listen(0, '127.0.0.1', resolve))
	let address = exporter.address()
	if (!address || typeof address === 'string') throw new Error('Missing test exporter address')
	endpoint = `http://127.0.0.1:${address.port}/v1/metrics`
})

afterAll(async () => {
	if (exporter.listening) await new Promise<void>((resolve) => exporter.close(() => resolve()))
	if (directory) await rm(directory, { recursive: true, force: true })
})

let workerScript = function workerScript(onStop: string, start = ''): string {
	return `
import { parentPort } from 'node:worker_threads'
let channel = new BroadcastChannel('slo-workload-control')
channel.onmessage = (event) => {
	if (event.data?.type === 'stop') {
		${onStop}
	}
}
console.log('[fixture-ready]')
${start}
`
}

let success = `
parentPort.postMessage({ type: 'workload-result', success: true, summary: { complete: true } })
console.log('[fixture-drained]')
channel.close()
process.exit(0)
`

// The supervisor runs unchanged in another process; only its external workers are scripted.
// A real database cannot deterministically deliver exit/result/shutdown event orderings.
let launch = async function launch(
	context: TestContext,
	script: string,
	options: { duration?: string; name?: string; flags?: string[] } = {}
) {
	built ??= runFile(
		'bun',
		[
			'build',
			fileURLToPath(new URL('./index.ts', import.meta.url)),
			'--target=node',
			'--format=esm',
			`--outfile=${path.join(directory, 'index.js')}`,
		],
		{ signal: context.signal }
	)
	await built
	let name = options.name ?? 'topic.run'
	let runDir = await mkdtemp(path.join(directory, 'run-'))
	await writeFile(path.join(directory, `${name}.js`), script)
	let child = spawn(
		process.execPath,
		[
			path.join(directory, 'index.js'),
			`--worker=${name}`,
			...(name === 'topic.run' ? ['--topic.run.drainTimeoutMs=1'] : []),
			...(options.flags ?? []),
		],
		{
			cwd: runDir,
			env: {
				PATH: process.env['PATH'],
				WORKLOAD_REF: 'supervisor-test',
				WORKLOAD_DURATION: options.duration ?? '1',
				OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint,
				OTEL_EXPORTER_OTLP_TIMEOUT: '1000',
			},
			signal: context.signal,
			killSignal: 'SIGKILL',
			stdio: ['ignore', 'pipe', 'pipe'],
		}
	)
	let output = ''
	let ready = Promise.withResolvers<void>()
	let collect = (data: Buffer) => {
		output += data.toString()
		if (output.includes('[fixture-ready]')) ready.resolve()
	}
	child.stdout.on('data', collect)
	child.stderr.on('data', collect)
	let finished = new Promise<{
		code: number | null
		signal: NodeJS.Signals | null
		output: string
	}>((resolve, reject) => {
		child.once('error', reject)
		child.once('close', (code, signal) => resolve({ code, signal, output }))
	})
	void finished.catch(() => {})
	context.onTestFinished(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
		await Promise.race([finished.catch(() => {}), sleep(1000, undefined, { ref: false })])
		await rm(runDir, { recursive: true, force: true })
	})
	return { child, finished, ready: ready.promise }
}

test('fails an unexpected topic exit without restarting the worker', async (context) => {
	let run = await launch(context, workerScript(success, 'process.exit(1)'))
	let result = await run.finished
	expect(result.code).toBe(1)
	expect(result.output).toContain('worker exited unexpectedly')
	expect(result.output.match(/spawned topic\.run/g)).toHaveLength(1)
})

test('keeps an integrity failure after a later successful result', async (context) => {
	let run = await launch(
		context,
		workerScript(
			success,
			"parentPort.postMessage({ type: 'workload-result', success: false, error: 'integrity failure' })"
		)
	)
	let result = await run.finished
	expect(result.code).toBe(1)
	expect(result.output).toContain('integrity failure')
	expect(result.output).toContain('[fixture-drained]')
	expect(result.output.match(/spawned topic\.run/g)).toHaveLength(1)
})

test('rejects a nonzero topic exit during intended shutdown', async (context) => {
	let run = await launch(
		context,
		workerScript(success.replace('process.exit(0)', 'process.exit(7)'))
	)
	let result = await run.finished
	expect(result.code).toBe(1)
	expect(result.output).toContain('worker exited with code 7')
	expect(result.output).toContain('duration elapsed')
})

test('rejects a clean topic exit without its final drain result', async (context) => {
	let run = await launch(context, workerScript('channel.close(); process.exit(0)'))
	let result = await run.finished
	expect(result.code).toBe(1)
	expect(result.output).toContain('without a successful drain result')
})

test(
	'fails when a topic worker must be terminated after the drain deadline',
	{ timeout: 15_000 },
	async (context) => {
		let run = await launch(context, workerScript('console.log("[fixture-ignores-stop]")'))
		let result = await run.finished
		expect(result.code).toBe(1)
		expect(result.output).toContain('[fixture-ignores-stop]')
		expect(result.output).toContain('forced worker termination')
	}
)

test('accepts a successful drain result followed by a clean topic exit', async (context) => {
	let run = await launch(context, workerScript(success))
	let result = await run.finished
	expect(result.code).toBe(0)
	expect(result.output).toContain('[fixture-drained]')
	expect(result.output).toContain('duration elapsed')
})

test('keeps duration zero running and fails an interrupted topic run', async (context) => {
	let run = await launch(context, workerScript(success), { duration: '0' })
	await run.ready
	await sleep(100, undefined, { signal: context.signal })
	expect(run.child.exitCode).toBeNull()
	run.child.kill('SIGTERM')
	let result = await run.finished
	expect(result.code).toBe(1)
	expect(result.output).toContain('SIGTERM')
	expect(result.output).toContain('[fixture-drained]')
	expect(result.output).not.toContain('duration elapsed')
})

test('retains restart recovery for non-topic workers', async (context) => {
	let start = `
let { existsSync, writeFileSync } = await import('node:fs')
if (!existsSync('started')) {
	writeFileSync('started', '')
	process.exit(1)
}
`
	let run = await launch(context, workerScript('channel.close(); process.exit(0)', start), {
		name: 'kv.fixture',
	})
	let result = await run.finished
	expect(result.code).toBe(0)
	expect(result.output.match(/spawned kv\.fixture/g)).toHaveLength(2)
	expect(result.output).toContain('restart 1/3')
})

test('fails an uncaught topic worker error without restarting', async (context) => {
	let run = await launch(
		context,
		workerScript(success, "throw new Error('fixture worker crash')")
	)
	let result = await run.finished
	expect(result.code).toBe(1)
	expect(result.output).toContain('fixture worker crash')
	expect(result.output).toContain('topic run failed: worker error')
	expect(result.output.match(/spawned topic\.run/g)).toHaveLength(1)
})
