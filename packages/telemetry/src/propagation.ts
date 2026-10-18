import type { MetadataHook } from '@ydbjs/core'
import { context, propagation } from '@opentelemetry/api'

export let propagator: MetadataHook = (metadata) => {
	propagation.inject(context.active(), metadata, {
		set(carrier, key, value) {
			carrier[key] = String(value)
		},
	})
}
