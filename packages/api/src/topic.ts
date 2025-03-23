import { createClient, type Client, type Transport } from '@connectrpc/connect';
import { TopicService } from './gen/ydb_topic_v1_pb.js';

export * from './gen/ydb_topic_v1_pb.js';
export * from './gen/protos/ydb_topic_pb.js';

export type TopicServiceClient = Client<typeof TopicService>;

export const createTopicClient = (transport: Transport) => createClient(TopicService, transport)
