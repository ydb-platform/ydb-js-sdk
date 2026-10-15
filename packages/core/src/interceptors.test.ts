import { InterceptingCall, type Interceptor } from '@grpc/grpc-js'
import { expect, test } from 'vitest'

import { addClientInterceptor, getRegisteredClientInterceptors } from './interceptors.ts'

test('appends an interceptor to the registry', () => {
	let before = getRegisteredClientInterceptors().length
	let interceptor: Interceptor = (options, nextCall) => new InterceptingCall(nextCall(options))

	using _ = addClientInterceptor(interceptor)

	expect(getRegisteredClientInterceptors()).toContain(interceptor)
	expect(getRegisteredClientInterceptors()).toHaveLength(before + 1)
})

test('removes an interceptor on disposal', () => {
	let before = getRegisteredClientInterceptors().length
	let interceptor: Interceptor = (options, nextCall) => new InterceptingCall(nextCall(options))
	let registration = addClientInterceptor(interceptor)

	registration[Symbol.dispose]()
	registration[Symbol.dispose]()

	expect(getRegisteredClientInterceptors()).not.toContain(interceptor)
	expect(getRegisteredClientInterceptors()).toHaveLength(before)
})
