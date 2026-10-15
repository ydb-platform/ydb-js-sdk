import { callbackify } from 'node:util'

import { InterceptingCall, type Interceptor, Metadata, credentials } from '@grpc/grpc-js'
import { abortable } from '@ydbjs/abortable'

export abstract class CredentialsProvider {
	abstract getToken(force?: boolean, signal?: AbortSignal): Promise<string>

	readonly interceptor: Interceptor = (options, nextCall) => {
		let controller = new AbortController()
		let acquiring = false
		let finished = false
		let ticket = credentials.createFromMetadataGenerator(
			callbackify(async (_params: unknown) => {
				controller.signal.throwIfAborted()
				let token: string
				acquiring = true
				try {
					token = await abortable(
						controller.signal,
						this.getToken(false, controller.signal)
					)
				} finally {
					acquiring = false
				}
				let metadata = new Metadata()
				metadata.set('x-ydb-auth-ticket', token)
				return metadata
			})
		)

		let call = nextCall({
			...options,
			credentials: options.credentials
				? credentials.combineCallCredentials(options.credentials, ticket)
				: ticket,
		})

		return new InterceptingCall(call, {
			start(metadata, _listener, next) {
				metadata = metadata.clone()
				metadata.remove('x-ydb-auth-ticket')
				next(metadata, {
					onReceiveStatus(result, nextStatus) {
						finished = true
						if (acquiring) {
							controller.abort()
						}
						nextStatus(result)
					},
				})
			},
			cancel(next) {
				if (!finished) {
					controller.abort()
				}
				next()
			},
		})
	}
}
