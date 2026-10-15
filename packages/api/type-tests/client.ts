import type { Metadata, MethodDefinition, ServiceDefinition } from '@grpc/grpc-js'
import { expectTypeOf } from 'vitest'

import type { ClientCallOptions, ServiceClient } from '../src/client.js'

type Request = { value: number }
type Response = { result: string }

interface Methods extends ServiceDefinition {
	unary: MethodDefinition<Request, Response> & { requestStream: false; responseStream: false }
	read: MethodDefinition<Request, Response> & { requestStream: false; responseStream: true }
	write: MethodDefinition<Request, Response> & { requestStream: true; responseStream: false }
	bidi: MethodDefinition<Request, Response> & { requestStream: true; responseStream: true }
}

declare let client: ServiceClient<Methods>
declare let input: AsyncIterable<Request>
declare let metadata: Metadata
let options: ClientCallOptions = { metadata, deadline: Date.now() + 1000 }
expectTypeOf(client.unary({ value: 1 }, options)).toEqualTypeOf<Promise<Response>>()
expectTypeOf(client.read({ value: 1 })).toEqualTypeOf<AsyncIterable<Response>>()
expectTypeOf(client.write(input)).toEqualTypeOf<Promise<Response>>()
expectTypeOf(client.bidi(input)).toEqualTypeOf<AsyncIterable<Response>>()
expectTypeOf(client.close()).toEqualTypeOf<void>()

// @ts-expect-error Service definitions must not permit arbitrary method names.
client.unknown({ value: 1 })
// @ts-expect-error Unary calls accept options, not native callbacks.
client.unary({ value: 1 }, () => {})
// @ts-expect-error Bidirectional calls require an iterable of request messages.
client.bidi({ value: 1 })
// @ts-expect-error Native callback methods are not part of the async client.
client.makeUnaryRequest()
// @ts-expect-error Native readiness callbacks are not part of the async client.
client.waitForReady()
