import { expect, test } from 'vitest'

import { addMetadataHook, getRegisteredMetadataHooks } from './metadata-hooks.ts'

test('appends a hook to the registry', () => {
	let before = getRegisteredMetadataHooks().length
	let hook = () => {}

	using _ = addMetadataHook(hook)

	expect(getRegisteredMetadataHooks()).toContain(hook)
	expect(getRegisteredMetadataHooks()).toHaveLength(before + 1)
})

test('removes a hook on disposal', () => {
	let before = getRegisteredMetadataHooks().length
	let hook = () => {}
	let registration = addMetadataHook(hook)

	registration[Symbol.dispose]()
	registration[Symbol.dispose]()

	expect(getRegisteredMetadataHooks()).not.toContain(hook)
	expect(getRegisteredMetadataHooks()).toHaveLength(before)
})
