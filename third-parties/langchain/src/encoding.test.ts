import { expect, test } from 'vitest'

import { escJsonPathKey, vectorToBytes } from './encoding.ts'

// ── vectorToBytes ─────────────────────────────────────────────────────────

test('packs an empty vector into a single marker byte', () => {
	let bytes = vectorToBytes([])

	expect(bytes).toEqual(new Uint8Array([0x01]))
})

test('packs a single float as 4 little-endian bytes plus marker', () => {
	let bytes = vectorToBytes([1.0])

	// IEEE-754 binary32 of 1.0 = 0x3F800000, little-endian → 00 00 80 3F.
	expect(bytes).toEqual(new Uint8Array([0x00, 0x00, 0x80, 0x3f, 0x01]))
})

test('packs multiple floats with little-endian Float32 layout', () => {
	let bytes = vectorToBytes([1.0, -1.0, 0.5])

	expect(bytes).toHaveLength(13)
	expect(bytes.slice(0, 4)).toEqual(new Uint8Array([0x00, 0x00, 0x80, 0x3f]))
	expect(bytes.slice(4, 8)).toEqual(new Uint8Array([0x00, 0x00, 0x80, 0xbf]))
	expect(bytes.slice(8, 12)).toEqual(new Uint8Array([0x00, 0x00, 0x00, 0x3f]))
	expect(bytes[12]).toBe(0x01)
})

test('produces a buffer of length n*4 + 1', () => {
	for (let n of [0, 1, 4, 32, 1536]) {
		let v = new Array(n).fill(0.0)
		expect(vectorToBytes(v)).toHaveLength(n * 4 + 1)
	}
})

test('terminates the buffer with the YDB vector marker byte', () => {
	let bytes = vectorToBytes([0.0, 0.0, 0.0, 0.0])

	expect(bytes[bytes.length - 1]).toBe(0x01)
})

// ── escJsonPathKey ────────────────────────────────────────────────────────

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
