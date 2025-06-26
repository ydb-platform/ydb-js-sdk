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
const HARD_EXPIRY_BUFFER_SECONDS = 30  // Hard limit - must refresh
const SOFT_EXPIRY_BUFFER_SECONDS = 120 // Soft limit - start background refresh
const BACKGROUND_REFRESH_TIMEOUT_MS = 30000 // 30 seconds timeout for background refresh

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
	#backgroundRefreshPromise: Promise<void> | null = null

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
		debug('Creating StaticCredentialsProvider with endpoint: %s, username: %s', endpoint, username)

		this.#username = username
		this.#password = password

		let cs = new URL(endpoint)
		debug('Parsed URL: protocol=%s, host=%s, pathname=%s', cs.protocol, cs.host, cs.pathname)

		if (['unix:', 'http:', 'https:', 'grpc:', 'grpcs:'].includes(cs.protocol) === false) {
			throw new Error('Invalid connection string protocol. Must be one of unix, grpc, grpcs, http, https')
		}

		// For unix sockets, keep the full URL, for everything else just use host:port
		let address: string
		if (cs.protocol === 'unix:') {
			address = `${cs.protocol}//${cs.host}${cs.pathname}`
		} else {
			// For http, https, grpc, grpcs - just use host:port
			address = `${cs.host}${cs.pathname}`
		}
		debug('Using address: %s', address)

		let channelCredentials = secureOptions ?
			credentials.createFromSecureContext(tls.createSecureContext(secureOptions)) :
			credentials.createInsecure()

		debug('Creating gRPC client with %s credentials', secureOptions ? 'secure' : 'insecure')
		this.#client = createClient(AuthServiceDefinition, createChannel(address, channelCredentials, channelOptions))
		debug('StaticCredentialsProvider created successfully')
	}

	/**
	 * Returns the token from the credentials.
	 * @param force - if true, forces a new token to be fetched
	 * @param signal - an optional AbortSignal to cancel the request
	 * @returns the token
	 */
	async getToken(force = false, signal?: AbortSignal): Promise<string> {
		debug('getToken called with force=%s, signal=%s', force, signal ? 'present' : 'none')
		const currentTimeSeconds = Date.now() / 1000

		// If token is still valid (hard buffer), return it
		if (!force && this.#token && this.#token.exp > currentTimeSeconds + HARD_EXPIRY_BUFFER_SECONDS) {
			debug('Token is still valid, exp=%s, current+buffer=%s',
				this.#token.exp, currentTimeSeconds + HARD_EXPIRY_BUFFER_SECONDS)

			// Start background refresh if approaching soft expiry
			if (this.#token.exp <= currentTimeSeconds + SOFT_EXPIRY_BUFFER_SECONDS && !this.#promise && !this.#backgroundRefreshPromise) {
				debug('Starting background refresh, token expires in %s seconds',
					this.#token.exp - currentTimeSeconds)

				// Fire and forget background refresh with timeout
				this.#backgroundRefreshPromise = this.#refreshTokenInBackground(signal)
					.finally(() => {
						this.#backgroundRefreshPromise = null
					})
			}

			debug('Returning cached token')
			return this.#token.value
		}

		debug('Token needs refresh: force=%s, token_exists=%s, expired=%s',
			force, !!this.#token, this.#token ? this.#token.exp <= currentTimeSeconds + HARD_EXPIRY_BUFFER_SECONDS : 'no_token')

		if (this.#promise) {
			debug('Refresh already in progress, waiting for existing promise')
			return this.#promise
		}

		debug('Starting synchronous token refresh')
		return this.#refreshToken(signal)
	}

	/**
	 * Refreshes the token in the background without blocking current requests
	 * @param signal - an optional AbortSignal to cancel the request
	 */
	async #refreshTokenInBackground(signal?: AbortSignal): Promise<void> {
		debug('Background refresh requested')

		if (this.#promise || this.#backgroundRefreshPromise) {
			debug('Background refresh skipped: already refreshing (sync=%s, bg=%s)',
				!!this.#promise, !!this.#backgroundRefreshPromise)
			return // Already refreshing (either sync or background)
		}

		debug('Starting background refresh with timeout=%sms', BACKGROUND_REFRESH_TIMEOUT_MS)

		// Create timeout signal for background refresh
		const timeoutController = new AbortController()
		const timeoutId = setTimeout(() => {
			debug('Background refresh timeout triggered')
			timeoutController.abort()
		}, BACKGROUND_REFRESH_TIMEOUT_MS)

		// Combine user signal with timeout signal
		const combinedSignal = signal
			? AbortSignal.any([signal, timeoutController.signal])
			: timeoutController.signal

		try {
			await this.#refreshToken(combinedSignal)
			debug('Background refresh completed successfully')
		} catch (error) {
			debug('Background refresh failed: %s', error)
			// Background refresh failed, will retry on next getToken call
		} finally {
			debug('Clearing background refresh timeout')
			clearTimeout(timeoutId)
		}
	}

	/**
	 * Refreshes the authentication token from the service
	 * @param signal - an optional AbortSignal to cancel the request
	 * @returns the new token value
	 */
	async #refreshToken(signal?: AbortSignal): Promise<string> {
		debug('Starting token refresh with signal=%s', signal ? 'present' : 'none')

		this.#promise = retry({
			...defaultRetryConfig,
			signal,
			idempotent: true,
			onRetry: (ctx) => {
				debug('Retry attempt #%d after error: %s', ctx.attempt, ctx.error)
				console.error(`[ydbjs:auth:static] Retry attempt #${ctx.attempt} after error:`, ctx.error)
			}
		}, async () => {
			debug('Attempting login with user=%s', this.#username)

			let response = await this.#client.login({ user: this.#username, password: this.#password }, { signal })
			debug('Login response received, operation=%s', response.operation ? 'present' : 'missing')

			if (!response.operation) {
				throw new ClientError(AuthServiceDefinition.login.path, Status.UNKNOWN, 'No operation in response')
			}

			debug('Operation status: %s', response.operation.status)
			if (response.operation.status !== StatusIds_StatusCode.SUCCESS) {
				throw new YDBError(response.operation.status, response.operation.issues)
			}

			let result = anyUnpack(response.operation.result!, LoginResultSchema)
			debug('Login result unpacked, result=%s', result ? 'present' : 'missing')

			if (!result) {
				throw new ClientError(AuthServiceDefinition.login.path, Status.UNKNOWN, 'No result in operation')
			}

			debug('Processing token, length=%s', result.token.length)

			// The result.token is a JWT in the format header.payload.signature.
			// We attempt to decode the payload to extract token metadata (aud, exp, iat, sub).
			// If the token is not in the expected format, we fallback to default values.
			let [header, payload, signature] = result.token.split('.')
			if (header && payload && signature) {
				debug('Token is valid JWT, parsing payload')
				let decodedPayload = JSON.parse(Buffer.from(payload, 'base64').toString())

				this.#token = {
					value: result.token,
					...decodedPayload,
				}
				debug('Token parsed successfully, exp=%s', decodedPayload.exp)
			} else {
				debug('Token is not JWT format, using fallback values')
				this.#token = {
					value: result.token,
					aud: [],
					exp: Math.floor(Date.now() / 1000) + 5 * 60, // fallback: 5 minutes from now
					iat: Math.floor(Date.now() / 1000),
					sub: '',
				}
			}

			debug('Token refresh completed successfully')
			return this.#token!.value!
		}).finally(() => {
			debug('Clearing refresh promise')
			this.#promise = null
		})

		return this.#promise
	}
}
