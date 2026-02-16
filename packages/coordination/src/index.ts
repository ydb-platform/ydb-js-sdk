import { create } from '@bufbuild/protobuf'
import { anyUnpack } from '@bufbuild/protobuf/wkt'
import { abortable } from '@ydbjs/abortable'
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

import type { AcquireSemaphoreOptions } from './session.js'
import { CoordinationSession } from './session.js'
import { SessionOwnedLock } from './semaphore.js'
import type { Lock } from './semaphore.js'

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
	 * Recovery window in milliseconds during which client may restore a detached session.
	 * If the client reconnects within this window, the session will be restored with the same session ID.
	 *
	 * Default: 30000 (30 seconds)
	 */
	recoveryWindowMs?: number

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
 * await session.acquire('my-semaphore', { count: 1 });
 *
 * // Release the semaphore
 * await session.release('my-semaphore');
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
	 * @param signal - Optional abort signal to timeout session creation
	 * @returns A coordination session instance
	 * @throws {YDBError} If the operation fails
	 */
	session(
		path: string,
		options?: SessionOptions,
		signal?: AbortSignal
	): Promise<CoordinationSession>

	/**
	 * Acquires a distributed lock with automatic session management
	 *
	 * This is a high-level convenience method that combines session creation,
	 * semaphore acquisition, and automatic cleanup into a single operation.
	 * The session is created internally and automatically closed when the lock is released.
	 *
	 * For more complex scenarios (multiple locks, long-lived sessions), use session() instead.
	 *
	 * @param path - Path to the coordination node
	 * @param name - Name of the semaphore to acquire
	 * @param options - Optional lock acquisition settings (combines AcquireSemaphoreOptions and SessionOptions)
	 * @param signal - Optional abort signal to timeout lock acquisition
	 * @returns A distributed lock that automatically manages session lifecycle
	 * @throws {YDBError} If the operation fails
	 *
	 * @example
	 * ```typescript
	 * // Simple distributed lock
	 * await using lock = await client.acquireLock('/local/node', 'my-lock')
	 * // Session created, lock acquired
	 * // Do work with lock
	 * // Lock released and session closed automatically
	 * ```
	 *
	 * @example
	 * ```typescript
	 * // With options
	 * await using lock = await client.acquireLock('/local/node', 'my-lock', {
	 *   timeoutMillis: 5000,
	 *   ephemeral: true
	 * })
	 * ```
	 */
	acquireLock(
		path: string,
		name: string,
		options?: AcquireSemaphoreOptions & SessionOptions,
		signal?: AbortSignal
	): Promise<Lock>

	/**
	 * Executes a callback with an acquired distributed lock
	 *
	 * This is a callback-style convenience method that ensures the lock signal
	 * is always available to the callback. The session is created, lock is acquired,
	 * callback is executed with the lock signal, and then lock is released and session
	 * is closed automatically.
	 *
	 * If the lock is lost during callback execution (session expired), the signal
	 * aborts and the callback should handle it gracefully.
	 *
	 * @param path - Path to the coordination node
	 * @param name - Name of the semaphore to acquire
	 * @param callback - Function to execute while holding the lock, receives AbortSignal
	 * @param options - Optional lock acquisition settings
	 * @returns Promise that resolves with the callback's return value
	 * @throws {YDBError} If the operation fails
	 *
	 * @example
	 * ```typescript
	 * // Callback style
	 * await client.withLock('/local/node', 'my-lock', async (signal) => {
	 *   await doExpensiveWork(signal)
	 *   // If lock is lost, signal aborts and work should stop
	 * }, { ephemeral: true })
	 * ```
	 */
	withLock<T>(
		path: string,
		name: string,
		callback: (signal: AbortSignal) => Promise<T>,
		options?: AcquireSemaphoreOptions & SessionOptions
	): Promise<T>
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
				response.operation?.status ??
					StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED,
				response.operation?.issues ?? []
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
				response.operation?.status ??
					StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED,
				response.operation?.issues ?? []
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
				response.operation?.status ??
					StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED,
				response.operation?.issues ?? []
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

	async function session(
		path: string,
		options?: SessionOptions,
		signal?: AbortSignal
	): Promise<CoordinationSession> {
		dbg.log('creating coordination session for node: %s', path)
		let session = new CoordinationSession(driver, path, options)

		try {
			if (signal) {
				await abortable(signal, session.ready())
			} else {
				await session.ready()
			}
			dbg.log('coordination session ready for node: %s', path)
			return session
		} catch (error) {
			dbg.log('session creation failed, closing session: %O', error)
			await session.close()
			throw error
		}
	}

	async function acquireLock(
		path: string,
		name: string,
		options?: AcquireSemaphoreOptions & SessionOptions,
		signal?: AbortSignal
	): Promise<Lock> {
		dbg.log('acquiring distributed lock: %s on node: %s', name, path)

		// Extract session options
		let sessionOptions: SessionOptions = {}
		if (options?.recoveryWindowMs !== undefined) {
			sessionOptions.recoveryWindowMs = options.recoveryWindowMs
		}
		if (options?.description !== undefined) {
			sessionOptions.description = options.description
		}

		// Extract acquire options
		let acquireOptions: AcquireSemaphoreOptions = {}
		if (options?.count !== undefined) {
			acquireOptions.count = options.count
		}
		if (options?.timeoutMillis !== undefined) {
			acquireOptions.timeoutMillis = options.timeoutMillis
		}
		if (options?.data !== undefined) {
			acquireOptions.data = options.data
		}
		if (options?.ephemeral !== undefined) {
			acquireOptions.ephemeral = options.ephemeral
		}

		let sess = await session(path, sessionOptions, signal)

		try {
			let lock = await sess.acquire(name, acquireOptions, signal)

			// Wrap in SessionOwnedLock that owns the session
			return new SessionOwnedLock(sess, lock)
		} catch (error) {
			dbg.log('failed to acquire lock, closing session: %O', error)
			await sess.close()
			throw error
		}
	}

	async function withLock<T>(
		path: string,
		name: string,
		callback: (signal: AbortSignal) => Promise<T>,
		options?: AcquireSemaphoreOptions & SessionOptions
	): Promise<T> {
		dbg.log('executing withLock: %s on node: %s', name, path)

		await using lock = await acquireLock(path, name, options)

		return await callback(lock.signal)
	}

	return {
		createNode,
		alterNode,
		dropNode,
		describeNode,
		session,
		acquireLock,
		withLock,
	}
}

// CoordinationSession is not exported - use coordination(driver).session() instead
export type {
	AcquireSemaphoreOptions,
	CreateSemaphoreOptions,
	DeleteSemaphoreOptions,
	DescribeSemaphoreOptions,
	DescribeSemaphoreResult,
	WatchOptions,
} from './session.js'

export type { Lock } from './semaphore.js'
