import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'

import { Driver } from '@ydbjs/core'
import { QueryClient, type QueryPart } from '@ydbjs/query'
import { Uint64 } from '@ydbjs/value/primitive'

type Row = { id: bigint; payload: string }
let expectedRows = Number(process.argv[2] ?? 16384)
let pauseMs = Number(process.argv[3] ?? 1)
if (!Number.isSafeInteger(expectedRows) || expectedRows < 1 || expectedRows > 65536)
	throw new Error('Row count must be between 1 and 65536 (up to 4 GiB).')
if (!Number.isFinite(pauseMs) || pauseMs < 0 || pauseMs > 100)
	throw new Error('Pause must be between 0 and 100 milliseconds.')
if (!process.env['YDB_CONNECTION_STRING']) throw new Error('YDB_CONNECTION_STRING is required.')
let bun = Reflect.get(globalThis, 'Bun') as { gc?: (synchronous: boolean) => void } | undefined
let collectGarbage =
	globalThis.gc ?? (typeof bun?.gc === 'function' ? () => bun.gc!(true) : undefined)
if (!collectGarbage) throw new Error('Run with --expose-gc to measure retained memory.')

using driver = new Driver(process.env['YDB_CONNECTION_STRING'])
await using client = new QueryClient(driver, { poolOptions: { maxSize: 1 } })
let signal = AbortSignal.timeout(120_000)
let options = { signal, idempotent: true, retry: { budget: 1 } }
let text =
	'DECLARE $rows AS Uint64; DECLARE $payload AS Utf8; SELECT id, $payload AS payload FROM AS_TABLE(ListMap(ListFromRange(0ul, $rows), ($id) -> { RETURN <|id:$id|>; }));'
let payloadBytes = 64 * 1024
let parameters = { rows: new Uint64(BigInt(expectedRows)), payload: 'x'.repeat(payloadBytes) }
let started = performance.now()
let peak = process.memoryUsage()
let timer = setInterval(() => {
	let now = process.memoryUsage()
	for (let key of Object.keys(peak) as Array<keyof typeof peak>)
		peak[key] = Math.max(peak[key], now[key])
}, 25)
timer.unref()

async function consume(parts: AsyncIterable<QueryPart<Row>>, attemptSignal: AbortSignal) {
	let count = 0
	let sum = 0n
	let nextSample = 64 * 1024 * 1024
	for await (let part of parts) {
		assert.equal(part.resultSetIndex, 0)
		assert.equal(part.truncated, false)
		for (let row of part.rows) {
			assert.equal(row.payload.length, payloadBytes)
			assert.equal(row.payload.charCodeAt(0), 120)
			assert.equal(row.payload.charCodeAt(row.payload.length - 1), 120)
			count++
			sum += row.id
		}
		if (count * payloadBytes >= nextSample) {
			console.log(
				JSON.stringify({
					readBytes: count * payloadBytes,
					memory: process.memoryUsage(),
				})
			)
			nextSample += 64 * 1024 * 1024
		}
		if (pauseMs) await setTimeout(pauseMs, undefined, { signal: attemptSignal })
	}
	assert.equal(count, expectedRows)
	assert.equal(sum, (BigInt(expectedRows) * BigInt(expectedRows - 1)) / 2n)
	return count * payloadBytes
}

try {
	let readBytes = await client.retrySession(options, (session, attemptSignal) =>
		consume(
			session.stream<Row>(text, parameters, { responsePartLimitBytes: 256 * 1024 }),
			attemptSignal
		)
	)
	collectGarbage()
	console.log(
		JSON.stringify({
			completed: true,
			readBytes,
			elapsedMs: Math.round(performance.now() - started),
			sampledPeak: peak,
			retained: process.memoryUsage(),
		})
	)
} finally {
	clearInterval(timer)
}
