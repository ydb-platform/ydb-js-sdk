import { expect, test } from 'vitest'

import { escJsonPathKey } from './encoding.ts'

test('preserves a JSON path with no SQL string escapes', () => {
	expect(escJsonPathKey('source')).toBe('source')
	expect(escJsonPathKey('a.b.c')).toBe('a.b.c')
})

test('escapes a single embedded quote', () => {
	expect(escJsonPathKey("o'reilly")).toBe(String.raw`o\'reilly`)
})

test('escapes every quote when several are present', () => {
	expect(escJsonPathKey("''")).toBe(String.raw`\'\'`)
	expect(escJsonPathKey("a'b'c")).toBe(String.raw`a\'b\'c`)
})

test('escapes literal backslashes', () => {
	expect(escJsonPathKey(String.raw`a\b\c`)).toBe(String.raw`a\\b\\c`)
	expect(escJsonPathKey('\\')).toBe('\\\\')
})

test('escapes a backslash followed by a quote', () => {
	expect(escJsonPathKey(String.raw`a\'b`)).toBe(String.raw`a\\\'b`)
})

test('escapes NUL without changing a literal escape sequence', () => {
	expect(escJsonPathKey('a\0b')).toBe(String.raw`a\x00b`)
	expect(escJsonPathKey(String.raw`a\x00b`)).toBe(String.raw`a\\x00b`)
})

test('handles an empty string', () => {
	expect(escJsonPathKey('')).toBe('')
})
