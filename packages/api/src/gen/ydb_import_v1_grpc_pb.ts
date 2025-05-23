// @generated by protoc-gen-nice-grpc v1 with parameter "target=ts,import_extension=js"
// @generated from file ydb_import_v1.proto (package Ydb.Import.V1, syntax proto3)
/* eslint-disable */

import type { MessageInitShape } from "@bufbuild/protobuf";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ImportDataRequestSchema, ImportDataResponseSchema, ImportFromS3RequestSchema, ImportFromS3ResponseSchema } from "./protos/ydb_import_pb.js";
import type { ServiceDefinition } from "nice-grpc";

/**
 * @generated from service Ydb.Import.V1.ImportService
 */
export const ImportServiceDefinition = {
  /**
   * Imports data from S3.
   * Method starts an asynchronous operation that can be cancelled while it is in progress.
   *
   * @generated from rpc Ydb.Import.V1.ImportService.ImportFromS3
   */
  importFromS3: {
    path: "/Ydb.Import.V1.ImportService/ImportFromS3",
    requestStream: false,
    requestSerialize: (message: MessageInitShape<typeof ImportFromS3RequestSchema>) => toBinary(ImportFromS3RequestSchema, create(ImportFromS3RequestSchema, message)),
    requestDeserialize: (bytes: Uint8Array) => fromBinary(ImportFromS3RequestSchema,bytes),
      responseStream: false, 
    responseSerialize: (message: MessageInitShape<typeof ImportFromS3ResponseSchema>) => toBinary(ImportFromS3ResponseSchema, create(ImportFromS3ResponseSchema, message)),
    responseDeserialize: (bytes: Uint8Array) => fromBinary(ImportFromS3ResponseSchema,bytes),
    options: {},
  },
  /**
   * Writes data to a table.
   * Method accepts serialized data in the selected format and writes it non-transactionally.
   *
   * @generated from rpc Ydb.Import.V1.ImportService.ImportData
   */
  importData: {
    path: "/Ydb.Import.V1.ImportService/ImportData",
    requestStream: false,
    requestSerialize: (message: MessageInitShape<typeof ImportDataRequestSchema>) => toBinary(ImportDataRequestSchema, create(ImportDataRequestSchema, message)),
    requestDeserialize: (bytes: Uint8Array) => fromBinary(ImportDataRequestSchema,bytes),
      responseStream: false, 
    responseSerialize: (message: MessageInitShape<typeof ImportDataResponseSchema>) => toBinary(ImportDataResponseSchema, create(ImportDataResponseSchema, message)),
    responseDeserialize: (bytes: Uint8Array) => fromBinary(ImportDataResponseSchema,bytes),
    options: {},
  },
} as const satisfies ServiceDefinition
