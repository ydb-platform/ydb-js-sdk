import { createClient, type Client, type Transport } from '@connectrpc/connect'
import { MonitoringService } from './gen/ydb_monitoring_v1_pb.js'

export * from './gen/ydb_monitoring_v1_pb.js'
export * from './gen/protos/ydb_monitoring_pb.js'

export type MonitoringServiceClient = Client<typeof MonitoringService>

export const createMonitoringClient = (transport: Transport) => createClient(MonitoringService, transport)
