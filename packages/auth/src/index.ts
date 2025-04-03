import { Metadata, type CallOptions, type ClientMiddlewareCall } from "nice-grpc";

export abstract class CredentialsProvider {
	constructor() {
		// @ts-ignore
		this.middleware = this.middleware.bind(this);
	}

	abstract getToken(force?: boolean, signal?: AbortSignal): Promise<string>

	readonly middleware = async function* <Request = unknown, Response = unknown>(
		this: CredentialsProvider,
		call: ClientMiddlewareCall<Request, Response>,
		options: CallOptions,
	) {
		let token = await this.getToken(false)

		return yield* call.next(call.request, {
			...options,
			metadata: Metadata(options.metadata).set('x-ydb-auth-ticket', token),
		});
	}
}
