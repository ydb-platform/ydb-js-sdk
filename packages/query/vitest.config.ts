import { defineProject } from 'vitest/config'

export default defineProject({
	test: {
		name: 'query',
		include: ['src/**/*.test.ts'],
		environment: 'node',
	},
})
