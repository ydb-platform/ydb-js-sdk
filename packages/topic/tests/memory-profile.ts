import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { type Socket, createConnection } from 'node:net'

import type { MemoryReport, MemorySample } from './memory-worker.ts'

export async function runMemoryProfile(
	connectionString: string,
	workerPath: string,
	reportPath: string,
	signal?: AbortSignal
): Promise<{ report: MemoryReport; cuts: number }> {
	let upstream = new URL(connectionString)
	let upstreamPort = Number(upstream.port || (upstream.protocol === 'grpcs:' ? 443 : 80))
	let sockets = new Set<Socket>()
	let track = (socket: Socket) => {
		socket.setNoDelay(true)
		sockets.add(socket)
		socket.once('close', () => sockets.delete(socket))
	}
	let disconnect = () => {
		for (let socket of sockets) socket.destroy()
	}
	let server = createServer()
	server.on('connection', track)
	server.on('connect', (request, incoming, head) => {
		if (request.url !== `${upstream.hostname}:${upstreamPort}`) {
			incoming.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
			return
		}
		let outgoing = createConnection({
			host: upstream.hostname,
			port: upstreamPort,
		})
		track(outgoing)
		incoming.once('error', () => outgoing.destroy())
		outgoing.once('error', () => incoming.destroy())
		incoming.once('close', () => outgoing.destroy())
		outgoing.once('close', () => incoming.destroy())
		outgoing.once('connect', () => {
			incoming.write('HTTP/1.1 200 Connection Established\r\n\r\n')
			if (head.length) outgoing.write(head)
			incoming.pipe(outgoing).pipe(incoming)
		})
	})
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', resolve)
	})
	await using proxy = {
		server,
		async [Symbol.asyncDispose]() {
			disconnect()
			await new Promise<void>((resolve) => server.close(() => resolve()))
		},
	}
	let address = proxy.server.address()
	if (!address || typeof address === 'string') throw new Error('Missing proxy address')
	let reportFile = reportPath
	let child = fork(workerPath, [], {
		execPath: process.env['YDB_MEMORY_RUNTIME'] || process.execPath,
		execArgv: ['--expose-gc', '--max-old-space-size=256'],
		stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		signal,
		env: {
			...process.env,
			DEBUG: '',
			YDB_CONNECTION_STRING: connectionString,
			// CONNECT preserves the server hostname for TLS identity verification.
			grpc_proxy: `http://127.0.0.1:${address.port}`,
			no_grpc_proxy: '',
			no_proxy: '',
			MEMORY_REPORT_FILE: reportFile,
		},
	})
	let output = ''
	for (let stream of [child.stdout, child.stderr]) {
		stream?.on('data', (chunk) => {
			output = (output + String(chunk)).slice(-16_384)
			if (process.env['YDB_MEMORY_PROGRESS'] === '1') process.stdout.write(chunk)
		})
	}
	let cuts = 0
	child.on('message', (message: unknown) => {
		if (
			message &&
			typeof message === 'object' &&
			'type' in message &&
			message.type === 'disconnect'
		) {
			cuts++
			disconnect()
			child.send({ type: 'disconnected' })
		}
	})
	let code = await new Promise<number | null>((resolve, reject) => {
		child.once('error', (error) => {
			// Keep the proxy alive until the interrupted worker finishes cleanup.
			if (error.name !== 'AbortError') reject(error)
		})
		child.once('exit', resolve)
	})
	assert.equal(code, 0, output)
	let report = JSON.parse(await readFile(reportFile, 'utf8')) as MemoryReport
	return { report, cuts }
}

export function verifyMemoryProfile(report: MemoryReport, cuts: number): void {
	let runtime = report.runtime ?? {
		name: 'node',
		version: report.node,
		supportsActiveResources: true,
	}
	assert(runtime.name === 'node' || runtime.name === 'bun', 'Unknown memory runtime')
	assert(report.reconnects.reader >= cuts)
	assert(report.reconnects.writer >= cuts)
	assert(cuts > 0)
	assert.deepEqual(report.accepted, report.delivered)
	assert.deepEqual(report.accepted, report.acknowledged)
	assert.deepEqual(report.accepted, report.committed)
	assert.equal(
		report.closedClientsAlive,
		0,
		`Closed clients remain reachable: ${JSON.stringify(report.closedClientsRemaining ?? [])}`
	)

	// Compare equally drained post-GC checkpoints; the verifier keeps counters, not message history.
	for (let scenario of ['steady', 'reconnect', 'replace']) {
		let measured = report.samples.filter(
			(sample) =>
				sample.phase === 'drained' && sample.scenario === scenario && sample.epoch >= 3
		)
		assert(measured.length >= 6)
		let head = measured.slice(0, 3)
		let tail = measured.slice(-3)
		let heap = (sample: MemorySample): number =>
			runtime.name === 'bun' ? sample.jsc!.heapSize : sample.heapUsed
		let buffers = (sample: MemorySample): number =>
			runtime.name === 'bun' ? sample.jsc!.extraMemorySize : sample.arrayBuffers
		let heapMetric = runtime.name === 'bun' ? 'jsc.heapSize' : 'heapUsed'
		let bufferMetric = runtime.name === 'bun' ? 'jsc.extraMemorySize' : 'arrayBuffers'
		if (runtime.name === 'bun') {
			for (let sample of measured) {
				assert(sample.jsc, 'Bun memory samples require bun:jsc heap statistics')
				assert(Number.isFinite(sample.jsc.heapSize) && sample.jsc.heapSize >= 0)
				assert(
					Number.isFinite(sample.jsc.extraMemorySize) && sample.jsc.extraMemorySize >= 0
				)
				assert(Number.isSafeInteger(sample.jsc.objectCount) && sample.jsc.objectCount >= 0)
			}
		}
		let mean = (samples: MemorySample[], metric: (sample: MemorySample) => number) =>
			samples.reduce((sum, sample) => sum + metric(sample), 0) / samples.length
		assert(
			mean(tail, heap) - mean(head, heap) < 8 * 1024 * 1024,
			`${scenario} ${heapMetric} grew beyond 8 MiB: ${JSON.stringify(measured)}`
		)
		assert(
			mean(tail, buffers) - mean(head, buffers) < 4 * 1024 * 1024,
			`${scenario} ${bufferMetric} grew beyond 4 MiB: ${JSON.stringify(measured)}`
		)
	}
	// Bun's resource inventory is empty even with an open TCP socket.
	if (runtime.name === 'node') {
		assert.deepEqual(
			report.samples.at(-1)!.activeResources.filter((name) => /TCP|TLS/.test(name)),
			[]
		)
	}
}
