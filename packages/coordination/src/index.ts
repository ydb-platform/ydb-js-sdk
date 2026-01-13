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

import { CoordinationSession } from './session.js'

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
 * Options for creating a coordination session
 */
export interface SessionOptions {
	/**
	 * Timeout in milliseconds during which client may restore a detached session
	 */
	timeoutMillis?: number | bigint

	/**
	 * Client-side timeout in milliseconds for establishing the session connection (default: 5000)
	 */
	startTimeoutMillis?: number

	/**
	 * User-defined description that may be used to describe the client
	 */
	description?: string
}

/**
 * High-level coordination client for YDB
 *
 * Provides methods for managing coordination nodes and creating sessions
 * for distributed semaphores and locks.
 *
 * @example
 * ```typescript
 * const client = coordination(driver);
 *
 * // Create a coordination node
 * await client.createNode('/local/my-coordination-node');
 *
 * // Create a session
 * const session = await client.session('/local/my-coordination-node');
 *
 * // Acquire a semaphore
 * await session.acquireSemaphore({ name: 'my-semaphore', count: 1 });
 *
 * // Release the semaphore
 * await session.releaseSemaphore({ name: 'my-semaphore' });
 *
 * // Close the session
 * await session.close();
 * ```
 */
export interface CoordinationClient {
	/**
	 * Creates a new coordination node
	 *
	 * @param path - Path to the coordination node
	 * @param config - Optional configuration settings
	 * @param signal - Optional abort signal for cancellation
	 * @throws {YDBError} If the operation fails
	 */
	createNode(
		path: string,
		config?: CoordinationNodeConfig,
		signal?: AbortSignal
	): Promise<void>

	/**
	 * Modifies settings of a coordination node
	 *
	 * @param path - Path to the coordination node
	 * @param config - Configuration settings to update
	 * @param signal - Optional abort signal for cancellation
	 * @throws {YDBError} If the operation fails
	 */
	alterNode(
		path: string,
		config?: CoordinationNodeConfig,
		signal?: AbortSignal
	): Promise<void>

	/**
	 * Drops a coordination node
	 *
	 * @param path - Path to the coordination node
	 * @param signal - Optional abort signal for cancellation
	 * @throws {YDBError} If the operation fails
	 */
	dropNode(path: string, signal?: AbortSignal): Promise<void>

	/**
	 * Describes a coordination node
	 *
	 * @param path - Path to the coordination node
	 * @param signal - Optional abort signal for cancellation
	 * @returns Node description with metadata and configuration
	 * @throws {YDBError} If the operation fails
	 */
	describeNode(
		path: string,
		signal?: AbortSignal
	): Promise<CoordinationNodeDescription>

	/**
	 * Creates a new coordination session
	 *
	 * @param path - Path to the coordination node
	 * @param options - Optional session configuration
	 * @returns A coordination session instance
	 * @throws {YDBError} If the operation fails
	 */
	session(
		path: string,
		options?: SessionOptions
	): Promise<CoordinationSession>
}

/**
 * Converts CoordinationNodeConfig to protobuf Config message
 * Note: path field is omitted as it's initialized by the server ("cannot be set")
 */
function buildConfig(config?: CoordinationNodeConfig) {
	let configInit: any = {}
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

/**
 * Creates a coordination client for managing coordination nodes and sessions
 *
 * @param driver - The YDB driver instance
 * @returns A coordination client instance
 *
 * @example
 * ```typescript
 * import { Driver } from '@ydbjs/core';
 * import { coordination } from '@ydbjs/coordination';
 *
 * const driver = new Driver('grpc://localhost:2136/local');
 * const client = coordination(driver);
 *
 * // Create a coordination node
 * await client.createNode('/local/my-coordination-node');
 * ```
 */
export function coordination(driver: Driver): CoordinationClient {
	async function createNode(
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
				response.operation?.status ||
					StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED,
				response.operation?.issues || []
			)
		}

		dbg.log('coordination node created successfully: %s', path)
	}

	async function alterNode(
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
				response.operation?.status ||
					StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED,
				response.operation?.issues || []
			)
		}

		dbg.log('coordination node altered successfully: %s', path)
	}

	async function dropNode(path: string, signal?: AbortSignal): Promise<void> {
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
				response.operation?.status ||
					StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED,
				response.operation?.issues || []
			)
		}

		dbg.log('coordination node dropped successfully: %s', path)
	}

	async function describeNode(
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
				response.operation?.status ||
					StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED,
				response.operation?.issues || []
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

	async function session(
		path: string,
		options?: SessionOptions
	): Promise<CoordinationSession> {
		dbg.log('creating coordination session for node: %s', path)
		let session = new CoordinationSession(driver, path, options)
		await session.ready()
		dbg.log('coordination session ready for node: %s', path)
		return session
	}

	return {
		createNode,
		alterNode,
		dropNode,
		describeNode,
		session,
	}
}

// CoordinationSession is not exported - use coordination(driver).session() instead
export type {
	AcquireSemaphoreOptions,
	ReleaseSemaphoreOptions,
	CreateSemaphoreOptions,
	UpdateSemaphoreOptions,
	DeleteSemaphoreOptions,
	DescribeSemaphoreOptions,
	DescribeSemaphoreResult,
	SemaphoreChangedEvent,
	SessionExpiredEvent,
} from './session.js'

export { CoordinationSessionEvents } from './session.js'
