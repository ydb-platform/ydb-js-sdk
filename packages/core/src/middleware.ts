import { SpanKind, trace } from '@opentelemetry/api'
import { loggers } from '@ydbjs/debug'
import {
	SPAN_NAMES,
	getBaseAttributes,
	recordErrorAttributes,
} from '@ydbjs/tracing'
import { isAbortError } from 'abort-controller-x'
import { ClientError, type ClientMiddleware } from 'nice-grpc'
import pkg from '../package.json' with { type: 'json' }

let log = loggers.grpc

const QUERY_SERVICE_PATH = '/Ydb.Query.V1.QueryService/'
const PATH_TO_SPAN: Record<string, string> = {
	[QUERY_SERVICE_PATH + 'CreateSession']: SPAN_NAMES.CreateSession,
	[QUERY_SERVICE_PATH + 'ExecuteQuery']: SPAN_NAMES.ExecuteQuery,
	[QUERY_SERVICE_PATH + 'CommitTransaction']: SPAN_NAMES.Commit,
	[QUERY_SERVICE_PATH + 'RollbackTransaction']: SPAN_NAMES.Rollback,
}

export function createTracingMiddleware(
	serverAddress: string,
	serverPort: number,
	dbNamespace?: string
): ClientMiddleware {
	const baseAttrs = getBaseAttributes(
		serverAddress,
		serverPort,
		dbNamespace || undefined
	)

	return async function* (call, options) {
		const spanName = PATH_TO_SPAN[call.method.path]
		if (!spanName) {
			return yield* call.next(call.request, options)
		}

		const tracer = trace.getTracer('Ydb.Sdk', pkg.version)
		const span = tracer.startSpan(spanName, {
			kind: SpanKind.CLIENT,
			attributes: baseAttrs,
		})

		try {
			const result = yield* call.next(call.request, options)
			span.end()
			return result
		} catch (error: unknown) {
			const errAttrs = recordErrorAttributes(error)
			span.setAttributes(errAttrs)
			span.recordException(
				error instanceof Error ? error : new Error(String(error))
			)
			span.setStatus({ code: 2, message: String(error) })
			span.end()
			throw error
		}
	}
}

export const debug: ClientMiddleware = async function* (call, options) {
	let hasError = false
	try {
		return yield* call.next(call.request, options)
	} catch (error) {
		hasError = true
		if (error instanceof ClientError) {
			log.log('%s', error.message)
		} else if (isAbortError(error)) {
			log.log('%s %s: %s', call.method.path, 'CANCELLED', error.message)
		} else {
			log.log('%s %s: %s', call.method.path, 'UNKNOWN', error)
		}

		throw error
	} finally {
		if (!hasError) {
			log.log('%s %s', call.method.path, 'OK')
		}
	}
}
