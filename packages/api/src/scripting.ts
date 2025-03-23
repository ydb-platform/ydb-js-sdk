import { createClient, type Client, type Transport } from '@connectrpc/connect'
import { ScriptingService } from './gen/ydb_scripting_v1_pb.js'

export * from './gen/ydb_scripting_v1_pb.js'
export * from './gen/protos/ydb_scripting_pb.js'

export type ScriptingServiceClient = Client<typeof ScriptingService>

export const createScriptingClient = (transport: Transport) => createClient(ScriptingService, transport)
