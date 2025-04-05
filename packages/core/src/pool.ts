import { type EndpointInfo } from '@ydbjs/api/discovery';
import type { ChannelCredentials, ChannelOptions } from 'nice-grpc';

import { type Connection, LazyConnection } from './conn.ts';
import { dbg } from './dbg.js';

export class ConnectionPool implements Disposable {
	protected connections: Set<Connection> = new Set();
	protected pessimized: Set<Connection> = new Set();

	#pessimizationTimeoutMs = 60000;
	#channelCredentials: ChannelCredentials;
	#channelOptions: ChannelOptions;

	constructor(channelCredentials: ChannelCredentials, channelOptions: ChannelOptions) {
		this.#channelCredentials = channelCredentials
		this.#channelOptions = channelOptions
	}

	/**
	 * Get a channel based on load balancing rules
	 */
	aquire(preferNodeId?: Connection["nodeId"]): Connection {
		let candidate: Connection | null = null;
		this.refreshPessimizedChannels();

		for (let connection of this.connections) {
			candidate ??= connection;

			if (connection.nodeId === preferNodeId) {
				return connection;
			}
		}

		if (candidate) {
			this.connections.delete(candidate);
			this.connections.add(candidate);

			return candidate;
		}

		for (let connection of this.pessimized) {
			candidate ??= connection;

			if (connection.nodeId === preferNodeId) {
				return connection
			}
		}

		if (candidate) {
			this.pessimized.delete(candidate);
			this.pessimized.add(candidate);

			return candidate;
		}

		throw new Error('No connection available');
	}

	release(conn: Connection) {
		this.connections.delete(conn);
		this.connections.add(conn);

		this.pessimized.delete(conn);
		this.pessimized.add(conn);

		dbg.extend("pool")('release connection to node id=%s address=%s', conn.nodeId, conn.address);
		return this;
	}

	/**
	 * Add a new connection to the pool
	 */
	add(endpoint: EndpointInfo) {
		let connection = this.findByNodeId(BigInt(endpoint.nodeId))
		if (connection) {
			this.remove(connection);
			connection.channel.close();
		}

		connection = new LazyConnection(endpoint, this.#channelCredentials, this.#channelOptions);

		this.connections.add(connection);
		dbg.extend("pool")('add connection to node id=%s address=%s', connection.nodeId, connection.address);

		return this;
	}

	/**
	 * Find a connection by node id
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
	 */
	remove(connection: Connection) {
		this.connections.delete(connection);
		this.pessimized.delete(connection);

		dbg.extend("pool")('remove connection to node id=%s address=%s', connection.nodeId, connection.address);

		return this;
	}

	/**
	 * Pessimize a connection for a set amount of time
	 */
	pessimize(connection: Connection) {
		connection.pessimizedUntil = Date.now() + this.#pessimizationTimeoutMs;
		this.pessimized.add(connection);
		this.connections.delete(connection);

		dbg.extend("pool")('pessimize node id=%s address=%s', connection.nodeId, connection.address);

		return this
	}

	/**
	 * Check pessimized channels and restore them if the timeout has elapsed
	 */
	private refreshPessimizedChannels(): void {
		let now = Date.now();

		for (let connection of this.pessimized) {
			if (connection.pessimizedUntil! < now) {
				this.pessimized.delete(connection);
				this.connections.add(connection);

				dbg.extend("pool")('unpesimize node id=%s address=%s', connection.nodeId, connection.address);
			}
		}
	}

	close() {
		for (let connection of this.connections) {
			connection.channel.close();
		}

		for (let connection of this.pessimized) {
			connection.channel.close();
		}

		this.connections.clear();
		this.pessimized.clear();

		dbg.extend("pool")('close pool');
	}

	[Symbol.dispose]() {
		return this.close();
	}
}
