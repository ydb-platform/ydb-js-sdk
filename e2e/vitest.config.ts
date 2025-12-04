import { defineProject } from 'vitest/config'

export default defineProject({
	test: {
		name: 'e2e',
		include: ['**/*.test.ts'],
		environment: 'node',
		globalSetup: '../vitest.setup.ydb.ts',
		testTimeout: 60000,
		hookTimeout: 30000,
		benchmark: {
			include: ['**/*.bench.ts'],
		},
	},
})
