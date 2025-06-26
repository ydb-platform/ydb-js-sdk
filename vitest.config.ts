import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'uni',
					include: ['packages/*/src/**/*.test.ts'],
					environment: 'node',
				},
			},
			{
				test: {
					name: 'int',
					include: ['packages/*/tests/**/*.test.ts'],
					environment: 'node',
					globalSetup: './vitest.setup.ydb.ts',
				},
			},
			{
				test: {
					name: 'e2e',
					include: ['e2e/**/*.test.ts'],
					environment: 'node',
					globalSetup: './vitest.setup.ydb.ts',
					testTimeout: 60000,
					hookTimeout: 30000,
				},
			},
		],
		passWithNoTests: true,
	},
})
