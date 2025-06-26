import { defineProject } from 'vitest/config'

export default defineProject({
	test: {
		name: 'topic',
		include: ['src/**/*.test.ts'],
		environment: 'node',
	},
})
