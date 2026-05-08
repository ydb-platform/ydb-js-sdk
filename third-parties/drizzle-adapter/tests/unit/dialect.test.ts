import { test } from 'vitest'
import assert from 'node:assert/strict'
import { sql as yql } from 'drizzle-orm'
import { YdbDialect } from '../../src/ydb/dialect.ts'

test('dialect', () => {
	let dialect = new YdbDialect({ casing: 'snake_case' })

	assert.equal(dialect.escapeName('pony`name'), '`pony``name`')
	assert.equal(dialect.escapeParam(7), '$p7')
	assert.equal(dialect.escapeString("Pinkie's pie"), "'Pinkie''s pie'")
	assert.equal(dialect.prepareTyping(), 'none')

	let query = dialect.sqlToQuery(yql`select ${123} as ${yql.identifier('pony_id')}`)
	assert.equal(query.sql, 'select $p0 as `pony_id`')
	assert.deepEqual(query.params, [123])
	assert.deepEqual(query.typings, ['none'])
})
