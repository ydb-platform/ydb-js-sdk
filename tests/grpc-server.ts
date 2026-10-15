import { type EventEmitter, once } from 'node:events'
import { promisify } from 'node:util'

import {
	type Metadata,
	Server,
	ServerCredentials,
	type ServerErrorResponse,
	type ServerUnaryCall,
	type ServerWritableStream,
	type ServiceDefinition,
	type UntypedServiceImplementation,
	type sendUnaryData,
} from '@grpc/grpc-js'

interface CallContext {
	metadata: Metadata
	signal: AbortSignal
}

type Handlers<Service extends ServiceDefinition> = {
	[Method in keyof Service]?: Service[Method]['requestStream'] extends true
		? never
		: (
				request: ReturnType<Service[Method]['requestDeserialize']>,
				context: CallContext
			) => Service[Method]['responseStream'] extends true
				? AsyncIterable<Parameters<Service[Method]['responseSerialize']>[0]>
				:
						| Parameters<Service[Method]['responseSerialize']>[0]
						| Promise<Parameters<Service[Method]['responseSerialize']>[0]>
}

export function createTestServer() {
	let server = new Server()
	let shutdown = () => promisify(server.tryShutdown.bind(server))()

	return {
		add<Service extends ServiceDefinition>(
			service: Service,
			handlers: Handlers<Service>
		): void {
			let implementation: UntypedServiceImplementation = {}

			for (let [name, method] of Object.entries(service)) {
				let handler = handlers[name] as
					| ((request: unknown, context: CallContext) => unknown)
					| undefined
				if (!handler) {
					continue
				}
				if (method.requestStream) {
					throw new Error('Test server does not support request streams')
				}

				if (method.responseStream) {
					implementation[name] = async (call: ServerWritableStream<unknown, unknown>) => {
						using context = contextFor(call)
						try {
							let responses = handler(call.request, context) as AsyncIterable<unknown>
							for await (let response of responses) {
								context.signal.throwIfAborted()
								if (!call.write(response)) {
									await once(call, 'drain', { signal: context.signal })
								}
							}
							if (!context.signal.aborted) {
								call.end()
							}
						} catch (error) {
							if (!context.signal.aborted) {
								call.emit('error', rpcError(error))
							}
						}
					}
				} else {
					implementation[name] = async (
						call: ServerUnaryCall<unknown, unknown>,
						respond: sendUnaryData<unknown>
					) => {
						using context = contextFor(call)
						try {
							respond(null, await handler(call.request, context))
						} catch (error) {
							respond(rpcError(error))
						}
					}
				}
			}

			server.addService(service, implementation)
		},
		listen(
			address = '127.0.0.1:0',
			credentials = ServerCredentials.createInsecure()
		): Promise<number> {
			return promisify(server.bindAsync.bind(server))(address, credentials)
		},
		shutdown,
		[Symbol.asyncDispose]: shutdown,
	}
}

function contextFor(
	call: EventEmitter & { metadata: Metadata; cancelled: boolean }
): CallContext & Disposable {
	let controller = new AbortController()
	let onCancel = () => controller.abort()
	call.once('cancelled', onCancel)
	if (call.cancelled) {
		controller.abort()
	}

	return {
		metadata: call.metadata,
		signal: controller.signal,
		[Symbol.dispose]() {
			call.off('cancelled', onCancel)
		},
	}
}

function rpcError(error: unknown): ServerErrorResponse {
	return typeof error === 'object' && error !== null
		? (error as ServerErrorResponse)
		: new Error(String(error))
}
