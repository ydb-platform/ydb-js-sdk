import { getEventListeners } from 'node:events'
import { expect, test } from 'vitest'
import { linkSignals } from './signals.ts'

test('cleans up listeners after using block', () => {
	let root = new AbortController().signal

	for (let i = 0; i < 10_000; i++) {
		using _ = linkSignals(root)
	}

	expect(getEventListeners(root, 'abort').length).toBe(0)
})

test('aborts immediately when parent already aborted', () => {
	let root = new AbortController()
	root.abort('dead')

	using linked = linkSignals(root.signal)

	expect(linked.signal.aborted).toBe(true)
	expect(linked.signal.reason).toBe('dead')
})

test('handles multiple signals and undefined', () => {
	let sig1 = new AbortController().signal
	let sig2 = new AbortController().signal

	{
		using _ = linkSignals(sig1, sig2, undefined)
		expect(getEventListeners(sig1, 'abort').length).toBe(1)
		expect(getEventListeners(sig2, 'abort').length).toBe(1)
	}

	expect(getEventListeners(sig1, 'abort').length).toBe(0)
	expect(getEventListeners(sig2, 'abort').length).toBe(0)
})

test('aborts linked signal on dispose', () => {
	let signal: AbortSignal

	{
		using linked = linkSignals(new AbortController().signal)
		signal = linked.signal
		expect(signal.aborted).toBe(false)
	}

	expect(signal.aborted).toBe(true)
})
