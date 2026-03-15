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
 * Fired when a previously pessimized connection is restored to active rotation
 * after the pessimization timeout elapsed.
 */
export interface UnpessimizeEvent {
	endpoint: EndpointInfo
}

/**
 * Fired when a discovery round completed successfully.
 */
export interface DiscoveryEvent {
	/**
	 * Datacenter where the discovery endpoint itself is located
	 * (from ListEndpointsResult.selfLocation). Together with
	 * EndpointInfo.location, allows detecting cross-DC routing.
	 */
	added: ReadonlyArray<EndpointInfo>
	removed: ReadonlyArray<EndpointInfo>
	duration: number
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
	 * A previously pessimized connection was restored to active rotation
	 * after the pessimization timeout elapsed.
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
