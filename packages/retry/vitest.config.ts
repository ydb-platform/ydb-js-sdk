import { defineProject } from 'vitest/config'

export default defineProject({
	test: {
		name: 'retry',
		include: ['src/**/*.test.ts'],
		environment: 'node',
	},
})
