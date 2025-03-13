// @generated by protoc-gen-es v2.2.3 with parameter "target=ts,import_extension=js"
// @generated from file ydb_operation_v1.proto (package Ydb.Operation.V1, syntax proto3)
/* eslint-disable */

import type { GenFile, GenService } from "@bufbuild/protobuf/codegenv1";
import { fileDesc, serviceDesc } from "@bufbuild/protobuf/codegenv1";
import type { CancelOperationRequestSchema, CancelOperationResponseSchema, ForgetOperationRequestSchema, ForgetOperationResponseSchema, GetOperationRequestSchema, GetOperationResponseSchema, ListOperationsRequestSchema, ListOperationsResponseSchema } from "./protos/ydb_operation_pb.js";
import { file_protos_ydb_operation } from "./protos/ydb_operation_pb.js";

/**
 * Describes the file ydb_operation_v1.proto.
 */
export const file_ydb_operation_v1: GenFile = /*@__PURE__*/
  fileDesc("ChZ5ZGJfb3BlcmF0aW9uX3YxLnByb3RvEhBZZGIuT3BlcmF0aW9uLlYxMpYDChBPcGVyYXRpb25TZXJ2aWNlElkKDEdldE9wZXJhdGlvbhIjLllkYi5PcGVyYXRpb25zLkdldE9wZXJhdGlvblJlcXVlc3QaJC5ZZGIuT3BlcmF0aW9ucy5HZXRPcGVyYXRpb25SZXNwb25zZRJiCg9DYW5jZWxPcGVyYXRpb24SJi5ZZGIuT3BlcmF0aW9ucy5DYW5jZWxPcGVyYXRpb25SZXF1ZXN0GicuWWRiLk9wZXJhdGlvbnMuQ2FuY2VsT3BlcmF0aW9uUmVzcG9uc2USYgoPRm9yZ2V0T3BlcmF0aW9uEiYuWWRiLk9wZXJhdGlvbnMuRm9yZ2V0T3BlcmF0aW9uUmVxdWVzdBonLllkYi5PcGVyYXRpb25zLkZvcmdldE9wZXJhdGlvblJlc3BvbnNlEl8KDkxpc3RPcGVyYXRpb25zEiUuWWRiLk9wZXJhdGlvbnMuTGlzdE9wZXJhdGlvbnNSZXF1ZXN0GiYuWWRiLk9wZXJhdGlvbnMuTGlzdE9wZXJhdGlvbnNSZXNwb25zZUJXCht0ZWNoLnlkYi5wcm90by5vcGVyYXRpb24udjFaOGdpdGh1Yi5jb20veWRiLXBsYXRmb3JtL3lkYi1nby1nZW5wcm90by9ZZGJfT3BlcmF0aW9uX1YxYgZwcm90bzM", [file_protos_ydb_operation]);

/**
 * @generated from service Ydb.Operation.V1.OperationService
 */
export const OperationService: GenService<{
  /**
   * Check status for a given operation.
   *
   * @generated from rpc Ydb.Operation.V1.OperationService.GetOperation
   */
  getOperation: {
    methodKind: "unary";
    input: typeof GetOperationRequestSchema;
    output: typeof GetOperationResponseSchema;
  },
  /**
   * Starts cancellation of a long-running operation,
   * Clients can use GetOperation to check whether the cancellation succeeded
   * or whether the operation completed despite cancellation.
   *
   * @generated from rpc Ydb.Operation.V1.OperationService.CancelOperation
   */
  cancelOperation: {
    methodKind: "unary";
    input: typeof CancelOperationRequestSchema;
    output: typeof CancelOperationResponseSchema;
  },
  /**
   * Forgets long-running operation. It does not cancel the operation and returns
   * an error if operation was not completed.
   *
   * @generated from rpc Ydb.Operation.V1.OperationService.ForgetOperation
   */
  forgetOperation: {
    methodKind: "unary";
    input: typeof ForgetOperationRequestSchema;
    output: typeof ForgetOperationResponseSchema;
  },
  /**
   * Lists operations that match the specified filter in the request.
   *
   * @generated from rpc Ydb.Operation.V1.OperationService.ListOperations
   */
  listOperations: {
    methodKind: "unary";
    input: typeof ListOperationsRequestSchema;
    output: typeof ListOperationsResponseSchema;
  },
}> = /*@__PURE__*/
  serviceDesc(file_ydb_operation_v1, 0);

