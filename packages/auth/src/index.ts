export abstract class CredentialsProvider {
	/** Cancels only the caller’s wait; shared token refreshes keep their own lifetime. */
	abstract getToken(force?: boolean, signal?: AbortSignal): Promise<string>
}
