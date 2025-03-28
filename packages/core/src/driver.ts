import * as tls from 'node:tls';

import { create, type DescMessage, type DescMethodStreaming, type DescMethodUnary, type MessageInitShape } from '@bufbuild/protobuf';
import { anyUnpack } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type Client, type ContextValues, type Interceptor, type StreamResponse, type Transport, type UnaryResponse } from '@connectrpc/connect';
import { createDiscoveryServiceClient, DiscoveryService, EndpointInfoSchema, ListEndpointsResultSchema, WhoAmIResultSchema, type ListEndpointsResult, type WhoAmIResult } from '@ydbjs/api/discovery';
import { StatusIds_StatusCode } from '@ydbjs/api/operation';
import type { CredentialsProvider } from '@ydbjs/auth';
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous';

import { LazyConnection, type Connection } from './connection.js';
import { nodeIdKey } from './context.js';
import { dbg } from './dbg.js';
import { ConnectionPool } from './pool.js';

export type DriverOptions = {
	ssl?: tls.SecureContextOptions
	credentialsProvier?: CredentialsProvider

	'ydb.sdk.application'?: string;
	'ydb.sdk.enable_discovery'?: boolean;
	'ydb.sdk.discovery_timeout_ms'?: number;
	'ydb.sdk.discovery_interval_ms'?: number;

	[key: string]: any;
}

const defaultOptions: DriverOptions = {
	'ydb.sdk.enable_discovery': true,
	'ydb.sdk.discovery_timeout_ms': 10000,
	'ydb.sdk.discovery_interval_ms': 60000,
}


export class Driver implements Transport, Disposable {
	protected readonly cs: URL
	protected readonly options: DriverOptions = {}

	#pool: ConnectionPool
	#ready = Promise.withResolvers<boolean>()

	#credentials: CredentialsProvider = new AnonymousCredentialsProvider()
	#interceptors: Interceptor[] = []

	#discoveryClient!: Client<typeof DiscoveryService>
	#rediscoverTimer?: NodeJS.Timeout

	constructor(connectionString: string, options: Readonly<DriverOptions> = defaultOptions) {
		dbg.extend("driver")("Driver(connectionString: %s, options: %o)", connectionString, options)

		this.cs = new URL(connectionString.replace(/^grpc/, 'http'))

		for (let key in defaultOptions) {
			this.options[key] = options[key] ?? defaultOptions[key]
		}

		if (['grpc:', 'grpcs:', 'http:', 'https:'].includes(this.cs.protocol) === false) {
			throw new Error('Invalid connection string protocol. Must be one of grpc, grpcs, http, https')
		}

		if (this.cs.pathname === '' && this.cs.searchParams.has('database') === false) {
			throw new Error('Invalid connection string. Database name is required')
		}

		if (this.isSecure && !options.ssl) {
			throw new Error('Secure connection requires SSL options')
		}

		if (this.cs.searchParams.has('application') === false) {
			this.cs.searchParams.set('application', this.options['ydb.sdk.application'] || '')
		} else {
			this.options['ydb.sdk.application'] ??= this.cs.searchParams.get('application') || ''
		}

		let endpoint = create(EndpointInfoSchema, {
			address: this.cs.hostname,
			nodeId: Infinity,
			port: parseInt(this.cs.port || (this.isSecure ? '443' : '80')),
			ssl: this.isSecure,
		})

		this.#interceptors.push((next) => (req) => {
			req.header.set('x-ydb-database', this.database)
			req.header.set('x-ydb-application-name', this.options['ydb.sdk.application'] || '')
			return next(req)
		})

		if (options.credentialsProvier) {
			this.#credentials = options.credentialsProvier
			this.#interceptors.push(this.#credentials.interceptor)
		}

		this.#pool = new ConnectionPool({
			nodeOptions: { ...options.ssl },
			interceptors: [...this.#interceptors],
		})

		if (this.options['ydb.sdk.enable_discovery'] === false) {
			dbg.extend("driver")('Discovery disabled, using single endpoint')
			this.#pool.add(endpoint)

			this.#discoveryClient = createDiscoveryServiceClient(this)

			this.#whoAmI(AbortSignal.timeout(this.options['ydb.sdk.discovery_timeout_ms']!))
				.then((r) => {
					this.#ready.resolve(true)
				})
				.catch((err) => {
					this.#ready.reject(err)
				})
		}

		if (this.options['ydb.sdk.enable_discovery'] === true) {
			dbg.extend("driver")('Discovery enabled, using connection pool')
			let conn = new LazyConnection(endpoint, { ...options.ssl, interceptors: this.#interceptors })

			this.#discoveryClient = createDiscoveryServiceClient(conn.transport)

			// Initial discovery
			this.#listEndpoints(AbortSignal.timeout(this.options['ydb.sdk.discovery_timeout_ms']!))

			// Periodic discovery
			this.#rediscoverTimer = setInterval(() => {
				this.#listEndpoints(AbortSignal.timeout(this.options['ydb.sdk.discovery_timeout_ms']!))
			}, this.options['ydb.sdk.discovery_interval_ms'] || 60 * 1000)

			// Unref the timer so it doesn't keep the process running
			this.#rediscoverTimer.unref()
		}
	}

	// TODO: add retry logic
	async #listEndpoints(signal?: AbortSignal): Promise<ListEndpointsResult> {
		dbg.extend("driver")("#listEndpoints(signal: %o)", signal)

		let response = await this.#discoveryClient.listEndpoints({ database: this.database }, { signal })
		if (!response.operation) {
			throw new ConnectError('No operation in response', Code.DataLoss)
		}

		if (response.operation.status !== StatusIds_StatusCode.SUCCESS) {
			throw new Error(`(${response.operation.status}) ${response.operation.issues}`)
		}

		let result = anyUnpack(response.operation.result!, ListEndpointsResultSchema);
		if (!result) {
			throw new ConnectError('No result in operation', Code.DataLoss)
		}

		try {
			for (let endpoint of result.endpoints) {
				this.#pool.add(endpoint)
			}

			this.#ready.resolve(true)
			return result
		} catch (err) {
			this.#ready.reject(err)
			throw err
		}
	}

	// TODO: add retry logic
	async #whoAmI(signal?: AbortSignal): Promise<WhoAmIResult> {
		dbg.extend("driver")("#whoAmI(signal: %o)", signal)

		let response = await this.#discoveryClient.whoAmI({}, { signal })
		if (!response.operation) {
			throw new ConnectError('No operation in response', Code.DataLoss)
		}

		if (response.operation.status !== StatusIds_StatusCode.SUCCESS) {
			throw new Error(`(${response.operation.status}) ${response.operation.issues}`)
		}

		let result = anyUnpack(response.operation.result!, WhoAmIResultSchema);
		if (!result) {
			throw new ConnectError('No result in operation', Code.DataLoss)
		}

		return result
	}

	get database(): string {
		return this.cs.pathname || this.cs.searchParams.get('database') || ''
	}

	get isSecure(): boolean {
		return this.cs.protocol === 'https:'
	}

	getConnection(preferNodeId?: number): Connection {
		return this.#pool.aquire(preferNodeId)
	}

	ready(signal?: AbortSignal): Promise<boolean> {
		if (signal) {
			let onabort = () => {
				signal.removeEventListener('abort', onabort)
				this.#ready.reject(new Error('Aborted'))
			}

			signal.addEventListener('abort', onabort)
		}

		return this.#ready.promise
	}

	unary<I extends DescMessage, O extends DescMessage>(method: DescMethodUnary<I, O>, signal: AbortSignal | undefined, timeoutMs: number | undefined, header: Headers | undefined, input: MessageInitShape<I>, contextValues?: ContextValues): Promise<UnaryResponse<I, O>> {
		let preferNodeId = contextValues?.get(nodeIdKey)

		return this.#pool.aquire(preferNodeId).transport.unary(method, signal, timeoutMs, header, input, contextValues)
	}

	stream<I extends DescMessage, O extends DescMessage>(method: DescMethodStreaming<I, O>, signal: AbortSignal | undefined, timeoutMs: number | undefined, header: Headers | undefined, input: AsyncIterable<MessageInitShape<I>>, contextValues?: ContextValues): Promise<StreamResponse<I, O>> {
		let preferNodeId = contextValues?.get(nodeIdKey)

		return this.#pool.aquire(preferNodeId).transport.stream(method, signal, timeoutMs, header, input, contextValues)
	}

	close(): void {
		clearInterval(this.#rediscoverTimer)
	}

	[Symbol.dispose](): void {
		this.close()
	}

	[Symbol.asyncDispose](): PromiseLike<void> {
		return Promise.resolve(this.close())
	}
}
