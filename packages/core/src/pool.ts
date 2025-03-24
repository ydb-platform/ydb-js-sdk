import { checkServerIdentity } from 'node:tls';

import { equals, type DescMessage, type MessageShape } from '@bufbuild/protobuf';
import { type Interceptor, type StreamResponse, type Transport } from '@connectrpc/connect';
import { createGrpcTransport, type GrpcTransportOptions } from '@connectrpc/connect-node';
import { grpcStatusOk, headerGrpcStatus } from '@connectrpc/connect/protocol-grpc';
import { EndpointInfoSchema, type EndpointInfo } from '@ydbjs/api/discovery';

import { nodeIdKey } from './context.js';
import { dbg } from './dbg.js';

export interface Connection {
	readonly endpoint: EndpointInfo;
	readonly transport: Transport;
	pessimizedUntil?: number;
}

export class LazyConnection implements Connection {
	#options: GrpcTransportOptions;
	#transport: Transport | null = null;

	endpoint: EndpointInfo;
	pessimizedUntil: number = 0;

	constructor(endpoint: EndpointInfo, options: Omit<GrpcTransportOptions, 'baseUrl'>) {
		this.endpoint = endpoint;

		this.#options = {
			...options,
			baseUrl: this.endpoint.ssl ? `https://${endpoint.address}:${endpoint.port}` : `http://${endpoint.address}:${endpoint.port}`,
			nodeOptions: {
				...options.nodeOptions,
				checkServerIdentity(hostname, cert) {
					return checkServerIdentity(endpoint.sslTargetNameOverride || hostname, cert);
				},
			},
			interceptors: [...options.interceptors || []]
		};

		this.#options.interceptors!.unshift(this.#debug)
		this.#options.interceptors!.unshift(this.#markNodeId)
	}

	get transport(): Transport {
		if (this.#transport === null) {
			dbg.extend("conn")('create transport to node id=%d address=%s:%d', this.endpoint.nodeId, this.endpoint.address, this.endpoint.port);

			this.#transport = createGrpcTransport(this.#options);
		}

		return this.#transport;
	};

	#markNodeId: Interceptor = (next) => {
		return async (req) => {
			req.contextValues.set(nodeIdKey, this.endpoint.nodeId);
			return next(req);
		}
	}

	#debug: Interceptor = (next) => {
		return async (req) => {
			let res = await next(req);

			if (!res.stream) {
				dbg.extend("grpc")('%s/%s', req.service.typeName, req.method.name, res.trailer.get(headerGrpcStatus));

				return res;
			}

			return {
				...res,
				message: withHooks(res, {
					onTailer: (trailer) => {
						dbg.extend("grpc")('%s/%s', req.service.typeName, req.method.name, trailer.get(headerGrpcStatus));
					}
				})
			}
		}
	}
}

export class ConnectionPool implements Disposable {
	protected connections: Set<Connection> = new Set();
	protected pessimized: Set<Connection> = new Set();

	private options: Omit<GrpcTransportOptions, 'baseUrl'>;
	private pessimizationTimeoutMs = 60000;

	constructor(options: Omit<GrpcTransportOptions, 'baseUrl'>) {
		this.options = {
			...options,
			interceptors: options.interceptors || []
		}

		this.options.interceptors!.push(this.#pessimizer)
	}

	/**
	 * Pessimize a connection if it returns a non-OK status.
	 */
	#pessimizer: Interceptor = (next) => {
		return async (req) => {
			let nodeId = req.contextValues.get(nodeIdKey)

			const res = await next(req);
			if (!res.stream) {
				if (res.trailer.get(headerGrpcStatus) !== grpcStatusOk) {
					this.pessimize(this.findByNodeId(nodeId)!)
				}

				return res;
			}

			return {
				...res,
				message: withHooks(res, {
					onTailer: (trailer) => {
						if (trailer.get(headerGrpcStatus) !== grpcStatusOk) {
							this.pessimize(this.findByNodeId(nodeId)!)
						}
					}
				})
			}
		}
	}

	/**
	 * Get a channel based on load balancing rules
	 */
	aquire(preferNodeId?: Connection["endpoint"]["nodeId"]): Connection {
		let candidate: Connection | null = null;
		this.refreshPessimizedChannels();

		for (let connection of this.connections) {
			candidate ??= connection;

			if (connection.endpoint.nodeId === preferNodeId) {
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

			if (connection.endpoint.nodeId === preferNodeId) {
				return connection
			}
		}

		if (candidate) {
			this.pessimized.delete(candidate);
			this.pessimized.add(candidate);

			return candidate;
		}

		throw new Error('No connections available');
	}

	release(conn: Connection) {
		throw new Error('Method not implemented.');
	}

	/**
	 * Add a new connection to the pool
	 */
	add(endpoint: EndpointInfo) {
		let connection = this.findByNodeId(endpoint.nodeId)
		if (connection && equals(EndpointInfoSchema, connection.endpoint, endpoint)) {
			return this;
		} else if (connection) {
			// TODO: graceful shutdown
			this.remove(connection);
		}

		connection = new LazyConnection(endpoint, this.options);
		this.connections.add(connection);
		dbg.extend("pool")('add connection to node id=%s address=%s:%d', endpoint.nodeId, endpoint.address, endpoint.port);

		return this;
	}

	/**
	 * Find a connection by node id
	 */
	findByNodeId(nodeId: number): Connection | undefined {
		for (let connection of this.connections) {
			if (connection.endpoint.nodeId === nodeId) {
				return connection;
			}
		}

		for (let connection of this.pessimized) {
			if (connection.endpoint.nodeId === nodeId) {
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

		dbg.extend("pool")('remove connection to node id=%s address=%s:%d', connection.endpoint.nodeId, connection.endpoint.address, connection.endpoint.port);

		return this;
	}

	/**
	 * Pessimize a connection for a set amount of time
	 */
	pessimize(connection: Connection) {
		connection.pessimizedUntil = Date.now() + this.pessimizationTimeoutMs;
		this.pessimized.add(connection);
		this.connections.delete(connection);

		dbg.extend("pool")('pessimize node id=%s address=%s:%d', connection.endpoint.nodeId, connection.endpoint.address, connection.endpoint.port);

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

				dbg.extend("pool")('unpesimize node id=%s address=%s:%d', connection.endpoint.nodeId, connection.endpoint.address, connection.endpoint.port);
			}
		}
	}

	[Symbol.dispose]() {
		// TODO: Dispose of connections
	}
}

async function* withHooks<I extends DescMessage, O extends DescMessage>(res: StreamResponse<I, O>, hooks: {
	onMessage?: (message: MessageShape<O>) => void,
	onHeader?: (header: Headers) => void,
	onTailer?: (trailer: Headers) => void
}) {
	hooks.onHeader?.(res.header);

	for await (const m of res.message) {
		yield m;
		hooks.onMessage?.(m);
	}

	yield* res.message;

	hooks.onTailer?.(res.trailer);
}
