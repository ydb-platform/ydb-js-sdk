export { Client } from './client.js'
export { createDeadline, type Deadline } from './deadline.js'
export { MessageSizeError, RpcError, Status } from './error.js'
export type {
	CallOptions,
	ClientOptions,
	Metadata,
	MetadataValue,
	MethodDefinition,
	RpcStatus,
	ServiceClient,
	ServiceDefinition,
	Transport,
} from './types.js'

export { createServiceClient } from './service.js'
