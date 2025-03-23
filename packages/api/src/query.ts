import { createClient, type Client, type Transport } from '@connectrpc/connect'
import { QueryService } from './gen/ydb_query_v1_pb.js'

export * from './gen/ydb_query_v1_pb.js'
export * from './gen/protos/ydb_query_pb.js'

export type QueryServiceClient = Client<typeof QueryService>

export const createQueryServiceClient = (transport: Transport) => createClient(QueryService, transport)
