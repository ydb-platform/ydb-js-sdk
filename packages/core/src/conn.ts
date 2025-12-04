import type { EndpointInfo } from '@ydbjs/api/discovery'
import { loggers } from '@ydbjs/debug'
import {
	type Channel,
	type ChannelCredentials,
	type ChannelOptions,
	createChannel,
} from 'nice-grpc'

let dbg = loggers.driver.extend('conn')

export interface Connection {
	readonly nodeId: bigint
	readonly address: string
	readonly channel: Channel
	pessimizedUntil?: number

	close(): void
}

export class LazyConnection implements Connection {
	#endpoint: EndpointInfo
	#channel: Channel | null = null
	#channelOptions: ChannelOptions
	#channelCredentials: ChannelCredentials
	pessimizedUntil?: number

	constructor(
		endpoint: EndpointInfo,
		channelCredentials: ChannelCredentials,
		channelOptions?: ChannelOptions
	) {
		this.#endpoint = endpoint

		this.#channelOptions = {
			...channelOptions,
			'grpc.ssl_target_name_override': endpoint.sslTargetNameOverride,
		}
		this.#channelCredentials = channelCredentials
	}

	get nodeId(): bigint {
		return BigInt(this.#endpoint.nodeId)
	}

	get address(): string {
		return `${this.#endpoint.address}:${this.#endpoint.port}`
	}

	get channel(): Channel {
		if (this.#channel === null) {
			dbg.log(
				'create channel to node id=%d address=%s',
				this.nodeId,
				this.address
			)

			this.#channel = createChannel(
				this.address,
				this.#channelCredentials,
				this.#channelOptions
			)
		}

		return this.#channel
	}

	close() {
		if (this.#channel) {
			dbg.log(
				'close channel to node id=%d address=%s',
				this.nodeId,
				this.address
			)
			this.#channel.close()
			this.#channel = null
		}
	}
}
