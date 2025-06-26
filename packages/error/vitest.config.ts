import { defineProject } from 'vitest/config'

export default defineProject({
	test: {
		name: 'error',
		include: ['src/**/*.test.ts'],
		environment: 'node',
	},
})
