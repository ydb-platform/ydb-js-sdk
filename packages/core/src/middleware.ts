import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { loggers } from '@ydbjs/debug'
import { YDBError } from '@ydbjs/error'
import { tracingContext } from './tracing-context.js'
import {
	SPAN_NAMES,
	SpanKind,
	type Tracer,
	formatTraceparent,
	getBaseAttributes,
	recordErrorAttributes,
} from './tracing.js'
import { isAbortError } from 'abort-controller-x'
import { ClientError, type ClientMiddleware, Metadata } from 'nice-grpc'

let log = loggers.grpc

const QUERY_SERVICE_PATH = '/Ydb.Query.V1.QueryService/'
const EXECUTE_QUERY_PATH = QUERY_SERVICE_PATH + 'ExecuteQuery'
const PATH_TO_SPAN: Record<string, string> = {
	[QUERY_SERVICE_PATH + 'CreateSession']: SPAN_NAMES.CreateSession,
	[EXECUTE_QUERY_PATH]: SPAN_NAMES.ExecuteQuery,
	[QUERY_SERVICE_PATH + 'CommitTransaction']: SPAN_NAMES.Commit,
	[QUERY_SERVICE_PATH + 'RollbackTransaction']: SPAN_NAMES.Rollback,
}

export function createTracingMiddleware(
	serverAddress: string,
	serverPort: number,
	dbNamespace: string | undefined,
	tracer: Tracer
): ClientMiddleware {
	const baseAttrs = getBaseAttributes(
		serverAddress,
		serverPort,
		dbNamespace ? { dbNamespace } : undefined
	)

	return async function* (call, options) {
		const spanName = PATH_TO_SPAN[call.method.path]
		if (!spanName) {
			return yield* call.next(call.request, options)
		}

		const span = tracer.startSpan(spanName, {
			kind: SpanKind.CLIENT,
			attributes: baseAttrs,
		})
		if (typeof process !== 'undefined' && process.env.YDB_TRACE_DEBUG) {
			const ctx = span.spanContext()
			// eslint-disable-next-line no-console
			console.log('[ydb-tracing]', spanName, 'traceId:', ctx.traceId)
		}
		tracingContext.enterWith({ span })

		const ctx = span.spanContext()
		const nextOptions =
			ctx.traceId && ctx.spanId
				? {
						...options,
						metadata: Metadata(options.metadata).set(
							'traceparent',
							formatTraceparent(
								ctx.traceId,
								ctx.spanId,
								ctx.traceFlags
							)
						),
					}
				: options

		try {
			if (call.method.path === EXECUTE_QUERY_PATH) {
				// Server streaming: yield* call.next() returns undefined (stream is yielded). Iterate the generator and end span when stream ends or part.status !== SUCCESS.
				const nextGen = call.next(call.request, nextOptions)
				let ended = false
				const endSpan = (err?: unknown) => {
					if (ended) return
					ended = true
					if (err !== undefined) {
						span.setAttributes(recordErrorAttributes(err))
						span.recordException(
							err instanceof Error ? err : new Error(String(err))
						)
						span.setStatus({ code: 2, message: String(err) })
					}
					span.end()
				}
				try {
					for await (const part of nextGen) {
						if (
							part &&
							typeof part === 'object' &&
							'status' in part &&
							part.status !== StatusIds_StatusCode.SUCCESS
						) {
							const p = part as {
								status: number
								issues?: import('@ydbjs/api/operation').IssueMessage[]
							}
							const err = new YDBError(
								p.status as StatusIds_StatusCode,
								p.issues ?? []
							)
							endSpan(err)
							yield part
							return
						}
						yield part
					}
					endSpan()
					return
				} catch (streamError: unknown) {
					endSpan(streamError)
					throw streamError
				}
			}
			const result = yield* call.next(call.request, nextOptions)
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
	} as ClientMiddleware
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
