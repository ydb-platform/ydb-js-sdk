import { createClient, type Client, type Transport } from '@connectrpc/connect'
import { CoordinationService } from './gen/ydb_coordination_v1_pb.js'

export * from './gen/ydb_coordination_v1_pb.js'
export * from './gen/protos/ydb_coordination_pb.js'

export type CoordinationServiceClient = Client<typeof CoordinationService>

export const createCoordinationServiceClient = (transport: Transport) => createClient(CoordinationService, transport)
