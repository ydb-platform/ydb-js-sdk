import type { EndpointInfo } from "@ydbjs/api/discovery";
import { createChannel, createClientFactory, type Channel, type ChannelCredentials, type ChannelOptions, type ClientFactory, type ClientMiddleware } from "nice-grpc";

import { dbg } from "./dbg.ts";

export type ConnectionCallOptions = {
	readonly nodeId?: unique symbol;
}

export const nodeIdSymbol = Symbol('nodeId');

export interface Connection {
	readonly nodeId: bigint;
	readonly address: string;
	readonly channel: Channel;
	readonly clientFactory: ClientFactory<ConnectionCallOptions>;
	pessimizedUntil?: number;
}

export class LazyConnection implements Connection {
	#endpoint: EndpointInfo;
	#channel: Channel | null = null;
	#channelOptions: ChannelOptions;
	#channelCredentials: ChannelCredentials;
	pessimizedUntil?: number;

	constructor(endpoint: EndpointInfo, channelCredentials: ChannelCredentials, channelOptions?: ChannelOptions) {
		this.#endpoint = endpoint;

		this.#channelOptions = {
			...channelOptions,
			'grpc.ssl_target_name_override': endpoint.sslTargetNameOverride,
		};
		this.#channelCredentials = channelCredentials;
	}

	get nodeId(): bigint {
		return BigInt(this.#endpoint.nodeId);
	}

	get address(): string {
		return `${this.#endpoint.address}:${this.#endpoint.port}`;
	}

	get channel(): Channel {
		if (this.#channel === null) {
			dbg.extend("conn")('create channel to node id=%d address=%s', this.nodeId, this.address);

			this.#channel = createChannel(this.address, this.#channelCredentials, this.#channelOptions);
		}

		return this.#channel;
	};

	get clientFactory(): ClientFactory<ConnectionCallOptions> {
		return createClientFactory().use(this.#debug).use(this.#markNodeId);
	}

	#debug: ClientMiddleware<ConnectionCallOptions> = (call, options) => {
		return call.next(call.request, {
			onTrailer: (trailer) => {
				dbg.extend("grpc")('%s%s %s', this.address, call.method.path, trailer.get('grpc-status')?.[0] ?? 'OK');
			}
		})
	}

	#markNodeId: ClientMiddleware<ConnectionCallOptions> = (call, options) => {
		return call.next(call.request, Object.assign(options, { [nodeIdSymbol]: this.nodeId }))
	}
}
