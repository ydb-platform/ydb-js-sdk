import { loggers } from '@ydbjs/debug';
import { type RetryConfig, retry } from "@ydbjs/retry";
import { backoff } from "@ydbjs/retry/strategy";
import { CredentialsProvider } from "./index.js";

let dbg = loggers.auth.extend('metadata')

export type MetadataCredentialsToken = {
	value: string
	expired_at: number
}

export type MetadataCredentials = {
	endpoint?: string
	flavor?: string
}

/**
 * A credentials provider that retrieves tokens from a metadata service.
 *
 * This class extends the `CredentialsProvider` class and implements the `getToken` method
 * to fetch tokens from a specified metadata endpoint. It supports optional retry logic
 * and allows customization of the metadata flavor and endpoint.
 *
 * @extends CredentialsProvider
 */
export class MetadataCredentialsProvider extends CredentialsProvider {
	#promise: Promise<string> | null = null

	#token: MetadataCredentialsToken | null = null
	#flavor: string = 'Google'
	#endpoint: string = 'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token'

	/**
	 * Creates an instance of `MetadataCredentialsProvider`.
	 *
	 * @param credentials - An optional object containing metadata credentials.
	 * @param credentials.flavor - The metadata flavor (default: 'Google').
	 * @param credentials.endpoint - The metadata endpoint URL (default: 'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token').
	 */
	constructor(credentials: MetadataCredentials = {}) {
		super()
		if (credentials.flavor) {
			this.#flavor = credentials.flavor
		}

		if (credentials.endpoint) {
			this.#endpoint = credentials.endpoint
		}

		dbg.log('creating metadata credentials provider with flavor: %s, endpoint: %s', this.#flavor, this.#endpoint)
	}

	/**
	 * Retrieves an authentication token from the specified endpoint.
	 * If a valid token is already available and `force` is not true, it returns the cached token.
	 * Otherwise, it fetches a new token with optional retry logic based on the provided configuration.
	 *
	 * @param force - A flag indicating whether to force fetching a new token regardless of the existing one's validity.
	 * @param signal - An AbortSignal to cancel the operation if needed.
	 * @returns A promise resolving to the authentication token as a string.
	 * @throws Will throw an error if the token fetch fails, the response is not OK, or the content type is incorrect.
	 */
	async getToken(force?: boolean, signal?: AbortSignal): Promise<string> {
		if (!force && this.#token && this.#token.expired_at > Date.now()) {
			dbg.log('returning cached token, expires in %d ms', this.#token.expired_at - Date.now())
			return this.#token.value
		}

		if (this.#promise) {
			dbg.log('token fetch already in progress, waiting for result')
			return this.#promise
		}

		dbg.log('fetching new token from metadata service')

		let retryConfig: RetryConfig = {
			retry: (err) => (err instanceof Error),
			signal,
			budget: 5,
			strategy: backoff(10, 1000),
			onRetry: (ctx) => {
				dbg.log('retrying token fetch, attempt %d, error: %O', ctx.attempt, ctx.error)
			},
		}

		this.#promise = retry(retryConfig, async (signal) => {
			dbg.log('attempting to fetch token from %s', this.#endpoint)
			let response = await fetch(this.#endpoint, {
				headers: {
					'Metadata-Flavor': this.#flavor,
				},
				signal,
			})

			dbg.log('%s %s %s', this.#endpoint, response.status, response.headers.get('Content-Type'))

			if (!response.ok) {
				let error = new Error(`Failed to fetch token: ${response.status} ${response.statusText}`)
				dbg.log('error fetching token: %O', error)
				throw error
			}

			let token = JSON.parse(await response.text()) as { access_token?: string, expires_in?: number }
			if (!token.access_token) {
				dbg.log('missing access token in response, response: %O', token)
				throw new Error('No access token exists in response');
			}

			this.#token = {
				value: token.access_token,
				expired_at: Date.now() + (token.expires_in ?? 3600) * 1000,
			}

			dbg.log('token fetched successfully, expires in %d seconds', token.expires_in ?? 3600)
			return this.#token.value
		}).finally(() => {
			this.#promise = null
		})

		return this.#promise
	}
}
