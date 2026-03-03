import { create } from '@bufbuild/protobuf'
import { anyUnpack } from '@bufbuild/protobuf/wkt'
import { StatusIds_StatusCode } from '@ydbjs/api/operation'
import type { Entry } from '@ydbjs/api/scheme'
import {
	type Config,
	ConfigSchema,
	ConsistencyMode,
	CoordinationServiceDefinition,
	DescribeNodeResultSchema,
	RateLimiterCountersMode,
} from '@ydbjs/api/coordination'
import type { Driver } from '@ydbjs/core'
import { loggers } from '@ydbjs/debug'
import { YDBError } from '@ydbjs/error'

let dbg = loggers.driver.extend('coordination')

/**
 * Consistency mode for coordination operations
 *
 * Re-exported from @ydbjs/api for convenience
 */
export { ConsistencyMode }

/**
 * Rate limiter counters mode
 *
 * Re-exported from @ydbjs/api for convenience
 */
export { RateLimiterCountersMode }

/**
 * Configuration settings for a coordination node
 */
export interface CoordinationNodeConfig {
	/**
	 * Period in milliseconds for self-checks (default 1 second)
	 */
	selfCheckPeriodMillis?: number

	/**
	 * Grace period for sessions on leader change (default 10 seconds)
	 */
	sessionGracePeriodMillis?: number

	/**
	 * Consistency mode for read operations
	 */
	readConsistencyMode?: ConsistencyMode

	/**
	 * Consistency mode for attach operations
	 */
	attachConsistencyMode?: ConsistencyMode

	/**
	 * Rate limiter counters mode
	 */
	rateLimiterCountersMode?: RateLimiterCountersMode
}

/**
 * Description of a coordination node
 */
export interface CoordinationNodeDescription {
	/**
	 * Node metadata (name, type, owner, etc.)
	 */
	self?: Entry

	/**
	 * Node configuration settings
	 */
	config?: Config
}

/**
 * Converts CoordinationNodeConfig to protobuf Config message
 * Note: path field is omitted as it's initialized by the server ("cannot be set")
 */
function buildConfig(config?: CoordinationNodeConfig) {
	let configInit: {
		selfCheckPeriodMillis?: number
		sessionGracePeriodMillis?: number
		readConsistencyMode?: ConsistencyMode
		attachConsistencyMode?: ConsistencyMode
		rateLimiterCountersMode?: RateLimiterCountersMode
	} = {}
	if (config?.selfCheckPeriodMillis !== undefined) {
		configInit.selfCheckPeriodMillis = config.selfCheckPeriodMillis
	}
	if (config?.sessionGracePeriodMillis !== undefined) {
		configInit.sessionGracePeriodMillis = config.sessionGracePeriodMillis
	}
	if (config?.readConsistencyMode !== undefined) {
		configInit.readConsistencyMode = config.readConsistencyMode
	}
	if (config?.attachConsistencyMode !== undefined) {
		configInit.attachConsistencyMode = config.attachConsistencyMode
	}
	if (config?.rateLimiterCountersMode !== undefined) {
		configInit.rateLimiterCountersMode = config.rateLimiterCountersMode
	}
	return create(ConfigSchema, configInit)
}

export async function createNode(
	driver: Driver,
	path: string,
	config?: CoordinationNodeConfig,
	signal?: AbortSignal
): Promise<void> {
	dbg.log('creating coordination node: %s', path)
	await driver.ready()

	let client = driver.createClient(CoordinationServiceDefinition)

	let configMsg = buildConfig(config)

	let response = await client.createNode(
		{
			path,
			config: configMsg,
		},
		signal ? { signal } : {}
	)

	if (response.operation?.status !== StatusIds_StatusCode.SUCCESS) {
		dbg.log(
			'failed to create coordination node, status: %d',
			response.operation?.status
		)
		throw new YDBError(
			response.operation?.status ??
				StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED,
			response.operation?.issues ?? []
		)
	}

	dbg.log('coordination node created successfully: %s', path)
}

export async function alterNode(
	driver: Driver,
	path: string,
	config?: CoordinationNodeConfig,
	signal?: AbortSignal
): Promise<void> {
	dbg.log('altering coordination node: %s', path)
	await driver.ready()

	let client = driver.createClient(CoordinationServiceDefinition)

	let configMsg = buildConfig(config)

	let response = await client.alterNode(
		{
			path,
			config: configMsg,
		},
		signal ? { signal } : {}
	)

	if (response.operation?.status !== StatusIds_StatusCode.SUCCESS) {
		dbg.log(
			'failed to alter coordination node, status: %d',
			response.operation?.status
		)
		throw new YDBError(
			response.operation?.status ??
				StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED,
			response.operation?.issues ?? []
		)
	}

	dbg.log('coordination node altered successfully: %s', path)
}

export async function dropNode(
	driver: Driver,
	path: string,
	signal?: AbortSignal
): Promise<void> {
	dbg.log('dropping coordination node: %s', path)
	await driver.ready()

	let client = driver.createClient(CoordinationServiceDefinition)

	let response = await client.dropNode(
		{
			path,
		},
		signal ? { signal } : {}
	)

	if (response.operation?.status !== StatusIds_StatusCode.SUCCESS) {
		dbg.log(
			'failed to drop coordination node, status: %d',
			response.operation?.status
		)
		throw new YDBError(
			response.operation?.status ??
				StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED,
			response.operation?.issues ?? []
		)
	}

	dbg.log('coordination node dropped successfully: %s', path)
}

export async function describeNode(
	driver: Driver,
	path: string,
	signal?: AbortSignal
): Promise<CoordinationNodeDescription> {
	dbg.log('describing coordination node: %s', path)
	await driver.ready()

	let client = driver.createClient(CoordinationServiceDefinition)

	let response = await client.describeNode(
		{
			path,
		},
		signal ? { signal } : {}
	)

	if (response.operation?.status !== StatusIds_StatusCode.SUCCESS) {
		dbg.log(
			'failed to describe coordination node, status: %d',
			response.operation?.status
		)
		throw new YDBError(
			response.operation?.status ??
				StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED,
			response.operation?.issues ?? []
		)
	}

	dbg.log('coordination node described successfully: %s', path)

	// Unpack the Any type result
	let result = response.operation?.result
		? anyUnpack(response.operation.result, DescribeNodeResultSchema)
		: undefined

	let description: CoordinationNodeDescription = {}
	if (result?.self !== undefined) {
		description.self = result.self
	}
	if (result?.config !== undefined) {
		description.config = result.config
	}
	return description
}
