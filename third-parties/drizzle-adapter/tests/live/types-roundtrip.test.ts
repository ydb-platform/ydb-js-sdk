import { test } from 'vitest'
import assert from 'node:assert/strict'
import { eq, sql as yql } from 'drizzle-orm'
import { createLiveContext } from './helpers/context.ts'
import { typesTable, typesTableName } from './helpers/schema.ts'
import { orderSelectedFields } from '../../src/ydb-core/result-mapping.ts'

let live = createLiveContext()

test('types round-trip', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'insert one full typed row, read it back, update typed fields, read the updated row, then clean it'
	)
	let id = live.baseUint64Id + 1n
	let now = new Date()
	let initialDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
	let initialDatetime = new Date(Math.floor(now.getTime() / 1000) * 1000)
	let initialTimestamp = new Date(now)
	let initialBytes = Uint8Array.from(Buffer.from('pony-bytes', 'utf8'))
	let initialJson = { pony: 'Pinkie Pie', level: 7 }
	let initialJsonDocument = ['Twilight', 'Sparkle']
	let initialUuid = '550e8400-e29b-41d4-a716-446655440000'
	let initialYson = Uint8Array.from([
		60, 97, 61, 49, 62, 91, 51, 59, 37, 102, 97, 108, 115, 101, 93,
	])

	let updatedBytes = Uint8Array.from(Buffer.from('rainbow-bytes', 'utf8'))
	let updatedJson = { pony: 'Rainbow Dash', level: 9 }
	let updatedJsonDocument = { team: 'Mane Six' }
	let updatedTimestamp = new Date(now.getTime() + 60_000)
	let updatedYson = Uint8Array.from([91, 49, 59, 50, 59, 51, 93])

	live.log('types', id.toString())
	await live.deleteTypeRows([id])

	try {
		await live.db.insert(typesTable).values({
			id,
			flag: true,
			signed64: -123n,
			u32: 42,
			f32: 1.5,
			f64: 2.75,
			bytesValue: initialBytes,
			dateValue: initialDate,
			datetimeValue: initialDatetime,
			timestampValue: initialTimestamp,
			jsonValue: initialJson,
			jsonDocumentValue: initialJsonDocument,
			uuidValue: initialUuid,
			ysonValue: initialYson,
		})

		let insertedRows = (await live.db
			.select()
			.from(typesTable)
			.where(eq(typesTable.id, id))) as Array<Record<string, unknown>>

		assert.deepEqual(live.normalizeTypeRow(insertedRows[0]!), {
			id,
			flag: true,
			signed64: -123n,
			u32: 42,
			f32: 1.5,
			f64: 2.75,
			bytesValue: Array.from(initialBytes),
			dateValue: initialDate.toISOString(),
			datetimeValue: initialDatetime.toISOString(),
			timestampValue: initialTimestamp.toISOString(),
			jsonValue: initialJson,
			jsonDocumentValue: initialJsonDocument,
			uuidValue: initialUuid,
			ysonValue: Array.from(initialYson),
		})

		await live.db
			.update(typesTable)
			.set({
				flag: false,
				signed64: 777n,
				u32: 99,
				f32: 3.25,
				f64: 6.5,
				bytesValue: updatedBytes,
				timestampValue: updatedTimestamp,
				jsonValue: updatedJson,
				jsonDocumentValue: updatedJsonDocument,
				uuidValue: '123e4567-e89b-12d3-a456-426614174000',
				ysonValue: updatedYson,
			})
			.where(eq(typesTable.id, id))

		let updatedRows = (await live.db
			.select()
			.from(typesTable)
			.where(eq(typesTable.id, id))) as Array<Record<string, unknown>>

		assert.deepEqual(live.normalizeTypeRow(updatedRows[0]!), {
			id,
			flag: false,
			signed64: 777n,
			u32: 99,
			f32: 3.25,
			f64: 6.5,
			bytesValue: Array.from(updatedBytes),
			dateValue: initialDate.toISOString(),
			datetimeValue: initialDatetime.toISOString(),
			timestampValue: updatedTimestamp.toISOString(),
			jsonValue: updatedJson,
			jsonDocumentValue: updatedJsonDocument,
			uuidValue: '123e4567-e89b-12d3-a456-426614174000',
			ysonValue: Array.from(updatedYson),
		})
	} finally {
		await live.deleteTypeRows([id])
	}
})

test('prepared query decodes typed object rows on live YDB', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'insert one typed row, read it through session.prepareQuery() in object mode, verify field codecs, then clean it'
	)

	let id = live.baseUint64Id + 2n
	let timestampValue = new Date()
	let bytesValue = Uint8Array.from(Buffer.from('prepared-bytes', 'utf8'))
	let jsonValue = { pony: 'Starlight Glimmer', level: 11 }

	await live.deleteTypeRows([id])

	try {
		await live.db.insert(typesTable).values({
			id,
			bytesValue,
			jsonValue,
			timestampValue,
		})

		let fields = orderSelectedFields({
			id: typesTable.id,
			bytesValue: typesTable.bytesValue,
			jsonValue: typesTable.jsonValue,
			timestampValue: typesTable.timestampValue,
		})
		let prepared = live.db._.session.prepareQuery(
			yql.raw(
				`SELECT \`id\`, \`bytes_value\`, \`json_value\`, \`timestamp_value\` FROM \`${typesTableName}\` WHERE \`id\` = ${id.toString()}`
			),
			fields,
			'live_types_prepared_object_mode',
			false
		)
		let row = (await prepared.get()) as Record<string, unknown>

		assert.equal(row['id'], id)
		assert.ok(row['bytesValue'] instanceof Uint8Array)
		assert.deepEqual(Array.from(row['bytesValue'] as Uint8Array), Array.from(bytesValue))
		assert.deepEqual(row['jsonValue'], jsonValue)
		assert.ok(row['timestampValue'] instanceof Date)
		assert.equal((row['timestampValue'] as Date).toISOString(), timestampValue.toISOString())
	} finally {
		await live.deleteTypeRows([id])
	}
})
