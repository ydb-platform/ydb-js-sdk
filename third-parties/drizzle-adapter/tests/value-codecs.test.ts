import { expect, inject, test } from 'vitest'
import { sql as yql } from 'drizzle-orm'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { YdbDriver, drizzle } from '../src/index.ts'
import {
	date32,
	datetime64,
	decimal,
	double,
	dyNumber,
	interval,
	interval64,
	timestamp64,
	uuid,
	ydbTable,
} from '../src/schema.ts'

test('column codecs bind and read extended scalar values through real YDB', async (tc) => {
	using core = new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
	await using sql = query(core)
	let adapter = new YdbDriver(core)
	adapter.client = sql
	let db = drizzle(adapter)
	let columns = ydbTable('scalar_codecs', {
		date: date32(),
		datetime: datetime64(),
		timestamp: timestamp64(),
		interval: interval(),
		interval64: interval64(),
		decimal: decimal(22, 9),
		dyNumber: dyNumber(),
		double: double(),
		uuid: uuid(),
	})
	let values = {
		date: new Date('1969-12-31T00:00:00Z'),
		datetime: new Date('1969-12-31T23:59:59Z'),
		timestamp: new Date('1969-12-31T23:59:59.001Z'),
		interval: -4_294_967_297,
		interval64: -9_007_199_254_740_993n,
		decimal: '123.456000001',
		dyNumber: '1234567890.123',
		double: 16777217,
		uuid: '00112233-4455-6677-8899-aabbccddeeff',
	}
	let rows = await sql.do({ signal: tc.signal }, () =>
		db
			.select({
				date: yql`${yql.param(values.date, columns.date)}`.mapWith(columns.date),
				datetime: yql`${yql.param(values.datetime, columns.datetime)}`.mapWith(
					columns.datetime
				),
				timestamp: yql`${yql.param(values.timestamp, columns.timestamp)}`.mapWith(
					columns.timestamp
				),
				interval: yql`${yql.param(values.interval, columns.interval)}`.mapWith(
					columns.interval
				),
				interval64: yql`${yql.param(values.interval64, columns.interval64)}`.mapWith(
					columns.interval64
				),
				decimal: yql`${yql.param(values.decimal, columns.decimal)}`.mapWith(
					columns.decimal
				),
				dyNumber: yql`${yql.param(values.dyNumber, columns.dyNumber)}`.mapWith(
					columns.dyNumber
				),
				double: yql`${yql.param(values.double, columns.double)}`.mapWith(columns.double),
				uuid: yql`${yql.param(values.uuid, columns.uuid)}`.mapWith(columns.uuid),
			})
			.execute()
	)
	expect(rows).toHaveLength(1)
	let [row] = rows as [Record<string, unknown>]
	expect(row).toEqual({ ...values, dyNumber: expect.any(String) })
	expect(Number(row.dyNumber)).toBe(Number(values.dyNumber))
})
