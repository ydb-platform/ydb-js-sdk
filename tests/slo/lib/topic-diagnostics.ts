import diagnostics_channel from 'node:diagnostics_channel'
import { inspect } from 'node:util'

// Subscribe to the topic writer's diagnostics channels and print each lifecycle
// event to stderr. Complements DEBUG logs with the structured DC payloads the
// writer publishes (reconnect attempt counts, terminal errors) — the signal you
// want when diagnosing behaviour under chaos.
//
//   using _dc = subscribeWriterDiagnostics()
type Subscription = [name: string, handler: (message: unknown) => void]

export function subscribeWriterDiagnostics(): Disposable {
	let subscriptions: Subscription[] = []

	let on = (name: string, format: (message: any) => string): void => {
		let handler = (message: any): void => {
			console.error('[dc] %s | %s', name, format(message))
		}
		diagnostics_channel.subscribe(name, handler)
		subscriptions.push([name, handler])
	}

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

	return {
		[Symbol.dispose]() {
			for (let [name, handler] of subscriptions) {
				diagnostics_channel.unsubscribe(name, handler)
			}
		},
	}
}
