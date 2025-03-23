import { createClient, type Client, type Transport } from '@connectrpc/connect'
import { ExportService } from './gen/ydb_export_v1_pb.js'

export * from './gen/ydb_export_v1_pb.js'
export * from './gen/protos/ydb_export_pb.js'

export type ExportServiceClient = Client<typeof ExportService>

export const createExportServiceClient = (transport: Transport) => createClient(ExportService, transport)
