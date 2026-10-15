import { InterceptingCall, type Interceptor } from '@grpc/grpc-js'
import { context, propagation } from '@opentelemetry/api'

export let propagator: Interceptor = (options, nextCall) =>
	new InterceptingCall(nextCall(options), {
		start(metadata, listener, next) {
			metadata = metadata.clone()
			propagation.inject(context.active(), metadata, {
				set(carrier, key, value) {
					carrier.set(key, String(value))
				},
			})

			next(metadata, listener)
		},
	})
