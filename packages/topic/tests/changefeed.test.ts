import { create } from '@bufbuild/protobuf'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { AlterTopicRequestSchema, TopicServiceDefinition } from '@ydbjs/api/topic'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { afterEach, beforeEach, expect, inject, test } from 'vitest'

import { createTopicReader } from '../src/reader/index.ts'
import type { TopicReader } from '../src/reader/index.ts'

// Table changefeeds (CDC) are served through the Topic read protocol: ALTER TABLE ...
// ADD CHANGEFEED materializes a topic at `<table>/<feed>`, consumers are attached to
// that path via AlterTopic, and each change arrives as a JSON record. The reader must
// accept such table-scoped topic paths transparently — same read/commit contract as a
// plain topic.

let driver = new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
await driver.ready()
let topicService = driver.createClient(TopicServiceDefinition)

let table: string
let consumer: string

beforeEach(() => {
	table = `changefeed_test_${Date.now()}`
	consumer = `consumer-${Date.now()}`
})

afterEach(async () => {
	// Dropping the table also drops its changefeed topic. The table may not exist
	// if the test failed before DDL completed.
	await using sql = query(driver)
	try {
		await sql`DROP TABLE ${sql.identifier(table)}`
	} catch {
		// table was never created
	}
})

// JSON change record for FORMAT='JSON', MODE='UPDATES'.
type ChangeRecord = {
	key: number[]
	update?: Record<string, unknown>
	erase?: Record<string, never>
}

let makeChangefeed = async function makeChangefeed(): Promise<void> {
	await using sql = query(driver)
	await sql`CREATE TABLE ${sql.identifier(table)} (id Uint64, v Utf8, PRIMARY KEY (id))`
	await sql`ALTER TABLE ${sql.identifier(table)} ADD CHANGEFEED feed WITH (FORMAT = 'JSON', MODE = 'UPDATES')`

	// A changefeed topic is created without consumers; the only way to attach one is
	// AlterTopic on the `<table>/<feed>` path.
	let altered = await topicService.alterTopic(
		create(AlterTopicRequestSchema, {
			path: `${table}/feed`,
			addConsumers: [{ name: consumer }],
		})
	)
	expect(altered.operation?.status).toBe(StatusIds_StatusCode.SUCCESS)
}

let collectRecords = async function collectRecords(
	reader: TopicReader,
	count: number,
	signal: AbortSignal
): Promise<ChangeRecord[]> {
	let records: ChangeRecord[] = []
	for await (let batch of reader.read({ limit: 10, batchWindowMs: 2000, signal })) {
		if (batch.length === 0) {
			continue
		}
		for (let message of batch) {
			records.push(JSON.parse(new TextDecoder().decode(message.payload)))
		}
		await reader.commit(batch)
		if (records.length >= count) {
			break
		}
	}
	return records
}

test('delivers JSON update records from a table changefeed and commits offsets', async (tc) => {
	await makeChangefeed()

	{
		await using sql = query(driver)
		await sql`UPSERT INTO ${sql.identifier(table)} (id, v) VALUES (1ul, 'one'), (2ul, 'two'), (3ul, 'three')`
	}

	let committed: bigint[] = []
	await using reader = createTopicReader(driver, {
		topic: `${table}/feed`,
		consumer,
		onCommittedOffset: (_, committedOffset) => {
			committed.push(committedOffset)
		},
	})

	let records = await collectRecords(reader, 3, tc.signal)
	records.sort((a, b) => a.key[0]! - b.key[0]!)

	expect(records).toEqual([
		{ key: [1], update: { v: 'one' } },
		{ key: [2], update: { v: 'two' } },
		{ key: [3], update: { v: 'three' } },
	])
	// Three records on a single-partition changefeed: the acknowledged committed
	// offset must reach the end offset.
	expect(committed.at(-1)).toBe(3n)
})

test('resumes a changefeed from the committed offset with a fresh reader', async (tc) => {
	await makeChangefeed()
	await using sql = query(driver)

	await sql`UPSERT INTO ${sql.identifier(table)} (id, v) VALUES (1ul, 'one'), (2ul, 'two')`

	{
		await using first = createTopicReader(driver, { topic: `${table}/feed`, consumer })
		let records = await collectRecords(first, 2, tc.signal)
		expect(records).toHaveLength(2)
	}

	await sql`UPSERT INTO ${sql.identifier(table)} (id, v) VALUES (3ul, 'three')`

	// Commits on a changefeed topic must persist per consumer: a fresh reader
	// starts after the two committed records and sees only the new one.
	await using second = createTopicReader(driver, { topic: `${table}/feed`, consumer })
	let records = await collectRecords(second, 1, tc.signal)

	expect(records).toEqual([{ key: [3], update: { v: 'three' } }])
})

test('delivers an erase record when a row is deleted', async (tc) => {
	await makeChangefeed()
	await using sql = query(driver)

	await sql`UPSERT INTO ${sql.identifier(table)} (id, v) VALUES (7ul, 'seven')`
	await sql`DELETE FROM ${sql.identifier(table)} WHERE id = 7ul`

	await using reader = createTopicReader(driver, { topic: `${table}/feed`, consumer })
	let records = await collectRecords(reader, 2, tc.signal)

	expect(records).toEqual([
		{ key: [7], update: { v: 'seven' } },
		{ key: [7], erase: {} },
	])
})
