import type { Metadata, RpcStatus } from './types.js'

export enum Status {
	OK = 0,
	CANCELLED = 1,
	UNKNOWN = 2,
	INVALID_ARGUMENT = 3,
	DEADLINE_EXCEEDED = 4,
	NOT_FOUND = 5,
	ALREADY_EXISTS = 6,
	PERMISSION_DENIED = 7,
	RESOURCE_EXHAUSTED = 8,
	FAILED_PRECONDITION = 9,
	ABORTED = 10,
	OUT_OF_RANGE = 11,
	UNIMPLEMENTED = 12,
	INTERNAL = 13,
	UNAVAILABLE = 14,
	DATA_LOSS = 15,
	UNAUTHENTICATED = 16,
}

export class RpcError extends Error implements RpcStatus {
	readonly code: number
	readonly details: string
	readonly metadata: Metadata

	constructor(code: number, details: string, metadata: Metadata = {}, options?: ErrorOptions) {
		super(details, options)
		this.name = 'RpcError'
		this.code = code
		this.details = details
		this.metadata = metadata
	}
}

export class MessageSizeError extends RpcError {
	readonly direction: 'request' | 'response'
	readonly limit: number

	constructor(direction: 'request' | 'response', limit: number, options?: ErrorOptions) {
		super(Status.RESOURCE_EXHAUSTED, `${direction} message exceeds ${limit} bytes`, {}, options)
		this.name = 'MessageSizeError'
		this.direction = direction
		this.limit = limit
	}
}
