import { createClient, type Client, type Transport } from '@connectrpc/connect'
import { TableService } from './gen/ydb_table_v1_pb.js'

export * from './gen/ydb_table_v1_pb.js'
export * from './gen/protos/ydb_table_pb.js'

export type TableServiceClient = Client<typeof TableService>

export const createTableClient = (transport: Transport) => createClient(TableService, transport)
