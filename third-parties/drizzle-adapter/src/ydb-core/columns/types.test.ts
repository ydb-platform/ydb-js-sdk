import { expect, test } from 'vitest'
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
} from '../../schema.ts'
import { YdbDialect } from '../../ydb/dialect.ts'
import { YdbInsertBuilder } from '../../ydb-core/query-builders/index.ts'
import { YdbSelectBuilder } from '../../ydb-core/query-builders/index.ts'
import { YdbSession } from '../../ydb-core/session.ts'
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

test('emits expected YQL types for each column builder', () => {
	expect(typesTable.id.getSQLType()).toBe('Int32')
	expect(typesTable.flag.getSQLType()).toBe('Bool')
	expect(typesTable.i8.getSQLType()).toBe('Int8')
	expect(typesTable.i16.getSQLType()).toBe('Int16')
	expect(typesTable.signed64.getSQLType()).toBe('Int64')
	expect(typesTable.u8.getSQLType()).toBe('Uint8')
	expect(typesTable.u16.getSQLType()).toBe('Uint16')
	expect(typesTable.u32.getSQLType()).toBe('Uint32')
	expect(typesTable.u64.getSQLType()).toBe('Uint64')
	expect(typesTable.f32.getSQLType()).toBe('Float')
	expect(typesTable.f64.getSQLType()).toBe('Double')
	expect(typesTable.dyNumberValue.getSQLType()).toBe('DyNumber')
	expect(typesTable.bytesValue.getSQLType()).toBe('String')
	expect(typesTable.dateValue.getSQLType()).toBe('Date')
	expect(typesTable.date32Value.getSQLType()).toBe('Date32')
	expect(typesTable.datetimeValue.getSQLType()).toBe('Datetime')
	expect(typesTable.datetime64Value.getSQLType()).toBe('Datetime64')
	expect(typesTable.timestampValue.getSQLType()).toBe('Timestamp')
	expect(typesTable.timestamp64Value.getSQLType()).toBe('Timestamp64')
	expect(typesTable.intervalValue.getSQLType()).toBe('Interval')
	expect(typesTable.interval64Value.getSQLType()).toBe('Interval64')
	expect(typesTable.jsonValue.getSQLType()).toBe('Json')
	expect(typesTable.jsonDocumentValue.getSQLType()).toBe('JsonDocument')
	expect(typesTable.uuidValue.getSQLType()).toBe('Uuid')
	expect(typesTable.ysonValue.getSQLType()).toBe('Yson')
	expect(typesTable.decimalValue.getSQLType()).toBe('Decimal(22, 9)')
	expect(typesTable.name.getSQLType()).toBe('Utf8')
})

test('encodes typed values on insert', () => {
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

	expect(query.sql).toBe(
		'insert into `column_types` (`id`, `flag`, `i8`, `i16`, `signed64`, `u8`, `u16`, `u32`, `u64`, `f32`, `f64`, `dy_number_value`, `bytes_value`, `date_value`, `date32_value`, `datetime_value`, `datetime64_value`, `timestamp_value`, `timestamp64_value`, `interval_value`, `interval64_value`, `json_value`, `json_document_value`, `uuid_value`, `yson_value`, `decimal_value`, `name`) values ($p0, $p1, $p2, $p3, $p4, $p5, $p6, $p7, $p8, $p9, $p10, $p11, $p12, $p13, $p14, $p15, $p16, $p17, $p18, $p19, $p20, $p21, $p22, $p23, $p24, Decimal("123.456", 22, 9), $p25)'
	)

	expect(query.params[0]).toBe(1)
	expect(query.params[1]).toBeInstanceOf(Bool)
	expect(query.params[2]).toBeInstanceOf(YdbInt8)
	expect(query.params[3]).toBeInstanceOf(YdbInt16)
	expect(query.params[4]).toBeInstanceOf(YdbInt64)
	expect(query.params[5]).toBeInstanceOf(YdbUint8)
	expect(query.params[6]).toBeInstanceOf(YdbUint16)
	expect(query.params[7]).toBeInstanceOf(YdbUint32)
	expect(query.params[8]).toBeInstanceOf(YdbUint64)
	expect(query.params[9]).toBeInstanceOf(YdbFloat)
	expect(query.params[10]).toBeInstanceOf(YdbDouble)
	expect((query.params[11] as { type?: { id?: unknown } }).type?.id).toBe(4866)
	expect(query.params[12]).toBeInstanceOf(Uint8Array)
	expect(query.params[13]).toBeInstanceOf(YdbDate)
	expect((query.params[14] as { type?: { id?: unknown } }).type?.id).toBe(64)
	expect(query.params[15]).toBeInstanceOf(YdbDatetime)
	expect((query.params[16] as { type?: { id?: unknown } }).type?.id).toBe(65)
	expect(query.params[17]).toBeInstanceOf(YdbTimestamp)
	expect((query.params[18] as { type?: { id?: unknown } }).type?.id).toBe(66)
	expect(query.params[19]).toBeInstanceOf(YdbInterval)
	expect((query.params[20] as { type?: { id?: unknown } }).type?.id).toBe(67)
	expect(query.params[21]).toBeInstanceOf(YdbJson)
	expect(query.params[22]).toBeInstanceOf(YdbJsonDocument)
	expect(query.params[23]).toBeInstanceOf(YdbUuid)
	expect(query.params[24]).toBeInstanceOf(YdbYson)
	expect(query.params[25]).toBe('Rarity')
})

test('rejects invalid decimal definitions', () => {
	expect(() =>
		toQuery(
			new YdbInsertBuilder(typesTable, session).values({
				id: 1,
				decimalValue: '12e3',
			} as any)
		)
	).toThrow(/Invalid decimal value: 12e3/)
})

test('infers column name for decimal()', () => {
	let inferredDecimalTable = ydbTable('inferred_decimal', {
		id: integer('id').notNull(),
		amount: decimal(22, 9),
	})

	expect(inferredDecimalTable.amount.name).toBe('amount')
	expect(inferredDecimalTable.amount.getSQLType()).toBe('Decimal(22, 9)')
})

test('wires customType encoders and decoders', () => {
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

	expect(customTable.slug.getSQLType()).toBe('Utf8')
	expect(query.sql).toBe('insert into `custom_types` (`id`, `slug`) values ($p0, Utf8("PONY"))')
	expect(query.params).toEqual([1])
})

test('decodes selected rows through column codecs', async () => {
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

	let rows = (await new YdbSelectBuilder(mockSession).from(typesTable).execute()) as Array<
		Record<string, unknown>
	>
	expect(rows.length).toBe(1)
	let row = rows[0]!

	expect(row['id']).toBe(1)
	expect(row['bytesValue']).toBeInstanceOf(Uint8Array)
	expect(Array.from(row['bytesValue'] as Uint8Array)).toEqual([1, 2, 3])
	expect(row['ysonValue']).toBeInstanceOf(Uint8Array)
	expect(Array.from(row['ysonValue'] as Uint8Array)).toEqual(
		Array.from(Buffer.from('<a=1>[3;%false]', 'latin1'))
	)
})
