import { createClient, type Client, type Transport } from '@connectrpc/connect'
import { SchemeService } from './gen/ydb_scheme_v1_pb.js'

export * from './gen/ydb_scheme_v1_pb.js'
export * from './gen/protos/ydb_scheme_pb.js'

export type SchemeServiceClient = Client<typeof SchemeService>

export const createSchemeClient = (transport: Transport) => createClient(SchemeService, transport)
