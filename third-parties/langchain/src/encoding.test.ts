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

test('passes a key with no quotes through unchanged', () => {
	expect(escJsonPathKey('source')).toBe('source')
	expect(escJsonPathKey('a.b.c')).toBe('a.b.c')
})

test('doubles a single embedded quote', () => {
	expect(escJsonPathKey("o'reilly")).toBe("o''reilly")
})

test('doubles every quote when several are present', () => {
	expect(escJsonPathKey("''")).toBe("''''")
	expect(escJsonPathKey("a'b'c")).toBe("a''b''c")
})

test('handles an empty string', () => {
	expect(escJsonPathKey('')).toBe('')
})
