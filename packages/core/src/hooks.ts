import { loggers } from '@ydbjs/debug'

let dbg = loggers.driver.extend('hooks')

/**
 * Invoke a user hook, swallowing and logging any throw. A hook must never break
 * the request path or the driver's internal loops, so both `BalancedChannel` and
 * the `EndpointPool` route their hook calls through here. Returns the hook's
 * value (or `undefined` if it is unset or threw).
 */
export let safeHook = function safeHook<A, R>(
	name: string,
	fn: ((arg: A) => R) | undefined,
	arg?: A
): R | undefined {
	if (fn === undefined) return undefined
	try {
		return fn(arg as A)
	} catch (error) {
		dbg.log('hook %s threw an error (swallowed): %O', name, error)
		return undefined
	}
}

/**
 * Read-only snapshot of endpoint metadata from discovery.
 */
export interface EndpointInfo {
	readonly nodeId: bigint
	/** 'host:port' */
	readonly address: string
	/** Datacenter / availability zone, e.g. 'sas', 'vla' */
	readonly location: string
}

/**
 * Fired synchronously inside BalancedChannel.createCall(), in the caller's
 * async context, when an RPC is dispatched to a selected endpoint.
 */
export interface CallStartEvent {
	/** Full gRPC method path, e.g. '/Ydb.Query.V1.QueryService/ExecuteQuery' */
	method: string
	/** The endpoint selected for this RPC (frozen object from Connection) */
	endpoint: EndpointInfo
	/** True if the selected endpoint matched the requested preferNodeId */
	preferred: boolean
	/** Pool state at the moment of endpoint selection */
	pool: {
		activeCount: number
		pessimizedCount: number
	}
}

/**
 * Fired exactly once when the RPC completes (unary response, stream close, or error).
 * Runs in the original async context (restored via AsyncLocalStorage.snapshot()).
 */
export interface CallCompleteEvent {
	/** gRPC status code: 0 = OK, 14 = UNAVAILABLE, etc. */
	grpcStatusCode: number
	/**
	 * Wall-clock time from createCall() to onReceiveStatus, in milliseconds.
	 *
	 * For unary RPCs this is the round-trip latency. For streaming RPCs
	 * (server-streaming, bidi) this includes the entire stream lifetime —
	 * from the moment the stream was opened until it closed or errored.
	 */
	duration: number
}

/**
 * Fired when a connection is moved out of active rotation.
 */
export interface PessimizeEvent {
	endpoint: EndpointInfo
}

/**
 * Fired when a previously pessimized connection is restored to active rotation —
 * on the next successful RPC to it, or a blanket un-ban on any successful
 * discovery round (there is no fixed pessimization timer).
 */
export interface UnpessimizeEvent {
	endpoint: EndpointInfo
}

/**
 * Fired when a discovery round completed successfully.
 */
export interface DiscoveryEvent {
	/** Endpoints that entered routing this round (newly discovered or revived). */
	added: ReadonlyArray<EndpointInfo>
	/** Endpoints that left routing this round (retired — dropped from discovery). */
	removed: ReadonlyArray<EndpointInfo>
	/** Round duration in milliseconds. */
	duration: number
	/**
	 * The full known endpoint set after this round — includes pessimized and
	 * retired (affinity-only) entries, not just the balanced-routable ones, so a
	 * node retired by this round appears in both `removed` and here until it is
	 * reaped.
	 */
	endpoints: ReadonlyArray<EndpointInfo>
}

/**
 * Fired when a discovery round failed.
 */
export interface DiscoveryErrorEvent {
	error: unknown
	attempt: number
	duration: number
}

/**
 * Optional callbacks for driver-level observability.
 *
 * All hooks are synchronous and must not throw. If a hook throws,
 * the error is logged via @ydbjs/debug and swallowed — it must never
 * affect the request path.
 *
 * @example Metrics only (no return from onCall):
 * ```ts
 * hooks: {
 *   onCall(event) {
 *     rpcStarted.add(1, { method: event.method, node_id: String(event.endpoint.nodeId) })
 *   }
 * }
 * ```
 *
 * @example Span lifecycle (return completion callback from onCall):
 * ```ts
 * hooks: {
 *   onCall(event) {
 *     let span = tracer.startSpan('ydb.rpc', { attributes: { 'ydb.node_id': Number(event.endpoint.nodeId) } })
 *     return (complete) => {
 *       span.setAttribute('rpc.grpc.status_code', complete.grpcStatusCode)
 *       span.end()
 *     }
 *   }
 * }
 * ```
 */
export interface DriverHooks {
	/**
	 * Called when an RPC is dispatched to an endpoint.
	 *
	 * May return a completion callback. If returned, it is called exactly once
	 * when the RPC ends (unary response, stream close, or error). The completion
	 * callback also runs in the original async context (restored via
	 * AsyncLocalStorage.snapshot()).
	 *
	 * If no return value — fire-and-forget (useful for simple counters).
	 */
	onCall?(event: CallStartEvent): void | ((complete: CallCompleteEvent) => void)

	/**
	 * A connection was pessimized (moved out of active rotation).
	 */
	onPessimize?(event: PessimizeEvent): void

	/**
	 * A previously pessimized connection was restored to active rotation — on the
	 * next successful RPC to it, or a blanket un-ban on a successful discovery
	 * round.
	 */
	onUnpessimize?(event: UnpessimizeEvent): void

	/**
	 * A discovery round completed successfully.
	 */
	onDiscovery?(event: DiscoveryEvent): void

	/**
	 * A discovery round failed.
	 */
	onDiscoveryError?(event: DiscoveryErrorEvent): void
}
