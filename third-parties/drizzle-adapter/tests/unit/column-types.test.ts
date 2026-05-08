import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
	bigint,
	boolean,
	bytes,
	customType,
	date,
	date32,
	datetime,
	datetime64,
	decimal,
	double,
	dyNumber,
	float,
	int16,
	int8,
	integer,
	interval,
	interval64,
	json,
	jsonDocument,
	text,
	timestamp,
	timestamp64,
	uint16,
	uint32,
	uint64,
	uint8,
	uuid,
	ydbTable,
	yson,
} from '../../src/index.ts'
import { YdbDialect } from '../../src/ydb/dialect.ts'
import { YdbInsertBuilder } from '../../src/ydb-core/query-builders/index.ts'
import { YdbSelectBuilder } from '../../src/ydb-core/query-builders/index.ts'
import { YdbSession } from '../../src/ydb-core/session.ts'
import {
	Bool,
	Date as YdbDate,
	Datetime as YdbDatetime,
	Double as YdbDouble,
	Float as YdbFloat,
	Int16 as YdbInt16,
	Int64 as YdbInt64,
	Int8 as YdbInt8,
	Interval as YdbInterval,
	Json as YdbJson,
	JsonDocument as YdbJsonDocument,
	Timestamp as YdbTimestamp,
	Uint16 as YdbUint16,
	Uint32 as YdbUint32,
	Uint64 as YdbUint64,
	Uint8 as YdbUint8,
	Uuid as YdbUuid,
	Yson as YdbYson,
} from '@ydbjs/value/primitive'
import { type SQL, sql as yql } from 'drizzle-orm/sql/sql'

let dialect = new YdbDialect()
let session = {} as any

let typesTable = ydbTable('column_types', {
	id: integer('id').notNull(),
	flag: boolean('flag'),
	i8: int8('i8'),
	i16: int16('i16'),
	signed64: bigint('signed64'),
	u8: uint8('u8'),
	u16: uint16('u16'),
	u32: uint32('u32'),
	u64: uint64('u64'),
	f32: float('f32'),
	f64: double('f64'),
	dyNumberValue: dyNumber('dy_number_value'),
	bytesValue: bytes('bytes_value'),
	dateValue: date('date_value'),
	date32Value: date32('date32_value'),
	datetimeValue: datetime('datetime_value'),
	datetime64Value: datetime64('datetime64_value'),
	timestampValue: timestamp('timestamp_value'),
	timestamp64Value: timestamp64('timestamp64_value'),
	intervalValue: interval('interval_value'),
	interval64Value: interval64('interval64_value'),
	jsonValue: json('json_value'),
	jsonDocumentValue: jsonDocument('json_document_value'),
	uuidValue: uuid('uuid_value'),
	ysonValue: yson('yson_value'),
	decimalValue: decimal('decimal_value', 22, 9),
	name: text('name'),
})

function toQuery(builder: { getSQL(): any }) {
	return dialect.sqlToQuery(builder.getSQL())
}

function typeRow(values: {
	id?: unknown
	flag?: unknown
	i8?: unknown
	i16?: unknown
	signed64?: unknown
	u8?: unknown
	u16?: unknown
	u32?: unknown
	u64?: unknown
	f32?: unknown
	f64?: unknown
	dyNumberValue?: unknown
	bytesValue?: unknown
	dateValue?: unknown
	date32Value?: unknown
	datetimeValue?: unknown
	datetime64Value?: unknown
	timestampValue?: unknown
	timestamp64Value?: unknown
	intervalValue?: unknown
	interval64Value?: unknown
	jsonValue?: unknown
	jsonDocumentValue?: unknown
	uuidValue?: unknown
	ysonValue?: unknown
	decimalValue?: unknown
	name?: unknown
}) {
	return [
		values.id ?? null,
		values.flag ?? null,
		values.i8 ?? null,
		values.i16 ?? null,
		values.signed64 ?? null,
		values.u8 ?? null,
		values.u16 ?? null,
		values.u32 ?? null,
		values.u64 ?? null,
		values.f32 ?? null,
		values.f64 ?? null,
		values.dyNumberValue ?? null,
		values.bytesValue ?? null,
		values.dateValue ?? null,
		values.date32Value ?? null,
		values.datetimeValue ?? null,
		values.datetime64Value ?? null,
		values.timestampValue ?? null,
		values.timestamp64Value ?? null,
		values.intervalValue ?? null,
		values.interval64Value ?? null,
		values.jsonValue ?? null,
		values.jsonDocumentValue ?? null,
		values.uuidValue ?? null,
		values.ysonValue ?? null,
		values.decimalValue ?? null,
		values.name ?? null,
	]
}

test('sql types', () => {
	assert.equal(typesTable.id.getSQLType(), 'Int32')
	assert.equal(typesTable.flag.getSQLType(), 'Bool')
	assert.equal(typesTable.i8.getSQLType(), 'Int8')
	assert.equal(typesTable.i16.getSQLType(), 'Int16')
	assert.equal(typesTable.signed64.getSQLType(), 'Int64')
	assert.equal(typesTable.u8.getSQLType(), 'Uint8')
	assert.equal(typesTable.u16.getSQLType(), 'Uint16')
	assert.equal(typesTable.u32.getSQLType(), 'Uint32')
	assert.equal(typesTable.u64.getSQLType(), 'Uint64')
	assert.equal(typesTable.f32.getSQLType(), 'Float')
	assert.equal(typesTable.f64.getSQLType(), 'Double')
	assert.equal(typesTable.dyNumberValue.getSQLType(), 'DyNumber')
	assert.equal(typesTable.bytesValue.getSQLType(), 'String')
	assert.equal(typesTable.dateValue.getSQLType(), 'Date')
	assert.equal(typesTable.date32Value.getSQLType(), 'Date32')
	assert.equal(typesTable.datetimeValue.getSQLType(), 'Datetime')
	assert.equal(typesTable.datetime64Value.getSQLType(), 'Datetime64')
	assert.equal(typesTable.timestampValue.getSQLType(), 'Timestamp')
	assert.equal(typesTable.timestamp64Value.getSQLType(), 'Timestamp64')
	assert.equal(typesTable.intervalValue.getSQLType(), 'Interval')
	assert.equal(typesTable.interval64Value.getSQLType(), 'Interval64')
	assert.equal(typesTable.jsonValue.getSQLType(), 'Json')
	assert.equal(typesTable.jsonDocumentValue.getSQLType(), 'JsonDocument')
	assert.equal(typesTable.uuidValue.getSQLType(), 'Uuid')
	assert.equal(typesTable.ysonValue.getSQLType(), 'Yson')
	assert.equal(typesTable.decimalValue.getSQLType(), 'Decimal(22, 9)')
	assert.equal(typesTable.name.getSQLType(), 'Utf8')
})

test('insert codecs', () => {
	let now = new Date()
	let rowDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
	let rowDatetime = new Date(Math.floor(now.getTime() / 1000) * 1000)
	let rowTimestamp = new Date(now)
	let rowYson = Buffer.from('<a=1>[3;%false]')

	let query = toQuery(
		new YdbInsertBuilder(typesTable, session).values({
			id: 1,
			flag: true,
			i8: -8,
			i16: -16,
			signed64: -123n,
			u8: 8,
			u16: 16,
			u32: 42,
			u64: 9007199254740993n,
			f32: 1.5,
			f64: 2,
			dyNumberValue: '1234567890.123',
			bytesValue: Buffer.from([1, 2, 3]),
			dateValue: rowDate,
			date32Value: rowDate,
			datetimeValue: rowDatetime,
			datetime64Value: rowDatetime,
			timestampValue: rowTimestamp,
			timestamp64Value: rowTimestamp,
			intervalValue: 123456,
			interval64Value: 123456789n,
			jsonValue: { pony: 'Pinkie Pie' },
			jsonDocumentValue: ['Twilight', 'Sparkle'],
			uuidValue: '550e8400-e29b-41d4-a716-446655440000',
			ysonValue: rowYson,
			decimalValue: '123.456',
			name: 'Rarity',
		})
	)

	assert.equal(
		query.sql,
		'insert into `column_types` (`id`, `flag`, `i8`, `i16`, `signed64`, `u8`, `u16`, `u32`, `u64`, `f32`, `f64`, `dy_number_value`, `bytes_value`, `date_value`, `date32_value`, `datetime_value`, `datetime64_value`, `timestamp_value`, `timestamp64_value`, `interval_value`, `interval64_value`, `json_value`, `json_document_value`, `uuid_value`, `yson_value`, `decimal_value`, `name`) values ($p0, $p1, $p2, $p3, $p4, $p5, $p6, $p7, $p8, $p9, $p10, $p11, $p12, $p13, $p14, $p15, $p16, $p17, $p18, $p19, $p20, $p21, $p22, $p23, $p24, Decimal("123.456", 22, 9), $p25)'
	)

	assert.equal(query.params[0], 1)
	assert.ok(query.params[1] instanceof Bool)
	assert.ok(query.params[2] instanceof YdbInt8)
	assert.ok(query.params[3] instanceof YdbInt16)
	assert.ok(query.params[4] instanceof YdbInt64)
	assert.ok(query.params[5] instanceof YdbUint8)
	assert.ok(query.params[6] instanceof YdbUint16)
	assert.ok(query.params[7] instanceof YdbUint32)
	assert.ok(query.params[8] instanceof YdbUint64)
	assert.ok(query.params[9] instanceof YdbFloat)
	assert.ok(query.params[10] instanceof YdbDouble)
	assert.equal((query.params[11] as { type?: { id?: unknown } }).type?.id, 4866)
	assert.ok(query.params[12] instanceof Uint8Array)
	assert.ok(query.params[13] instanceof YdbDate)
	assert.equal((query.params[14] as { type?: { id?: unknown } }).type?.id, 64)
	assert.ok(query.params[15] instanceof YdbDatetime)
	assert.equal((query.params[16] as { type?: { id?: unknown } }).type?.id, 65)
	assert.ok(query.params[17] instanceof YdbTimestamp)
	assert.equal((query.params[18] as { type?: { id?: unknown } }).type?.id, 66)
	assert.ok(query.params[19] instanceof YdbInterval)
	assert.equal((query.params[20] as { type?: { id?: unknown } }).type?.id, 67)
	assert.ok(query.params[21] instanceof YdbJson)
	assert.ok(query.params[22] instanceof YdbJsonDocument)
	assert.ok(query.params[23] instanceof YdbUuid)
	assert.ok(query.params[24] instanceof YdbYson)
	assert.equal(query.params[25], 'Rarity')
})

test('decimal rejects invalid', () => {
	assert.throws(
		() =>
			toQuery(
				new YdbInsertBuilder(typesTable, session).values({
					id: 1,
					decimalValue: '12e3',
				} as any)
			),
		/Invalid decimal value: 12e3/
	)
})

test('decimal supports inferred column names', () => {
	let inferredDecimalTable = ydbTable('inferred_decimal', {
		id: integer('id').notNull(),
		amount: decimal(22, 9),
	})

	assert.equal(inferredDecimalTable.amount.name, 'amount')
	assert.equal(inferredDecimalTable.amount.getSQLType(), 'Decimal(22, 9)')
})

test('customType', () => {
	let slugType = customType<{ data: string; driverData: SQL }>({
		dataType() {
			return 'Utf8'
		},
		toDriver(value) {
			return yql.raw(`Utf8("${value.toUpperCase()}")`)
		},
	})

	let customTable = ydbTable('custom_types', {
		id: integer('id').notNull(),
		slug: slugType('slug'),
	})

	let query = toQuery(new YdbInsertBuilder(customTable, session).values({ id: 1, slug: 'pony' }))

	assert.equal(customTable.slug.getSQLType(), 'Utf8')
	assert.equal(query.sql, 'insert into `custom_types` (`id`, `slug`) values ($p0, Utf8("PONY"))')
	assert.deepEqual(query.params, [1])
})

test('select decoders', async () => {
	let mockClient = {
		execute: async () => ({
			rows: [
				typeRow({
					id: 1,
					bytesValue: [1, 2, 3],
					ysonValue: '<a=1>[3;%false]',
				}),
			],
		}),
	} as any
	let mockSession = new YdbSession(mockClient, dialect)

	let [row] = (await new YdbSelectBuilder(mockSession).from(typesTable).execute()) as Array<
		Record<string, unknown>
	>

	assert.equal(row['id'], 1)
	assert.ok(row['bytesValue'] instanceof Uint8Array)
	assert.deepEqual(Array.from(row['bytesValue'] as Uint8Array), [1, 2, 3])
	assert.ok(row['ysonValue'] instanceof Uint8Array)
	assert.deepEqual(
		Array.from(row['ysonValue'] as Uint8Array),
		Array.from(Buffer.from('<a=1>[3;%false]', 'latin1'))
	)
})
