import { CredentialsProvider } from './index.js'

export class AnonymousCredentialsProvider extends CredentialsProvider {
	getToken(): Promise<string> {
		return Promise.resolve('')
	}
}
