import { defineProject } from 'vitest/config'

export default defineProject({
	test: {
		name: 'value',
		include: ['src/**/*.test.ts'],
		environment: 'node',
	},
})
