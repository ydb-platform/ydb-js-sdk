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
					globalSetup: '../../vitest.setup.ydb.ts',
					benchmark: {
						include: ['./tests/**/*.bench.ts'],
					},
				},
			},
		],
	},
})
