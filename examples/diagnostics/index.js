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
	'ydb:driver.discovery.completed',
	// @ydbjs/core — connection pool
	'ydb:driver.connection.added',
	'ydb:driver.connection.pessimized',
	'ydb:driver.connection.unpessimized',
	'ydb:driver.connection.retired',
	'ydb:driver.connection.removed',
	'ydb:driver.connection.pool.opened',
	'ydb:driver.connection.pool.stats',
	'ydb:driver.pile.changed',
	'ydb:driver.pile.fallback',
	// @ydbjs/retry
	'ydb:retry.exhausted',
	'ydb:retry.attempt.completed',
	// @ydbjs/auth
	'ydb:auth.token.refreshed',
	'ydb:auth.token.expired',
	'ydb:auth.provider.failed',
	// @ydbjs/query — session pool
	'ydb:query.session.created',
	'ydb:query.session.closed',
	'ydb:query.session.pool.opened',
	'ydb:query.session.pool.closed',
	'ydb:query.session.acquired',
	'ydb:query.session.released',
	'ydb:query.session.acquire.failed',
	'ydb:query.session.waiter.enqueued',
	'ydb:query.session.waiter.dequeued',
]

let tracingChannels = [
	// @ydbjs/core
	'tracing:ydb:driver.discovery',
	// @ydbjs/retry
	'tracing:ydb:retry.run',
	'tracing:ydb:retry.attempt',
	// @ydbjs/auth
	'tracing:ydb:auth.token.fetch',
	// @ydbjs/query
	'tracing:ydb:query.execute',
	'tracing:ydb:query.transaction',
	'tracing:ydb:query.session.acquire',
	'tracing:ydb:query.session.create',
	'tracing:ydb:query.session.delete',
	'tracing:ydb:query.begin',
	'tracing:ydb:query.commit',
	'tracing:ydb:query.rollback',
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
	if (typeof value === 'bigint') {
		return `${value}n`
	}
	if (value instanceof Error) {
		return value.name
	}
	return JSON.stringify(value)
}

function describe(payload) {
	if (!payload || typeof payload !== 'object') {
		return ''
	}

	// Query text, parameter values, tokens, and error messages may contain application data.
	let entries = []
	for (let key of [
		'duration',
		'uptime',
		'nodeId',
		'sessionId',
		'txId',
		'idempotent',
		'isolation',
		'attempt',
		'attempts',
		'backoffMs',
		'outcome',
		'provider',
		'addedCount',
		'removedCount',
		'totalCount',
	]) {
		let value = payload[key]
		if (['string', 'number', 'boolean', 'bigint'].includes(typeof value)) {
			entries.push(`${key}=${format(value)}`)
		}
	}
	if (payload.error instanceof Error) {
		entries.push(`error=${payload.error.name}`)
	}
	return entries.join(' ')
}

// ── Subscriptions ───────────────────────────────────────────────────────────

for (let name of publishChannels) {
	subscribe(name, (msg) => {
		let payload = describe(msg)
		console.log(`${ts()} ${indent()}● ${name}${payload ? '  ' + payload : ''}`)
	})
}

for (let name of tracingChannels) {
	tracingChannel(name).subscribe({
		start(ctx) {
			let payload = describe(ctx)
			console.log(`${ts()} ${indent()}┌─ ${name}${payload ? '  ' + payload : ''}`)
			depth++
		},
		asyncEnd(ctx) {
			if (failed.has(ctx)) {
				return
			}
			depth = Math.max(0, depth - 1)
			console.log(`${ts()} ${indent()}└─ ${name} ✓`)
		},
		error(ctx) {
			failed.add(ctx)
			depth = Math.max(0, depth - 1)
			let errorName = ctx.error instanceof Error ? ctx.error.name : 'non-Error failure'
			console.log(`${ts()} ${indent()}└─ ${name} ✗ ${errorName}`)
		},
	})
}

// ── Workload ────────────────────────────────────────────────────────────────

let connectionString = process.env.YDB_CONNECTION_STRING || 'grpc://localhost:2136/local'
// `ENABLE_DISCOVERY=1` to see the full discovery / pool flow. Off by default
// because containerised YDB usually advertises an internal hostname that's
// unreachable from the host machine, hanging the demo on first RPC.
let enableDiscovery = process.env.ENABLE_DISCOVERY === '1'

console.log('# diagnostics example')
console.log(`# discovery=${enableDiscovery ? 'on' : 'off'}\n`)

let driver = new Driver(connectionString, {
	'ydb.sdk.enable_discovery': enableDiscovery,
})
try {
	await driver.ready()
	let sql = query(driver)

	try {
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
	} finally {
		await sql.close()
	}
} finally {
	driver.close()
}
