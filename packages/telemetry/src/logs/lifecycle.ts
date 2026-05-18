import { context as otelContext } from '@opentelemetry/api'
import { SeverityNumber, logs } from '@opentelemetry/api-logs'

import pkg from '../../package.json' with { type: 'json' }
import { recordErrorAttributes } from '../attributes.js'
import { safeSubscribe, safeTracingSubscribe } from '../safe.js'

type Attrs = Record<string, string | number | boolean>

/**
 * Converts a diagnostics_channel payload to flat OTel log attributes.
 * BigInt values are stringified — OTel LogAttributes does not support bigint.
 * Nested objects / arrays are omitted (not meaningful as flat attributes).
 */
function toAttrs(payload: unknown): Attrs {
	if (payload === null || typeof payload !== 'object') return {}
	let out: Attrs = {}
	for (let [k, v] of Object.entries(payload as Record<string, unknown>)) {
		if (typeof v === 'string') out[k] = v
		else if (typeof v === 'number') out[k] = v
		else if (typeof v === 'boolean') out[k] = v
		else if (typeof v === 'bigint') out[k] = String(v)
	}
	return out
}

export function setupLifecycleLogs(): () => void {
	let logger = logs.getLogger(pkg.name, pkg.version)

	function emit(sev: SeverityNumber, body: string, attrs: Attrs = {}): void {
		logger.emit({
			severityNumber: sev,
			severityText: SeverityNumber[sev],
			body,
			attributes: attrs,
			context: otelContext.active(),
		})
	}

	function emitTracingError(channelBase: string, msg: unknown): void {
		let m = msg as Record<string, unknown>
		let errAttrs = recordErrorAttributes(m?.error)
		emit(SeverityNumber.ERROR, `${channelBase} error`, { ...toAttrs(m), ...errAttrs })
	}

	let unsubs: Array<() => void> = [
		// ── Driver ───────────────────────────────────────────────────────────
		safeSubscribe('ydb:driver.ready', (msg) => {
			emit(SeverityNumber.INFO, 'ydb:driver.ready', toAttrs(msg))
		}),
		safeSubscribe('ydb:driver.closed', (msg) => {
			emit(SeverityNumber.WARN, 'ydb:driver.closed', toAttrs(msg))
		}),

		// ── Discovery ─────────────────────────────────────────────────────────
		safeSubscribe('ydb:discovery.completed', (msg) => {
			emit(SeverityNumber.DEBUG, 'ydb:discovery.completed', toAttrs(msg))
		}),

		// ── Connection pool ───────────────────────────────────────────────────
		safeSubscribe('ydb:pool.connection.added', (msg) => {
			emit(SeverityNumber.INFO, 'ydb:pool.connection.added', toAttrs(msg))
		}),
		safeSubscribe('ydb:pool.connection.removed', (msg) => {
			emit(SeverityNumber.INFO, 'ydb:pool.connection.removed', toAttrs(msg))
		}),
		safeSubscribe('ydb:pool.connection.pessimized', (msg) => {
			emit(SeverityNumber.INFO, 'ydb:pool.connection.pessimized', toAttrs(msg))
		}),
		safeSubscribe('ydb:pool.connection.unpessimized', (msg) => {
			emit(SeverityNumber.DEBUG, 'ydb:pool.connection.unpessimized', toAttrs(msg))
		}),

		// ── Session pool ──────────────────────────────────────────────────────
		safeSubscribe('ydb:session.created', (msg) => {
			emit(SeverityNumber.INFO, 'ydb:session.created', toAttrs(msg))
		}),
		safeSubscribe('ydb:session.closed', (msg) => {
			emit(SeverityNumber.INFO, 'ydb:session.closed', toAttrs(msg))
		}),
		safeSubscribe('ydb:session.pool.exhausted', (msg) => {
			emit(SeverityNumber.WARN, 'ydb:session.pool.exhausted', toAttrs(msg))
		}),
		safeSubscribe('ydb:session.pool.queued', (msg) => {
			emit(SeverityNumber.DEBUG, 'ydb:session.pool.queued', toAttrs(msg))
		}),

		// ── Query ─────────────────────────────────────────────────────────────
		safeSubscribe('ydb:query.attempt.started', (msg) => {
			emit(SeverityNumber.DEBUG, 'ydb:query.attempt.started', toAttrs(msg))
		}),

		// ── Auth ──────────────────────────────────────────────────────────────
		safeSubscribe('ydb:auth.token.refreshed', (msg) => {
			emit(SeverityNumber.DEBUG, 'ydb:auth.token.refreshed', toAttrs(msg))
		}),
		safeSubscribe('ydb:auth.token.expired', (msg) => {
			emit(SeverityNumber.INFO, 'ydb:auth.token.expired', toAttrs(msg))
		}),
		safeSubscribe('ydb:auth.provider.failed', (msg) => {
			emit(SeverityNumber.WARN, 'ydb:auth.provider.failed', toAttrs(msg))
		}),

		// ── Retry ─────────────────────────────────────────────────────────────
		safeSubscribe('ydb:retry.exhausted', (msg) => {
			emit(SeverityNumber.WARN, 'ydb:retry.exhausted', toAttrs(msg))
		}),

		// ── Tracing channel errors → ERROR ────────────────────────────────────
		safeTracingSubscribe('tracing:ydb:driver.init', {
			error: (msg) => emitTracingError('tracing:ydb:driver.init', msg),
		}),
		safeTracingSubscribe('tracing:ydb:discovery', {
			error: (msg) => emitTracingError('tracing:ydb:discovery', msg),
		}),
		safeTracingSubscribe('tracing:ydb:auth.token.fetch', {
			error: (msg) => emitTracingError('tracing:ydb:auth.token.fetch', msg),
		}),
		safeTracingSubscribe('tracing:ydb:session.acquire', {
			error: (msg) => emitTracingError('tracing:ydb:session.acquire', msg),
		}),
		safeTracingSubscribe('tracing:ydb:session.create', {
			error: (msg) => emitTracingError('tracing:ydb:session.create', msg),
		}),
		safeTracingSubscribe('tracing:ydb:query.execute', {
			error: (msg) => emitTracingError('tracing:ydb:query.execute', msg),
		}),
		safeTracingSubscribe('tracing:ydb:query.transaction', {
			error: (msg) => emitTracingError('tracing:ydb:query.transaction', msg),
		}),
		safeTracingSubscribe('tracing:ydb:retry.run', {
			error: (msg) => emitTracingError('tracing:ydb:retry.run', msg),
		}),
		safeTracingSubscribe('tracing:ydb:retry.attempt', {
			error: (msg) => emitTracingError('tracing:ydb:retry.attempt', msg),
		}),
	]

	return () => {
		for (let unsub of unsubs) unsub()
	}
}
