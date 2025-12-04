import { defineProject } from 'vitest/config'

export default defineProject({
	test: {
		name: 'abortable',
		include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
		environment: 'node',
	},
})
