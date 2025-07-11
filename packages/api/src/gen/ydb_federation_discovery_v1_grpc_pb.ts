// @generated by protoc-gen-nice-grpc v1 with parameter "target=ts,import_extension=js"
// @generated from file ydb_federation_discovery_v1.proto (package Ydb.FederationDiscovery.V1, syntax proto3)
/* eslint-disable */

import type { MessageInitShape } from "@bufbuild/protobuf";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ListFederationDatabasesRequestSchema, ListFederationDatabasesResponseSchema } from "./protos/ydb_federation_discovery_pb.js";
import type { ServiceDefinition } from "nice-grpc";

/**
 * @generated from service Ydb.FederationDiscovery.V1.FederationDiscoveryService
 */
export const FederationDiscoveryServiceDefinition = {
  /**
   * Get list of databases.
   *
   * @generated from rpc Ydb.FederationDiscovery.V1.FederationDiscoveryService.ListFederationDatabases
   */
  listFederationDatabases: {
    path: "/Ydb.FederationDiscovery.V1.FederationDiscoveryService/ListFederationDatabases",
    requestStream: false,
    requestSerialize: (message: MessageInitShape<typeof ListFederationDatabasesRequestSchema>) => toBinary(ListFederationDatabasesRequestSchema, create(ListFederationDatabasesRequestSchema, message)),
    requestDeserialize: (bytes: Uint8Array) => fromBinary(ListFederationDatabasesRequestSchema,bytes),
      responseStream: false, 
    responseSerialize: (message: MessageInitShape<typeof ListFederationDatabasesResponseSchema>) => toBinary(ListFederationDatabasesResponseSchema, create(ListFederationDatabasesResponseSchema, message)),
    responseDeserialize: (bytes: Uint8Array) => fromBinary(ListFederationDatabasesResponseSchema,bytes),
    options: {},
  },
} as const satisfies ServiceDefinition
//@ts-expect-error
FederationDiscoveryServiceDefinition["name"] = "FederationDiscoveryService";
//@ts-expect-error
FederationDiscoveryServiceDefinition["fullName"] = "Ydb.FederationDiscovery.V1.FederationDiscoveryService";
