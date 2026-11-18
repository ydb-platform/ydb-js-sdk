import { defineConfig } from 'vitest/config'

// Use workspace sources without opting consumers into unpublished files
// when their tools enable the standard "development" condition.
export default defineConfig({
	resolve: {
		conditions: ['ydbjs-source', 'development'],
	},
	ssr: {
		resolve: { conditions: ['ydbjs-source', 'module', 'node', 'development'] },
	},
	test: {
		execArgv: ['--expose-gc'],
		vmMemoryLimit: '300Mb',
		projects: [
			{
				resolve: {
					conditions: ['ydbjs-source', 'development'],
				},
				ssr: {
					resolve: { conditions: ['ydbjs-source', 'module', 'node', 'development'] },
				},
				test: {
					name: {
						label: 'uni',
						color: 'yellow',
					},
					include: ['packages/*/src/**/*.test.ts', 'third-parties/*/src/**/*.test.ts'],
					environment: 'node',
					setupFiles: ['./vitest.setup.runtime.ts'],
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
					conditions: ['ydbjs-source', 'development'],
				},
				ssr: {
					resolve: { conditions: ['ydbjs-source', 'module', 'node', 'development'] },
				},
				test: {
					name: {
						label: 'int',
						color: 'blue',
					},
					include: [
						'packages/*/tests/**/*.test.ts',
						'third-parties/*/tests/**/*.test.ts',
						'packages/grpc/interop/**/*.test.ts',
					],
					environment: 'node',
					setupFiles: ['./vitest.setup.runtime.ts'],
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
					conditions: ['ydbjs-source', 'development'],
				},
				ssr: {
					resolve: { conditions: ['ydbjs-source', 'module', 'node', 'development'] },
				},
				test: {
					name: {
						label: 'e2e',
						color: 'magenta',
					},
					include: ['e2e/**/*.test.ts'],
					environment: 'node',
					setupFiles: ['./vitest.setup.runtime.ts'],
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
			reporter: ['text', 'lcovonly', 'html'],
			reportsDirectory: './coverage',
			include: ['packages/*/src/**/*.ts', 'third-parties/*/src/**/*.ts'],
			exclude: [
				'packages/api/src/gen/**',
				'**/coverage/**',
				'**/tests/**',
				'**/dist/**',
				'**/vitest.*',
				'**/*.test.ts',
				'**/*.bench.ts',
				// Test scaffolding — fakes/harnesses, not product code.
				'**/*.fixtures.ts',
			],
		},
	},
})
