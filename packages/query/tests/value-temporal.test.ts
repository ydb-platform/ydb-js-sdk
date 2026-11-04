import { install } from 'temporal-polyfill/shim'
import { Temporal } from 'temporal-polyfill'
import { expect, inject, test } from 'vitest'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { Interval, TzTimestamp, Uuid } from '@ydbjs/value/primitive'

type TemporalCollectionsRow = {
	dates: Temporal.PlainDate[]
	maps: Map<string, number>[]
	bytes: Uint8Array[]
	doubles: number[]
}
type TemporalScalarsRow = {
	interval: Temporal.Duration
	timestamp: Temporal.ZonedDateTime
	uuid: string
}

install()

function createDriver() {
	return new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
}

test('tagged parameters preserve nested Temporal dates, maps, bytes and doubles', async (tc) => {
	using driver = createDriver()
	await using sql = query(driver, { temporal: true })
	let dates = [Temporal.PlainDate.from('2025-01-01')]
	let maps = [new Map([['a', 1]])]
	let bytes = [Uint8Array.of(1, 2, 3)]
	let doubles = new Float64Array([16777217, Math.PI])

	let result = await sql<
		[TemporalCollectionsRow]
	>`SELECT ${dates} AS dates, ${maps} AS maps, ${bytes} AS bytes, ${doubles} AS doubles`.signal(
		tc.signal
	)
	let row = result[0]![0]!

	expect(row.dates).toHaveLength(1)
	expect(Temporal.PlainDate.compare(row.dates[0]!, dates[0]!)).toBe(0)
	expect(row.maps).toEqual(maps)
	expect(row.doubles).toEqual([...doubles])
	expect(row.bytes).toHaveLength(1)
	expect(row.bytes[0]).toBeInstanceOf(Uint8Array)
	expect([...row.bytes[0]!]).toEqual([...bytes[0]!])
})

test('Temporal interval and timezone timestamp results retain microsecond precision', async (tc) => {
	using driver = createDriver()
	await using sql = query(driver, { temporal: true })
	let interval = new Interval(-4_294_967_297)
	let expectedTimestamp = Temporal.ZonedDateTime.from('2025-01-01T00:00:00.001234+00:00[UTC]')
	let timestamp = new TzTimestamp(expectedTimestamp)
	let uuid = new Uuid('00112233-4455-6677-8899-aabbccddeeff')

	let result = await sql<
		[TemporalScalarsRow]
	>`SELECT ${interval} AS interval, ${timestamp} AS timestamp, ${uuid} AS uuid`.signal(tc.signal)

	expect(
		Temporal.Duration.compare(
			result[0]![0]!.interval,
			Temporal.Duration.from('-PT4294.967297S')
		)
	).toBe(0)
	expect(result[0]![0]!.timestamp.epochNanoseconds).toBe(expectedTimestamp.epochNanoseconds)
	expect(result[0]![0]!.timestamp.timeZoneId).toBe('UTC')
	expect(result[0]![0]!.uuid).toBe('00112233-4455-6677-8899-aabbccddeeff')
})
