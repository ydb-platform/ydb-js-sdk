import { test } from 'vitest'
import * as assert from 'node:assert/strict'
import { sql as yql } from 'drizzle-orm'
import { YdbDialect } from '../ydb/dialect.ts'
import { uuid, ydbTable } from '../schema.ts'

test('instantiates YdbDialect with default options', () => {
	let dialect = new YdbDialect({ casing: 'snake_case' })

	assert.equal(dialect.escapeName('pony`name'), '`pony``name`')
	assert.equal(dialect.escapeParam(7), '$p7')
	assert.equal(dialect.escapeString("Pinkie's pie"), "'Pinkie\\'s pie'")
	assert.equal(dialect.prepareTyping(), 'none')

	let query = dialect.sqlToQuery(yql`select ${123} as ${yql.identifier('pony_id')}`)
	assert.equal(query.sql, 'select $p0 as `pony_id`')
	assert.deepEqual(query.params, [123])
	assert.deepEqual(query.typings, ['none'])
})

test('renders null literals and keeps subsequent values and typings aligned', () => {
	let dialect = new YdbDialect()
	let string = "null, 'untrusted'"
	let columns = ydbTable('items', { id: uuid() })
	let id = '00112233-4455-6677-8899-aabbccddeeff'
	let fragment = yql`${null}, ${string}`
	let query = dialect.sqlToQuery(
		yql`select ${fragment}, ${yql.param(null)}, ${yql.param(id, columns.id)}`
	)

	assert.equal(query.sql, 'select null, $p0, null, $p1')
	assert.deepEqual(query.params, [string, columns.id.mapToDriverValue(id)])
	assert.deepEqual(query.typings, ['none', 'uuid'])
})
