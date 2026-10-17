import type { EndpointInfo as ProtoEndpointInfo } from '@ydbjs/api/discovery'
import { loggers } from '@ydbjs/debug'
import { Client, type ClientOptions, type Transport } from '@ydbjs/grpc'

import type { EndpointInfo } from './hooks.js'

let dbg = loggers.driver.extend('conn')

export interface Connection extends Disposable {
	readonly endpoint: EndpointInfo
	readonly client: Transport & Pick<Client, 'state' | 'connect'>
	close(): void
}

export class GrpcConnection implements Connection {
	readonly endpoint: EndpointInfo
	readonly client: Client

	constructor(endpoint: ProtoEndpointInfo, options?: ClientOptions) {
		let host =
			endpoint.address.includes(':') && !endpoint.address.startsWith('[')
				? `[${endpoint.address}]`
				: endpoint.address
		let address = `${host}:${endpoint.port}`
		this.endpoint = Object.freeze<EndpointInfo>({
			nodeId: BigInt(endpoint.nodeId),
			address,
			location: endpoint.location,
			pile: endpoint.bridgePileName,
		})

		this.client = new Client(`${endpoint.ssl ? 'https' : 'http'}://${address}`, {
			...options,
			tls: {
				...options?.tls,
				...(endpoint.sslTargetNameOverride && {
					servername: endpoint.sslTargetNameOverride,
				}),
			},
		})
		dbg.log('create connection to node id=%d address=%s', this.endpoint.nodeId, address)
	}

	close(): void {
		dbg.log(
			'close connection to node id=%d address=%s',
			this.endpoint.nodeId,
			this.endpoint.address
		)
		this.client.close()
	}

	[Symbol.dispose](): void {
		this.close()
	}
}
