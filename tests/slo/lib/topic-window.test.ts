import { expect, test } from 'vitest'

import { TopicWindow } from './topic-window.ts'

test('blocks a full window until the reader commits messages', async (tc) => {
	let window = new TopicWindow(4)
	await window.wait(3, tc.signal)

	let released = false
	let waiting = window.wait(4, tc.signal).then(() => {
		released = true
		return released
	})
	await Promise.resolve()
	expect(released).toBe(false)

	window.commit(1)
	await waiting
	expect(released).toBe(true)
})

test('stops a producer waiting for reader progress', async () => {
	let window = new TopicWindow(4)
	let controller = new AbortController()
	let waiting = window.wait(4, controller.signal)
	controller.abort(new Error('stopped'))
	await expect(waiting).rejects.toThrow('stopped')
})

test('does not grant additional capacity for repeated commits', async () => {
	let window = new TopicWindow(4)
	window.commit(2)
	window.commit(2)
	let controller = new AbortController()
	let waiting = window.wait(6, controller.signal)
	controller.abort(new Error('still full'))
	await expect(waiting).rejects.toThrow('still full')
	expect(() => window.commit(1)).toThrow('Invalid committed')
})
