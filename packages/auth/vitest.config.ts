import { defineProject } from 'vitest/config'

export default defineProject({
	test: {
		name: 'auth',
		include: ['src/**/*.test.ts'],
		environment: 'node',
	},
})
