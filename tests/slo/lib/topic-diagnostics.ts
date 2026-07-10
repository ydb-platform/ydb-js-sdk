import diagnostics_channel from 'node:diagnostics_channel'
import { inspect } from 'node:util'

// Subscribe to the topic writer/reader diagnostics_channel events and print each to
// stderr as structured lifecycle lines. This complements verbose `DEBUG='ydbjs:*'`
// output: the DC events are machine-parseable (session / reconnect / error payloads),
// so a run can be asserted on them. diagnostics_channel is thread-local, so the
// subscriber must run in the same worker thread as the writer/reader — attach it
// out-of-band via `--import ./instrument.js`.
//
//   using _dc = subscribeTopicDiagnostics()
type Subscription = [name: string, handler: (message: unknown) => void]

let subscriber = function subscriber(): {
	on: (name: string, format: (message: any) => string) => void
	dispose: Disposable
} {
	let subscriptions: Subscription[] = []
	let on = (name: string, format: (message: any) => string): void => {
		let handler = (message: any): void => {
			console.error('[dc] %s | %s', name, format(message))
		}
		diagnostics_channel.subscribe(name, handler)
		subscriptions.push([name, handler])
	}
	return {
		on,
		dispose: {
			[Symbol.dispose]() {
				for (let [name, handler] of subscriptions) {
					diagnostics_channel.unsubscribe(name, handler)
				}
			},
		},
	}
}

export function subscribeWriterDiagnostics(): Disposable {
	let { on, dispose } = subscriber()
	on(
		'ydb:topic.writer.session.started',
		(m) => `${m.producer} session=${m.sessionId} lastSeqNo=${m.lastSeqNo}`
	)
	on(
		'ydb:topic.writer.reconnecting',
		(m) => `${m.producer} attempt=${m.attempt} error=${inspect(m.error, { depth: 6 })}`
	)
	on(
		'ydb:topic.writer.errored',
		(m) => `${m.producer} TERMINAL error=${inspect(m.error, { depth: 6 })}`
	)
	on('ydb:topic.writer.closed', (m) => `${m.producer} closed`)
	return dispose
}

export function subscribeReaderDiagnostics(): Disposable {
	let { on, dispose } = subscriber()
	on(
		'ydb:topic.reader.partition.started',
		(m) =>
			`${m.consumer} p=${m.partitionId} session=${m.partitionSessionId} committed=${m.committedOffset}`
	)
	on('ydb:topic.reader.partition.stopped', (m) => `${m.consumer} p=${m.partitionId} ${m.reason}`)
	on(
		'ydb:topic.reader.reconnecting',
		(m) => `${m.consumer} attempt=${m.attempt} error=${inspect(m.error, { depth: 6 })}`
	)
	on(
		'ydb:topic.reader.errored',
		(m) => `${m.consumer} TERMINAL error=${inspect(m.error, { depth: 6 })}`
	)
	on('ydb:topic.reader.closed', (m) => `${m.consumer} closed`)
	return dispose
}

export function subscribeTopicDiagnostics(): Disposable {
	let writer = subscribeWriterDiagnostics()
	let reader = subscribeReaderDiagnostics()
	return {
		[Symbol.dispose]() {
			writer[Symbol.dispose]()
			reader[Symbol.dispose]()
		},
	}
}
