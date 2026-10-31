// oxlint-disable no-await-in-loop -- Each case completes before the shared client starts the next query.
import { expect, inject, test } from 'vitest'
import type { Value as WireValue } from '@ydbjs/api/value'
import { Driver } from '@ydbjs/core'
import { QueryClient, query } from '@ydbjs/query'
import { fromYdb, toJs } from '@ydbjs/value'
import { Optional } from '@ydbjs/value/optional'
import { Pg, PgType } from '@ydbjs/value/pg'
import { Int32, Int32Type, Text, TextType } from '@ydbjs/value/primitive'
import { StructType } from '@ydbjs/value/struct'
import { Tagged } from '@ydbjs/value/tagged'
import { TupleType } from '@ydbjs/value/tuple'
import { Variant, VariantType } from '@ydbjs/value/variant'
import { Void } from '@ydbjs/value/void'
function createDriver() {
	return new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
}

test('tuple and named Variant parameters preserve selected alternatives through tagged SQL', async (tc) => {
	using driver = createDriver()
	await using sql = query(driver)
	let tuple = new VariantType(new TupleType([new TextType(), new Int32Type()]))
	let named = new VariantType(
		new StructType(['__proto__', 'a`b'], [new Int32Type(), new TextType()])
	)
	let values = [
		new Variant(new Int32(42), 1, tuple),
		new Variant(new Int32(7), '__proto__', named),
		new Variant(new Text('escaped name'), 'a`b', named),
	]
	for (let name of ['a\\b', 'trailing\\', 'slash\\`tick']) {
		values.push(
			new Variant(
				new Text('escaped name'),
				name,
				new VariantType(new StructType([name], [new TextType()]))
			)
		)
	}
	for (let value of values) {
		let result = await sql<{ value: Variant }[]>`SELECT ${value} AS value`.signal(tc.signal)
		let decoded = result[0]![0]!.value
		expect(decoded).toBeInstanceOf(Variant)
		expect(decoded.tag).toBe(value.tag)
		expect(toJs(decoded.item)).toEqual(toJs(value.item))
		expect(decoded.type.encode()).toEqual(value.type.encode())
		expect(decoded.encode()).toEqual(value.encode())
	}
})

test('Tagged, Void and Pg results remain typed values in ordinary query results', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)
	let result = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute<{ tagged: Tagged; void_value: Void; pg: Pg }>(
			'SELECT AsTagged(42, "customer/id") AS tagged, Void() AS void_value, PgConst("42", PgType("int4")) AS pg;'
		)
	)
	let row = result.resultSets[0]!.rows[0]!
	expect(row.tagged).toBeInstanceOf(Tagged)
	expect(row.tagged.type.tag).toBe('customer/id')
	expect(toJs(row.tagged.item)).toBe(42)
	expect(row.void_value).toBeInstanceOf(Void)
	expect(row.pg).toBeInstanceOf(Pg)
	expect(row.pg.value).toBe('42')
	expect(row.pg.type).toMatchObject({ typeName: 'pgint4', oid: 23, typlen: 4, typmod: -1 })
})

test('Optional around non-null and null Variant payloads keeps the selected branch', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)
	let cases = [
		['Just(Variant(42, "1", Variant<Utf8, Int32>))', 42],
		['Just(Variant(CAST(NULL AS Int32), "1", Variant<Utf8, Int32?>))', null],
		['Just(Just(Variant(42, "1", Variant<Utf8, Int32>)))', 42],
	] as const
	for (let [expression, expected] of cases) {
		let text = `SELECT ${expression} AS value;`
		let raw = await client.retrySession({ signal: tc.signal }, (session) =>
			session.execute<{ value: WireValue }>(text, {}, { raw: true })
		)
		let set = raw.resultSets[0]!
		let value = fromYdb(set.rows[0]!.value, set.columns[0]!.type!)
		expect(value).toBeInstanceOf(Optional)
		expect(value.type.encode()).toEqual(set.columns[0]!.type)
		let projected = toJs(value) as Variant
		expect(projected).toBeInstanceOf(Variant)
		expect(projected.index).toBe(1)
		expect(toJs(projected.item)).toBe(expected)
		let result = await client.retrySession({ signal: tc.signal }, (session) =>
			session.execute<{ value: Variant }>(text)
		)
		expect(result.resultSets[0]!.rows[0]!.value.index).toBe(1)
		expect(toJs(result.resultSets[0]!.rows[0]!.value.item)).toBe(expected)
	}
})

test('non-null nested Variant results preserve both branches without ambiguity', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)
	let text =
		'SELECT Just(Variant(Variant(42, "1", Variant<Int32,Int32>), "0", Variant<Variant<Int32,Int32>,Int32>)) AS value;'
	let raw = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute<{ value: WireValue }>(text, {}, { raw: true })
	)
	let set = raw.resultSets[0]!
	let decoded = fromYdb(set.rows[0]!.value, set.columns[0]!.type!)
	expect(decoded.type.encode()).toEqual(set.columns[0]!.type)
	expect(decoded.encode()).toEqual(set.rows[0]!.value)
	let value = toJs(decoded) as Variant<Variant>
	expect(value).toBeInstanceOf(Variant)
	expect(value.index).toBe(0)
	expect(value.item).toBeInstanceOf(Variant)
	expect(value.item.index).toBe(1)
	expect(toJs(value.item.item)).toBe(42)
	let result = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute<{ value: Variant<Variant> }>(text)
	)
	expect(result.resultSets[0]!.rows[0]!.value.index).toBe(0)
	expect(result.resultSets[0]!.rows[0]!.value.item.index).toBe(1)
	expect(toJs(result.resultSets[0]!.rows[0]!.value.item.item)).toBe(42)
})

test('ambiguous Optional Variant results require explicit raw mode instead of guessing a branch', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)
	await using sql = query(client)
	let text = `
		$a = Just(Variant(Variant(CAST(NULL AS Int32), "1", Variant<Int32?,Int32?>), "0", Variant<Variant<Int32?,Int32?>,Int32?>));
		$b = Just(Variant(CAST(NULL AS Int32), "1", Variant<Variant<Int32?,Int32?>,Int32?>));
		SELECT $a AS a, $b AS b,
			CAST(Way(Unwrap($a)) AS Utf8) AS a_branch,
			CAST(Way(Unwrap($b)) AS Utf8) AS b_branch;`
	let raw = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute<Record<string, WireValue>>(text, {}, { raw: true })
	)
	let set = raw.resultSets[0]!
	expect(set.columns[0]!.type).toEqual(set.columns[1]!.type)
	expect(set.rows[0]!.a).toEqual(set.rows[0]!.b)
	expect(toJs(fromYdb(set.rows[0]!.a_branch!, set.columns[2]!.type!))).toBe('0')
	expect(toJs(fromYdb(set.rows[0]!.b_branch!, set.columns[3]!.type!))).toBe('1')
	for (let name of ['a', 'b']) {
		expect(() => fromYdb(set.rows[0]![name]!, set.columns[0]!.type!)).toThrow(/ambiguous.*raw/i)
	}
	await expect(
		client.retrySession({ signal: tc.signal }, (session) => session.execute(text))
	).rejects.toThrow(/ambiguous.*raw/i)
	let rows = await sql<{ a: WireValue; b: WireValue }[]>`SELECT
		Just(Variant(Variant(CAST(NULL AS Int32), "1", Variant<Int32?,Int32?>), "0", Variant<Variant<Int32?,Int32?>,Int32?>)) AS a,
		Just(Variant(CAST(NULL AS Int32), "1", Variant<Variant<Int32?,Int32?>,Int32?>)) AS b`
		.raw()
		.signal(tc.signal)
	expect(rows[0]![0]!.a).toEqual(set.rows[0]!.a)
	expect(rows[0]![0]!.b).toEqual(set.rows[0]!.b)
})

test('Pg text, binary, null and OID-only parameters reach the server without JS coercion', async (tc) => {
	using driver = createDriver()
	await using client = new QueryClient(driver)
	await using sql = query(client)
	let type = new PgType({ typeName: 'pgint4', oid: 23, typlen: 4, typmod: -1 })
	let cases = [
		[new Pg('42', type), '42'],
		[new Pg(new Uint8Array([0, 0, 0, 42]), type), '42'],
		[new Pg(null, type), null],
	] as const
	for (let [value, expected] of cases) {
		let rows = await sql<{ value: Pg }[]>`SELECT ${value} AS value`.signal(tc.signal)
		let result = rows[0]![0]!.value
		expect(result).toBeInstanceOf(Pg)
		expect(result.value).toBe(expected)
		expect(result.type.encode()).toEqual(type.encode())
	}
	let result = await client.retrySession({ signal: tc.signal }, (session) =>
		session.execute<{ value: Pg }>('DECLARE $value AS pgint4; SELECT $value AS value;', {
			value: new Pg('42', new PgType({ oid: 23 })),
		})
	)
	expect(result.resultSets[0]!.rows[0]!.value.value).toBe('42')
	expect(result.resultSets[0]!.rows[0]!.value.type.oid).toBe(23)
})

test('Void values work as query parameters', async (tc) => {
	using driver = createDriver()
	await using sql = query(driver)
	let rows = await sql<{ void_value: Void }[]>`
		SELECT ${new Void()} AS void_value
	`.signal(tc.signal)
	expect(rows[0]![0]!.void_value).toBeInstanceOf(Void)
})
