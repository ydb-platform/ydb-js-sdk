import { defineConfig } from 'vitest/config'

let results = process.env.GRPC_TEST_RESULTS
if (!results) throw new Error('GRPC_TEST_RESULTS must name the JSON report file')

export default defineConfig({
	resolve: {
		conditions: ['development'],
	},
	test: {
		name: 'grpc',
		include: ['packages/grpc/src/**/*.test.ts', 'packages/grpc/interop/interop.test.ts'],
		environment: 'node',
		setupFiles: ['./vitest.setup.polyfills.ts', './vitest.setup.grpc-runtime.ts'],
		execArgv: ['--expose-gc'],
		fileParallelism: false,
		maxWorkers: 1,
		passWithNoTests: false,
		reporters: ['default', 'json'],
		outputFile: {
			json: results,
		},
	},
})
