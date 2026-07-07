import { defineConfig } from 'vitest/config'

// Every packages/* package.json "exports" carries a "development" condition
// pointing at its src/**.ts (see AGENTS.md); resolving with that condition
// makes @ydbjs/* imports hit source directly instead of ./dist/**.js, so
// tests run against live edits and v8 coverage attributes back to src/**.ts.
export default defineConfig({
	resolve: {
		conditions: ['development'],
	},
	test: {
		execArgv: ['--expose-gc'],
		vmMemoryLimit: '300Mb',
		projects: [
			{
				resolve: {
					conditions: ['development'],
				},
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
				resolve: {
					conditions: ['development'],
				},
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
					testTimeout: 60000,
					hookTimeout: 30000,
					benchmark: {
						include: [
							'packages/*/tests/**/*.bench.ts',
							'third-parties/*/tests/**/*.bench.ts',
						],
					},
				},
			},
			{
				resolve: {
					conditions: ['development'],
				},
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
			provider: 'v8',
			reporter: ['text', 'lcov'],
			reportsDirectory: './coverage',
			include: ['packages/*/src/**/*.ts', 'third-parties/*/src/**/*.ts'],
			exclude: [
				'packages/api/**',
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
