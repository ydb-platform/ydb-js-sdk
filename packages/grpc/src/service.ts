import { RpcError, Status } from './error.js'
import type { CallOptions, ServiceClient, ServiceDefinition, Transport } from './types.js'

async function unary<Response>(responses: AsyncIterable<Response>): Promise<Response> {
	let received = false
	let result: Response | undefined
	for await (let response of responses) {
		if (received) {
			throw new RpcError(Status.INTERNAL, 'Received multiple responses for a unary call')
		}
		received = true
		result = response
	}
	if (!received) {
		throw new RpcError(Status.INTERNAL, 'Missing unary response')
	}

	return result as Response
}

export function createServiceClient<Service extends ServiceDefinition>(
	service: Service,
	transport: Transport
): ServiceClient<Service> {
	if (Object.hasOwn(service, 'close')) {
		throw new TypeError('Service method "close" conflicts with the client lifecycle method')
	}

	let client: Record<string, unknown> = { close: () => transport.close() }
	for (let [name, method] of Object.entries(service)) {
		client[name] = (request: unknown, options?: CallOptions) => {
			let responses = transport.call(method, request, options)
			return method.responseStream ? responses : unary(responses)
		}
	}

	return client as ServiceClient<Service>
}
