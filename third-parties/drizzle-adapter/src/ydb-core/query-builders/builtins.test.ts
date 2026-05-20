import * as assert from 'node:assert/strict'

import { sql as yql } from 'drizzle-orm/sql/sql'
import { test } from 'vitest'

import { dialect } from '../../../tests/helpers/unit-basic.ts'
import {
	currentUtcDate,
	currentUtcDatetime,
	currentUtcTimestamp,
	maxOf,
	minOf,
	random,
	randomNumber,
	randomUuid,
	unwrap,
} from './builtins.ts'

test('renders CurrentUtc* clock readings with parentheses', () => {
	assert.equal(dialect.sqlToQuery(currentUtcDate()).sql, 'CurrentUtcDate()')
	assert.equal(dialect.sqlToQuery(currentUtcDatetime()).sql, 'CurrentUtcDatetime()')
	assert.equal(dialect.sqlToQuery(currentUtcTimestamp()).sql, 'CurrentUtcTimestamp()')
})

test('passes per-row cache keys to Random', () => {
	let query = dialect.sqlToQuery(random(yql`${yql.identifier('id')}`))
	assert.equal(query.sql, 'Random(`id`)')
	assert.deepEqual(query.params, [])
})

test('passes multiple cache keys to RandomNumber', () => {
	let query = dialect.sqlToQuery(
		randomNumber(yql`${yql.identifier('id')}`, yql`${yql.identifier('shard')}`)
	)
	assert.equal(query.sql, 'RandomNumber(`id`, `shard`)')
})

test('threads cache keys through RandomUuid', () => {
	let query = dialect.sqlToQuery(randomUuid(yql`${yql.identifier('id')}`))
	assert.equal(query.sql, 'RandomUuid(`id`)')
})

test('unwrap renders Unwrap with a single argument by default', () => {
	let query = dialect.sqlToQuery(unwrap(yql`${yql.identifier('value')}`))
	assert.equal(query.sql, 'Unwrap(`value`)')
})

test('unwrap renders Unwrap with a custom error message when provided', () => {
	let query = dialect.sqlToQuery(unwrap(yql`${yql.identifier('value')}`, 'value must be set'))
	assert.equal(query.sql, 'Unwrap(`value`, $p0)')
	assert.deepEqual(query.params, ['value must be set'])
})

test('maxOf renders MAX_OF with all arguments', () => {
	let query = dialect.sqlToQuery(maxOf(1, 2, 3))
	assert.equal(query.sql, 'MAX_OF($p0, $p1, $p2)')
	assert.deepEqual(query.params, [1, 2, 3])
})

test('minOf renders MIN_OF and accepts SQL expressions alongside literals', () => {
	let query = dialect.sqlToQuery(minOf(yql`${yql.identifier('left')}`, 100))
	assert.equal(query.sql, 'MIN_OF(`left`, $p0)')
	assert.deepEqual(query.params, [100])
})
