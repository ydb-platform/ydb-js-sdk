import { expect, inject, test } from 'vitest'
import { TZDate } from '@date-fns/tz'
import { Type_PrimitiveTypeId, type Value as WireValue } from '@ydbjs/api/value'
import { Driver } from '@ydbjs/core'
import { QueryClient, query } from '@ydbjs/query'
import { fromYdb, toJs } from '@ydbjs/value'
import { Optional, OptionalType } from '@ydbjs/value/optional'
import { Int32Type, Interval, TzTimestamp, Uuid } from '@ydbjs/value/primitive'
import { Struct, StructType } from '@ydbjs/value/struct'

function createDriver() {
	return new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
}

test('server results retain optional presence, empty container schemas and UUID bits', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)
	let text = `SELECT
		CAST(NULL AS Int32) AS absent,
		Just(CAST(NULL AS Int32)) AS inner_absent,
		Just(Just(CAST(NULL AS Int32))) AS deepest_absent,
		ListCreate(Int32) AS empty_list,
		DictCreate(Utf8, Int32) AS empty_dict,
		AsList(Just(42), CAST(NULL AS Int32)) AS nullable_list,
		Uuid('00112233-4455-6677-8899-aabbccddeeff') AS uuid;`
	let result = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute<Record<string, WireValue>>(text, {}, { raw: true })
	)
	let set = result.resultSets[0]!
	let decoded = Object.fromEntries(
		set.columns.map((column) => {
			let wire = set.rows[0]![column.name]!
			let value = fromYdb(wire, column.type!)
			expect(value.type.encode()).toEqual(column.type)
			expect(value.encode()).toEqual(wire)
			return [column.name, value]
		})
	)
	expect(decoded.absent).toBeInstanceOf(Optional)
	expect((decoded.absent as Optional<Int32Type>).item).toBeNull()
	let inner = decoded.inner_absent as Optional<OptionalType>
	expect(inner.item).toBeInstanceOf(Optional)
	expect((inner.item as Optional<Int32Type>).item).toBeNull()
	let deepest = decoded.deepest_absent as Optional<OptionalType>
	expect((deepest.item as Optional<OptionalType>).item).toBeInstanceOf(Optional)
	expect(toJs(decoded.nullable_list!)).toEqual([42, null])
	expect(toJs(decoded.uuid!)).toBe('00112233-4455-6677-8899-aabbccddeeff')
	let native = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute(text)
	)
	expect(native.resultSets[0]!.rows).toEqual([
		{
			absent: null,
			inner_absent: null,
			deepest_absent: null,
			empty_list: [],
			empty_dict: new Map(),
			nullable_list: [42, null],
			uuid: '00112233-4455-6677-8899-aabbccddeeff',
		},
	])
})

test('typed nested optional and missing own struct fields survive parameter binding', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)
	let optional = new Optional(new Optional(null, new Int32Type()))
	let struct = new Struct(
		{},
		new StructType(
			['constructor', '__proto__'],
			[new OptionalType(new Int32Type()), new OptionalType(new Int32Type())]
		)
	)
	await using sql = query(client)
	let result = await sql`SELECT ${optional} AS optional, ${struct} AS struct`.signal(tc.signal)
	expect(result).toStrictEqual([
		[{ optional: null, struct: JSON.parse('{"constructor":null,"__proto__":null}') }],
	])
	let wire = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute<Record<string, WireValue>>(
			'DECLARE $value AS Optional<Optional<Int32>>; SELECT $value AS value;',
			{ value: optional },
			{ raw: true }
		)
	)
	expect(wire.resultSets[0]!.columns[0]!.type).toEqual(optional.type.encode())
	expect(wire.resultSets[0]!.rows[0]!.value).toEqual(optional.encode())
})

test('tagged parameters preserve arrays of dates, maps, bytes and doubles', async (tc) => {
	using driver = createDriver()
	await using sql = query(driver)
	let dates = [new Date('2025-01-01T00:00:00Z')]
	let maps = [new Map([['a', 1]])]
	let bytes = [Uint8Array.of(1, 2, 3)]
	let doubles = new Float64Array([16777217, Math.PI])
	let result = await sql<
		{ dates: Date[]; maps: Map<string, number>[]; bytes: Uint8Array[]; doubles: number[] }[]
	>`SELECT ${dates} AS dates, ${maps} AS maps, ${bytes} AS bytes, ${doubles} AS doubles`.signal(
		tc.signal
	)
	let row = result[0]![0]!
	expect(row.dates).toEqual(dates)
	expect(row.maps).toEqual(maps)
	expect(row.doubles).toEqual([...doubles])
	expect(row.bytes).toHaveLength(1)
	expect(row.bytes[0]).toBeInstanceOf(Uint8Array)
	expect([...row.bytes[0]!]).toEqual([...bytes[0]!])
})

test('interval and timezone timestamp parameters retain their wire precision', async (tc) => {
	using driver = createDriver()
	await using sql = query(driver)
	let interval = new Interval(-4_294_967_297)
	let timestamp = new TzTimestamp(new TZDate('2025-01-01T00:00:00.001Z', 'UTC'))
	let uuid = new Uuid('00112233-4455-6677-8899-aabbccddeeff')
	let result = await sql<
		[{ interval: number; timestamp: Date; uuid: string }]
	>`SELECT ${interval} AS interval, ${timestamp} AS timestamp, ${uuid} AS uuid`.signal(tc.signal)
	expect(result[0]![0]!.interval).toBe(-4_294_967_297)
	expect((result[0]![0]!.timestamp as Date).getTime()).toBe(
		Date.parse('2025-01-01T00:00:00.001Z')
	)
	expect(result[0]![0]!.uuid).toBe('00112233-4455-6677-8899-aabbccddeeff')
})

test('untyped empty server containers decode to native empty containers', async (tc) => {
	using driver = createDriver()
	await using sql = query(driver)
	expect(await sql`SELECT [] AS list, AsDict() AS dict`.signal(tc.signal)).toEqual([
		[{ list: [], dict: new Map() }],
	])
})

test('own column names and raw protobuf cells are preserved by both query APIs', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)
	let result = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute('SELECT 1 AS `__proto__`, 2 AS `constructor`, 3 AS `toString`;')
	)
	let row = result.resultSets[0]!.rows[0]!
	expect(row).toStrictEqual(JSON.parse('{"__proto__":1,"constructor":2,"toString":3}'))
	expect(Object.getPrototypeOf(row)).toBe(Object.prototype)
	await using sql = query(client)
	let raw = await sql<Record<string, WireValue>[]>`SELECT 42 AS n`.raw().signal(tc.signal)
	expect(raw[0]![0]!.n!.value).toEqual({ case: 'int32Value', value: 42 })
	expect(raw[0]![0]!.n).not.toHaveProperty('type')
	expect(result.resultSets[0]!.columns[0]!.type?.type).toEqual({
		case: 'typeId',
		value: Type_PrimitiveTypeId.INT32,
	})
})
