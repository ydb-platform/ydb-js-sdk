import { expect, test } from 'vitest'
import { sql as yql } from 'drizzle-orm'
import { createLiveContext } from './helpers/context.ts'
import { usersTableName } from './helpers/schema.ts'

let live = createLiveContext()

test('preserves inline string values in read-only queries on live YDB', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(t, 'read-only SELECT of inline strings with quotes and backslashes')
	let values = {
		quote: "Pinkie's pie",
		backslash: String.raw`C:\new\test`,
		backslashQuote: String.raw`pony\' OR TRUE --`,
		trailingBackslash: 'pony\\',
		control: 'line\n\r\t\b\f\v\0end',
	}
	let selection = Object.entries(values).map(
		([name, value]) => yql`cast(${value} as Utf8) as ${yql.identifier(name)}`
	)

	let rows = await live.db.execute(yql`select ${yql.join(selection, yql`, `)}`.inlineParams())

	expect(rows).toEqual([values])
})

test('preserves quoted aliases in read-only queries on live YDB', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(t, 'read-only SELECT with aliases containing backticks and backslashes')
	let names = ['pony`name', 'pony\\name', 'pony\\`name', 'pony\\']
	let selection = names.map((name) => yql`${1} as ${yql.identifier(name)}`)

	let rows = await live.db.execute(yql`select ${yql.join(selection, yql`, `)}`)

	expect(rows).toEqual([Object.fromEntries(names.map((name) => [name, 1]))])
})

test('runs raw sql against live YDB', async (t) => {
	if (!live.requireLiveYdb(t)) return
	live.describeDbChange(
		t,
		'insert one user row via raw SQL, read it back, delete it, then confirm the row is gone'
	)
	let id = live.baseIntId + 1

	live.log('raw', id)
	await live.deleteUserRows([id])

	try {
		await live.db.execute(
			yql`insert into ${yql.identifier(usersTableName)} (id, name) values (${id}, ${'pinky'})`
		)

		let inserted = await live.db.execute<Array<{ id: number; name: string }>>(
			yql`select id, name from ${yql.identifier(usersTableName)} where id = ${id}`
		)

		expect(inserted).toEqual([{ id, name: 'pinky' }])

		await live.db.execute(yql`delete from ${yql.identifier(usersTableName)} where id = ${id}`)

		let remaining = await live.db.execute<Array<{ id: number; name: string }>>(
			yql`select id, name from ${yql.identifier(usersTableName)} where id = ${id}`
		)

		expect(remaining).toEqual([])
	} finally {
		await live.deleteUserRows([id])
	}
})
