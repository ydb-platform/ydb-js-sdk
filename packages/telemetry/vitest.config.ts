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
					include: ['src/**/*.test.ts'],
					environment: 'node',
				},
			},
			{
				test: {
					name: {
						label: 'int',
						color: 'blue',
					},
					include: ['tests/**/*.test.ts'],
					environment: 'node',
					testTimeout: 30000,
					// leak.test.ts uses global.gc() to verify WeakRef reclamation.
					execArgv: ['--expose-gc'],
				},
			},
		],
	},
})
