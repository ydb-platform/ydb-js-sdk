import { defineProject } from 'vitest/config'

export default defineProject({
	test: {
		projects: [
			{
				test: {
					name: {
						label: 'uni',
						color: 'yellow',
					},
					include: ['./src/**/*.test.ts'],
					environment: 'node',
					// The reader/writer lifecycle tests assert gc-reclaim via globalThis.gc —
					// mirror the root config so package-level runs do not fail spuriously.
					execArgv: ['--expose-gc'],
					benchmark: {
						include: ['./src/**/*.bench.ts'],
					},
				},
			},
			{
				test: {
					name: {
						label: 'int',
						color: 'blue',
					},
					include: ['./tests/**/*.test.ts'],
					environment: 'node',
					execArgv: ['--expose-gc'],
					testTimeout: 15000,
					globalSetup: '../../vitest.setup.ydb.ts',
					benchmark: {
						include: ['./tests/**/*.bench.ts'],
					},
				},
			},
		],
	},
})
