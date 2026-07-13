export type { DriverIdentity } from './driver-identity.js'
export * from './driver.js'
export type {
	CallCompleteEvent,
	CallStartEvent,
	DiscoveryErrorEvent,
	DiscoveryEvent,
	DriverHooks,
	EndpointInfo,
	PessimizeEvent,
	UnpessimizeEvent,
} from './hooks.js'
export { addClientMiddleware } from './middleware.js'
export {
	DriverCSError,
	DriverCSProtocolError,
	DriverCSDatabaseError,
	DriverOptionsError,
	DriverDiscoveryTimeoutError,
	DriverDiscoveryIntervalError,
	DriverDiscoveryOptionsError,
	DriverDegradedThresholdError,
	DriverResponseError,
	EndpointsUnavailableError,
} from './errors.js'

// The endpoints engine (src/endpoints/*) is an internal implementation detail of
// Driver. Consumers only ever hold a Driver — direct-IO is reached through
// `Driver.createClient(service, { nodeId, endpoint, hard })`, not by touching the
// pool. So EndpointPool / createEndpointsRuntime / selectEndpoint / buildSnapshot
// and their types are intentionally NOT exported.
