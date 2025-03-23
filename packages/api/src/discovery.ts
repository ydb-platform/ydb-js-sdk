import { createClient, type Client, type Transport } from '@connectrpc/connect'
import { DiscoveryService } from './gen/ydb_discovery_v1_pb.js'

export * from './gen/ydb_discovery_v1_pb.js'
export * from './gen/protos/ydb_discovery_pb.js'

export type DiscoveryServiceClient = Client<typeof DiscoveryService>

export const createDiscoveryServiceClient = (transport: Transport) => createClient(DiscoveryService, transport)
