import { createClient, type Client, type Transport } from '@connectrpc/connect'
import { ImportService } from './gen/ydb_import_v1_pb.js'

export * from './gen/ydb_import_v1_pb.js'
export * from './gen/protos/ydb_import_pb.js'

export type ImportServiceClient = Client<typeof ImportService>

export const createImportServiceClient = (transport: Transport) => createClient(ImportService, transport)
