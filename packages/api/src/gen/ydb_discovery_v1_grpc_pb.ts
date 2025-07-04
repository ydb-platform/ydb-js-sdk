// @generated by protoc-gen-nice-grpc v1 with parameter "target=ts,import_extension=js"
// @generated from file ydb_discovery_v1.proto (package Ydb.Discovery.V1, syntax proto3)
/* eslint-disable */

import type { MessageInitShape } from "@bufbuild/protobuf";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ListEndpointsRequestSchema, ListEndpointsResponseSchema, WhoAmIRequestSchema, WhoAmIResponseSchema } from "./protos/ydb_discovery_pb.js";
import type { ServiceDefinition } from "nice-grpc";

/**
 * @generated from service Ydb.Discovery.V1.DiscoveryService
 */
export const DiscoveryServiceDefinition = {
  /**
   * @generated from rpc Ydb.Discovery.V1.DiscoveryService.ListEndpoints
   */
  listEndpoints: {
    path: "/Ydb.Discovery.V1.DiscoveryService/ListEndpoints",
    requestStream: false,
    requestSerialize: (message: MessageInitShape<typeof ListEndpointsRequestSchema>) => toBinary(ListEndpointsRequestSchema, create(ListEndpointsRequestSchema, message)),
    requestDeserialize: (bytes: Uint8Array) => fromBinary(ListEndpointsRequestSchema,bytes),
      responseStream: false, 
    responseSerialize: (message: MessageInitShape<typeof ListEndpointsResponseSchema>) => toBinary(ListEndpointsResponseSchema, create(ListEndpointsResponseSchema, message)),
    responseDeserialize: (bytes: Uint8Array) => fromBinary(ListEndpointsResponseSchema,bytes),
    options: {},
  },
  /**
   * @generated from rpc Ydb.Discovery.V1.DiscoveryService.WhoAmI
   */
  whoAmI: {
    path: "/Ydb.Discovery.V1.DiscoveryService/WhoAmI",
    requestStream: false,
    requestSerialize: (message: MessageInitShape<typeof WhoAmIRequestSchema>) => toBinary(WhoAmIRequestSchema, create(WhoAmIRequestSchema, message)),
    requestDeserialize: (bytes: Uint8Array) => fromBinary(WhoAmIRequestSchema,bytes),
      responseStream: false, 
    responseSerialize: (message: MessageInitShape<typeof WhoAmIResponseSchema>) => toBinary(WhoAmIResponseSchema, create(WhoAmIResponseSchema, message)),
    responseDeserialize: (bytes: Uint8Array) => fromBinary(WhoAmIResponseSchema,bytes),
    options: {},
  },
} as const satisfies ServiceDefinition
//@ts-expect-error
DiscoveryServiceDefinition["name"] = "DiscoveryService";
//@ts-expect-error
DiscoveryServiceDefinition["fullName"] = "Ydb.Discovery.V1.DiscoveryService";
