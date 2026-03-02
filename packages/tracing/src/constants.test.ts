import { expect, test } from 'vitest'

import { DB_SYSTEM, SPAN_NAMES } from './constants.js'

test('DB_SYSTEM equals ydb', () => {
	expect(DB_SYSTEM).toBe('ydb')
})

test('SPAN_NAMES contains CreateSession', () => {
	expect(SPAN_NAMES.CreateSession).toBe('ydb.CreateSession')
})

test('SPAN_NAMES contains ExecuteQuery', () => {
	expect(SPAN_NAMES.ExecuteQuery).toBe('ydb.ExecuteQuery')
})

test('SPAN_NAMES contains Commit', () => {
	expect(SPAN_NAMES.Commit).toBe('ydb.Commit')
})

test('SPAN_NAMES contains Rollback', () => {
	expect(SPAN_NAMES.Rollback).toBe('ydb.Rollback')
})
