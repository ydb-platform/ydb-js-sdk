import { createClient, type Client, type Transport } from '@connectrpc/connect'
import { RateLimiterService } from './gen/ydb_rate_limiter_v1_pb.js'

export * from './gen/ydb_rate_limiter_v1_pb.js'
export * from './gen/protos/ydb_rate_limiter_pb.js'

export type RateLimiterServiceClient = Client<typeof RateLimiterService>

export const createRateLimiterClient = (transport: Transport) => createClient(RateLimiterService, transport)
