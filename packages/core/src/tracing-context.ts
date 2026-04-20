import { AsyncLocalStorage } from 'node:async_hooks'

export type TracingContextStore = {
	span?: unknown
	queryText?: string
}

export const tracingContext = new AsyncLocalStorage<TracingContextStore>()
