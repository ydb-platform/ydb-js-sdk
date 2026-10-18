import type { MetadataValue } from '@ydbjs/grpc'

export type MetadataHook = (
	metadata: Record<string, MetadataValue | readonly MetadataValue[]>
) => void

let registeredHooks: MetadataHook[] = []

export function addMetadataHook(hook: MetadataHook): Disposable {
	registeredHooks.push(hook)

	return {
		[Symbol.dispose]() {
			let index = registeredHooks.indexOf(hook)
			if (index >= 0) {
				registeredHooks.splice(index, 1)
			}
		},
	}
}

export function getRegisteredMetadataHooks(): readonly MetadataHook[] {
	return registeredHooks
}
