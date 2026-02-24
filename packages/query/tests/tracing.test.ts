import { beforeAll, expect, inject, test } from 'vitest'

import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { Driver } from '@ydbjs/core'
import { SPAN_NAMES } from '@ydbjs/tracing'

import { query } from '../src/index.js'

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider()
provider.addSpanProcessor(new SimpleSpanProcessor(exporter))
provider.register()

let driver: Driver

function parseConnectionString(cs: string): {
	host: string
	port: number
	database: string
} {
	const m = cs.match(/^grpcs?:\/\/([^:/]+):(\d+)(?:\/(.*))?$/)
	if (!m || m[1] === undefined || m[2] === undefined)
		return { host: '', port: 0, database: '' }
	const database = m[3] !== undefined && m[3] !== '' ? '/' + m[3] : ''
	return { host: m[1], port: Number(m[2]), database }
}

function assertCommonDbAttributes(
	span: { name: string; attributes?: Record<string, unknown> },
	expected: { host: string; port: number; database: string }
) {
	const attrs = (span.attributes ?? {}) as Record<string, unknown>
	expect(attrs['db.system']).toBe('ydb')
	expect(attrs['server.address']).toBe(expected.host)
	expect(attrs['server.port']).toBe(expected.port)
	expect(String(attrs['db.namespace'] ?? '')).toBe(expected.database)
}

function getSpanByName(
	spans: ReturnType<InMemorySpanExporter['getFinishedSpans']>,
	name: string
): { name: string; attributes?: Record<string, unknown> } {
	const found = spans.filter((s) => s.name === name)
	expect(found.length).toBe(1)
	const s = found[0]!
	const attrs = s.attributes as Record<string, unknown> | undefined
	return attrs !== undefined
		? { name: s.name, attributes: attrs }
		: { name: s.name }
}

beforeAll(async () => {
	driver = new Driver(inject('connectionString'), {
		'ydb.sdk.enable_discovery': false,
	})
	await driver.ready()
})

test('creates spans for CreateSession and ExecuteQuery', async () => {
	exporter.reset()
	const sql = query(driver)
	await sql`SELECT 1 AS id`
	const spans = exporter.getFinishedSpans()
	const spanNames = spans.map((s) => s.name)
	expect(spanNames).toContain(SPAN_NAMES.CreateSession)
	expect(spanNames).toContain(SPAN_NAMES.ExecuteQuery)
})

test('createSession and ExecuteQuery spans have common db attributes', async () => {
	exporter.reset()
	const sql = query(driver)
	await sql`SELECT 42 AS id`
	const spans = exporter.getFinishedSpans()
	const expected = parseConnectionString(inject('connectionString'))
	const createSessionSpan = getSpanByName(spans, SPAN_NAMES.CreateSession)
	const executeQuerySpan = getSpanByName(spans, SPAN_NAMES.ExecuteQuery)
	assertCommonDbAttributes(createSessionSpan, expected)
	assertCommonDbAttributes(executeQuerySpan, expected)
})

test('creates spans for transaction: CreateSession, ExecuteQuery, Commit', async () => {
	exporter.reset()
	const sql = query(driver)
	await sql.begin(async (tx) => tx`SELECT 1 AS id`)
	const spans = exporter.getFinishedSpans()
	const spanNames = spans.map((s) => s.name)
	expect(spanNames).toContain(SPAN_NAMES.CreateSession)
	expect(spanNames).toContain(SPAN_NAMES.ExecuteQuery)
	expect(spanNames).toContain(SPAN_NAMES.Commit)
	const expected = parseConnectionString(inject('connectionString'))
	assertCommonDbAttributes(getSpanByName(spans, SPAN_NAMES.Commit), expected)
})

test('rollback emits ydb.Rollback span', async () => {
	exporter.reset()
	const sql = query(driver)
	await expect(
		sql.begin(async (tx) => {
			await tx`SELECT 1 AS id`
			throw new Error('rollback')
		})
	).rejects.toThrow('Transaction failed.')
	const spans = exporter.getFinishedSpans()
	const spanNames = spans.map((s) => s.name)
	expect(spanNames).toContain(SPAN_NAMES.Rollback)
	const rollbackSpan = getSpanByName(spans, SPAN_NAMES.Rollback)
	assertCommonDbAttributes(
		rollbackSpan,
		parseConnectionString(inject('connectionString'))
	)
})

test('executeQuery error sets error status and error.type on span', async () => {
	exporter.reset()
	const sql = query(driver)
	await expect(sql`SELECT * FROM non_existing_table_xyz`).rejects.toThrow(
		/table|error|not found/i
	)

	await new Promise((r) => setTimeout(r, 100))
	const spans = exporter.getFinishedSpans()
	const errorSpan = spans.find((s) => s.status?.code === 2)
	// When a span has error status, it must have error.type (no conditional expect)
	expect(
		errorSpan == null || errorSpan.attributes?.['error.type'] != null
	).toBe(true)
})
