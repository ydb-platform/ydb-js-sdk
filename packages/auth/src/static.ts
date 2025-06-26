import * as tls from 'node:tls'

import { anyUnpack } from '@bufbuild/protobuf/wkt'
import { type ChannelOptions, credentials } from '@grpc/grpc-js'
import { AuthServiceDefinition, LoginResultSchema } from '@ydbjs/api/auth'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
import { defaultRetryConfig, retry } from '@ydbjs/retry'
import { type Client, ClientError, Status, createChannel, createClient } from 'nice-grpc'

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

/**
 * A credentials provider that uses static username and password to authenticate.
 * It fetches and caches a token from the specified authentication service.
 *
 * @extends CredentialsProvider
 */
export class StaticCredentialsProvider extends CredentialsProvider {
	#client: Client<typeof AuthServiceDefinition>
	#promise: Promise<string> | null = null

	#token: StaticCredentialsToken | null = null
	#username: string
	#password: string

	constructor(
		{ username, password }: StaticCredentials,
		endpoint: string,
		secureOptions?: tls.SecureContextOptions | undefined,
		channelOptions?: ChannelOptions
	) {
		super()
		this.#username = username
		this.#password = password

		let cs = new URL(endpoint)

		if (['unix:', 'http:', 'https:', 'grpc:', 'grpcs:'].includes(cs.protocol) === false) {
			throw new Error('Invalid connection string protocol. Must be one of unix, grpc, grpcs, http, https')
		}

		let address = `${cs.protocol}//${cs.host}${cs.pathname}`

		let channelCredentials = secureOptions ?
			credentials.createFromSecureContext(tls.createSecureContext(secureOptions)) :
			credentials.createInsecure()

		this.#client = createClient(AuthServiceDefinition, createChannel(address, channelCredentials, channelOptions))
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

		this.#promise = retry({ ...defaultRetryConfig, signal, idempotent: true }, async () => {
			let response = await this.#client.login({ user: this.#username, password: this.#password }, { signal })
			if (!response.operation) {
				throw new ClientError(AuthServiceDefinition.login.path, Status.UNKNOWN, 'No operation in response')
			}

			if (response.operation.status !== StatusIds_StatusCode.SUCCESS) {
				throw new YDBError(response.operation.status, response.operation.issues)
			}

			let result = anyUnpack(response.operation.result!, LoginResultSchema)
			if (!result) {
				throw new ClientError(AuthServiceDefinition.login.path, Status.UNKNOWN, 'No result in operation')
			}

			// The result.token is a JWT in the format header.payload.signature.
			// We attempt to decode the payload to extract token metadata (aud, exp, iat, sub).
			// If the token is not in the expected format, we fallback to default values.
			let [header, payload, signature] = result.token.split('.')
			if (header && payload && signature) {
				let decodedPayload = JSON.parse(Buffer.from(payload, 'base64').toString())

				this.#token = {
					value: result.token,
					...decodedPayload,
				}
			} else {
				this.#token = {
					value: result.token,
					aud: [],
					exp: Math.floor(Date.now() / 1000) + 5 * 60, // fallback: 5 minutes from now
					iat: Math.floor(Date.now() / 1000),
					sub: '',
				}
			}

			return this.#token!.value!
		}).finally(() => {
			this.#promise = null
		})

		return this.#promise
	}
}
