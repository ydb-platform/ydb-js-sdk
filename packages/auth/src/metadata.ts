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

	async getToken(force?: boolean, signal?: AbortSignal): Promise<string> {
		if (!force && this.#token && this.#token.expires_in > Date.now() / 1000) {
			return this.#token.access_token
		}

		if (this.#promise) {
			return this.#promise
		}

		let retryConfig: RetryConfig = {
			retry: (err) => (err instanceof Error && (err.name !== 'TimeoutError' && err.name !== 'AbortError')),
			signal,
			budget: 10,
			strategy: backoff(1000, 10_1000),
		}

		this.#promise = retry(retryConfig, async () => {
			let response = await fetch(this.#endpoint, {
				headers: {
					'Metadata-Flavor': this.#flavor,
				},
				signal,
			})

			if (!response.ok) {
				throw new Error(`Failed to fetch token: ${response.status} ${response.statusText}`)
			}

			if (!response.headers.has('Content-Type')) {
				throw new Error('No Content-Type header in response')
			}

			if (!response.headers.get('Content-Type')?.startsWith('application/json')) {
				throw new Error('Content-Type header is not application/json')
			}

			this.#token = await response.json()

			return this.#token!.access_token
		}).finally(() => {
			this.#promise = null
		})

		return this.#promise
	}
}
