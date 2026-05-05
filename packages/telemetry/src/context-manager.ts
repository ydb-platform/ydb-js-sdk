import { AsyncLocalStorage } from 'node:async_hooks'

import { recordErrorAttributes } from './attributes.js'
import type { Span, StartSpanOptions, Tracer } from './tracing.js'

/**
 * Tracks the currently active subscriber span across async continuations.
 * Separate from OTel's own context ALS — used exclusively to wire parent→child
 * between nested tracing channels. Restored on asyncEnd/error so sibling
 * operations (e.g. retry attempts) each get the correct parent.
 */
export let spanStorage = new AsyncLocalStorage<Span | undefined>()

/** Returns the span currently active in the subscriber ALS context. */
export function getActiveSubscriberSpan(): Span | undefined {
	return spanStorage.getStore()
}

/** Helpers closed over a specific tracer and base attributes, used by tracing channel subscribers. */
export type TracingSetup = {
	enter(ctx: object, name: string, options: StartSpanOptions): void
	finishOk(ctx: object): void
	finishError(ctx: object & { error?: unknown }): void
	noop(): void
	base: Record<string, string | number | boolean>
}

type SpanState = { span: Span; parentSpan: Span | undefined }

/**
 * Builds a TracingSetup bound to the given tracer and base attributes.
 * Each instance has its own WeakMap so concurrent register() calls never
 * collide even when they receive the same ctx object from the channel.
 */
export function createTracingSetup(
	tracer: Tracer,
	base: Record<string, string | number | boolean>
): TracingSetup {
	let stateMap = new WeakMap<object, SpanState>()

	function startChild(name: string, options: StartSpanOptions): Span {
		let parent = spanStorage.getStore()
		return parent !== undefined
			? parent.runInContext(() => tracer.startSpan(name, options))
			: tracer.startSpan(name, options)
	}

	return {
		base,

		enter(ctx, name, options) {
			let parentSpan = spanStorage.getStore()
			let span = startChild(name, options)
			stateMap.set(ctx, { span, parentSpan })
			spanStorage.enterWith(span)
		},

		finishOk(ctx) {
			let state = stateMap.get(ctx)
			if (state) {
				state.span.end()
				stateMap.delete(ctx)
				spanStorage.enterWith(state.parentSpan)
			}
		},

		finishError(ctx) {
			let state = stateMap.get(ctx)
			if (state) {
				let errAttrs = recordErrorAttributes(ctx.error)
				state.span.setAttributes(errAttrs)
				state.span.recordException(
					ctx.error instanceof Error ? ctx.error : new Error(String(ctx.error))
				)
				state.span.setStatus({ code: 2 })
				state.span.end()
				stateMap.delete(ctx)
				spanStorage.enterWith(state.parentSpan)
			}
		},

		noop() {},
	}
}
