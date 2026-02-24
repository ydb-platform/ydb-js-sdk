import { SpanKind, trace } from '@opentelemetry/api'
import pkg from '../package.json' with { type: 'json' }
import { DB_SYSTEM } from './constants.js'
import { recordErrorAttributes } from './error.js'
export function getBaseAttributes(serverAddress, serverPort, dbNamespace) {
	const attrs = {
		'db.system': DB_SYSTEM,
		'server.address': serverAddress,
		'server.port': serverPort,
	}
	if (dbNamespace) {
		attrs['db.namespace'] = dbNamespace
	}
	return attrs
}
export function createSpan(operationName, baseAttributes, fn) {
	const tracer = trace.getTracer('Ydb.Sdk', pkg.version)
	const attrs = {
		'db.system': DB_SYSTEM,
		...baseAttributes,
	}
	const span = tracer.startSpan(operationName, {
		kind: SpanKind.CLIENT,
		attributes: attrs,
	})
	return fn(span)
		.then((result) => {
			span.end()
			return result
		})
		.catch((error) => {
			const errAttrs = recordErrorAttributes(error)
			span.setAttributes(errAttrs)
			span.recordException(error)
			span.setStatus({ code: 2, message: String(error) })
			span.end()
			throw error
		})
}
//# sourceMappingURL=span.js.map
