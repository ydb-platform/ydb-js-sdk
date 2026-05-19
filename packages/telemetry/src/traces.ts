import { channel as plainChannel, tracingChannel } from 'node:diagnostics_channel'

import {
	type DiagLogger,
	type Span,
	SpanStatusCode,
	type Tracer,
	context,
	trace,
} from '@opentelemetry/api'

import type { DriverIdentity } from '@ydbjs/core'

import {
	EVENT_CHANNELS,
	type EventChannelEntry,
	type TracingChannelEntry,
	buildTracingChannels,
} from './channels.js'
import { getActiveSubscriberSpan, spanStorage } from './context.js'
import {
	BASE_ATTRIBUTES,
	coerceError,
	identityAttrs,
	recordErrorAttributes,
} from './semconv/index.js'

export type YdbTracesPipelineOptions = {
	captureQueryText: boolean
	emitAcquireSessionSpan: boolean
}

type SpanState = { span: Span }

export class YdbTracesPipeline {
	#tracer: Tracer
	#diag: DiagLogger
	#opts: YdbTracesPipelineOptions
	#subs: Disposable[] = []
	#stateMap: WeakMap<object, SpanState> = new WeakMap()

	constructor(tracer: Tracer, diag: DiagLogger, opts: YdbTracesPipelineOptions) {
		this.#tracer = tracer
		this.#diag = diag
		this.#opts = opts
	}

	enable(): void {
		if (this.#subs.length > 0) return

		let table = buildTracingChannels({
			captureQueryText: this.#opts.captureQueryText,
			emitAcquireSessionSpan: this.#opts.emitAcquireSessionSpan,
		})

		for (let entry of table) this.#subs.push(this.#subscribeTracing(entry))
		for (let entry of EVENT_CHANNELS) this.#subs.push(this.#subscribeEvent(entry))
	}

	disable(): void {
		for (let s of this.#subs) s[Symbol.dispose]()
		this.#subs.length = 0
	}

	#subscribeTracing(entry: TracingChannelEntry): Disposable {
		// StoreType=Span | undefined matches spanStorage; ContextType=object is
		// the payload shape (each row's lambda narrows it).
		let ch = tracingChannel<Span | undefined, object>(entry.channel)

		// Skip `end` (it fires on callback return — too early for async fns,
		// which would close the span before the awaited work runs) and
		// `asyncStart` (no trace-relevant signal). `asyncEnd` runs after
		// `error` as well, but `#finish` is a no-op the second time because
		// the WeakMap entry is already gone.
		//
		// When `#safeCreateSpan` swallows a span-creation error, bindStore
		// stores `undefined`; children fall back to `context.active()` via
		// `getActiveSubscriberSpan`. No cast needed — the ALS type allows it.
		ch.start.bindStore(spanStorage, (ctx) => this.#safeCreateSpan(entry, ctx))

		// @types/node declares the start/end/asyncStart fields as required even
		// though `subscribe` accepts a partial set at runtime — we only need
		// `asyncEnd` and `error`, so we type the literal as Partial and open
		// it to the full shape at the boundary.
		type Subs = Parameters<typeof ch.subscribe>[0]
		let handlers: Partial<Subs> = {
			asyncEnd: (ctx) => {
				try {
					this.#finish(ctx, undefined)
				} catch (err) {
					this.#diag.error(`telemetry asyncEnd in ${entry.channel}`, err as Error)
				}
			},
			error: (ctx) => {
				try {
					this.#finish(ctx, ctx.error)
				} catch (err) {
					this.#diag.error(`telemetry error in ${entry.channel}`, err as Error)
				}
			},
		}

		ch.subscribe(handlers as Subs)

		return {
			[Symbol.dispose]() {
				ch.unsubscribe(handlers as Subs)
				ch.start.unbindStore(spanStorage)
			},
		}
	}

	#subscribeEvent(entry: EventChannelEntry): Disposable {
		let ch = plainChannel(entry.channel)
		let diag = this.#diag

		let fn = (msg: unknown) => {
			try {
				let span = getActiveSubscriberSpan()
				if (span) entry.apply(msg as never, span)
			} catch (err) {
				diag.error(`telemetry event in ${entry.channel}`, err as Error)
			}
		}

		ch.subscribe(fn)

		return {
			[Symbol.dispose]() {
				ch.unsubscribe(fn)
			},
		}
	}

	// Swallows errors from #createSpan so a thrown attribute hook can't poison
	// the parent ALS scope — children just see the prior active span.
	#safeCreateSpan(entry: TracingChannelEntry, ctx: object): Span | undefined {
		try {
			return this.#createSpan(entry, ctx)
		} catch (err) {
			this.#diag.error(`telemetry start in ${entry.channel}`, err as Error)
			return undefined
		}
	}

	#createSpan(entry: TracingChannelEntry, ctx: object): Span {
		// Identity rides in the payload, not in ALS — that's what makes
		// multi-driver attribution work without producers having to wrap their
		// own entry points in any subscriber context.
		let identity = (ctx as { driver?: DriverIdentity }).driver
		let attrs = {
			...BASE_ATTRIBUTES,
			...identityAttrs(identity),
			...(entry.attrs ? entry.attrs(ctx as never) : {}),
		}

		let parentSpan = getActiveSubscriberSpan()
		let parentCtx = parentSpan ? trace.setSpan(context.active(), parentSpan) : context.active()

		let span = this.#tracer.startSpan(
			entry.span,
			{ kind: entry.kind, attributes: attrs as never },
			parentCtx
		)

		this.#stateMap.set(ctx, { span })
		return span
	}

	#finish(ctx: object, error: unknown): void {
		let state = this.#stateMap.get(ctx)
		if (!state) return
		if (error !== undefined) {
			state.span.setAttributes(recordErrorAttributes(error))
			state.span.recordException(coerceError(error))
			state.span.setStatus({ code: SpanStatusCode.ERROR })
		}
		state.span.end()
		this.#stateMap.delete(ctx)
	}
}
