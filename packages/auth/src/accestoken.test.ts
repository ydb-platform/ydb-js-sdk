import { expect, test } from 'vitest'

import { AccessTokenCredentialsProvider } from './access-token.ts'

test('parses valid token', async () => {
	let provider = new AccessTokenCredentialsProvider({ token: 'test-token' })
	let token = await provider.getToken()
	expect(token).eq('test-token')
})
