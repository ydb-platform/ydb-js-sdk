export abstract class CredentialsProvider {
	abstract getToken(force?: boolean, signal?: AbortSignal): Promise<string>
}
