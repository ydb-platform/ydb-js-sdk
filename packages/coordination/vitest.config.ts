import { defineProject } from 'vitest/config'

export default defineProject({
	test: {
		projects: [
			{
				test: {
					name: {
						label: 'int',
						color: 'blue',
					},
					include: ['tests/**/*.test.ts'],
					environment: 'node',
					testTimeout: 30000,
					globalSetup: '../../vitest.setup.ydb.ts',
				},
			},
		],
	},
})
