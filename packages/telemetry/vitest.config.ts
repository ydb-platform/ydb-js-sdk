import { defineProject } from 'vitest/config'

export default defineProject({
	test: {
		name: 'telemetry',
		include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
		environment: 'node',
	},
})
