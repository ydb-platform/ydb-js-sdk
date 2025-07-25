// @generated by protoc-gen-nice-grpc v1 with parameter "target=ts,import_extension=js"
// @generated from file ydb_scheme_v1.proto (package Ydb.Scheme.V1, syntax proto3)
/* eslint-disable */

import type { MessageInitShape } from "@bufbuild/protobuf";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { DescribePathRequestSchema, DescribePathResponseSchema, ListDirectoryRequestSchema, ListDirectoryResponseSchema, MakeDirectoryRequestSchema, MakeDirectoryResponseSchema, ModifyPermissionsRequestSchema, ModifyPermissionsResponseSchema, RemoveDirectoryRequestSchema, RemoveDirectoryResponseSchema } from "./protos/ydb_scheme_pb.js";
import type { ServiceDefinition } from "nice-grpc";

/**
 * @generated from service Ydb.Scheme.V1.SchemeService
 */
export const SchemeServiceDefinition = {
  /**
   * Make Directory.
   *
   * @generated from rpc Ydb.Scheme.V1.SchemeService.MakeDirectory
   */
  makeDirectory: {
    path: "/Ydb.Scheme.V1.SchemeService/MakeDirectory",
    requestStream: false,
    requestSerialize: (message: MessageInitShape<typeof MakeDirectoryRequestSchema>) => toBinary(MakeDirectoryRequestSchema, create(MakeDirectoryRequestSchema, message)),
    requestDeserialize: (bytes: Uint8Array) => fromBinary(MakeDirectoryRequestSchema,bytes),
      responseStream: false, 
    responseSerialize: (message: MessageInitShape<typeof MakeDirectoryResponseSchema>) => toBinary(MakeDirectoryResponseSchema, create(MakeDirectoryResponseSchema, message)),
    responseDeserialize: (bytes: Uint8Array) => fromBinary(MakeDirectoryResponseSchema,bytes),
    options: {},
  },
  /**
   * Remove Directory.
   *
   * @generated from rpc Ydb.Scheme.V1.SchemeService.RemoveDirectory
   */
  removeDirectory: {
    path: "/Ydb.Scheme.V1.SchemeService/RemoveDirectory",
    requestStream: false,
    requestSerialize: (message: MessageInitShape<typeof RemoveDirectoryRequestSchema>) => toBinary(RemoveDirectoryRequestSchema, create(RemoveDirectoryRequestSchema, message)),
    requestDeserialize: (bytes: Uint8Array) => fromBinary(RemoveDirectoryRequestSchema,bytes),
      responseStream: false, 
    responseSerialize: (message: MessageInitShape<typeof RemoveDirectoryResponseSchema>) => toBinary(RemoveDirectoryResponseSchema, create(RemoveDirectoryResponseSchema, message)),
    responseDeserialize: (bytes: Uint8Array) => fromBinary(RemoveDirectoryResponseSchema,bytes),
    options: {},
  },
  /**
   * Returns information about given directory and objects inside it.
   *
   * @generated from rpc Ydb.Scheme.V1.SchemeService.ListDirectory
   */
  listDirectory: {
    path: "/Ydb.Scheme.V1.SchemeService/ListDirectory",
    requestStream: false,
    requestSerialize: (message: MessageInitShape<typeof ListDirectoryRequestSchema>) => toBinary(ListDirectoryRequestSchema, create(ListDirectoryRequestSchema, message)),
    requestDeserialize: (bytes: Uint8Array) => fromBinary(ListDirectoryRequestSchema,bytes),
      responseStream: false, 
    responseSerialize: (message: MessageInitShape<typeof ListDirectoryResponseSchema>) => toBinary(ListDirectoryResponseSchema, create(ListDirectoryResponseSchema, message)),
    responseDeserialize: (bytes: Uint8Array) => fromBinary(ListDirectoryResponseSchema,bytes),
    options: {},
  },
  /**
   * Returns information about object with given path.
   *
   * @generated from rpc Ydb.Scheme.V1.SchemeService.DescribePath
   */
  describePath: {
    path: "/Ydb.Scheme.V1.SchemeService/DescribePath",
    requestStream: false,
    requestSerialize: (message: MessageInitShape<typeof DescribePathRequestSchema>) => toBinary(DescribePathRequestSchema, create(DescribePathRequestSchema, message)),
    requestDeserialize: (bytes: Uint8Array) => fromBinary(DescribePathRequestSchema,bytes),
      responseStream: false, 
    responseSerialize: (message: MessageInitShape<typeof DescribePathResponseSchema>) => toBinary(DescribePathResponseSchema, create(DescribePathResponseSchema, message)),
    responseDeserialize: (bytes: Uint8Array) => fromBinary(DescribePathResponseSchema,bytes),
    options: {},
  },
  /**
   * Modify permissions.
   *
   * @generated from rpc Ydb.Scheme.V1.SchemeService.ModifyPermissions
   */
  modifyPermissions: {
    path: "/Ydb.Scheme.V1.SchemeService/ModifyPermissions",
    requestStream: false,
    requestSerialize: (message: MessageInitShape<typeof ModifyPermissionsRequestSchema>) => toBinary(ModifyPermissionsRequestSchema, create(ModifyPermissionsRequestSchema, message)),
    requestDeserialize: (bytes: Uint8Array) => fromBinary(ModifyPermissionsRequestSchema,bytes),
      responseStream: false, 
    responseSerialize: (message: MessageInitShape<typeof ModifyPermissionsResponseSchema>) => toBinary(ModifyPermissionsResponseSchema, create(ModifyPermissionsResponseSchema, message)),
    responseDeserialize: (bytes: Uint8Array) => fromBinary(ModifyPermissionsResponseSchema,bytes),
    options: {},
  },
} as const satisfies ServiceDefinition
//@ts-expect-error
SchemeServiceDefinition["name"] = "SchemeService";
//@ts-expect-error
SchemeServiceDefinition["fullName"] = "Ydb.Scheme.V1.SchemeService";
