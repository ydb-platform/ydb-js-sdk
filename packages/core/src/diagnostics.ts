import { channel } from 'node:diagnostics_channel'

// Publisher identities must survive driver lifetimes and garbage collection.
export let driverChannels = {
	ready: channel('ydb:driver.ready'),
	failed: channel('ydb:driver.failed'),
	closed: channel('ydb:driver.closed'),
	connectionAdded: channel('ydb:driver.connection.added'),
	connectionRetired: channel('ydb:driver.connection.retired'),
	connectionRemoved: channel('ydb:driver.connection.removed'),
	connectionPessimized: channel('ydb:driver.connection.pessimized'),
	connectionUnpessimized: channel('ydb:driver.connection.unpessimized'),
	poolOpened: channel('ydb:driver.connection.pool.opened'),
	poolStats: channel('ydb:driver.connection.pool.stats'),
	discoveryCompleted: channel('ydb:driver.discovery.completed'),
	pileChanged: channel('ydb:driver.pile.changed'),
	pileFallback: channel('ydb:driver.pile.fallback'),
} as const
