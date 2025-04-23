import { CredentialsProvider } from './index.js'

/**
 * Provides anonymous credentials for authentication.
 * The token returned by this provider is always an empty string.
 */
export class AnonymousCredentialsProvider extends CredentialsProvider {
	getToken(): Promise<string> {
		return Promise.resolve('')
	}
}
