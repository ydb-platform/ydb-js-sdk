import { InterceptingCall, type Interceptor, status } from '@grpc/grpc-js'
import { loggers } from '@ydbjs/debug'

let log = loggers.grpc

export let debug: Interceptor = (options, nextCall) =>
	new InterceptingCall(nextCall(options), {
		start(metadata, _listener, next) {
			next(metadata, {
				onReceiveStatus(result, nextStatus) {
					log.log(
						'%s %s: %s',
						options.method_definition.path,
						status[result.code],
						result.details
					)
					nextStatus(result)
				},
			})
		},
	})

// Drivers snapshot this registry at construction, before creating any clients.
let registeredInterceptors: Interceptor[] = []

export function addClientInterceptor(interceptor: Interceptor): Disposable {
	registeredInterceptors.push(interceptor)

	return {
		[Symbol.dispose]() {
			let index = registeredInterceptors.indexOf(interceptor)
			if (index >= 0) {
				registeredInterceptors.splice(index, 1)
			}
		},
	}
}

export function getRegisteredClientInterceptors(): readonly Interceptor[] {
	return registeredInterceptors
}
