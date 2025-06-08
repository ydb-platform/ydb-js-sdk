import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		projects: [
			'packages/*',
			'third-party/*',
			{
				extends: true,
				test: {
					name: 'e2e',
					include: ['**/*.e2e.test.ts'],
					globalSetup: './vitest.setup.e2e.js',
				},
			},
		],
		passWithNoTests: true,
	},
})
