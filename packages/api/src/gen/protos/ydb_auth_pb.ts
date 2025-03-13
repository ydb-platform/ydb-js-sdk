// @generated by protoc-gen-es v2.2.3 with parameter "target=ts,import_extension=js"
// @generated from file protos/ydb_auth.proto (package Ydb.Auth, syntax proto3)
/* eslint-disable */

import type { GenFile, GenMessage } from "@bufbuild/protobuf/codegenv1";
import { fileDesc, messageDesc } from "@bufbuild/protobuf/codegenv1";
import type { Operation, OperationParams } from "./ydb_operation_pb.js";
import { file_protos_ydb_operation } from "./ydb_operation_pb.js";
import type { Message } from "@bufbuild/protobuf";

/**
 * Describes the file protos/ydb_auth.proto.
 */
export const file_protos_ydb_auth: GenFile = /*@__PURE__*/
  fileDesc("ChVwcm90b3MveWRiX2F1dGgucHJvdG8SCFlkYi5BdXRoImkKDExvZ2luUmVxdWVzdBI5ChBvcGVyYXRpb25fcGFyYW1zGAEgASgLMh8uWWRiLk9wZXJhdGlvbnMuT3BlcmF0aW9uUGFyYW1zEgwKBHVzZXIYAiABKAkSEAoIcGFzc3dvcmQYAyABKAkiPQoNTG9naW5SZXNwb25zZRIsCglvcGVyYXRpb24YASABKAsyGS5ZZGIuT3BlcmF0aW9ucy5PcGVyYXRpb24iHAoLTG9naW5SZXN1bHQSDQoFdG9rZW4YASABKAlCUQoTdGVjaC55ZGIucHJvdG8uYXV0aFo3Z2l0aHViLmNvbS95ZGItcGxhdGZvcm0veWRiLWdvLWdlbnByb3RvL3Byb3Rvcy9ZZGJfQXV0aPgBAWIGcHJvdG8z", [file_protos_ydb_operation]);

/**
 * @generated from message Ydb.Auth.LoginRequest
 */
export type LoginRequest = Message<"Ydb.Auth.LoginRequest"> & {
  /**
   * @generated from field: Ydb.Operations.OperationParams operation_params = 1;
   */
  operationParams?: OperationParams;

  /**
   * @generated from field: string user = 2;
   */
  user: string;

  /**
   * @generated from field: string password = 3;
   */
  password: string;
};

/**
 * Describes the message Ydb.Auth.LoginRequest.
 * Use `create(LoginRequestSchema)` to create a new message.
 */
export const LoginRequestSchema: GenMessage<LoginRequest> = /*@__PURE__*/
  messageDesc(file_protos_ydb_auth, 0);

/**
 * @generated from message Ydb.Auth.LoginResponse
 */
export type LoginResponse = Message<"Ydb.Auth.LoginResponse"> & {
  /**
   * After successfull completion must contain LoginResult.
   *
   * @generated from field: Ydb.Operations.Operation operation = 1;
   */
  operation?: Operation;
};

/**
 * Describes the message Ydb.Auth.LoginResponse.
 * Use `create(LoginResponseSchema)` to create a new message.
 */
export const LoginResponseSchema: GenMessage<LoginResponse> = /*@__PURE__*/
  messageDesc(file_protos_ydb_auth, 1);

/**
 * @generated from message Ydb.Auth.LoginResult
 */
export type LoginResult = Message<"Ydb.Auth.LoginResult"> & {
  /**
   * @generated from field: string token = 1;
   */
  token: string;
};

/**
 * Describes the message Ydb.Auth.LoginResult.
 * Use `create(LoginResultSchema)` to create a new message.
 */
export const LoginResultSchema: GenMessage<LoginResult> = /*@__PURE__*/
  messageDesc(file_protos_ydb_auth, 2);

