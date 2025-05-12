import { type RetryConfig, retry } from "@ydbjs/retry";
import { backoff } from "@ydbjs/retry/strategy";

import { CredentialsProvider } from "./index.js";
import { dbg } from "./dbg.js";

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
			return this.#token.value
		}

		if (this.#promise) {
			return this.#promise
		}

		let retryConfig: RetryConfig = {
			retry: (err) => (err instanceof Error),
			signal,
			budget: 5,
			strategy: backoff(10, 1000),
		}

		this.#promise = retry(retryConfig, async (signal) => {
			let response = await fetch(this.#endpoint, {
				headers: {
					'Metadata-Flavor': this.#flavor,
				},
				signal,
			})

			dbg('%s %s %s', this.#endpoint, response.status, response.headers.get('Content-Type'))

			if (!response.ok) {
				throw new Error(`Failed to fetch token: ${response.status} ${response.statusText}`)
			}

			let token = JSON.parse(await response.text()) as { access_token?: string, expires_in?: number }
			if (!token.access_token) {
				dbg('missing access token in response, response=%O', token)
				throw new Error('No access token exists in response');
			}

			this.#token = {
				value: token.access_token,
				expired_at: Date.now() + (token.expires_in ?? 3600) * 1000,
			}

			return this.#token.value
		}).finally(() => {
			this.#promise = null
		})

		return this.#promise
	}
}
