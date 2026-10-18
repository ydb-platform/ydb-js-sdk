import { expectTypeOf } from 'vitest'

import { Server } from '../src/server.js'
import type {
	Metadata,
	ServerContext,
	ServiceDefinition,
	ServiceImplementation,
} from '../src/types.js'

type RequestInput = { value?: number }
type Request = { value: number }
type ResponseInput = { result?: string }
type Response = { result: string }

let codecs = {
	requestSerialize(_request: RequestInput): Uint8Array {
		return new Uint8Array()
	},
	requestDeserialize(_bytes: Uint8Array): Request {
		return { value: 0 }
	},
	responseSerialize(_response: ResponseInput): Uint8Array {
		return new Uint8Array()
	},
	responseDeserialize(_bytes: Uint8Array): Response {
		return { result: '' }
	},
}
let definition = {
	unary: { ...codecs, path: '/test.Service/Unary', requestStream: false, responseStream: false },
	read: { ...codecs, path: '/test.Service/Read', requestStream: false, responseStream: true },
	write: { ...codecs, path: '/test.Service/Write', requestStream: true, responseStream: false },
	bidi: { ...codecs, path: '/test.Service/Bidi', requestStream: true, responseStream: true },
} satisfies ServiceDefinition

declare let server: Server
let implementation: ServiceImplementation<typeof definition> = {
	unary(request, context) {
		expectTypeOf(request).toEqualTypeOf<Request>()
		expectTypeOf(context).toEqualTypeOf<ServerContext>()
		expectTypeOf(context.metadata).toEqualTypeOf<Metadata>()
		expectTypeOf(context.signal).toEqualTypeOf<AbortSignal>()
		expectTypeOf(context.deadline).toEqualTypeOf<number | undefined>()
		expectTypeOf(context.peer).toEqualTypeOf<string>()
		context.sendHeader({ 'x-header': 'ready' })
		context.setTrailer({ 'x-data-bin': new Uint8Array([1, 2]) })
		return {}
	},
	async *read(request) {
		expectTypeOf(request).toEqualTypeOf<Request>()
		yield {}
		yield { result: String(request.value) }
	},
	async write(requests) {
		expectTypeOf(requests).toEqualTypeOf<AsyncIterable<Request>>()
		for await (let request of requests) {
			expectTypeOf(request).toEqualTypeOf<Request>()
		}
		return {}
	},
	async *bidi(requests) {
		expectTypeOf(requests).toEqualTypeOf<AsyncIterable<Request>>()
		for await (let request of requests) {
			yield { result: String(request.value) }
		}
	},
}
server.add(definition, implementation)
server.add(definition, { unary: async () => ({ result: 'accepted' }) })
expectTypeOf(server.listen()).toEqualTypeOf<Promise<number>>()
expectTypeOf(server.close()).toEqualTypeOf<Promise<void>>()
expectTypeOf(server.destroy()).toEqualTypeOf<void>()
expectTypeOf(server[Symbol.dispose]()).toEqualTypeOf<void>()

// @ts-expect-error Server disposal is synchronous; graceful shutdown uses close().
server[Symbol.asyncDispose]()

// @ts-expect-error Service definitions must not permit arbitrary handler names.
server.add(definition, { unknown: () => ({}) })
server.add(definition, {
	// @ts-expect-error Unary handlers return a response, not a response stream.
	unary: async function* () {
		yield {}
	},
})
// @ts-expect-error Server-streaming handlers return an iterable, not a Promise response.
server.add(definition, { read: async () => ({ result: 'wrong shape' }) })
// @ts-expect-error Client-streaming handlers consume an iterable of requests.
server.add(definition, { write: (request: Request) => ({ result: String(request.value) }) })
// @ts-expect-error Responses must match the response serializer input.
server.add(definition, { unary: () => ({ result: 42 }) })
server.add(definition, {
	// @ts-expect-error Bidirectional handlers yield response messages.
	bidi: async function* () {
		yield { result: 42 }
	},
})

declare let context: ServerContext
// @ts-expect-error Request metadata is read-only.
context.metadata['x-request'] = 'changed'
// @ts-expect-error The transport owns the call cancellation signal.
context.signal = new AbortController().signal
