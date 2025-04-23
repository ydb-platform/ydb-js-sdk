import { defineProject } from 'vitest/config'

export default defineProject({
	test: {
		exclude: ['**/*.e2e.test.ts'],
	},
})
