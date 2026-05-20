import * as assert from 'node:assert/strict'

import { sql as yql } from 'drizzle-orm/sql/sql'
import { test } from 'vitest'

import { dialect } from '../../../tests/helpers/unit-basic.ts'
import { numericHash } from './digest.ts'

test('renders Digest::NumericHash with Unwrap and a Uint64 cast for a numeric literal', () => {
	let query = dialect.sqlToQuery(numericHash(42))
	assert.equal(query.sql, 'Unwrap(Digest::NumericHash(CAST($p0 AS Uint64)))')
	assert.deepEqual(query.params, [42])
})

test('renders Digest::NumericHash for a bigint literal', () => {
	let query = dialect.sqlToQuery(numericHash(42n))
	assert.equal(query.sql, 'Unwrap(Digest::NumericHash(CAST($p0 AS Uint64)))')
	assert.deepEqual(query.params, [42n])
})

test('inlines a SQL expression argument without parameterising it', () => {
	let query = dialect.sqlToQuery(numericHash(yql`${yql.identifier('id')}`))
	assert.equal(query.sql, 'Unwrap(Digest::NumericHash(CAST(`id` AS Uint64)))')
	assert.deepEqual(query.params, [])
})
