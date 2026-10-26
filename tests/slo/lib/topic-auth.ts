import type { MessageInitShape } from '@bufbuild/protobuf'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import {
	type StreamReadMessage_FromClientSchema,
	type StreamReadMessage_FromServer,
	type StreamWriteMessage_FromClientSchema,
	type StreamWriteMessage_FromServer,
	TopicServiceDefinition,
} from '@ydbjs/api/topic'
import { StaticCredentialsProvider } from '@ydbjs/auth/static'
import { getSecureOptionsFromEnviron } from '@ydbjs/auth/environ'
import { type ClientTarget, Driver, type DriverOptions } from '@ydbjs/core'
import type { ServiceClient, ServiceDefinition } from '@ydbjs/grpc'

export class TokenRenewal {
	updates = 0
	changes = 0
	#lastToken: string | undefined
	#firstExpiry = Infinity
	#lastResponse = 0

	sent(token: string, now = Date.now()): void {
		let expiry: number
		try {
			expiry =
				Number(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).exp) *
				1000
		} catch {
			throw new Error('Token renewal requires a JWT with an expiry')
		}

		if (!Number.isFinite(expiry) || expiry <= now || expiry - now > 10 * 60_000) {
			throw new Error('Token renewal requires valid tokens with at most 10 minutes remaining')
		}

		this.#firstExpiry = Math.min(this.#firstExpiry, expiry)
		this.#lastToken ??= token
	}

	acknowledge(token: string, now = Date.now()): void {
		this.sent(token, now)
		this.updates++

		if (this.#lastToken !== undefined && this.#lastToken !== token) {
			this.changes++
		}

		this.#lastToken = token
	}

	observe(now = Date.now()): void {
		this.#lastResponse = now
	}

	qualified(): boolean {
		return this.changes > 0 && this.#lastResponse >= this.#firstExpiry
	}
}

type TopicRequest =
	| MessageInitShape<typeof StreamReadMessage_FromClientSchema>
	| MessageInitShape<typeof StreamWriteMessage_FromClientSchema>
type TopicResponse = StreamReadMessage_FromServer | StreamWriteMessage_FromServer
type TopicClient = ServiceClient<typeof TopicServiceDefinition>

export function createTopicAuth(connectionString: string, enabled: boolean) {
	let streams = new Set<TokenRenewal>()
	let completed = { streams: 0, renewed: 0, updates: 0, changes: 0 }
	let options: DriverOptions = {}

	if (enabled) {
		let secureOptions = /^grpcs:|^https:/.test(connectionString)
			? getSecureOptionsFromEnviron()
			: undefined
		options = {
			secureOptions,
			credentialsProvider: new StaticCredentialsProvider(
				{ username: 'root', password: '' },
				connectionString,
				secureOptions
			),
		}
	}

	async function* observe<Request extends TopicRequest, Response extends TopicResponse>(
		input: AsyncIterable<Request>,
		call: (requests: AsyncIterable<Request>) => AsyncIterable<Response>
	): AsyncGenerator<Response> {
		let renewal = new TokenRenewal()
		streams.add(renewal)
		let pendingToken: string | undefined

		async function* requests() {
			for await (let request of input) {
				if (request.clientMessage?.case === 'updateTokenRequest') {
					pendingToken = request.clientMessage.value.token
					if (!pendingToken) {
						throw new Error('Token renewal requires a non-empty token')
					}
					renewal.sent(pendingToken)
				}
				yield request
			}
		}

		try {
			for await (let response of call(requests())) {
				if (response.status === StatusIds_StatusCode.SUCCESS) {
					if (
						response.serverMessage.case === 'readResponse' ||
						response.serverMessage.case === 'writeResponse'
					) {
						renewal.observe()
					}
					if (response.serverMessage.case === 'updateTokenResponse') {
						if (!pendingToken) {
							throw new Error('Token update acknowledged without a non-empty token')
						}
						renewal.acknowledge(pendingToken)
						pendingToken = undefined
					}
				}
				yield response
			}
		} finally {
			completed.streams++
			completed.renewed += Number(renewal.qualified())
			completed.updates += renewal.updates
			completed.changes += renewal.changes
			streams.delete(renewal)
		}
	}

	class TopicAuthDriver extends Driver {
		override createClient<Service extends ServiceDefinition>(
			service: Service,
			target?: bigint | ClientTarget
		): ServiceClient<Service> {
			if (!enabled || !Object.is(service, TopicServiceDefinition)) {
				return super.createClient(service, target)
			}

			let client = super.createClient(TopicServiceDefinition, target)
			let observed: TopicClient = {
				...client,
				streamRead: (requests, callOptions) =>
					observe(requests, (input) => client.streamRead(input, callOptions)),
				streamWrite: (requests, callOptions) =>
					observe(requests, (input) => client.streamWrite(input, callOptions)),
			}
			return observed as ServiceClient<Service>
		}
	}

	return {
		createDriver(driverOptions: DriverOptions = {}): Driver {
			return new TopicAuthDriver(connectionString, { ...options, ...driverOptions })
		},
		finish() {
			if (!enabled) {
				return undefined
			}

			let result = { ...completed }
			for (let stream of streams) {
				result.streams++
				result.renewed += Number(stream.qualified())
				result.updates += stream.updates
				result.changes += stream.changes
			}
			if (result.renewed === 0) {
				throw new Error(
					`No stream accepted a changed token and continued past the old token expiry: ${JSON.stringify(result)}`
				)
			}
			return result
		},
	}
}
