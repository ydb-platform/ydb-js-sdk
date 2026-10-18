import type { ConnectionOptions } from 'node:tls'

export type MetadataValue = string | Uint8Array
export type Metadata = Readonly<Record<string, MetadataValue | readonly MetadataValue[]>>

export interface MethodDefinition<RequestMessage = any, ResponseMessage = any> {
	path: string
	requestStream: boolean
	responseStream: boolean
	requestSerialize(request: RequestMessage): Uint8Array
	responseDeserialize(bytes: Uint8Array): ResponseMessage
	requestDeserialize?: (bytes: Uint8Array) => RequestMessage
	responseSerialize?: (response: ResponseMessage) => Uint8Array
}

export type ServiceDefinition = Record<string, MethodDefinition>

export interface RpcStatus {
	code: number
	details: string
	metadata: Metadata
}

export interface CallOptions {
	signal?: AbortSignal
	deadline?: number | Date
	metadata?: Metadata
	onHeader?: (metadata: Metadata) => void
	onTrailer?: (metadata: Metadata) => void
	onStatus?: (status: RpcStatus) => void
}

export interface ClientOptions {
	tls?: ConnectionOptions
	maxSendBytes?: number
	maxReceiveBytes?: number
	connectTimeoutMs?: number
	keepaliveIntervalMs?: number
	keepaliveTimeoutMs?: number
	connectionWindowBytes?: number
	streamWindowBytes?: number
	userAgent?: string
}

export interface Transport {
	call<RequestMessage, ResponseMessage>(
		method: MethodDefinition<RequestMessage, ResponseMessage>,
		input: RequestMessage | AsyncIterable<RequestMessage>,
		options?: CallOptions
	): AsyncIterable<ResponseMessage>
	close(): void
}

type RequestOf<Method extends MethodDefinition> = Parameters<Method['requestSerialize']>[0]
type ResponseOf<Method extends MethodDefinition> = ReturnType<Method['responseDeserialize']>

export type ServiceClient<Service extends ServiceDefinition> = Pick<Transport, 'close'> & {
	[Method in keyof Service as string extends Method ? never : Method]: (
		request: Service[Method]['requestStream'] extends true
			? AsyncIterable<RequestOf<Service[Method]>>
			: RequestOf<Service[Method]>,
		options?: CallOptions
	) => Service[Method]['responseStream'] extends true
		? AsyncIterable<ResponseOf<Service[Method]>>
		: Promise<ResponseOf<Service[Method]>>
}
