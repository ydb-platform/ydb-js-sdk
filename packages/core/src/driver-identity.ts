/**
 * Stable identity stamped onto diagnostics_channel payloads so multi-driver
 * subscribers (telemetry / metrics) can attribute events to the right Driver
 * without relying on AsyncLocalStorage. Producers attach this to the channel
 * payload at publish-time; subscribers read it from the payload.
 */
export type DriverIdentity = {
	database: string
	address: string
	port?: number
}
