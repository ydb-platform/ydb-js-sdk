// @generated by protoc-gen-es v2.6.0 with parameter "target=ts,import_extension=js"
// @generated from file protos/ydb_federation_discovery.proto (package Ydb.FederationDiscovery, syntax proto3)
/* eslint-disable */

import type { GenEnum, GenFile, GenMessage } from "@bufbuild/protobuf/codegenv2";
import { enumDesc, fileDesc, messageDesc } from "@bufbuild/protobuf/codegenv2";
import type { Operation } from "./ydb_operation_pb.js";
import { file_protos_ydb_operation } from "./ydb_operation_pb.js";
import type { Message } from "@bufbuild/protobuf";

/**
 * Describes the file protos/ydb_federation_discovery.proto.
 */
export const file_protos_ydb_federation_discovery: GenFile = /*@__PURE__*/
  fileDesc("CiVwcm90b3MveWRiX2ZlZGVyYXRpb25fZGlzY292ZXJ5LnByb3RvEhdZZGIuRmVkZXJhdGlvbkRpc2NvdmVyeSL5AQoMRGF0YWJhc2VJbmZvEgwKBG5hbWUYASABKAkSDAoEcGF0aBgCIAEoCRIKCgJpZBgDIAEoCRIQCghlbmRwb2ludBgEIAEoCRIQCghsb2NhdGlvbhgFIAEoCRI8CgZzdGF0dXMYBiABKA4yLC5ZZGIuRmVkZXJhdGlvbkRpc2NvdmVyeS5EYXRhYmFzZUluZm8uU3RhdHVzEg4KBndlaWdodBgHIAEoAyJPCgZTdGF0dXMSFgoSU1RBVFVTX1VOU1BFQ0lGSUVEEAASDQoJQVZBSUxBQkxFEAESDQoJUkVBRF9PTkxZEAISDwoLVU5BVkFJTEFCTEUQAyIgCh5MaXN0RmVkZXJhdGlvbkRhdGFiYXNlc1JlcXVlc3QiTwofTGlzdEZlZGVyYXRpb25EYXRhYmFzZXNSZXNwb25zZRIsCglvcGVyYXRpb24YASABKAsyGS5ZZGIuT3BlcmF0aW9ucy5PcGVyYXRpb24imwEKHUxpc3RGZWRlcmF0aW9uRGF0YWJhc2VzUmVzdWx0Eh4KFmNvbnRyb2xfcGxhbmVfZW5kcG9pbnQYASABKAkSQwoUZmVkZXJhdGlvbl9kYXRhYmFzZXMYAiADKAsyJS5ZZGIuRmVkZXJhdGlvbkRpc2NvdmVyeS5EYXRhYmFzZUluZm8SFQoNc2VsZl9sb2NhdGlvbhgDIAEoCUKLAQojdGVjaC55ZGIucHJvdG8uZmVkZXJhdGlvbi5kaXNjb3ZlcnlCGUZlZGVyYXRpb25EaXNjb3ZlcnlQcm90b3NaRmdpdGh1Yi5jb20veWRiLXBsYXRmb3JtL3lkYi1nby1nZW5wcm90by9wcm90b3MvWWRiX0ZlZGVyYXRpb25EaXNjb3Zlcnn4AQFiBnByb3RvMw", [file_protos_ydb_operation]);

/**
 * @generated from message Ydb.FederationDiscovery.DatabaseInfo
 */
export type DatabaseInfo = Message<"Ydb.FederationDiscovery.DatabaseInfo"> & {
  /**
   * @generated from field: string name = 1;
   */
  name: string;

  /**
   * @generated from field: string path = 2;
   */
  path: string;

  /**
   * @generated from field: string id = 3;
   */
  id: string;

  /**
   * @generated from field: string endpoint = 4;
   */
  endpoint: string;

  /**
   * for single datacenter databases
   *
   * @generated from field: string location = 5;
   */
  location: string;

  /**
   * @generated from field: Ydb.FederationDiscovery.DatabaseInfo.Status status = 6;
   */
  status: DatabaseInfo_Status;

  /**
   * to determine this database priority on the client side
   *
   * @generated from field: int64 weight = 7;
   */
  weight: bigint;
};

/**
 * Describes the message Ydb.FederationDiscovery.DatabaseInfo.
 * Use `create(DatabaseInfoSchema)` to create a new message.
 */
export const DatabaseInfoSchema: GenMessage<DatabaseInfo> = /*@__PURE__*/
  messageDesc(file_protos_ydb_federation_discovery, 0);

/**
 * @generated from enum Ydb.FederationDiscovery.DatabaseInfo.Status
 */
export enum DatabaseInfo_Status {
  /**
   * @generated from enum value: STATUS_UNSPECIFIED = 0;
   */
  STATUS_UNSPECIFIED = 0,

  /**
   * @generated from enum value: AVAILABLE = 1;
   */
  AVAILABLE = 1,

  /**
   * @generated from enum value: READ_ONLY = 2;
   */
  READ_ONLY = 2,

  /**
   * @generated from enum value: UNAVAILABLE = 3;
   */
  UNAVAILABLE = 3,
}

/**
 * Describes the enum Ydb.FederationDiscovery.DatabaseInfo.Status.
 */
export const DatabaseInfo_StatusSchema: GenEnum<DatabaseInfo_Status> = /*@__PURE__*/
  enumDesc(file_protos_ydb_federation_discovery, 0, 0);

/**
 * @generated from message Ydb.FederationDiscovery.ListFederationDatabasesRequest
 */
export type ListFederationDatabasesRequest = Message<"Ydb.FederationDiscovery.ListFederationDatabasesRequest"> & {
};

/**
 * Describes the message Ydb.FederationDiscovery.ListFederationDatabasesRequest.
 * Use `create(ListFederationDatabasesRequestSchema)` to create a new message.
 */
export const ListFederationDatabasesRequestSchema: GenMessage<ListFederationDatabasesRequest> = /*@__PURE__*/
  messageDesc(file_protos_ydb_federation_discovery, 1);

/**
 * @generated from message Ydb.FederationDiscovery.ListFederationDatabasesResponse
 */
export type ListFederationDatabasesResponse = Message<"Ydb.FederationDiscovery.ListFederationDatabasesResponse"> & {
  /**
   * Operation contains the result of the request. Check the ydb_operation.proto.
   *
   * @generated from field: Ydb.Operations.Operation operation = 1;
   */
  operation?: Operation;
};

/**
 * Describes the message Ydb.FederationDiscovery.ListFederationDatabasesResponse.
 * Use `create(ListFederationDatabasesResponseSchema)` to create a new message.
 */
export const ListFederationDatabasesResponseSchema: GenMessage<ListFederationDatabasesResponse> = /*@__PURE__*/
  messageDesc(file_protos_ydb_federation_discovery, 2);

/**
 * @generated from message Ydb.FederationDiscovery.ListFederationDatabasesResult
 */
export type ListFederationDatabasesResult = Message<"Ydb.FederationDiscovery.ListFederationDatabasesResult"> & {
  /**
   * @generated from field: string control_plane_endpoint = 1;
   */
  controlPlaneEndpoint: string;

  /**
   * @generated from field: repeated Ydb.FederationDiscovery.DatabaseInfo federation_databases = 2;
   */
  federationDatabases: DatabaseInfo[];

  /**
   * @generated from field: string self_location = 3;
   */
  selfLocation: string;
};

/**
 * Describes the message Ydb.FederationDiscovery.ListFederationDatabasesResult.
 * Use `create(ListFederationDatabasesResultSchema)` to create a new message.
 */
export const ListFederationDatabasesResultSchema: GenMessage<ListFederationDatabasesResult> = /*@__PURE__*/
  messageDesc(file_protos_ydb_federation_discovery, 3);

