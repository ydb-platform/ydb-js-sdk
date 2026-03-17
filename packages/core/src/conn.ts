import type { EndpointInfo as ProtoEndpointInfo } from '@ydbjs/api/discovery'
import { loggers } from '@ydbjs/debug'
import {
	type Channel,
	type ChannelCredentials,
	type ChannelOptions,
	createChannel,
} from 'nice-grpc'

import type { EndpointInfo } from './hooks.js'

let dbg = loggers.driver.extend('conn')

/**
 * Immutable view of a single gRPC connection.
 * Pessimization state is owned by the Pool — not here.
 */
export interface Connection extends Disposable {
	readonly endpoint: EndpointInfo
	readonly channel: Channel

	close(): void
	[Symbol.dispose](): void
}

/**
 * A single gRPC connection to a YDB node.
 */
export class GrpcConnection implements Connection {
	readonly endpoint: EndpointInfo
	#channel: Channel

	constructor(
		endpoint: ProtoEndpointInfo,
		channelCredentials: ChannelCredentials,
		channelOptions?: ChannelOptions
	) {
		let address = `${endpoint.address}:${endpoint.port}`

		// Freeze the value object so hooks receive a stable, immutable reference
		// without being able to accidentally mutate driver internals.
		this.endpoint = Object.freeze<EndpointInfo>({
			nodeId: BigInt(endpoint.nodeId),
			address,
			location: endpoint.location,
		})

		dbg.log('create channel to node id=%d address=%s', this.endpoint.nodeId, address)

		this.#channel = createChannel(address, channelCredentials, {
			...channelOptions,
			// Required when the TLS certificate CN doesn't match the gRPC endpoint
			// address (common in YDB deployments behind a load balancer).
			'grpc.ssl_target_name_override': endpoint.sslTargetNameOverride,
		})
	}

	get channel(): Channel {
		return this.#channel
	}

	close(): void {
		dbg.log(
			'close channel to node id=%d address=%s',
			this.endpoint.nodeId,
			this.endpoint.address
		)
		this.#channel.close()
	}

	[Symbol.dispose](): void {
		this.close()
	}
}
