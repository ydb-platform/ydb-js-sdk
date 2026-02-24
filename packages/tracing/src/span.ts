import { SpanKind, trace } from '@opentelemetry/api'
import type { Span } from '@opentelemetry/api'
import pkg from '../package.json' with { type: 'json' }
import { DB_SYSTEM } from './constants.js'
import { recordErrorAttributes } from './error.js'

export type SpanBaseAttributes = {
	'server.address': string
	'server.port': number
	'db.namespace'?: string
}

export function getBaseAttributes(
	serverAddress: string,
	serverPort: number,
	dbNamespace?: string
): SpanBaseAttributes & { 'db.system': string } {
	const attrs: SpanBaseAttributes & { 'db.system': string } = {
		'db.system': DB_SYSTEM,
		'server.address': serverAddress,
		'server.port': serverPort,
	}
	if (dbNamespace) {
		attrs['db.namespace'] = dbNamespace
	}
	return attrs
}

export function createSpan<T>(
	operationName: string,
	baseAttributes: SpanBaseAttributes & { 'db.system'?: string },
	fn: (span: Span) => Promise<T>
): Promise<T> {
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
