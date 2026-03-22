import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import { loggers } from '@ydbjs/debug'
import { YDBError } from '@ydbjs/error'
import {
	SPAN_NAMES,
	SpanFinalizer,
	SpanKind,
	type Tracer,
	formatTraceparent,
	getBaseAttributes,
	tracingContext,
} from '@ydbjs/telemetry'
import { ClientError, type ClientMiddleware, Metadata } from 'nice-grpc'

let log = loggers.grpc

const EXECUTE_QUERY_METHOD = 'ExecuteQuery'
const METHOD_TO_SPAN: Record<string, string> = {
	CreateSession: SPAN_NAMES.CreateSession,
	ExecuteQuery: SPAN_NAMES.ExecuteQuery,
	CommitTransaction: SPAN_NAMES.Commit,
	RollbackTransaction: SPAN_NAMES.Rollback,
}

function grpcMethodName(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1)
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
		const methodName = grpcMethodName(call.method.path)
		const spanName = METHOD_TO_SPAN[methodName]
		if (!spanName) {
			return yield* call.next(call.request, options)
		}

		const existingQueryText = tracingContext.getStore()?.queryText

		const span = tracer.startSpan(spanName, {
			kind: SpanKind.CLIENT,
			attributes: baseAttrs,
		})
		if (existingQueryText && methodName === EXECUTE_QUERY_METHOD) {
			span.setAttribute('db.query.text', existingQueryText)
		}
		if (typeof process !== 'undefined' && process.env.YDB_TRACE_DEBUG) {
			const ctx = span.spanContext()
			// eslint-disable-next-line no-console
			console.log('[ydb-tracing]', spanName, 'traceId:', ctx.traceId)
		}
		tracingContext.enterWith(
			existingQueryText ? { span, queryText: existingQueryText } : { span }
		)

		const ctx = span.spanContext()
		const nextOptions =
			ctx.traceId && ctx.spanId
				? {
						...options,
						metadata: Metadata(options.metadata).set(
							'traceparent',
							formatTraceparent(ctx.traceId, ctx.spanId, ctx.traceFlags)
						),
					}
				: options

		return yield* span.runInContext(async function* () {
			try {
				if (methodName === EXECUTE_QUERY_METHOD) {
					// Server streaming: iterate the generator and end span when the stream ends or a part.status !== SUCCESS.
					const nextGen = call.next(call.request, nextOptions)
					let ended = false
					const endSpan = (err?: unknown) => {
						if (ended) return
						ended = true
						if (err !== undefined) {
							SpanFinalizer.finishByError(span, err)
						} else {
							SpanFinalizer.finishSuccess(span)
						}
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
				SpanFinalizer.finishByError(span, error)
				throw error
			}
		})
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
		} else if (error instanceof Error && error.name === 'AbortError') {
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
