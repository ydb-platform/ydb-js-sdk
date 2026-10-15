import type { SecureContextOptions } from 'node:tls'

import { Channel, type ChannelCredentials, type ChannelOptions } from '@grpc/grpc-js'
import { expect, test } from 'vitest'

import { StaticCredentialsProvider } from './static.ts'

test.for<{ endpoint: string; secure?: SecureContextOptions; target: string }>([
	{ endpoint: 'http://localhost:80', target: 'localhost:80' },
	{ endpoint: 'grpc://localhost', target: 'localhost:80' },
	{ endpoint: 'grpcs://localhost', secure: {}, target: 'localhost:443' },
	{ endpoint: 'grpc://localhost:2136', target: 'localhost:2136' },
	{ endpoint: 'unix:///tmp/ydb-auth.sock', target: 'unix:///tmp/ydb-auth.sock' },
])(
	'uses the configured authentication dial target for $endpoint',
	({ endpoint, secure, target }) => {
		let addresses: string[] = []
		using channels = {
			values: [] as Channel[],
			[Symbol.dispose]() {
				for (let channel of this.values) {
					channel.close()
				}
			},
		}

		void new StaticCredentialsProvider(
			{ username: 'test', password: 'test' },
			endpoint,
			secure,
			{
				channelFactoryOverride(
					address: string,
					credentials: ChannelCredentials,
					options: ChannelOptions
				) {
					addresses.push(address)
					let channel = new Channel(address, credentials, options)
					channels.values.push(channel)
					return channel
				},
			}
		)

		expect(addresses).toEqual([target])
	}
)
