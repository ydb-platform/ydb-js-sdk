/**
 * Detects the current JavaScript runtime and returns formatted user agent string
 */
export const detectRuntime = function detectRuntime(): string {
	let runtime: string
	let version: string

	/* node:coverage ignore start -- non-Node runtimes can't execute under the Node test leg */
	if (typeof (globalThis as any).Deno !== 'undefined') {
		runtime = 'deno'
		version = (globalThis as any).Deno.version.deno
	} else if (typeof (globalThis as any).Bun !== 'undefined') {
		runtime = 'bun'
		version = (globalThis as any).Bun.version
	} else {
		/* node:coverage ignore stop */
		runtime = 'node'
		version = process.versions.node
	}

	let platform = `${process.platform}-${process.arch}`
	return `${runtime}/${version} (${platform})`
}
