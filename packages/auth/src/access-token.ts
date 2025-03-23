import { CredentialsProvider } from "./index.ts";

export type AccessTokenCredentials = {
	// TODO: support read from file
	// source: 'file' | 'inline'
	token: string
}

export class AccessTokenCredentialsProvider extends CredentialsProvider {
	#token: string

	constructor(credentials: AccessTokenCredentials) {
		super();
		this.#token = credentials.token;
	}

	async getToken(force: boolean, signal?: AbortSignal): Promise<string> {
		return Promise.resolve(this.#token);
	}
}
