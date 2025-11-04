import * as fs from 'node:fs'
import * as path from 'node:path'
import { constants, createPrivateKey, sign } from 'node:crypto'
import { CredentialsProvider } from '@ydbjs/auth'
import { loggers } from '@ydbjs/debug'
import { type RetryConfig, retry } from '@ydbjs/retry'
import { type RetryStrategy, exponential, fixed } from '@ydbjs/retry/strategy'

let dbg = loggers.auth.extend('yc-sa')

/**
 * HTTP error with status code for IAM API requests.
 */
class IamApiError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly statusText: string,
		cause?: unknown
	) {
		super(message)
		this.name = 'IamApiError'
		this.cause = cause
	}
}

// Base64URL encode helper (JWT uses Base64URL, not regular Base64)
// Node.js 18+ supports base64url directly
function base64UrlEncode(data: string | Buffer): string {
	let buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
	return buffer.toString('base64url')
}

export type ServiceAccountKey = {
	id: string
	service_account_id: string
	private_key: string
	created_at?: string
	key_algorithm?: string
	public_key?: string
}

export type IamToken = {
	value: string
	expires_at: number // timestamp in ms
}

export type ServiceAccountCredentialsOptions = {
	iamEndpoint?: string
}

/**
 * A credentials provider that authenticates using Yandex Cloud Service Account authorized key.
 *
 * This provider reads a Service Account authorized key JSON file, creates a JWT signed with PS256,
 * exchanges it for an IAM token via Yandex Cloud IAM API, and uses that token for YDB authentication.
 *
 * Tokens are automatically cached and refreshed before expiration.
 *
 * @extends CredentialsProvider
 */
export class ServiceAccountCredentialsProvider extends CredentialsProvider {
	#key: ServiceAccountKey
	#token: IamToken | null = null
	#promise: Promise<string> | null = null
	#iamEndpoint: string = 'https://iam.api.cloud.yandex.net/iam/v1/tokens'

	/**
	 * Creates an instance of ServiceAccountCredentialsProvider.
	 *
	 * @param key - Service Account authorized key JSON object
	 * @param options - Optional configuration (IAM endpoint override)
	 */
	constructor(key: ServiceAccountKey, options?: ServiceAccountCredentialsOptions) {
		super()

		if (!key.id || !key.service_account_id || !key.private_key) {
			throw new Error(
				'Invalid Service Account key: missing required fields (id, service_account_id, private_key)'
			)
		}

		// Yandex Cloud authorized keys may contain a warning line before the PEM key
		// Remove it if present to get clean PEM format
		if (key.private_key.includes('PLEASE DO NOT REMOVE')) {
			key.private_key = key.private_key.replace(/^.*?-----BEGIN PRIVATE KEY-----/s, '-----BEGIN PRIVATE KEY-----')
		}

		this.#key = key
		if (options?.iamEndpoint) {
			this.#iamEndpoint = options.iamEndpoint
		}

		dbg.log('creating service account credentials provider for SA: %s (key ID: %s)', key.service_account_id, key.id)
	}

	/**
	 * Creates a provider instance from a JSON file path.
	 *
	 * @param filePath - Path to the authorized key JSON file
	 * @param options - Optional configuration
	 * @returns ServiceAccountCredentialsProvider instance
	 */
	static fromFile(filePath: string, options?: ServiceAccountCredentialsOptions): ServiceAccountCredentialsProvider {
		let resolvedPath = path.resolve(filePath)
		dbg.log('reading service account key from file: %s', resolvedPath)

		let content: string
		try {
			content = fs.readFileSync(resolvedPath, 'utf8')
		} catch (error) {
			throw new Error(`Failed to read Service Account key file: ${filePath}`, { cause: error })
		}

		let key: ServiceAccountKey
		try {
			key = JSON.parse(content)
		} catch (error) {
			throw new Error(`Failed to parse Service Account key JSON`, { cause: error })
		}

		return new ServiceAccountCredentialsProvider(key, options)
	}

	/**
	 * Creates a provider instance from environment variable.
	 *
	 * Reads path from YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS environment variable.
	 *
	 * @param options - Optional configuration
	 * @returns ServiceAccountCredentialsProvider instance
	 * @throws Error if environment variable is not set
	 */
	static fromEnv(options?: ServiceAccountCredentialsOptions): ServiceAccountCredentialsProvider {
		let filePath = process.env.YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS
		if (!filePath) {
			throw new Error('YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS environment variable is not set')
		}

		return ServiceAccountCredentialsProvider.fromFile(filePath, options)
	}

	/**
	 * Retrieves an IAM token for authentication.
	 *
	 * Always returns a valid token immediately if available.
	 * If token is expiring soon (< 5 minutes), returns it immediately and refreshes in background.
	 * Only blocks when token is expired or force=true.
	 *
	 * @param force - If true, forces fetching a new token regardless of cache
	 * @param signal - AbortSignal to cancel the operation
	 * @returns Promise resolving to IAM token string
	 */
	async getToken(force?: boolean, signal?: AbortSignal): Promise<string> {
		let now = Date.now()

		if (!force && this.#token && this.#token.expires_at > now) {
			// Refresh in background when token expires in < 5 minutes to avoid blocking on expiration
			if (this.#token.expires_at <= now + 5 * 60 * 1000) {
				this.#refreshTokenInBackground(signal)
			}

			return this.#token.value
		}

		if (this.#promise) {
			return this.#promise
		}

		dbg.log('fetching new IAM token (token expired or force=true, key ID: %s)', this.#key.id)

		this.#promise = (async (): Promise<string> => {
			try {
				this.#token = await this.#fetchIamToken(signal)
				dbg.log(
					'IAM token fetched successfully, expires at %s (key ID: %s)',
					new Date(this.#token.expires_at).toISOString(),
					this.#key.id
				)
				return this.#token.value
			} finally {
				this.#promise = null
			}
		})()

		return this.#promise
	}

	/**
	 * Refreshes token in background without blocking.
	 * Does nothing if refresh is already in progress.
	 */
	#refreshTokenInBackground(signal?: AbortSignal): void {
		if (this.#promise) {
			return
		}

		// Track promise to prevent duplicate refreshes, but don't await it (non-blocking)
		let refreshPromise: Promise<string> | null = null
		refreshPromise = (async (): Promise<string> => {
			try {
				this.#token = await this.#fetchIamToken(signal)
				dbg.log(
					'background IAM token refresh successful, expires at %s (key ID: %s)',
					new Date(this.#token.expires_at).toISOString(),
					this.#key.id
				)
				return this.#token.value
			} catch (error) {
				// Don't throw - failed background refresh will retry on next getToken call
				// Return existing token if available to avoid breaking ongoing requests
				dbg.log('background IAM token refresh failed: %O (key ID: %s)', error, this.#key.id)
				if (this.#token) {
					return this.#token.value
				}
				throw error
			} finally {
				// Check promise reference to avoid clearing if another refresh started (race condition)
				if (this.#promise === refreshPromise) {
					this.#promise = null
				}
			}
		})()

		this.#promise = refreshPromise
	}

	/**
	 * Determines retry strategy for error.
	 *
	 * @returns RetryStrategy for retryable errors, null for non-retryable
	 */
	#getRetryStrategy(error: unknown): RetryStrategy | null {
		if (!(error instanceof Error)) {
			return null
		}

		// AbortError is not retryable - user explicitly cancelled the operation
		if (error.name === 'AbortError') {
			return null
		}

		if (error instanceof IamApiError) {
			let status = error.status

			// 429/503 indicate server overload - exponential backoff prevents overwhelming the server
			if (status === 429 || status === 503) {
				return exponential(100)
			}

			// Other 5xx are transient server errors - fast retry to catch quick recovery
			if (status >= 500 && status < 600) {
				return fixed(0)
			}

			// 4xx are client errors (wrong credentials, bad request) - retry won't help
			if (status >= 400 && status < 500) {
				return null
			}
		}

		// Network errors are transient - fast retry to catch when connection restored
		if (error.name === 'TypeError' && (error.message.includes('fetch') || error.message.includes('network'))) {
			return fixed(0)
		}

		// Unknown errors: assume not retryable (be conservative)
		return null
	}

	/**
	 * Creates a JWT signed with PS256 algorithm for IAM token exchange.
	 *
	 * @returns JWT string
	 */
	#createJWT(): string {
		let privateKey = createPrivateKey({
			key: this.#key.private_key,
			format: 'pem',
		})

		let now = Math.floor(Date.now() / 1000)

		let header = {
			typ: 'JWT',
			alg: 'PS256',
			kid: this.#key.id,
		}

		let payload = {
			iss: this.#key.service_account_id,
			aud: this.#iamEndpoint,
			iat: now,
			exp: now + 3600,
		}

		let encodedHeader = base64UrlEncode(JSON.stringify(header))
		let encodedPayload = base64UrlEncode(JSON.stringify(payload))
		let unsignedToken = `${encodedHeader}.${encodedPayload}`

		// PS256 (RSA-PSS with SHA-256) is required by Yandex Cloud IAM API
		// JWT RFC 7518 specifies PS256 as RSA-PSS using SHA-256 and MGF1 with SHA-256
		// Node.js sign() requires digest algorithm first, then RSA-PSS padding in options
		// saltLength 32 bytes matches SHA-256 digest size (required by JWT spec)
		// See:
		// - https://nodejs.org/api/crypto.html#cryptosignalgorithm-data-key-callback (Node.js crypto.sign documentation)
		// - https://datatracker.ietf.org/doc/html/rfc7518#section-3.5 (JWT PS256 algorithm specification)
		let signature = sign('sha256', Buffer.from(unsignedToken), {
			key: privateKey,
			padding: constants.RSA_PKCS1_PSS_PADDING,
			saltLength: 32,
		})

		let encodedSignature = base64UrlEncode(signature)

		return `${unsignedToken}.${encodedSignature}`
	}

	/**
	 * Fetches IAM token from Yandex Cloud IAM API using JWT.
	 * Includes built-in retry logic with smart strategy selection:
	 * - Fast retry for network errors and transient server errors
	 * - Exponential backoff for server overload (429, 503)
	 *
	 * @param signal - AbortSignal to cancel the request
	 * @returns Promise resolving to IamToken with value and expiration
	 */
	async #fetchIamToken(signal?: AbortSignal): Promise<IamToken> {
		let retryConfig: RetryConfig = {
			retry: (err) => this.#getRetryStrategy(err) !== null,
			signal,
			budget: 5,
			strategy: (ctx, cfg) => {
				let strategy = this.#getRetryStrategy(ctx.error)

				return strategy ? strategy(ctx, cfg) : 0
			},
			onRetry: (ctx) => {
				dbg.log(
					'retrying IAM token fetch, attempt %d, error: %O (key ID: %s)',
					ctx.attempt,
					ctx.error,
					this.#key.id
				)
			},
		}

		return await retry(retryConfig, async (signal) => {
			let jwt = this.#createJWT()

			let response = await fetch(this.#iamEndpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ jwt }),
				signal: signal ?? null,
			})

			if (!response.ok) {
				let errorText = await response.text().catch(() => 'Unknown error')
				throw new IamApiError(
					`IAM API error: ${response.status} ${response.statusText} - ${errorText}`,
					response.status,
					response.statusText
				)
			}

			let data = (await response.json()) as { iamToken?: string; expiresAt?: string }

			if (!data.iamToken) {
				throw new Error('IAM API response missing iamToken field')
			}

			if (!data.expiresAt) {
				throw new Error('IAM API response missing expiresAt field')
			}

			return {
				value: data.iamToken,
				expires_at: new Date(data.expiresAt).getTime(),
			}
		})
	}
}
