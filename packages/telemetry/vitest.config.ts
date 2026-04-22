import { defineProject } from 'vitest/config'

export default defineProject({
	test: {
		name: 'telemetry',
		include: ['src/**/*.test.ts'],
		environment: 'node',
	},
})
