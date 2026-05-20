import * as assert from 'node:assert/strict'

import { sql as yql } from 'drizzle-orm/sql/sql'
import { test } from 'vitest'

import { dialect } from '../../../tests/helpers/unit-basic.ts'
import { crc32c, crc64, numericHash, xxHash } from './digest.ts'

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

test('renders Digest::XXH3 with Unwrap and a String cast for a string literal', () => {
	let query = dialect.sqlToQuery(xxHash('ada@example.com'))
	assert.equal(query.sql, 'Unwrap(Digest::XXH3(CAST($p0 AS String)))')
	assert.deepEqual(query.params, ['ada@example.com'])
})

test('renders Digest::Crc32c with Unwrap and a String cast', () => {
	let query = dialect.sqlToQuery(crc32c('payload'))
	assert.equal(query.sql, 'Unwrap(Digest::Crc32c(CAST($p0 AS String)))')
	assert.deepEqual(query.params, ['payload'])
})

test('renders Digest::Crc64 without an init seed by default', () => {
	let query = dialect.sqlToQuery(crc64('payload'))
	assert.equal(query.sql, 'Unwrap(Digest::Crc64(CAST($p0 AS String)))')
	assert.deepEqual(query.params, ['payload'])
})

test('renders Digest::Crc64 with an init seed when provided', () => {
	let query = dialect.sqlToQuery(crc64('payload', 7n))
	assert.equal(query.sql, 'Unwrap(Digest::Crc64(CAST($p0 AS String), CAST($p1 AS Uint64)))')
	assert.deepEqual(query.params, ['payload', 7n])
})
