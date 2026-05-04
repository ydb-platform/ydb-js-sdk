/**
 * YDB Diagnostics Channel Example
 *
 * Подписывается на все события `node:diagnostics_channel`, которые публикуют
 * пакеты SDK (`@ydbjs/core`, `@ydbjs/retry`, `@ydbjs/auth`, `@ydbjs/query`),
 * выполняет один SELECT и одну транзакцию, и печатает весь стек событий в
 * консоль в порядке их возникновения.
 *
 * Цель — показать, как один телеметрический подписчик может построить трейсы,
 * метрики и логи поверх SDK, не подключая никакие OTel зависимости.
 *
 * Запуск:
 *   YDB_CONNECTION_STRING=grpc://localhost:2136/local node index.js
 */

import { subscribe, tracingChannel } from 'node:diagnostics_channel'
import { performance } from 'node:perf_hooks'

import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'

// ── Channel registry ────────────────────────────────────────────────────────

/**
 * Public DC contract published by SDK packages. Keep this list in sync with
 * the README tables in `@ydbjs/core`, `@ydbjs/retry`, `@ydbjs/auth`,
 * `@ydbjs/query`. For real telemetry you would wire each into spans/metrics.
 */
let publishChannels = [
	// @ydbjs/core — driver lifecycle
	'ydb:driver.ready',
	'ydb:driver.failed',
	'ydb:driver.closed',
	// @ydbjs/core — discovery
	'ydb:discovery.completed',
	// @ydbjs/core — connection pool
	'ydb:pool.connection.added',
	'ydb:pool.connection.pessimized',
	'ydb:pool.connection.unpessimized',
	'ydb:pool.connection.retired',
	'ydb:pool.connection.removed',
	// @ydbjs/retry
	'ydb:retry.exhausted',
	// @ydbjs/auth
	'ydb:auth.token.refreshed',
	'ydb:auth.token.expired',
	'ydb:auth.provider.failed',
	// @ydbjs/query — session pool
	'ydb:session.created',
	'ydb:session.closed',
]

let tracingChannels = [
	// @ydbjs/core
	'tracing:ydb:discovery',
	// @ydbjs/retry
	'tracing:ydb:retry.run',
	'tracing:ydb:retry.attempt',
	// @ydbjs/auth
	'tracing:ydb:auth.token.fetch',
	// @ydbjs/query
	'tracing:ydb:query.execute',
	'tracing:ydb:query.transaction',
	'tracing:ydb:session.acquire',
	'tracing:ydb:session.create',
]

// ── Pretty printer ──────────────────────────────────────────────────────────

let started = performance.now()
let depth = 0
// `tracingChannel` invokes BOTH `error` and `asyncEnd` when the wrapped
// promise rejects. We only want one log line per span, so remember which
// span ctx already produced an `error` line and skip the trailing `asyncEnd`.
let failed = new WeakSet()

function ts() {
	let ms = (performance.now() - started).toFixed(1).padStart(7)
	return `+${ms}ms`
}

function indent() {
	return '  '.repeat(depth)
}

function format(value) {
	if (typeof value === 'bigint') return `${value}n`
	if (value instanceof Error) return `${value.name}(${value.message})`
	return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? `${v}n` : v))
}

function describe(payload) {
	if (!payload || typeof payload !== 'object') return ''
	let entries = Object.entries(payload)
		.filter(([k]) => k !== 'span' && k !== 'error' && k !== 'asyncId')
		.map(([k, v]) => `${k}=${format(v)}`)
	let extras = []
	if ('error' in payload) extras.push(`error=${format(payload.error)}`)
	return [...entries, ...extras].join(' ')
}

// Try to keep query text in logs short.
function tidy(payload) {
	if (!payload || typeof payload !== 'object') return payload
	if ('text' in payload && typeof payload.text === 'string' && payload.text.length > 60) {
		return { ...payload, text: payload.text.slice(0, 60) + '…' }
	}
	return payload
}

// ── Subscriptions ───────────────────────────────────────────────────────────

for (let name of publishChannels) {
	subscribe(name, (msg) => {
		let payload = describe(tidy(msg))
		console.log(`${ts()} ${indent()}● ${name}${payload ? '  ' + payload : ''}`)
	})
}

for (let name of tracingChannels) {
	tracingChannel(name).subscribe({
		start(ctx) {
			let payload = describe(tidy(ctx))
			console.log(`${ts()} ${indent()}┌─ ${name}${payload ? '  ' + payload : ''}`)
			depth++
		},
		asyncEnd(ctx) {
			if (failed.has(ctx)) return // `error` already printed for this span
			depth = Math.max(0, depth - 1)
			console.log(`${ts()} ${indent()}└─ ${name} ✓`)
		},
		error(ctx) {
			failed.add(ctx)
			depth = Math.max(0, depth - 1)
			console.log(`${ts()} ${indent()}└─ ${name} ✗ ${format(ctx.error)}`)
		},
	})
}

// ── Workload ────────────────────────────────────────────────────────────────

let connectionString = process.env.YDB_CONNECTION_STRING || 'grpc://localhost:2136/local'
// `ENABLE_DISCOVERY=1` to see the full discovery / pool flow. Off by default
// because containerised YDB usually advertises an internal hostname that's
// unreachable from the host machine, hanging the demo on first RPC.
let enableDiscovery = process.env.ENABLE_DISCOVERY === '1'

console.log(`# diagnostics example, connecting to ${connectionString}`)
console.log(`# discovery=${enableDiscovery ? 'on' : 'off'}\n`)

// `using` for the driver and `await using` for the query client — dispose
// runs in reverse order so the session pool drains (publishing
// `session.closed{pool_close}`) BEFORE `driver.close()` fires `driver.closed`.
using driver = new Driver(connectionString, {
	'ydb.sdk.enable_discovery': enableDiscovery,
})
await driver.ready()

await using sql = query(driver)

// `Query` extends `EventEmitter`. Its `.finally` aborts an internal controller
// which can synthesise a stray `'error'` event after the awaited result is
// already resolved — unhandled by default. Demos run with the noisy event
// silenced; production code should attach `.on('error', …)` per query or
// install a process-level handler.
process.on('uncaughtException', (err) => {
	if (err instanceof Error && err.name === 'AbortError') return
	throw err
})

console.log('\n# 1. single-shot SELECT 1\n')
{
	let [[row]] = await sql`SELECT 1 AS n`
	console.log(`\n  → result: ${JSON.stringify(row)}\n`)
}

console.log('\n# 2. transaction with two SELECTs\n')
{
	let result = await sql.begin(async (tx) => {
		let [[a]] = await tx`SELECT 1 AS a`
		let [[b]] = await tx`SELECT ${a.a + 1} AS b`
		return b.b
	})
	console.log(`\n  → result: ${result}\n`)
}

console.log('\n# done, shutting down\n')

// `await using` above releases sql first (drains the session pool, fires
// `session.closed{pool_close}`), then `using driver` closes the driver and
// fires `driver.closed`. No manual close() calls needed.
