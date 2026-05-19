import { channel as plainChannel, tracingChannel } from 'node:diagnostics_channel'

import type {
	BatchObservableResult,
	Counter,
	Histogram,
	Meter,
	MetricAttributes,
	ObservableGauge,
	ObservableUpDownCounter,
} from '@opentelemetry/api'
import { ATTR_DB_OPERATION_NAME } from '@opentelemetry/semantic-conventions'

import type { DriverIdentity } from '@ydbjs/core'

import { LEAF_OPERATIONS } from './operations.js'
import { ConnectionPoolRegistry } from './state/connection-pool.js'
import { SessionPoolRegistry } from './state/session-pool.js'
import {
	ATTR_YDB_AUTH_PROVIDER,
	ATTR_YDB_CONNECTION_STATE,
	ATTR_YDB_IDEMPOTENT,
	ATTR_YDB_RETRY_OUTCOME,
	ATTR_YDB_SESSION_CLOSE_REASON,
	ATTR_YDB_SESSION_STATE,
	BASE_ATTRIBUTES,
	METRIC_DB_CLIENT_OPERATION_DURATION,
	METRIC_YDB_AUTH_TOKEN_EXPIRATIONS,
	METRIC_YDB_AUTH_TOKEN_FETCH_DURATION,
	METRIC_YDB_AUTH_TOKEN_FETCH_FAILURES,
	METRIC_YDB_DRIVER_CONNECTION_COUNT,
	METRIC_YDB_DRIVER_CONNECTION_PESSIMIZATIONS,
	METRIC_YDB_QUERY_SESSION_ACQUIRE_DURATION,
	METRIC_YDB_QUERY_SESSION_ACQUIRE_FAILURES,
	METRIC_YDB_QUERY_SESSION_ACQUIRE_PENDING,
	METRIC_YDB_QUERY_SESSION_CLOSED,
	METRIC_YDB_QUERY_SESSION_COUNT,
	METRIC_YDB_QUERY_SESSION_CREATE_DURATION,
	METRIC_YDB_QUERY_SESSION_MAX,
	METRIC_YDB_QUERY_SESSION_MIN,
	METRIC_YDB_RETRY_ATTEMPTS,
	METRIC_YDB_RETRY_DURATION,
	identityAttrs,
	recordErrorAttributes,
} from './semconv/index.js'

function baseFor(driver: DriverIdentity | undefined): MetricAttributes {
	return { ...BASE_ATTRIBUTES, ...identityAttrs(driver) }
}

type DurationCtx = { driver?: DriverIdentity }

/**
 * Metrics pipeline. Owns OTel instruments and subscribes `diagnostics_channel`
 * events into them. State for observable instruments is split per domain —
 * connection-pool vs session-pool — and is rebuilt from channel events only,
 * never by reaching into pool internals. Late subscribers therefore miss the
 * initial state of an already-running driver.
 */
export class YdbMetricsPipeline {
	#meter: Meter
	#connectionState = new ConnectionPoolRegistry()
	#sessionState = new SessionPoolRegistry()
	#subs: Disposable[] = []
	#observableSubs: Disposable[] = []

	#dbClientOperationDuration!: Histogram
	#sessionCreateDuration!: Histogram
	#sessionAcquireDuration!: Histogram
	#authTokenFetchDuration!: Histogram
	#retryDuration!: Histogram

	#connectionPessimizations!: Counter
	#sessionClosed!: Counter
	#sessionAcquireFailures!: Counter
	#authTokenFetchFailures!: Counter
	#authTokenExpirations!: Counter
	#retryAttempts!: Counter

	#connectionCount!: ObservableUpDownCounter
	#sessionCount!: ObservableUpDownCounter
	#sessionAcquirePending!: ObservableUpDownCounter
	#sessionMax!: ObservableGauge
	#sessionMin!: ObservableGauge

	constructor(meter: Meter) {
		this.#meter = meter
		this.#registerInstruments()
	}

	enable(): void {
		if (this.#subs.length > 0) return
		this.#subscribeLeafDurations()
		this.#subscribeConnectionEvents()
		this.#subscribeSessionEvents()
		this.#subscribeAuthEvents()
		this.#subscribeRetryEvents()
		this.#registerObservableCallbacks()
	}

	disable(): void {
		for (let s of this.#subs) s[Symbol.dispose]()
		this.#subs.length = 0
		for (let s of this.#observableSubs) s[Symbol.dispose]()
		this.#observableSubs.length = 0
	}

	#registerInstruments(): void {
		this.#dbClientOperationDuration = this.#meter.createHistogram(
			METRIC_DB_CLIENT_OPERATION_DURATION,
			{
				description: 'Duration of each client-side YDB operation attempt.',
				unit: 's',
			}
		)
		this.#sessionCreateDuration = this.#meter.createHistogram(
			METRIC_YDB_QUERY_SESSION_CREATE_DURATION,
			{
				description:
					'Time to create a query session (CreateSession + AttachStream first message).',
				unit: 's',
			}
		)
		this.#sessionAcquireDuration = this.#meter.createHistogram(
			METRIC_YDB_QUERY_SESSION_ACQUIRE_DURATION,
			{
				description: 'Time to acquire a session lease from the pool.',
				unit: 's',
			}
		)
		this.#authTokenFetchDuration = this.#meter.createHistogram(
			METRIC_YDB_AUTH_TOKEN_FETCH_DURATION,
			{
				description: 'Duration of a token fetch / refresh.',
				unit: 's',
			}
		)
		this.#retryDuration = this.#meter.createHistogram(METRIC_YDB_RETRY_DURATION, {
			description: 'End-to-end duration of a retry loop including backoffs.',
			unit: 's',
		})

		this.#connectionPessimizations = this.#meter.createCounter(
			METRIC_YDB_DRIVER_CONNECTION_PESSIMIZATIONS,
			{
				description: 'Count of connection pessimization events.',
				unit: '{event}',
			}
		)
		this.#sessionClosed = this.#meter.createCounter(METRIC_YDB_QUERY_SESSION_CLOSED, {
			description: 'Count of session removals, tagged by close reason.',
			unit: '{session}',
		})
		this.#sessionAcquireFailures = this.#meter.createCounter(
			METRIC_YDB_QUERY_SESSION_ACQUIRE_FAILURES,
			{
				description:
					'Failed session acquires (pool full / pool-internal timeout / pool closed), tagged by error.type. ' +
					'Caller-aborted acquires are not counted as failures — see ydb:query.session.acquire.failed.',
				unit: '{failure}',
			}
		)
		this.#authTokenFetchFailures = this.#meter.createCounter(
			METRIC_YDB_AUTH_TOKEN_FETCH_FAILURES,
			{
				description: 'Failed token fetch / refresh attempts.',
				unit: '{failure}',
			}
		)
		this.#authTokenExpirations = this.#meter.createCounter(METRIC_YDB_AUTH_TOKEN_EXPIRATIONS, {
			description: 'Incidents where a stale (past hard expiry buffer) token was served.',
			unit: '{expiration}',
		})
		this.#retryAttempts = this.#meter.createCounter(METRIC_YDB_RETRY_ATTEMPTS, {
			description: 'Count of retry attempts tagged with outcome.',
			unit: '{attempt}',
		})

		this.#connectionCount = this.#meter.createObservableUpDownCounter(
			METRIC_YDB_DRIVER_CONNECTION_COUNT,
			{
				description: 'Current count of pooled gRPC connections, by state.',
				unit: '{connection}',
			}
		)
		this.#sessionCount = this.#meter.createObservableUpDownCounter(
			METRIC_YDB_QUERY_SESSION_COUNT,
			{
				description: 'Current count of live query sessions in the pool, by state.',
				unit: '{session}',
			}
		)
		this.#sessionAcquirePending = this.#meter.createObservableUpDownCounter(
			METRIC_YDB_QUERY_SESSION_ACQUIRE_PENDING,
			{
				description: 'Callers currently waiting for a session lease.',
				unit: '{request}',
			}
		)
		this.#sessionMax = this.#meter.createObservableGauge(METRIC_YDB_QUERY_SESSION_MAX, {
			description: 'Configured maxSize of the session pool.',
			unit: '{session}',
		})
		this.#sessionMin = this.#meter.createObservableGauge(METRIC_YDB_QUERY_SESSION_MIN, {
			description: 'Configured minSize of the session pool.',
			unit: '{session}',
		})
	}

	#registerObservableCallbacks(): void {
		let cb = (observable: BatchObservableResult) => {
			for (let [driver, state] of this.#connectionState.connections()) {
				let base = baseFor(driver)
				observable.observe(this.#connectionCount, state.live, {
					...base,
					[ATTR_YDB_CONNECTION_STATE]: 'live',
				})
				observable.observe(this.#connectionCount, state.pessimized, {
					...base,
					[ATTR_YDB_CONNECTION_STATE]: 'pessimized',
				})
			}
			for (let [driver, state] of this.#sessionState.sessions()) {
				let base = baseFor(driver)
				let idle = Math.max(0, state.total - state.acquired)
				observable.observe(this.#sessionCount, idle, {
					...base,
					[ATTR_YDB_SESSION_STATE]: 'idle',
				})
				observable.observe(this.#sessionCount, state.acquired, {
					...base,
					[ATTR_YDB_SESSION_STATE]: 'acquired',
				})
				observable.observe(this.#sessionCount, state.creating, {
					...base,
					[ATTR_YDB_SESSION_STATE]: 'creating',
				})
				observable.observe(this.#sessionAcquirePending, state.waiters, base)
				observable.observe(this.#sessionMax, state.maxSize, base)
				observable.observe(this.#sessionMin, state.minSize, base)
			}
		}
		this.#meter.addBatchObservableCallback(cb, [
			this.#connectionCount,
			this.#sessionCount,
			this.#sessionAcquirePending,
			this.#sessionMax,
			this.#sessionMin,
		])
		this.#observableSubs.push({
			[Symbol.dispose]: () => {
				this.#meter.removeBatchObservableCallback(cb, [
					this.#connectionCount,
					this.#sessionCount,
					this.#sessionAcquirePending,
					this.#sessionMax,
					this.#sessionMin,
				])
			},
		})
	}

	#subPlain<T>(name: string, fn: (msg: T) => void): Disposable {
		let ch = plainChannel(name)
		let handler = (msg: unknown) => fn(msg as T)
		ch.subscribe(handler)
		return {
			[Symbol.dispose]() {
				ch.unsubscribe(handler)
			},
		}
	}

	#subDuration(
		channelName: string,
		instrument: Histogram,
		makeAttrs: (ctx: DurationCtx) => MetricAttributes,
		hooks?: { onStart?: (ctx: DurationCtx) => void; onEnd?: (ctx: DurationCtx) => void }
	): Disposable {
		let ch = tracingChannel<DurationCtx, DurationCtx>(channelName)
		// Per-subscription WeakMap, not a pipeline-wide one. The same channel
		// can be subscribed twice (e.g. session.create feeds both the generic
		// `db.client.operation.duration` and the specific
		// `ydb.query.session.create.duration` instruments). Both subscriptions
		// see the same ctx in `start` and `asyncEnd`; a shared map would let
		// whichever handler runs first delete the entry before the other reads
		// it, and the second instrument would silently drop the recording.
		let starts = new WeakMap<object, number>()
		let handlers = {
			start: (ctx: DurationCtx) => {
				starts.set(ctx, performance.now())
				hooks?.onStart?.(ctx)
			},
			asyncEnd: (ctx: DurationCtx) => {
				try {
					let started = starts.get(ctx)
					if (started === undefined) return
					starts.delete(ctx)
					let durationMs = performance.now() - started
					instrument.record(durationMs / 1000, makeAttrs(ctx))
				} finally {
					hooks?.onEnd?.(ctx)
				}
			},
			error: (ctx: DurationCtx & { error?: unknown }) => {
				try {
					let started = starts.get(ctx)
					if (started === undefined) return
					starts.delete(ctx)
					let durationMs = performance.now() - started
					let attrs = makeAttrs(ctx)
					instrument.record(durationMs / 1000, {
						...attrs,
						...recordErrorAttributes(ctx.error),
					})
				} finally {
					hooks?.onEnd?.(ctx)
				}
			},
		}
		ch.subscribe(handlers as Parameters<typeof ch.subscribe>[0])
		return {
			[Symbol.dispose]() {
				ch.unsubscribe(handlers as Parameters<typeof ch.unsubscribe>[0])
			},
		}
	}

	#subscribeLeafDurations(): void {
		for (let { channel, operation } of LEAF_OPERATIONS) {
			this.#subs.push(
				this.#subDuration(channel, this.#dbClientOperationDuration, (ctx) => ({
					...baseFor(ctx.driver),
					[ATTR_DB_OPERATION_NAME]: operation,
				}))
			)
		}

		// `session.create.duration` shares its source channel with the generic
		// `db.client.operation.duration` so dashboards can pivot on either
		// without filtering. The hooks also drive the `creating` observable.
		this.#subs.push(
			this.#subDuration(
				'tracing:ydb:query.session.create',
				this.#sessionCreateDuration,
				(ctx) => baseFor(ctx.driver),
				{
					onStart: (ctx) => {
						if (ctx.driver) this.#sessionState.createStarted(ctx.driver)
					},
					onEnd: (ctx) => {
						if (ctx.driver) this.#sessionState.createEnded(ctx.driver)
					},
				}
			)
		)

		this.#subs.push(
			this.#subDuration(
				'tracing:ydb:query.session.acquire',
				this.#sessionAcquireDuration,
				(ctx) => baseFor(ctx.driver)
			)
		)

		this.#subs.push(
			this.#subDuration(
				'tracing:ydb:auth.token.fetch',
				this.#authTokenFetchDuration,
				(ctx: DurationCtx & { provider?: string }) => ({
					...baseFor(ctx.driver),
					...(ctx.provider !== undefined
						? { [ATTR_YDB_AUTH_PROVIDER]: ctx.provider }
						: {}),
				})
			)
		)

		this.#subs.push(
			this.#subDuration(
				'tracing:ydb:retry.run',
				this.#retryDuration,
				(ctx: DurationCtx & { idempotent?: boolean; outcome?: string }) => ({
					...BASE_ATTRIBUTES,
					...(ctx.idempotent !== undefined
						? { [ATTR_YDB_IDEMPOTENT]: ctx.idempotent }
						: {}),
					...(ctx.outcome !== undefined ? { [ATTR_YDB_RETRY_OUTCOME]: ctx.outcome } : {}),
				})
			)
		)
	}

	#subscribeConnectionEvents(): void {
		this.#subs.push(
			this.#subPlain<{ driver: DriverIdentity }>('ydb:driver.connection.added', (msg) =>
				this.#connectionState.connectionAdded(msg.driver)
			)
		)
		this.#subs.push(
			this.#subPlain<{ driver: DriverIdentity }>(
				'ydb:driver.connection.pessimized',
				(msg) => {
					this.#connectionState.connectionPessimized(msg.driver)
					this.#connectionPessimizations.add(1, baseFor(msg.driver))
				}
			)
		)
		this.#subs.push(
			this.#subPlain<{ driver: DriverIdentity }>(
				'ydb:driver.connection.unpessimized',
				(msg) => this.#connectionState.connectionUnpessimized(msg.driver)
			)
		)
		this.#subs.push(
			this.#subPlain<{ driver: DriverIdentity }>('ydb:driver.connection.retired', (msg) =>
				this.#connectionState.connectionRemoved(msg.driver)
			)
		)
		this.#subs.push(
			this.#subPlain<{ driver: DriverIdentity }>('ydb:driver.connection.removed', (msg) =>
				this.#connectionState.connectionRemoved(msg.driver)
			)
		)
		// Driver close is the safety net for the session registry: if the
		// caller skipped `pool.close()` and let the driver dispose first, this
		// keeps state from leaking.
		this.#subs.push(
			this.#subPlain<{ driver: DriverIdentity }>('ydb:driver.closed', (msg) => {
				this.#connectionState.driverClosed(msg.driver)
				this.#sessionState.driverClosed(msg.driver)
			})
		)
	}

	#subscribeSessionEvents(): void {
		this.#subs.push(
			this.#subPlain<{ driver: DriverIdentity; maxSize: number; minSize: number }>(
				'ydb:query.session.pool.opened',
				(msg) => this.#sessionState.poolOpened(msg.driver, msg.maxSize, msg.minSize)
			)
		)
		this.#subs.push(
			this.#subPlain<{ driver: DriverIdentity }>('ydb:query.session.pool.closed', (msg) =>
				this.#sessionState.poolClosed(msg.driver)
			)
		)
		this.#subs.push(
			this.#subPlain<{ driver: DriverIdentity }>('ydb:query.session.created', (msg) =>
				this.#sessionState.created(msg.driver)
			)
		)
		this.#subs.push(
			this.#subPlain<{ driver: DriverIdentity; reason: string }>(
				'ydb:query.session.closed',
				(msg) => {
					this.#sessionState.closed(msg.driver)
					this.#sessionClosed.add(1, {
						...baseFor(msg.driver),
						[ATTR_YDB_SESSION_CLOSE_REASON]: msg.reason,
					})
				}
			)
		)
		this.#subs.push(
			this.#subPlain<{ driver: DriverIdentity }>('ydb:query.session.acquired', (msg) =>
				this.#sessionState.acquired(msg.driver)
			)
		)
		this.#subs.push(
			this.#subPlain<{ driver: DriverIdentity }>('ydb:query.session.released', (msg) =>
				this.#sessionState.released(msg.driver)
			)
		)
		this.#subs.push(
			this.#subPlain<{ driver: DriverIdentity }>('ydb:query.session.waiter.enqueued', (msg) =>
				this.#sessionState.waiterEnqueued(msg.driver)
			)
		)
		this.#subs.push(
			this.#subPlain<{ driver: DriverIdentity }>('ydb:query.session.waiter.dequeued', (msg) =>
				this.#sessionState.waiterDequeued(msg.driver)
			)
		)
		this.#subs.push(
			this.#subPlain<{ driver: DriverIdentity; error: unknown }>(
				'ydb:query.session.acquire.failed',
				(msg) =>
					this.#sessionAcquireFailures.add(1, {
						...baseFor(msg.driver),
						...recordErrorAttributes(msg.error),
					})
			)
		)
	}

	#subscribeAuthEvents(): void {
		this.#subs.push(
			this.#subPlain<{ provider: string; error: unknown }>(
				'ydb:auth.provider.failed',
				(msg) =>
					this.#authTokenFetchFailures.add(1, {
						...BASE_ATTRIBUTES,
						[ATTR_YDB_AUTH_PROVIDER]: msg.provider,
						...recordErrorAttributes(msg.error),
					})
			)
		)
		this.#subs.push(
			this.#subPlain<{ provider: string }>('ydb:auth.token.expired', (msg) =>
				this.#authTokenExpirations.add(1, {
					...BASE_ATTRIBUTES,
					[ATTR_YDB_AUTH_PROVIDER]: msg.provider,
				})
			)
		)
	}

	#subscribeRetryEvents(): void {
		this.#subs.push(
			this.#subPlain<{ attempt: number; idempotent: boolean; outcome: string }>(
				'ydb:retry.attempt.completed',
				(msg) =>
					this.#retryAttempts.add(1, {
						...BASE_ATTRIBUTES,
						[ATTR_YDB_IDEMPOTENT]: msg.idempotent,
						[ATTR_YDB_RETRY_OUTCOME]: msg.outcome,
					})
			)
		)
	}
}
