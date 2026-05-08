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
					include: ['tests/unit/**/*.test.ts'],
					environment: 'node',
				},
			},
			{
				test: {
					name: {
						label: 'int',
						color: 'blue',
					},
					include: ['tests/live/**/*.test.ts'],
					environment: 'node',
					globalSetup: '../../vitest.setup.ydb.ts',
					testTimeout: 60000,
					hookTimeout: 30000,
					maxConcurrency: 1,
				},
			},
		],
	},
})
