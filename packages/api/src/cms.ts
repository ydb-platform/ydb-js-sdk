import { createClient, type Client, type Transport } from '@connectrpc/connect'
import { CmsService } from './gen/ydb_cms_v1_pb.js'

export * from './gen/ydb_cms_v1_pb.js'
export * from './gen/protos/ydb_cms_pb.js'

export type CmsServiceClient = Client<typeof CmsService>

export const createCmsServiceClient = (transport: Transport) => createClient(CmsService, transport)
