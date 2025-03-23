import { createClient, type Client, type Transport } from '@connectrpc/connect'
import { AuthService } from './gen/ydb_auth_v1_pb.js'

export * from './gen/ydb_auth_v1_pb.js'
export * from './gen/protos/ydb_auth_pb.js'

export type AuthServiceClient = Client<typeof AuthService>

export const createAuthServiceClient = (transport: Transport) => createClient(AuthService, transport)
