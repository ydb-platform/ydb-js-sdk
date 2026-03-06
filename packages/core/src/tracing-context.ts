import { AsyncLocalStorage } from 'node:async_hooks'
import type { Span } from './tracing.js'

export type TracingContextStore = {
	span: Span
}

export const tracingContext = new AsyncLocalStorage<TracingContextStore>()
