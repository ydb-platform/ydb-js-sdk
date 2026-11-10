import { expect, inject, test } from 'vitest'
import { Driver } from '@ydbjs/core'
import { QueryClient, query } from '@ydbjs/query'
import { BitVector, Float32Vector, Int8Vector, Uint8Vector } from '@ydbjs/value/vector'

let cases = [
	{
		name: 'Float32',
		value: new Float32Vector(new Float64Array([1.5, -2.5, 0])),
		tag: 'FloatVector',
		expression: 'Knn::ToBinaryStringFloat(CAST([1.5, -2.5, 0.0] AS List<Float>))',
		expected: new Float32Array([1.5, -2.5, 0]),
	},
	{
		name: 'Int8',
		value: new Int8Vector(new Int8Array([-128, -1, 0, 127])),
		tag: 'Int8Vector',
		expression: 'Knn::ToBinaryStringInt8(CAST([-128, -1, 0, 127] AS List<Int8>))',
		expected: new Int8Array([-128, -1, 0, 127]),
	},
	{
		name: 'Uint8',
		value: new Uint8Vector(new Uint8Array([0, 128, 255])),
		tag: 'Uint8Vector',
		expression: 'Knn::ToBinaryStringUint8(CAST([0, 128, 255] AS List<Uint8>))',
		expected: new Uint8Array([0, 128, 255]),
	},
	{
		name: 'Bit',
		value: BitVector.fromSigns([1, 2, 3, 0, -1, -3, 0, 15, 6, -1, -1, 33.34]),
		tag: 'BitVector',
		expression:
			'Knn::ToBinaryStringBit(CAST([1, 2, 3, 0, -1, -3, 0, 15, 6, -1, -1, 33.34] AS List<Double>))',
		expected: new Uint8Array([1, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1]),
	},
]

type VectorRow = {
	client: Uint8Array
	server: Uint8Array
	vector: Float32Array | Int8Array | Uint8Array | BitVector
}

type TaggedVectorRow = { vector: Float32Array }
type NumericVectorRow = { floats: Float32Array; signed: Int8Array; unsigned: Uint8Array }

for (let fixture of cases) {
	test(`${fixture.name} matches the server vector format and converts tagged results`, async (tc) => {
		using driver = new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
		await using client = new QueryClient(driver)
		let text = `SELECT $input AS client, Untag(${fixture.expression}, "${fixture.tag}") AS server,
			${fixture.expression} AS vector;`

		let result = await client.retrySession({ signal: tc.signal }, (session) => {
			return session.execute<[VectorRow]>(text, { input: fixture.value })
		})
		let row = result.resultSets[0].rows[0]!
		let coordinates = row.vector instanceof BitVector ? row.vector.toTypedArray() : row.vector

		expect(Array.from(row.client)).toEqual(Array.from(row.server))
		expect(coordinates).toEqual(fixture.expected)
		expect(result.resultSets[0].columns[2]!.type).toMatchObject({
			type: { case: 'taggedType', value: { tag: fixture.tag } },
		})
	})
}

test('the tagged facade binds compact vectors and decodes explicit vector tags', async (tc) => {
	using driver = new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
	await using sql = query(driver)
	let vector = new Float32Vector([0.25, -0.5])

	let [[row]] = await sql<[TaggedVectorRow]>`
		SELECT AsTagged(${vector}, "FloatVector") AS vector;
	`.signal(tc.signal)

	expect(row!.vector).toEqual(new Float32Array([0.25, -0.5]))
})

test('preserves empty numeric vectors returned by the server', async (tc) => {
	using driver = new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
	await using sql = query(driver)

	let [[row]] = await sql<[NumericVectorRow]>`
		SELECT Knn::ToBinaryStringFloat(CAST([] AS List<Float>)) AS floats,
			Knn::ToBinaryStringInt8(CAST([] AS List<Int8>)) AS signed,
			Knn::ToBinaryStringUint8(CAST([] AS List<Uint8>)) AS unsigned;
	`.signal(tc.signal)

	expect(row!.floats).toEqual(new Float32Array())
	expect(row!.signed).toEqual(new Int8Array())
	expect(row!.unsigned).toEqual(new Uint8Array())
})

test('preserves non-finite Float32 coordinates returned by the server', async (tc) => {
	using driver = new Driver(inject('connectionString'), { 'ydb.sdk.enable_discovery': false })
	await using sql = query(driver)
	let values = new Float32Array([NaN, Infinity, -Infinity])

	let [[row]] = await sql<[TaggedVectorRow]>`
		SELECT Knn::ToBinaryStringFloat(${values}) AS vector;
	`.signal(tc.signal)

	expect(row!.vector).toEqual(values)
})
