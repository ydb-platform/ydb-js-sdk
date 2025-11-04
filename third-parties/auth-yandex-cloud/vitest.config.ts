import { defineProject } from 'vitest/config'

export default defineProject({
	test: {
		name: 'auth-yandex-cloud',
		include: ['src/**/*.test.ts'],
		environment: 'node',
	},
})
