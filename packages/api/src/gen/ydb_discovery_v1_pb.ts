// @generated by protoc-gen-es v2.2.3 with parameter "target=ts,import_extension=js"
// @generated from file ydb_discovery_v1.proto (package Ydb.Discovery.V1, syntax proto3)
/* eslint-disable */

import type { GenFile, GenService } from "@bufbuild/protobuf/codegenv1";
import { fileDesc, serviceDesc } from "@bufbuild/protobuf/codegenv1";
import type { ListEndpointsRequestSchema, ListEndpointsResponseSchema, WhoAmIRequestSchema, WhoAmIResponseSchema } from "./protos/ydb_discovery_pb.js";
import { file_protos_ydb_discovery } from "./protos/ydb_discovery_pb.js";

/**
 * Describes the file ydb_discovery_v1.proto.
 */
export const file_ydb_discovery_v1: GenFile = /*@__PURE__*/
  fileDesc("ChZ5ZGJfZGlzY292ZXJ5X3YxLnByb3RvEhBZZGIuRGlzY292ZXJ5LlYxMrUBChBEaXNjb3ZlcnlTZXJ2aWNlEloKDUxpc3RFbmRwb2ludHMSIy5ZZGIuRGlzY292ZXJ5Lkxpc3RFbmRwb2ludHNSZXF1ZXN0GiQuWWRiLkRpc2NvdmVyeS5MaXN0RW5kcG9pbnRzUmVzcG9uc2USRQoGV2hvQW1JEhwuWWRiLkRpc2NvdmVyeS5XaG9BbUlSZXF1ZXN0Gh0uWWRiLkRpc2NvdmVyeS5XaG9BbUlSZXNwb25zZUJXCht0ZWNoLnlkYi5wcm90by5kaXNjb3ZlcnkudjFaOGdpdGh1Yi5jb20veWRiLXBsYXRmb3JtL3lkYi1nby1nZW5wcm90by9ZZGJfRGlzY292ZXJ5X1YxYgZwcm90bzM", [file_protos_ydb_discovery]);

/**
 * @generated from service Ydb.Discovery.V1.DiscoveryService
 */
export const DiscoveryService: GenService<{
  /**
   * @generated from rpc Ydb.Discovery.V1.DiscoveryService.ListEndpoints
   */
  listEndpoints: {
    methodKind: "unary";
    input: typeof ListEndpointsRequestSchema;
    output: typeof ListEndpointsResponseSchema;
  },
  /**
   * @generated from rpc Ydb.Discovery.V1.DiscoveryService.WhoAmI
   */
  whoAmI: {
    methodKind: "unary";
    input: typeof WhoAmIRequestSchema;
    output: typeof WhoAmIResponseSchema;
  },
}> = /*@__PURE__*/
  serviceDesc(file_ydb_discovery_v1, 0);

