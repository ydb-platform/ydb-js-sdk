import {
	type CallOptions,
	type ClientMiddlewareCall,
	Metadata,
} from 'nice-grpc'

export abstract class CredentialsProvider {
	constructor() {
		// @ts-expect-error Inside middleware perform `this.getToken` call
		// to get the token. This is a workaround for the fact that
		// `this` is not bound to the class instance inside the middleware.
		this.middleware = this.middleware.bind(this)
	}

	abstract getToken(force?: boolean, signal?: AbortSignal): Promise<string>

	readonly middleware = async function* <
		Request = unknown,
		Response = unknown,
	>(
		this: CredentialsProvider,
		call: ClientMiddlewareCall<Request, Response>,
		options: CallOptions
	) {
		let token = await this.getToken(false, options.signal)

		return yield* call.next(call.request, {
			...options,
			metadata: Metadata(options.metadata).set(
				'x-ydb-auth-ticket',
				token
			),
		})
	}
}
