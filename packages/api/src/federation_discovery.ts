import { createClient, type Client, type Transport } from '@connectrpc/connect'
import { FederationDiscoveryService } from './gen/ydb_federation_discovery_v1_pb.js'

export * from './gen/ydb_federation_discovery_v1_pb.js'
export * from './gen/protos/ydb_federation_discovery_pb.js'

export type FederationDiscoveryServiceClient = Client<typeof FederationDiscoveryService>

export const createFederationDiscoveryServiceClient = (transport: Transport) => createClient(FederationDiscoveryService, transport)
