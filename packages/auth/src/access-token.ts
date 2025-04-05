import { CredentialsProvider } from './index.js'

export type AccessTokenCredentials = {
	// TODO: support read from file
	// source: 'file' | 'inline'
	token: string
}

export class AccessTokenCredentialsProvider extends CredentialsProvider {
	#token: string

	constructor(credentials: AccessTokenCredentials) {
		super()
		this.#token = credentials.token
	}

	/**
	 * Returns the token from the credentials.
	 * @param force - ignored
	 * @param signal - ignored
	 * @returns the token
	 */
	getToken(): Promise<string> {
		return Promise.resolve(this.#token)
	}
}
