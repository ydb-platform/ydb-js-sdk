// @generated by protoc-gen-es v2.2.3 with parameter "target=ts,import_extension=js"
// @generated from file ydb_federation_discovery_v1.proto (package Ydb.FederationDiscovery.V1, syntax proto3)
/* eslint-disable */

import type { GenFile, GenService } from "@bufbuild/protobuf/codegenv1";
import { fileDesc, serviceDesc } from "@bufbuild/protobuf/codegenv1";
import type { ListFederationDatabasesRequestSchema, ListFederationDatabasesResponseSchema } from "./protos/ydb_federation_discovery_pb.js";
import { file_protos_ydb_federation_discovery } from "./protos/ydb_federation_discovery_pb.js";

/**
 * Describes the file ydb_federation_discovery_v1.proto.
 */
export const file_ydb_federation_discovery_v1: GenFile = /*@__PURE__*/
  fileDesc("CiF5ZGJfZmVkZXJhdGlvbl9kaXNjb3ZlcnlfdjEucHJvdG8SGllkYi5GZWRlcmF0aW9uRGlzY292ZXJ5LlYxMqsBChpGZWRlcmF0aW9uRGlzY292ZXJ5U2VydmljZRKMAQoXTGlzdEZlZGVyYXRpb25EYXRhYmFzZXMSNy5ZZGIuRmVkZXJhdGlvbkRpc2NvdmVyeS5MaXN0RmVkZXJhdGlvbkRhdGFiYXNlc1JlcXVlc3QaOC5ZZGIuRmVkZXJhdGlvbkRpc2NvdmVyeS5MaXN0RmVkZXJhdGlvbkRhdGFiYXNlc1Jlc3BvbnNlQmwKJnRlY2gueWRiLnByb3RvLmZlZGVyYXRpb24uZGlzY292ZXJ5LnYxWkJnaXRodWIuY29tL3lkYi1wbGF0Zm9ybS95ZGItZ28tZ2VucHJvdG8vWWRiX0ZlZGVyYXRpb25EaXNjb3ZlcnlfVjFiBnByb3RvMw", [file_protos_ydb_federation_discovery]);

/**
 * @generated from service Ydb.FederationDiscovery.V1.FederationDiscoveryService
 */
export const FederationDiscoveryService: GenService<{
  /**
   * Get list of databases.
   *
   * @generated from rpc Ydb.FederationDiscovery.V1.FederationDiscoveryService.ListFederationDatabases
   */
  listFederationDatabases: {
    methodKind: "unary";
    input: typeof ListFederationDatabasesRequestSchema;
    output: typeof ListFederationDatabasesResponseSchema;
  },
}> = /*@__PURE__*/
  serviceDesc(file_ydb_federation_discovery_v1, 0);

