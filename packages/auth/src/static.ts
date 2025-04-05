import { anyUnpack } from '@bufbuild/protobuf/wkt'
import { AuthServiceDefinition, LoginResultSchema } from '@ydbjs/api/auth'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { type Client, ClientError, type ClientFactory, Status, createChannel, createClientFactory } from 'nice-grpc'

import { CredentialsProvider } from './index.js'

export type StaticCredentialsToken = {
	value: string
	aud: string[]
	exp: number
	iat: number
	sub: string
}

export type StaticCredentials = {
	// TODO: support read from file
	// source: 'file' | 'inline'
	username: string
	password: string
}

export class StaticCredentialsProvider extends CredentialsProvider {
	#client: Client<typeof AuthServiceDefinition>
	#promise: Promise<string> | null = null

	#token: StaticCredentialsToken | null = null
	#username: string
	#password: string

	constructor(
		credentials: StaticCredentials,
		endpoint: string,
		clientFactory: ClientFactory = createClientFactory()
	) {
		super()
		this.#username = credentials.username
		this.#password = credentials.password

		let cs = new URL(endpoint.replace(/^grpc/, 'http'))
		this.#client = clientFactory.create(AuthServiceDefinition, createChannel(cs.origin))
	}

	/**
	 * Returns the token from the credentials.
	 * @param force - if true, forces a new token to be fetched
	 * @param signal - an optional AbortSignal to cancel the request
	 * @returns the token
	 */
	async getToken(force = false, signal?: AbortSignal): Promise<string> {
		if (!force && this.#token && this.#token.exp > Date.now() / 1000) {
			return this.#token.value
		}

		if (this.#promise) {
			return this.#promise
		}

		this.#promise = (async () => {
			let response = await this.#client.login(
				{
					user: this.#username,
					password: this.#password,
				},
				{ signal }
			)

			if (!response.operation) {
				throw new ClientError(AuthServiceDefinition.login.path, Status.UNKNOWN, 'No operation in response')
			}

			if (response.operation.status !== StatusIds_StatusCode.SUCCESS) {
				throw new Error(`(${response.operation.status}) ${JSON.stringify(response.operation.issues)}`)
			}

			let result = anyUnpack(response.operation.result!, LoginResultSchema)
			if (!result) {
				throw new ClientError(AuthServiceDefinition.login.path, Status.UNKNOWN, 'No result in operation')
			}

			// Parse the JWT token to extract expiration time
			const [, payload] = result.token.split('.')
			const decodedPayload = JSON.parse(Buffer.from(payload, 'base64').toString())

			this.#token = {
				value: result.token,
				...decodedPayload,
			}

			return this.#token!.value!
		})().finally(() => {
			this.#promise = null
		})

		return this.#promise
	}
}
