import { CredentialsProvider } from "./index.js";

export class AnonymousCredentialsProvider extends CredentialsProvider {
	constructor() {
		super();
	}

	async getToken(): Promise<string> {
		return Promise.resolve('');
	}
}
