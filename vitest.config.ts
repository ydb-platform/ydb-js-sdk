import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'uni',
					include: ['packages/*/src/**/*.test.ts'],
					environment: 'node',
					benchmark: {
						include: ['packages/*/src/**/*.bench.ts']
					}
				},
			},
			{
				test: {
					name: 'int',
					include: ['packages/*/tests/**/*.test.ts'],
					environment: 'node',
					globalSetup: './vitest.setup.ydb.ts',
					benchmark: {
						include: ['packages/*/tests/**/*.bench.ts'],
					},
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
					benchmark: {
						include: ['e2e/**/*.bench.ts']
					}
				},
			},
		],
		passWithNoTests: true,
		coverage: {
			exclude: [
				'packages/api/**',
				'examples/**',
				'**/coverage/**',
				'**/tests/**',
				'**/dist/**',
				'**/vitest.*',
				'**/*.test.ts',
				'**/*.bench.ts',
			]
		}
	},
})
