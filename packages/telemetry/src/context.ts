import { AsyncLocalStorage } from 'node:async_hooks'

import type { Span } from '@opentelemetry/api'

/**
 * Active subscriber span, propagated across async continuations via
 * `tracingChannel.bindStore`. We keep our own ALS instead of reusing
 * OTel's context because channel handlers are discrete events — there's no
 * function for `context.with(ctx, fn)` to wrap, and `enterWith` isn't part
 * of OTel's public API.
 */
export let spanStorage = new AsyncLocalStorage<Span>()

export function getActiveSubscriberSpan(): Span | undefined {
	return spanStorage.getStore()
}
