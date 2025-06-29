import { type EndpointInfo } from '@ydbjs/api/discovery';
import { loggers } from '@ydbjs/debug';
import type { ChannelCredentials, ChannelOptions } from 'nice-grpc';
import { type Connection, LazyConnection } from './conn.js';

let dbg = loggers.driver.extend('pool')

const PESSIMIZATION_TIMEOUT_MS = 60_000;

export class ConnectionPool implements Disposable {
	protected connections: Set<Connection> = new Set();
	protected pessimized: Set<Connection> = new Set();

	#channelOptions?: ChannelOptions;
	#channelCredentials: ChannelCredentials;

	constructor(channelCredentials: ChannelCredentials, channelOptions?: ChannelOptions) {
		dbg.log('creating connection pool')
		this.#channelCredentials = channelCredentials

		if (channelOptions) {
			this.#channelOptions = channelOptions
		}
	}

	/**
	 * Get a channel based on load balancing rules
	 * @param preferNodeId The preferred node id to use
	 * @returns A connection from the pool
	 */
	acquire(preferNodeId?: Connection["nodeId"]): Connection {
		let candidate: Connection | null = null;
		this.#refreshPessimizedChannels();

		// Try to find preferred node or any good connection
		for (let connection of this.connections) {
			candidate ??= connection;

			if (connection.nodeId === preferNodeId) {
				dbg.log('returning preferred connection to node %d', preferNodeId)
				return connection;
			}
		}

		if (candidate) {
			// Move to end of set for round-robin
			this.connections.delete(candidate);
			this.connections.add(candidate);
			dbg.log('returning round-robin connection to node %d (pool size: %d)', candidate.nodeId, this.connections.size)
			return candidate;
		}

		// Fallback to pessimized connections
		dbg.log('no good connections available, falling back to pessimized connections')
		for (let connection of this.pessimized) {
			candidate ??= connection;

			if (connection.nodeId === preferNodeId) {
				dbg.log('returning preferred pessimized connection to node %d', preferNodeId)
				return connection
			}
		}

		if (candidate) {
			this.pessimized.delete(candidate);
			this.pessimized.add(candidate);
			dbg.log('returning pessimized connection to node %d (pessimized size: %d)', candidate.nodeId, this.pessimized.size)
			return candidate;
		}

		dbg.log('no connections available in pool')
		throw new Error('No connection available');
	}

	/**
	 * Release a connection back to the pool
	 * @param conn The connection to release
	 * @returns The connection pool instance
	 */
	release(conn: Connection) {
		this.connections.delete(conn);
		this.connections.add(conn);

		this.pessimized.delete(conn);
		this.pessimized.add(conn);

		dbg.log('released connection to node %d address %s', conn.nodeId, conn.address)
		return this;
	}

	/**
	 * Add a new connection to the pool
	 * @param endpoint The endpoint information for the new connection
	 */
	add(endpoint: EndpointInfo) {
		let connection = this.findByNodeId(BigInt(endpoint.nodeId))
		if (connection) {
			dbg.log('replacing existing connection to node %d', endpoint.nodeId)
			this.remove(connection);
			connection.channel.close();
		}

		connection = new LazyConnection(endpoint, this.#channelCredentials, this.#channelOptions);

		this.connections.add(connection);
		dbg.log('added connection to node %d address %s (pool size: %d)', connection.nodeId, connection.address, this.connections.size)

		return this;
	}

	/**
	 * Find a connection by node id
	 * @param nodeId The node id to search for
	 * @returns The connection if found, undefined otherwise
	 */
	findByNodeId(nodeId: Connection["nodeId"]): Connection | undefined {
		for (let connection of this.connections) {
			if (connection.nodeId === nodeId) {
				return connection;
			}
		}

		for (let connection of this.pessimized) {
			if (connection.nodeId === nodeId) {
				return connection;
			}
		}

		return undefined
	}

	/**
	 * Remove a connection from the pool
	 * @param connection The connection to remove
	 */
	remove(connection: Connection) {
		this.connections.delete(connection);
		this.pessimized.delete(connection);

		dbg.log('removed connection to node %d address %s', connection.nodeId, connection.address)

		return this;
	}

	/**
	 * Pessimize a connection for a set amount of time
	 * @param connection The connection to pessimize
	 */
	pessimize(connection: Connection) {
		connection.pessimizedUntil = Date.now() + PESSIMIZATION_TIMEOUT_MS;
		this.pessimized.add(connection);
		this.connections.delete(connection);

		dbg.log('pessimized node %d address %s', connection.nodeId, connection.address)

		return this
	}

	/**
	 * Check pessimized channels and restore them if the timeout has elapsed
	 */
	#refreshPessimizedChannels(): void {
		let now = Date.now();

		for (let connection of this.pessimized) {
			if (connection.pessimizedUntil! < now) {
				this.pessimized.delete(connection);
				this.connections.add(connection);

				dbg.log('un-pessimized node %d address %s', connection.nodeId, connection.address)
			}
		}
	}

	/**
	 * Close all connections in the pool
	 */
	close() {
		dbg.log('closing connection pool (%d active, %d pessimized)', this.connections.size, this.pessimized.size)

		for (let connection of this.connections) {
			connection.close();
		}

		for (let connection of this.pessimized) {
			connection.close();
		}

		this.connections.clear();
		this.pessimized.clear();

		dbg.log('connection pool closed')
	}

	/**
	 * Destroy the connection pool.
	 */
	destroy() {
		this.close();
	}

	[Symbol.dispose]() {
		return this.destroy();
	}
}
