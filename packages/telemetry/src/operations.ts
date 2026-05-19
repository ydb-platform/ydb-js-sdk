// Canonical table of CLIENT-leaf YDB operations. Each row binds a
// `tracingChannel` name to its `db.operation.name` value and to the span
// name we emit. Both the trace pipeline (channels.ts) and the metrics
// pipeline (metrics.ts) pull from this table so adding a new leaf
// operation cannot drift — forget the entry and the trace row loses its
// `ATTR_DB_OPERATION_NAME`; forget the channel and `leafOperation()`
// throws at module load.
//
// Only CLIENT-kind leaves live here. Parent / internal spans
// (`query.transaction`, `retry.run`, `retry.attempt`, `auth.token.fetch`,
// the optional `query.session.acquire`) are NOT operations — they do not
// feed `db.client.operation.duration` and have no `db.operation.name`.

export type LeafOperation = {
	/** `tracingChannel` name (the `tracing:` prefix is included). */
	channel: string
	/** Value placed on `db.operation.name`. Service-qualified. */
	operation: string
	/** Span name (`ydb.*`). */
	span: string
}

export let LEAF_OPERATIONS: ReadonlyArray<LeafOperation> = [
	{
		channel: 'tracing:ydb:driver.discovery',
		operation: 'Discovery.ListEndpoints',
		span: 'ydb.Discovery',
	},
	{ channel: 'tracing:ydb:query.begin', operation: 'Query.BeginTransaction', span: 'ydb.Begin' },
	{
		channel: 'tracing:ydb:query.execute',
		operation: 'Query.ExecuteQuery',
		span: 'ydb.ExecuteQuery',
	},
	{
		channel: 'tracing:ydb:query.commit',
		operation: 'Query.CommitTransaction',
		span: 'ydb.Commit',
	},
	{
		channel: 'tracing:ydb:query.rollback',
		operation: 'Query.RollbackTransaction',
		span: 'ydb.Rollback',
	},
	{
		channel: 'tracing:ydb:query.session.create',
		operation: 'Query.CreateSession',
		span: 'ydb.CreateSession',
	},
	{
		channel: 'tracing:ydb:query.session.delete',
		operation: 'Query.DeleteSession',
		span: 'ydb.DeleteSession',
	},
]

let byChannel: ReadonlyMap<string, LeafOperation> = new Map(
	LEAF_OPERATIONS.map((row) => [row.channel, row])
)

export function leafOperation(channel: string): LeafOperation {
	let row = byChannel.get(channel)
	if (!row) {
		throw new Error(
			`leafOperation: no entry for channel "${channel}". Add it to LEAF_OPERATIONS in operations.ts.`
		)
	}
	return row
}
