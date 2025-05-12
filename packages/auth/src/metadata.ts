import { type RetryConfig, retry } from "@ydbjs/retry";
import { backoff } from "@ydbjs/retry/strategy";

import { CredentialsProvider } from "./index.js";

export type MetadataCredentialsToken = {
	access_token: string
	expires_in: number
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

	constructor(credentials: MetadataCredentials) {
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
		if (!force && this.#token && this.#token.expires_in > Date.now() / 1000) {
			return this.#token.access_token
		}

		if (this.#promise) {
			return this.#promise
		}

		let retryConfig: RetryConfig = {
			retry: (err) => (err instanceof Error),
			signal,
			budget: 10,
			strategy: backoff(100, 1000),
		}

		this.#promise = retry(retryConfig, async (signal) => {
			let response = await fetch(this.#endpoint, {
				headers: {
					'Metadata-Flavor': this.#flavor,
				},
				signal,
			})

			if (!response.ok) {
				throw new Error(`Failed to fetch token: ${response.status} ${response.statusText}`)
			}

			this.#token = JSON.parse(await response.text())

			if (!this.#token!.access_token) {
				dbg('missing token in response, response=%O', this.#token)
				throw new Error('No access token exists in response');
			}

			return this.#token!.access_token
		}).finally(() => {
			this.#promise = null
		})

		return this.#promise
	}
}
