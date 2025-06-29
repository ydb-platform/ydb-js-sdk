import * as tls from 'node:tls'

import { anyUnpack } from '@bufbuild/protobuf/wkt'
import { type ChannelOptions, credentials } from '@grpc/grpc-js'
import { AuthServiceDefinition, LoginResultSchema } from '@ydbjs/api/auth'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { YDBError } from '@ydbjs/error'
import { defaultRetryConfig, retry } from '@ydbjs/retry'
import { type Client, ClientError, Status, createChannel, createClient } from 'nice-grpc'
import createDebug from 'debug'

import { CredentialsProvider } from './index.js'

const debug = createDebug('ydbjs:auth:static')

// Token refresh strategy configuration
const ACQUIRE_TOKEN_TIMEOUT_MS = 5_000 // 5 seconds timeout for token acquisition
const HARD_EXPIRY_BUFFER_SECONDS = 30 // Hard limit - must refresh
const SOFT_EXPIRY_BUFFER_SECONDS = 120 // Soft limit - start background refresh
const BACKGROUND_REFRESH_TIMEOUT_MS = 30_000 // 30 seconds timeout for background refresh

export type StaticCredentialsToken = {
	value: string
	aud: string[]
	exp: number
	iat: number
	sub: string
}

export type StaticCredentials = {
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
	#username: string
	#password: string

	#token: StaticCredentialsToken | undefined = undefined
	#promise: Promise<string> | undefined = undefined
	#backgroundRefreshPromise: Promise<void> | undefined = undefined

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

		let address = cs.host
		// For unix sockets, keep the full URL
		if (cs.protocol === 'unix:') {
			address = `${cs.protocol}//${cs.host}${cs.pathname}`
		}

		let channelCredentials = secureOptions ? credentials.createFromSecureContext(tls.createSecureContext(secureOptions)) : credentials.createInsecure()
		this.#client = createClient(AuthServiceDefinition, createChannel(address, channelCredentials, channelOptions))
	}

	/**
	 * Returns the token from the credentials.
	 * @param force - if true, forces a new token to be fetched
	 * @param signal - an optional AbortSignal to cancel the request. Defaults to a timeout of 5 seconds.
	 * @returns the token
	 */
	async getToken(force = false, signal: AbortSignal = AbortSignal.timeout(ACQUIRE_TOKEN_TIMEOUT_MS)): Promise<string> {
		let currentTimeSeconds = Date.now() / 1000

		// If token is still valid (hard buffer), return it
		if (!force && this.#token && this.#token.exp > currentTimeSeconds + HARD_EXPIRY_BUFFER_SECONDS) {
			// Start background refresh if approaching soft expiry
			if (this.#token.exp <= currentTimeSeconds + SOFT_EXPIRY_BUFFER_SECONDS && !this.#promise && !this.#backgroundRefreshPromise) {
				// Fire and forget background refresh with timeout
				this.#backgroundRefreshPromise = this.#refreshTokenInBackground(signal).finally(() => {
					this.#backgroundRefreshPromise = undefined
				})
			}

			return this.#token.value
		}

		if (this.#promise) {
			return this.#promise
		}

		return this.#refreshToken(signal)
	}

	/**
	 * Refreshes the token in the background without blocking current requests
	 * @param signal - an optional AbortSignal to cancel the request
	 */
	async #refreshTokenInBackground(signal: AbortSignal): Promise<void> {
		if (this.#promise || this.#backgroundRefreshPromise) {
			return // Already refreshing (either sync or background)
		}

		// Combine user signal with timeout signal
		let combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(BACKGROUND_REFRESH_TIMEOUT_MS)])

		void this.#refreshToken(combinedSignal)
	}

	/**
	 * Refreshes the authentication token from the service
	 * @param signal - an optional AbortSignal to cancel the request
	 * @returns the new token value
	 */
	async #refreshToken(signal: AbortSignal): Promise<string> {
		this.#promise = retry(
			{
				...defaultRetryConfig,
				signal,
				idempotent: true,
				onRetry: (ctx) => {
					debug('Retry attempt #%d after error: %s', ctx.attempt, ctx.error)
				},
			},
			async () => {
				debug('Attempting login with user=%s', this.#username)

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
			}
		).finally(() => {
			this.#promise = undefined
		})

		return this.#promise
	}
}
