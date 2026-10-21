import { expect, test } from 'vitest'

import { Client } from './client.ts'

for (let key of ['connectTimeoutMs', 'keepaliveIntervalMs', 'keepaliveTimeoutMs'] as const) {
	for (let value of [2147483648, 30 * 24 * 60 * 60 * 1000]) {
		test(`rejects ${key} above the Node timer limit: ${value}`, () => {
			expect(() => new Client('http://127.0.0.1:2135', { [key]: value })).toThrow(RangeError)
		})
	}

	for (let value of [0, 2147483647]) {
		test(`accepts ${key} at the timer boundary: ${value}`, () => {
			using client = new Client('http://127.0.0.1:2135', { [key]: value })

			expect(client.state).toBe('idle')
		})
	}
}

for (let key of ['maxSendBytes', 'maxReceiveBytes'] as const) {
	test(`accepts ${key} above the timer limit`, () => {
		using client = new Client('http://127.0.0.1:2135', { [key]: 2147483648 })

		expect(client.state).toBe('idle')
	})
}
