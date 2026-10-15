import {
	type CallOptions,
	type Client,
	Metadata,
	type MethodDefinition,
	type ServiceDefinition,
} from '@grpc/grpc-js'

import { readCall, unaryCall } from './stream.js'

export interface ClientCallOptions extends CallOptions {
	metadata?: Metadata
	signal?: AbortSignal
	onHeader?: (metadata: Metadata) => void
	onTrailer?: (metadata: Metadata) => void
}

type Request<Method extends MethodDefinition<any, any>> = Parameters<Method['requestSerialize']>[0]
type Response<Method extends MethodDefinition<any, any>> = ReturnType<Method['responseDeserialize']>

export type ServiceClient<Service extends ServiceDefinition> = Pick<Client, 'close'> & {
	[Method in keyof Service as string extends Method ? never : Method]: (
		request: Service[Method]['requestStream'] extends true
			? AsyncIterable<Request<Service[Method]>>
			: Request<Service[Method]>,
		options?: ClientCallOptions
	) => Service[Method]['responseStream'] extends true
		? AsyncIterable<Response<Service[Method]>>
		: Promise<Response<Service[Method]>>
}

export function createServiceClient<Service extends ServiceDefinition>(
	service: Service,
	nativeClient: Client
): ServiceClient<Service> {
	let client: Record<string, unknown> = {
		close: nativeClient.close.bind(nativeClient),
	}

	for (let [name, method] of Object.entries(service)) {
		let { path, requestSerialize, responseDeserialize } = method

		if (method.requestStream && method.responseStream) {
			client[name] = (input: AsyncIterable<unknown>, options: ClientCallOptions = {}) =>
				readCall(
					() =>
						nativeClient.makeBidiStreamRequest(
							path,
							requestSerialize,
							responseDeserialize,
							options.metadata ?? new Metadata(),
							options
						),
					options,
					input
				)
		} else if (method.requestStream) {
			client[name] = (input: AsyncIterable<unknown>, options: ClientCallOptions = {}) =>
				unaryCall(
					(callback) =>
						nativeClient.makeClientStreamRequest(
							path,
							requestSerialize,
							responseDeserialize,
							options.metadata ?? new Metadata(),
							options,
							callback
						),
					options,
					input
				)
		} else if (method.responseStream) {
			client[name] = (request: unknown, options: ClientCallOptions = {}) =>
				readCall(
					() =>
						nativeClient.makeServerStreamRequest(
							path,
							requestSerialize,
							responseDeserialize,
							request,
							options.metadata ?? new Metadata(),
							options
						),
					options
				)
		} else {
			client[name] = (request: unknown, options: ClientCallOptions = {}) =>
				unaryCall(
					(callback) =>
						nativeClient.makeUnaryRequest(
							path,
							requestSerialize,
							responseDeserialize,
							request,
							options.metadata ?? new Metadata(),
							options,
							callback
						),
					options
				)
		}
	}

	return client as ServiceClient<Service>
}
