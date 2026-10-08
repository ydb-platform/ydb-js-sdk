import { create } from '@bufbuild/protobuf'
import { type Duration, DurationSchema, timestampDate } from '@bufbuild/protobuf/wkt'
import { expect, test } from 'vitest'

import { parseReadSettings } from './read-settings.js'

test('normalizes a bare topic path to a single setting', () => {
	let settings = parseReadSettings('/my-topic')
	expect(settings).toHaveLength(1)
	expect(settings[0]!.path).toBe('/my-topic')
	expect(settings[0]!.maxLag).toBeUndefined()
	expect(settings[0]!.readFrom).toBeUndefined()
	expect(settings[0]!.partitionIds).toEqual([])
})

test('normalizes a single source object to one setting', () => {
	let settings = parseReadSettings({ path: '/a', partitionIds: [1n, 3n] })
	expect(settings).toHaveLength(1)
	expect(settings[0]!.path).toBe('/a')
	expect(settings[0]!.partitionIds).toEqual([1n, 3n])
})

test('builds one setting per source in an array', () => {
	let settings = parseReadSettings([{ path: '/a' }, { path: '/b', partitionIds: [0n] }])
	expect(settings.map((s) => s.path)).toEqual(['/a', '/b'])
	expect(settings[1]!.partitionIds).toEqual([0n])
})

test('splits a numeric maxLag into seconds and nanos', () => {
	let [settings] = parseReadSettings({ path: '/t', maxLag: 1500 })
	expect(settings!.maxLag).toMatchObject({ seconds: 1n, nanos: 500_000_000 })
})

test('parses an ms-string maxLag', () => {
	let [settings] = parseReadSettings({ path: '/t', maxLag: '90s' })
	expect(settings!.maxLag).toMatchObject({ seconds: 90n, nanos: 0 })
})

test('passes a Duration maxLag through untouched', () => {
	let duration: Duration = create(DurationSchema, { seconds: 5n, nanos: 250 })
	let [settings] = parseReadSettings({ path: '/t', maxLag: duration })
	expect(settings!.maxLag).toBe(duration)
})

test('sends an explicit zero maxLag on the wire', () => {
	let [settings] = parseReadSettings({ path: '/t', maxLag: 0 })
	expect(settings!.maxLag).toMatchObject({ seconds: 0n, nanos: 0 })
})

test('converts a Date readFrom to a timestamp', () => {
	let readFrom = new Date('2026-01-15T12:30:45.500Z')
	let [settings] = parseReadSettings({ path: '/t', readFrom })
	expect(timestampDate(settings!.readFrom!).getTime()).toBe(readFrom.getTime())
})

test('converts an epoch-milliseconds readFrom to a timestamp', () => {
	let [settings] = parseReadSettings({ path: '/t', readFrom: 1_700_000_000_500 })
	expect(settings!.readFrom).toMatchObject({ seconds: 1_700_000_000n, nanos: 500_000_000 })
})

test('sends readFrom zero as the epoch instead of dropping it', () => {
	let [settings] = parseReadSettings({ path: '/t', readFrom: 0 })
	expect(settings!.readFrom).toMatchObject({ seconds: 0n, nanos: 0 })
})

test('passes an empty partitionIds list through', () => {
	let [settings] = parseReadSettings({ path: '/t', partitionIds: [] })
	expect(settings!.partitionIds).toEqual([])
})
