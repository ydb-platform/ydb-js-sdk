import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		execArgv: ['--expose-gc'],
		vmMemoryLimit: '300Mb',
		projects: [
			{
				test: {
					name: {
						label: 'uni',
						color: 'yellow',
					},
					include: ['packages/*/src/**/*.test.ts', 'third-parties/*/src/**/*.test.ts'],
					environment: 'node',
					execArgv: ['--expose-gc'],
					benchmark: {
						include: [
							'packages/*/src/**/*.bench.ts',
							'third-parties/*/src/**/*.bench.ts',
						],
					},
				},
			},
			{
				test: {
					name: {
						label: 'int',
						color: 'blue',
					},
					include: [
						'packages/*/tests/**/*.test.ts',
						'third-parties/*/tests/**/*.test.ts',
					],
					environment: 'node',
					execArgv: ['--expose-gc'],
					globalSetup: './vitest.setup.ydb.ts',
					benchmark: {
						include: [
							'packages/*/tests/**/*.bench.ts',
							'third-parties/*/tests/**/*.bench.ts',
						],
					},
				},
			},
			{
				test: {
					name: {
						label: 'e2e',
						color: 'magenta',
					},
					include: ['e2e/**/*.test.ts'],
					environment: 'node',
					globalSetup: './vitest.setup.ydb.ts',
					testTimeout: 60000,
					hookTimeout: 30000,
					maxConcurrency: 1,
					benchmark: {
						include: ['e2e/**/*.bench.ts'],
					},
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
			],
		},
	},
})
