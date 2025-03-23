import { CredentialsProvider } from "./index.ts";

export class AnonymousCredentialsProvider extends CredentialsProvider {
	constructor() {
		super();
	}

	async getToken(): Promise<string> {
		return Promise.resolve('');
	}
}
