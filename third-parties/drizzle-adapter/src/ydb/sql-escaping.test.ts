import { test } from 'vitest'
import * as assert from 'node:assert/strict'
import { sql as yql } from 'drizzle-orm'
import { buildCreateUserSql, buildDropTableSql } from '../migrator.ts'
import { YdbDialect } from './dialect.ts'

test('escapes backslashes and backticks in query and migration identifiers', () => {
	let dialect = new YdbDialect()
	let cases = [
		{ value: 'pony`name', escaped: '`pony``name`' },
		{ value: 'pony\\name', escaped: '`pony\\\\name`' },
		{ value: 'pony\\`name', escaped: '`pony\\\\``name`' },
		{ value: 'pony\\', escaped: '`pony\\\\`' },
	]

	for (let { value, escaped } of cases) {
		let query = dialect.sqlToQuery(yql`select 1 as ${yql.identifier(value)}`)

		assert.equal(query.sql, `select 1 as ${escaped}`)
		assert.equal(buildDropTableSql(value), `DROP TABLE ${escaped}`)
	}
})

test('escapes inline query and migration strings with default YQL syntax', () => {
	let dialect = new YdbDialect()
	let cases = [
		{ value: "Pinkie's pie", escaped: String.raw`'Pinkie\'s pie'` },
		{ value: String.raw`C:\new\test`, escaped: String.raw`'C:\\new\\test'` },
		{ value: String.raw`pony\' OR TRUE --`, escaped: String.raw`'pony\\\' OR TRUE --'` },
		{ value: 'pony\\', escaped: String.raw`'pony\\'` },
		{ value: 'line\n\r\t\b\f\v\0end', escaped: "'line\n\r\t\b\f\v\\x00end'" },
	]

	for (let { value, escaped } of cases) {
		let query = dialect.sqlToQuery(yql`select ${value}`.inlineParams())

		assert.equal(query.sql, `select ${escaped}`)
		assert.deepEqual(query.params, [])
		assert.equal(
			buildCreateUserSql('pony', { password: value }),
			`CREATE USER \`pony\` PASSWORD ${escaped}`
		)
	}
})
