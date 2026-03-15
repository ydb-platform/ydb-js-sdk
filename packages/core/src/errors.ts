export class DriverCSError extends Error {
	constructor(msg: string) {
		super(`Invalid connection string. ${msg}`)
		this.name = 'DriverCSError'
	}
}

export class DriverCSProtocolError extends DriverCSError {
	constructor() {
		super('Protocol must be one of grpc, grpcs, http, https.')
		this.name = 'DriverCSProtocolError'
	}
}

export class DriverCSDatabaseError extends DriverCSError {
	constructor() {
		super('Database name is required in pathname or querystring.')
		this.name = 'DriverCSDatabaseError'
	}
}

export class DriverOptionsError extends Error {
	constructor(msg: string) {
		super(`Invalid driver options. ${msg}`)
		this.name = 'DriverOptionsError'
	}
}

export class DriverDiscoveryTimeoutError extends DriverOptionsError {
	constructor(actual: number) {
		super(`discovery_timeout_ms must be greater than 0. Received: ${actual}`)
		this.name = 'DriverDiscoveryTimeoutError'
	}
}

export class DriverDiscoveryIntervalError extends DriverOptionsError {
	constructor(actual: number) {
		super(`discovery_interval_ms must be greater than 0. Received: ${actual}`)
		this.name = 'DriverDiscoveryIntervalError'
	}
}

export class DriverDiscoveryOptionsError extends DriverOptionsError {
	constructor() {
		super(`discovery_interval_ms must be greater than discovery_timeout_ms.`)
		this.name = 'DriverDiscoveryOptionsError'
	}
}

export class DriverResponseError extends Error {
	constructor(msg: string) {
		super(`Invalid response. ${msg}`)
		this.name = 'DriverResponseError'
	}
}
