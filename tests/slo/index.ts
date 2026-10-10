import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import { ValueType } from '@opentelemetry/api'

import { installSafetyHandlers } from './lib/safety.ts'
import { meterProvider } from './lib/telemetry.ts'
import { CONTROL_CHANNEL, type ControlMessage, type WorkerData } from './lib/worker-api.ts'

let meter = meterProvider.getMeter('slo-supervisor')

let sdk_workload_restarts_total = meter.createCounter<{ worker: string }>(
	'sdk_workload_restarts_total',
	{ valueType: ValueType.INT, description: 'Worker restart count' }
)

let sdk_process_errors_total = meter.createCounter<{ worker: string; kind: string }>(
	'sdk_process_errors_total',
	{ valueType: ValueType.INT, description: 'Unhandled rejections / exceptions' }
)

meter
	.createObservableGauge('sdk_memory_usage', {
		unit: 'bytes',
		valueType: ValueType.INT,
	})
	.addCallback((r) => {
		let u = process.memoryUsage()
		r.observe(u.rss, { worker: 'main', type: 'rss' })
		r.observe(u.external, { worker: 'main', type: 'external' })
		r.observe(u.heapUsed, { worker: 'main', type: 'heapUsed' })
		r.observe(u.heapTotal, { worker: 'main', type: 'heapTotal' })
		r.observe(u.arrayBuffers, { worker: 'main', type: 'arrayBuffers' })
	})

// ---- CLI parsing ----------------------------------------------------------
type Parsed = {
	setup: string | undefined
	workers: string[]
	teardown: string | undefined
	params: Map<string, Record<string, string>>
}

function parseArgv(argv: string[]): Parsed {
	let setup: string | undefined
	let teardown: string | undefined
	let workers: string[] = []
	let flatArgs: string[] = []

	for (let arg of argv) {
		if (!arg.startsWith('--')) continue
		let eq = arg.indexOf('=')
		if (eq === -1) {
			console.error('[index] expected --key=value, got:', arg)
			process.exit(2)
		}
		let key = arg.slice(2, eq)
		let value = arg.slice(eq + 1)
		if (key === 'setup') {
			if (setup) {
				console.error('[index] --setup can be specified only once')
				process.exit(2)
			}
			setup = value
		} else if (key === 'teardown') {
			if (teardown) {
				console.error('[index] --teardown can be specified only once')
				process.exit(2)
			}
			teardown = value
		} else if (key === 'worker') {
			workers.push(value)
		} else {
			flatArgs.push(`${key}=${value}`)
		}
	}

	let names = new Set<string>()
	for (let n of [setup, teardown, ...workers]) {
		if (!n) continue
		if (names.has(n)) {
			console.error('[index] duplicate worker name:', n)
			process.exit(2)
		}
		names.add(n)
	}

	let params = new Map<string, Record<string, string>>()
	for (let n of names) params.set(n, {})

	let sortedNames = [...names].sort((a, b) => b.length - a.length)
	outer: for (let kv of flatArgs) {
		let eq = kv.indexOf('=')
		let k = kv.slice(0, eq)
		let v = kv.slice(eq + 1)
		for (let n of sortedNames) {
			if (k.startsWith(n + '.')) {
				params.get(n)![k.slice(n.length + 1)] = v
				continue outer
			}
		}
		console.warn('[index] unrecognized flag ignored: --' + kv)
	}

	return { setup, teardown, workers, params }
}

function resolveWorker(name: string): URL {
	let url = new URL(`./${name}.js`, import.meta.url)
	if (!existsSync(fileURLToPath(url))) {
		console.error(`[index] worker not found: ${name} (expected ${fileURLToPath(url)})`)
		process.exit(2)
	}
	return url
}

// ---- Global state ---------------------------------------------------------
let cli = parseArgv(process.argv.slice(2))
let DURATION = Number(process.env['WORKLOAD_DURATION'] || '60')
let topicProfile = cli.workers.includes('topic.run')
let drainTimeoutMs = Number(cli.params.get('topic.run')?.['drainTimeoutMs'] ?? '120000')
if (!Number.isFinite(DURATION) || DURATION < 0) {
	console.error('[index] WORKLOAD_DURATION must be a non-negative number of seconds')
	process.exit(2)
}
if (topicProfile && cli.workers.length !== 1) {
	console.error('[index] topic.run must be the only workload worker')
	process.exit(2)
}
if (
	topicProfile &&
	(!Number.isInteger(drainTimeoutMs) || drainTimeoutMs < 1 || drainTimeoutMs > 2_147_478_647)
) {
	console.error('[index] topic.run.drainTimeoutMs must be a positive timer duration')
	process.exit(2)
}
let runFailed = false

let ctrl = new AbortController()
process.on('SIGINT', () => {
	console.error('[index] SIGINT, aborting')
	if (topicProfile) runFailed = true
	ctrl.abort()
})
process.on('SIGTERM', () => {
	console.error('[index] SIGTERM, aborting')
	if (topicProfile) runFailed = true
	ctrl.abort()
})

let controlChannel = new BroadcastChannel(CONTROL_CHANNEL)
let stopBroadcast = false
function broadcastStop() {
	if (stopBroadcast) return
	stopBroadcast = true
	let msg: ControlMessage = { type: 'stop' }
	controlChannel.postMessage(msg)
}
ctrl.signal.addEventListener('abort', broadcastStop, { once: true })

function failTopic(reason: string): void {
	console.error(`[index] topic run failed: ${reason}`)
	runFailed = true
	ctrl.abort()
}

installSafetyHandlers('log', (kind, _err) => {
	sdk_process_errors_total.add(1, { worker: 'main', kind })
	if (topicProfile) failTopic(`supervisor ${kind}`)
})

// ---- Phase helpers --------------------------------------------------------
function runOnce(name: string): Promise<number> {
	let url = resolveWorker(name)
	let data: WorkerData = { name, params: cli.params.get(name) ?? {} }
	let worker = new Worker(url, { workerData: data })

	let exited = Promise.withResolvers<number>()
	let timer = topicProfile
		? setTimeout(() => {
				failTopic(`phase ${name} exceeded 60000ms`)
				void worker
					.terminate()
					.catch((error) => console.error(`[index] cannot terminate ${name}:`, error))
			}, 60_000)
		: undefined
	timer?.unref()
	worker.on('error', (err) => {
		console.error(`[index] worker ${name} error:`, err)
		if (topicProfile) failTopic(`phase ${name} errored`)
	})
	worker.once('exit', (code) => {
		clearTimeout(timer)
		exited.resolve(code ?? 1)
	})
	return exited.promise
}

let RESTART_CAP = 3
let RESTART_WINDOW_MS = 60_000
let BACKOFF_MS = [250, 500, 1000]

async function runForever(name: string): Promise<void> {
	let url = resolveWorker(name)
	let data: WorkerData = { name, params: cli.params.get(name) ?? {} }
	let restartTimestamps: number[] = []

	while (!ctrl.signal.aborted) {
		let worker = new Worker(url, { workerData: data })
		console.log(`[index] spawned ${name}`)
		let successfulResult = false

		let exited = Promise.withResolvers<number>()
		let killer: ReturnType<typeof setTimeout> | undefined
		let onAbort = () => {
			let timeoutMs = topicProfile ? drainTimeoutMs + 5000 : 5000
			killer = setTimeout(() => {
				console.error(`[index] ${name} did not exit in ${timeoutMs}ms, terminating`)
				if (topicProfile) failTopic('forced worker termination')
				void worker
					.terminate()
					.catch((error) => console.error(`[index] cannot terminate ${name}:`, error))
			}, timeoutMs)
			killer.unref()
		}
		worker.on('message', (message: unknown) => {
			if (
				!topicProfile ||
				!message ||
				typeof message !== 'object' ||
				!('type' in message) ||
				message.type !== 'workload-result'
			)
				return
			if (!('success' in message) || message.success !== true) {
				console.error('[index] unsuccessful worker result:', message)
				failTopic('worker reported an unsuccessful result')
				return
			}
			if (!ctrl.signal.aborted) {
				failTopic('worker reported success before shutdown')
				return
			}
			if (
				!('summary' in message) ||
				!message.summary ||
				typeof message.summary !== 'object'
			) {
				failTopic('worker success result is missing its summary')
				return
			}
			if (!runFailed) successfulResult = true
		})
		worker.on('error', (err) => {
			console.error(`[index] ${name} error:`, err)
			if (topicProfile) failTopic('worker error')
		})
		worker.once('exit', (code) => {
			clearTimeout(killer)
			ctrl.signal.removeEventListener('abort', onAbort)
			exited.resolve(code ?? 1)
		})
		if (ctrl.signal.aborted) onAbort()
		else ctrl.signal.addEventListener('abort', onAbort, { once: true })
		// oxlint-disable-next-line no-await-in-loop
		let exitCode = await exited.promise

		if (topicProfile) {
			if (!ctrl.signal.aborted) failTopic(`worker exited unexpectedly with code ${exitCode}`)
			if (exitCode !== 0) failTopic(`worker exited with code ${exitCode}`)
			if (!successfulResult) failTopic('worker exited without a successful drain result')
			return
		}

		if (ctrl.signal.aborted) {
			console.log(`[index] ${name} exited (${exitCode}) during shutdown`)
			return
		}

		let now = Date.now()
		restartTimestamps = restartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS)
		restartTimestamps.push(now)
		sdk_workload_restarts_total.add(1, { worker: name })
		console.error(
			`[index] ${name} exited unexpectedly with code ${exitCode} (restart ${restartTimestamps.length}/${RESTART_CAP} in ${RESTART_WINDOW_MS / 1000}s)`
		)

		if (restartTimestamps.length > RESTART_CAP) {
			console.error(`[index] ${name} exceeded restart cap, aborting run`)
			runFailed = true
			ctrl.abort()
			return
		}

		let backoff = BACKOFF_MS[Math.min(restartTimestamps.length - 1, BACKOFF_MS.length - 1)]
		// oxlint-disable-next-line no-await-in-loop
		await new Promise((r) => setTimeout(r, backoff))
	}
}

// ---- Main -----------------------------------------------------------------

// Phase: setup
if (cli.setup) {
	console.log(`[index] setup: ${cli.setup}`)
	let code = await runOnce(cli.setup)
	if (code !== 0) {
		console.error(`[index] setup failed with code ${code}`)
		runFailed = true
	}
}

// Phase: run
if (!runFailed && cli.workers.length > 0) {
	console.log(`[index] run: duration=${DURATION}s, workers=${cli.workers.join(',')}`)
	let durationTimer =
		DURATION > 0
			? setTimeout(() => {
					console.log('[index] duration elapsed, stopping workers')
					ctrl.abort()
				}, DURATION * 1000)
			: undefined
	durationTimer?.unref()

	await Promise.all(cli.workers.map((name) => runForever(name)))
	clearTimeout(durationTimer)
}

// Phase: teardown (best-effort даже если run провалился)
if (cli.teardown) {
	console.log(`[index] teardown: ${cli.teardown}`)
	let code = await runOnce(cli.teardown)
	if (code !== 0) {
		console.error(`[index] teardown failed with code ${code}`)
		runFailed = true
	}
}

controlChannel.close()

try {
	await meterProvider.forceFlush()
} catch (err) {
	console.error('[index] meter flush failed:', err)
}

try {
	await meterProvider.shutdown()
} catch (err) {
	console.error('[index] meter shutdown failed:', err)
}

process.exit(runFailed ? 1 : 0)
