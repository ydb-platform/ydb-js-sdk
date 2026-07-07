// `Promise.withResolvers` landed in Node 22; on Node 20 it is missing.
// At runtime the SDK polyfills it in @ydbjs/core (loaded whenever a Driver is
// constructed), but unit/contract tests exercise code with a fake driver and
// only a type-only `import type { Driver }`, so that side-effect never runs.
// Install the polyfill for the test runtime here instead of in library code.
if (typeof Promise.withResolvers !== 'function') {
	// @ts-expect-error assigning the polyfill onto the PromiseConstructor
	Promise.withResolvers = function withResolvers<T>(): PromiseWithResolvers<T> {
		let resolve!: (value: T | PromiseLike<T>) => void
		let reject!: (reason?: unknown) => void
		let promise = new Promise<T>((res, rej) => {
			resolve = res
			reject = rej
		})
		return { promise, resolve, reject }
	}
}
