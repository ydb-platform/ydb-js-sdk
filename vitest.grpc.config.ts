import { defineConfig } from 'vitest/config'

export default defineConfig({
	resolve: {
		conditions: ['ydbjs-source', 'development'],
	},
	ssr: {
		resolve: { conditions: ['ydbjs-source', 'module', 'node', 'development'] },
	},
	test: {
		name: 'grpc',
		include: ['packages/grpc/src/**/*.test.ts', 'packages/grpc/interop/interop.test.ts'],
		environment: 'node',
		setupFiles: ['./vitest.setup.runtime.ts'],
		execArgv: ['--expose-gc'],
		maxWorkers: 1,
	},
})
