import { defineProject } from 'vitest/config'

export default defineProject({
	test: {
		name: 'tracing',
		include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
		environment: 'node',
	},
})
