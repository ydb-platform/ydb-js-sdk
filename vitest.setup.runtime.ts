let expectedRuntime = process.env.TEST_RUNTIME
let runtime = process.versions.bun ? 'bun' : 'node'

if (expectedRuntime && runtime !== expectedRuntime) {
	throw new Error(`Expected ${expectedRuntime} worker, got ${runtime}`)
}
