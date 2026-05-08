import { channel, tracingChannel } from 'node:diagnostics_channel'

type AnyHandler = (ctx: any) => void

/** Subscribes to a plain diagnostics channel with an error-swallowing wrapper. */
export function safeSubscribe(name: string, fn: (msg: unknown) => void): () => void {
	let safe = (msg: unknown) => {
		try {
			fn(msg)
		} catch {}
	}
	let ch = channel(name)
	ch.subscribe(safe)
	return () => ch.unsubscribe(safe)
}

type SafeHandlers = {
	start?: AnyHandler | undefined
	end?: AnyHandler | undefined
	asyncStart?: AnyHandler | undefined
	asyncEnd?: AnyHandler | undefined
	error?: AnyHandler | undefined
}

/**
 * Subscribes to a diagnostics tracing channel with error-swallowing wrappers.
 * Handlers are wrapped in try/catch so telemetry bugs never affect the request path.
 */
export function safeTracingSubscribe<StoreType extends object>(
	channelName: string,
	handlers: SafeHandlers
): () => void {
	let ch = tracingChannel<StoreType>(channelName)

	let safe: SafeHandlers = {
		start: handlers.start
			? (ctx) => {
					try {
						handlers.start!(ctx)
					} catch {}
				}
			: undefined,
		end: handlers.end
			? (ctx) => {
					try {
						handlers.end!(ctx)
					} catch {}
				}
			: undefined,
		asyncStart: handlers.asyncStart
			? (ctx) => {
					try {
						handlers.asyncStart!(ctx)
					} catch {}
				}
			: undefined,
		asyncEnd: handlers.asyncEnd
			? (ctx) => {
					try {
						handlers.asyncEnd!(ctx)
					} catch {}
				}
			: undefined,
		error: handlers.error
			? (ctx) => {
					try {
						handlers.error!(ctx)
					} catch {}
				}
			: undefined,
	}

	let typedSafe = safe as Parameters<typeof ch.subscribe>[0]
	ch.subscribe(typedSafe)
	return () => ch.unsubscribe(typedSafe)
}
