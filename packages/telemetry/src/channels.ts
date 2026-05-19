import { type Attributes, type Span, SpanKind } from '@opentelemetry/api'
import {
	ATTR_DB_OPERATION_NAME,
	ATTR_DB_QUERY_TEXT,
	ATTR_NETWORK_PEER_ADDRESS,
} from '@opentelemetry/semantic-conventions'

import { leafOperation } from './operations.js'
import {
	ATTR_YDB_AUTH_PROVIDER,
	ATTR_YDB_DISCOVERY_ADDED_COUNT,
	ATTR_YDB_DISCOVERY_DURATION,
	ATTR_YDB_DISCOVERY_REMOVED_COUNT,
	ATTR_YDB_DISCOVERY_TOTAL_COUNT,
	ATTR_YDB_DRIVER_CONNECTION_PESSIMIZATION_DURATION,
	ATTR_YDB_DRIVER_CONNECTION_PESSIMIZATION_UNTIL,
	ATTR_YDB_DRIVER_CONNECTION_REMOVE_REASON,
	ATTR_YDB_DRIVER_CONNECTION_RETIRE_REASON,
	ATTR_YDB_IDEMPOTENT,
	ATTR_YDB_ISOLATION,
	ATTR_YDB_NODE_DC,
	ATTR_YDB_NODE_ID,
	ATTR_YDB_RETRY_ATTEMPT,
	ATTR_YDB_RETRY_ATTEMPTS_TOTAL,
	ATTR_YDB_RETRY_BACKOFF,
	ATTR_YDB_RETRY_TOTAL_DURATION,
	ATTR_YDB_SESSION_CLOSE_REASON,
	ATTR_YDB_SESSION_ID,
	ATTR_YDB_SESSION_UPTIME,
	ATTR_YDB_TRANSACTION_ID,
	EVENT_YDB_DRIVER_CONNECTION_ADDED,
	EVENT_YDB_DRIVER_CONNECTION_PESSIMIZED,
	EVENT_YDB_DRIVER_CONNECTION_REMOVED,
	EVENT_YDB_DRIVER_CONNECTION_RETIRED,
	EVENT_YDB_DRIVER_CONNECTION_UNPESSIMIZED,
} from './semconv/index.js'

// `ctx: never` makes every row's stricter `(ctx: T) => Attributes` assignable
// to this signature; the trace pipeline narrows it via `ctx as never` at the
// call site, keeping `any` out of the public type.
export type TracingChannelEntry = {
	channel: string
	span: string
	kind: SpanKind
	attrs?: (ctx: never) => Attributes
}

export type EventChannelEntry = {
	channel: string
	apply: (msg: never, span: Span) => void
}

export type ChannelTableOptions = {
	captureQueryText: boolean
	emitAcquireSessionSpan: boolean
}

// Build a CLIENT-leaf row. `channel` and `span` come from the canonical
// `LEAF_OPERATIONS` table, and `ATTR_DB_OPERATION_NAME` is prefilled from
// the same entry, so adding a new operation only requires editing
// `operations.ts`. `extra` contributes the per-row payload attributes.
function leafRow<T>(channel: string, extra?: (ctx: T) => Attributes): TracingChannelEntry {
	let op = leafOperation(channel)
	let attrs = (ctx: T): Attributes => ({
		[ATTR_DB_OPERATION_NAME]: op.operation,
		...(extra?.(ctx) ?? {}),
	})
	return {
		channel: op.channel,
		span: op.span,
		kind: SpanKind.CLIENT,
		attrs: attrs as (ctx: never) => Attributes,
	}
}

export function buildTracingChannels(opts: ChannelTableOptions): TracingChannelEntry[] {
	let table: TracingChannelEntry[] = [
		leafRow('tracing:ydb:driver.discovery'),
		{
			channel: 'tracing:ydb:retry.run',
			span: 'ydb.RunWithRetry',
			kind: SpanKind.INTERNAL,
			attrs: (ctx: { idempotent: boolean }) => ({
				[ATTR_YDB_IDEMPOTENT]: ctx.idempotent,
			}),
		},
		{
			channel: 'tracing:ydb:retry.attempt',
			span: 'ydb.Try',
			kind: SpanKind.INTERNAL,
			attrs: (ctx: { attempt: number; idempotent: boolean; backoffMs: number }) => ({
				[ATTR_YDB_RETRY_ATTEMPT]: ctx.attempt,
				[ATTR_YDB_IDEMPOTENT]: ctx.idempotent,
				// ms on the dc bus, seconds on OTel.
				[ATTR_YDB_RETRY_BACKOFF]: ctx.backoffMs / 1000,
			}),
		},
		{
			channel: 'tracing:ydb:query.transaction',
			span: 'ydb.Transaction',
			kind: SpanKind.CLIENT,
			attrs: (ctx: { isolation: string; idempotent: boolean }) => ({
				[ATTR_YDB_ISOLATION]: ctx.isolation,
				[ATTR_YDB_IDEMPOTENT]: ctx.idempotent,
			}),
		},
		leafRow(
			'tracing:ydb:query.begin',
			(ctx: { sessionId: string; nodeId: bigint; isolation: string }) => ({
				[ATTR_YDB_SESSION_ID]: ctx.sessionId,
				[ATTR_YDB_NODE_ID]: Number(ctx.nodeId),
				[ATTR_YDB_ISOLATION]: ctx.isolation,
			})
		),
		leafRow(
			'tracing:ydb:query.execute',
			(ctx: {
				text: string
				sessionId: string
				nodeId: bigint
				idempotent: boolean
				isolation: string
			}) => ({
				[ATTR_YDB_SESSION_ID]: ctx.sessionId,
				[ATTR_YDB_NODE_ID]: Number(ctx.nodeId),
				[ATTR_YDB_IDEMPOTENT]: ctx.idempotent,
				[ATTR_YDB_ISOLATION]: ctx.isolation,
				// Undefined attribute values are dropped by the OTel SDK; this is
				// the hot path so we avoid the extra `{}` literal that a
				// conditional spread would allocate every call.
				[ATTR_DB_QUERY_TEXT]: opts.captureQueryText ? ctx.text : undefined,
			})
		),
		leafRow(
			'tracing:ydb:query.commit',
			(ctx: { sessionId: string; nodeId: bigint; txId: string }) => ({
				[ATTR_YDB_SESSION_ID]: ctx.sessionId,
				[ATTR_YDB_NODE_ID]: Number(ctx.nodeId),
				[ATTR_YDB_TRANSACTION_ID]: ctx.txId,
			})
		),
		leafRow(
			'tracing:ydb:query.rollback',
			(ctx: { sessionId: string; nodeId: bigint; txId: string }) => ({
				[ATTR_YDB_SESSION_ID]: ctx.sessionId,
				[ATTR_YDB_NODE_ID]: Number(ctx.nodeId),
				[ATTR_YDB_TRANSACTION_ID]: ctx.txId,
			})
		),
		leafRow('tracing:ydb:query.session.create'),
		leafRow(
			'tracing:ydb:query.session.delete',
			(ctx: { sessionId: string; nodeId: bigint; reason: string; uptime: number }) => ({
				[ATTR_YDB_SESSION_ID]: ctx.sessionId,
				[ATTR_YDB_NODE_ID]: Number(ctx.nodeId),
				[ATTR_YDB_SESSION_CLOSE_REASON]: ctx.reason,
				// `uptime` arrives in ms (dc-bus convention); OTel expects seconds.
				[ATTR_YDB_SESSION_UPTIME]: ctx.uptime / 1000,
			})
		),
		{
			channel: 'tracing:ydb:auth.token.fetch',
			span: 'ydb.TokenFetch',
			kind: SpanKind.INTERNAL,
			attrs: (ctx: { provider: string }) => ({
				[ATTR_YDB_AUTH_PROVIDER]: ctx.provider,
			}),
		},
	]

	if (opts.emitAcquireSessionSpan) {
		table.push({
			channel: 'tracing:ydb:query.session.acquire',
			span: 'ydb.AcquireSession',
			kind: SpanKind.INTERNAL,
		})
	}

	return table
}

// Rows that attach data to whichever span is currently active. "Summary"
// payloads set attributes (discovery / retry totals); "point-in-time"
// payloads become `span.addEvent`. Events fired with no active span are
// dropped silently — that is the intended behaviour, since these channels
// also feed metrics independently of any trace.
export let EVENT_CHANNELS: EventChannelEntry[] = [
	{
		channel: 'ydb:driver.discovery.completed',
		apply: (
			msg: {
				addedCount: number
				removedCount: number
				totalCount: number
				duration: number
			},
			span
		) => {
			span.setAttributes({
				[ATTR_YDB_DISCOVERY_ADDED_COUNT]: msg.addedCount,
				[ATTR_YDB_DISCOVERY_REMOVED_COUNT]: msg.removedCount,
				[ATTR_YDB_DISCOVERY_TOTAL_COUNT]: msg.totalCount,
				[ATTR_YDB_DISCOVERY_DURATION]: msg.duration / 1000,
			})
		},
	},
	{
		channel: 'ydb:retry.exhausted',
		apply: (msg: { attempts: number; totalDuration: number }, span) => {
			span.setAttributes({
				[ATTR_YDB_RETRY_ATTEMPTS_TOTAL]: msg.attempts,
				[ATTR_YDB_RETRY_TOTAL_DURATION]: msg.totalDuration / 1000,
			})
		},
	},
	{
		channel: 'ydb:driver.connection.added',
		apply: (msg: { nodeId: bigint; address: string; location: string }, span) => {
			span.addEvent(EVENT_YDB_DRIVER_CONNECTION_ADDED, {
				[ATTR_YDB_NODE_ID]: Number(msg.nodeId),
				[ATTR_YDB_NODE_DC]: msg.location,
				[ATTR_NETWORK_PEER_ADDRESS]: msg.address,
			})
		},
	},
	{
		channel: 'ydb:driver.connection.pessimized',
		apply: (
			msg: { nodeId: bigint; address: string; location: string; until: number },
			span
		) => {
			span.addEvent(EVENT_YDB_DRIVER_CONNECTION_PESSIMIZED, {
				[ATTR_YDB_NODE_ID]: Number(msg.nodeId),
				[ATTR_YDB_NODE_DC]: msg.location,
				[ATTR_NETWORK_PEER_ADDRESS]: msg.address,
				[ATTR_YDB_DRIVER_CONNECTION_PESSIMIZATION_UNTIL]: msg.until / 1000,
			})
		},
	},
	{
		channel: 'ydb:driver.connection.unpessimized',
		apply: (
			msg: { nodeId: bigint; address: string; location: string; duration: number },
			span
		) => {
			span.addEvent(EVENT_YDB_DRIVER_CONNECTION_UNPESSIMIZED, {
				[ATTR_YDB_NODE_ID]: Number(msg.nodeId),
				[ATTR_YDB_NODE_DC]: msg.location,
				[ATTR_NETWORK_PEER_ADDRESS]: msg.address,
				[ATTR_YDB_DRIVER_CONNECTION_PESSIMIZATION_DURATION]: msg.duration / 1000,
			})
		},
	},
	{
		channel: 'ydb:driver.connection.retired',
		apply: (
			msg: { nodeId: bigint; address: string; location: string; reason: string },
			span
		) => {
			span.addEvent(EVENT_YDB_DRIVER_CONNECTION_RETIRED, {
				[ATTR_YDB_NODE_ID]: Number(msg.nodeId),
				[ATTR_YDB_NODE_DC]: msg.location,
				[ATTR_NETWORK_PEER_ADDRESS]: msg.address,
				[ATTR_YDB_DRIVER_CONNECTION_RETIRE_REASON]: msg.reason,
			})
		},
	},
	{
		channel: 'ydb:driver.connection.removed',
		apply: (
			msg: { nodeId: bigint; address: string; location: string; reason: string },
			span
		) => {
			span.addEvent(EVENT_YDB_DRIVER_CONNECTION_REMOVED, {
				[ATTR_YDB_NODE_ID]: Number(msg.nodeId),
				[ATTR_YDB_NODE_DC]: msg.location,
				[ATTR_NETWORK_PEER_ADDRESS]: msg.address,
				[ATTR_YDB_DRIVER_CONNECTION_REMOVE_REASON]: msg.reason,
			})
		},
	},
]
