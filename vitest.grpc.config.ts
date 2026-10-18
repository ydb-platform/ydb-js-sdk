import { defineConfig } from 'vitest/config'

export default defineConfig({
	resolve: {
		conditions: ['development'],
	},
	test: {
		name: 'grpc',
		include: ['packages/grpc/src/**/*.test.ts', 'packages/grpc/interop/interop.test.ts'],
		environment: 'node',
		setupFiles: ['./vitest.setup.polyfills.ts', './vitest.setup.runtime.ts'],
		execArgv: ['--expose-gc'],
		maxWorkers: 1,
	},
})
