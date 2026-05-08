import assert from 'node:assert/strict'
import { type TestContext, afterAll, beforeAll } from 'vitest'
import { eq, sql as yql } from 'drizzle-orm'
import { YdbDriver, type YdbDrizzleDatabase, drizzle } from '../../../src/index.ts'
import {
	keepData,
	liveSchema,
	posts,
	postsTableName,
	requireLiveYdb,
	typesTable,
	typesTableName,
	users,
	usersTableName,
	verbose,
	ydbUrl,
} from './schema.ts'

export interface LiveTestContext {
	readonly db: YdbDrizzleDatabase<typeof liveSchema>
	readonly liveQueryLog: Array<{ query: string; params: unknown[] }>
	readonly baseIntId: number
	readonly baseUint64Id: bigint
	log(...args: unknown[]): void
	requireLiveYdb(t: TestContext): boolean
	describeDbChange(t: TestContext, description: string): void
	deleteUserRows(ids: number[]): Promise<void>
	deletePostRows(ids: number[]): Promise<void>
	deleteTypeRows(ids: bigint[]): Promise<void>
	normalizeTypeRow(row: Record<string, unknown>): Record<string, unknown>
	sortById<T extends { id: number | bigint }>(rows: T[]): T[]
}

export function createLiveContext(): LiveTestContext {
	let driver: YdbDriver
	let db!: YdbDrizzleDatabase<typeof liveSchema>
	let liveDbUnavailableReason: string | undefined
	let liveQueryLog: Array<{ query: string; params: unknown[] }> = []
	let uniqueSeed = Number(
		(process.hrtime.bigint() + BigInt(Math.floor(Math.random() * 1_000_000))) % 1_000_000_000n
	)
	let baseIntId = uniqueSeed
	let baseUint64Id = 2_000_000_000n + BigInt(uniqueSeed % 1_000_000)

	function log(...args: unknown[]): void {
		if (!verbose) {
			return
		}

		console.log('[test]', ...args)
	}

	function sortById<T extends { id: number | bigint }>(rows: T[]): T[] {
		return [...rows].sort((left, right) => {
			if (left.id < right.id) {
				return -1
			}

			if (left.id > right.id) {
				return 1
			}

			return 0
		})
	}

	async function ensureTables(): Promise<void> {
		await db.execute(
			yql.raw(`
      CREATE TABLE IF NOT EXISTS ${usersTableName} (
        id Int32,
        name Utf8,
        PRIMARY KEY (id)
      )
    `)
		)

		await db.execute(
			yql.raw(`
      CREATE TABLE IF NOT EXISTS ${postsTableName} (
        id Int32,
        user_id Int32,
        title Utf8,
        PRIMARY KEY (id)
      )
    `)
		)

		await db.execute(
			yql.raw(`
      CREATE TABLE IF NOT EXISTS ${typesTableName} (
        id Uint64,
        flag Bool,
        signed64 Int64,
        u32 Uint32,
        f32 Float,
        f64 Double,
        bytes_value String,
        date_value Date,
        datetime_value Datetime,
        timestamp_value Timestamp,
        json_value Json,
        json_document_value JsonDocument,
        uuid_value Uuid,
        yson_value Yson,
        PRIMARY KEY (id)
      )
    `)
		)
	}

	async function deleteUserRows(ids: number[]): Promise<void> {
		if (keepData) {
			return
		}

		await Promise.all(ids.map((id) => db.delete(users).where(eq(users.id, id))))
	}

	async function deletePostRows(ids: number[]): Promise<void> {
		if (keepData) {
			return
		}

		await Promise.all(ids.map((id) => db.delete(posts).where(eq(posts.id, id))))
	}

	async function deleteTypeRows(ids: bigint[]): Promise<void> {
		if (keepData) {
			return
		}

		await Promise.all(ids.map((id) => db.delete(typesTable).where(eq(typesTable.id, id))))
	}

	function normalizeTypeRow(row: Record<string, unknown>) {
		assert.ok(row['bytesValue'] instanceof Uint8Array)
		assert.ok(row['ysonValue'] instanceof Uint8Array)
		assert.ok(row['dateValue'] instanceof Date)
		assert.ok(row['datetimeValue'] instanceof Date)
		assert.ok(row['timestampValue'] instanceof Date)

		return {
			id: row['id'],
			flag: row['flag'],
			signed64: row['signed64'],
			u32: row['u32'],
			f32: row['f32'],
			f64: row['f64'],
			bytesValue: Array.from(row['bytesValue'] as Uint8Array),
			dateValue: (row['dateValue'] as Date).toISOString(),
			datetimeValue: (row['datetimeValue'] as Date).toISOString(),
			timestampValue: (row['timestampValue'] as Date).toISOString(),
			jsonValue: row['jsonValue'],
			jsonDocumentValue: row['jsonDocumentValue'],
			uuidValue: row['uuidValue'],
			ysonValue: Array.from(row['ysonValue'] as Uint8Array),
		}
	}

	beforeAll(async () => {
		try {
			driver = new YdbDriver(ydbUrl)
			await driver.ready()
			db = drizzle(driver, {
				schema: liveSchema,
				logger: {
					logQuery(query, params) {
						liveQueryLog.push({ query, params: [...params] })

						if (verbose) {
							console.log('[sql]', query, params)
						}
					},
				},
			})

			await ensureTables()
			log('up', usersTableName, postsTableName, typesTableName, keepData ? 'keep' : 'clean')
		} catch (error) {
			liveDbUnavailableReason = error instanceof Error ? error.message : String(error)
			if (requireLiveYdb) {
				throw new Error(`YDB unavailable: ${liveDbUnavailableReason}`, { cause: error })
			}
		}
	})

	afterAll(async () => {
		driver?.close()
	})

	return {
		get db() {
			return db
		},
		liveQueryLog,
		baseIntId,
		baseUint64Id,
		log,
		requireLiveYdb(t: TestContext): boolean {
			if (liveDbUnavailableReason) {
				t.skip(`YDB unavailable: ${liveDbUnavailableReason}`)
				return false
			}

			return true
		},
		describeDbChange(t: TestContext, description: string): void {
			void t
			log('DB change:', description)
		},
		deleteUserRows,
		deletePostRows,
		deleteTypeRows,
		normalizeTypeRow,
		sortById,
	}
}
