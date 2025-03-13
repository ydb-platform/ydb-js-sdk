// @generated by protoc-gen-es v2.2.3 with parameter "target=ts,import_extension=js"
// @generated from file protos/ydb_formats.proto (package Ydb.Formats, syntax proto3)
/* eslint-disable */

import type { GenFile, GenMessage } from "@bufbuild/protobuf/codegenv1";
import { fileDesc, messageDesc } from "@bufbuild/protobuf/codegenv1";
import type { Message } from "@bufbuild/protobuf";

/**
 * Describes the file protos/ydb_formats.proto.
 */
export const file_protos_ydb_formats: GenFile = /*@__PURE__*/
  fileDesc("Chhwcm90b3MveWRiX2Zvcm1hdHMucHJvdG8SC1lkYi5Gb3JtYXRzIiQKEkFycm93QmF0Y2hTZXR0aW5ncxIOCgZzY2hlbWEYASABKAwi2gEKC0NzdlNldHRpbmdzEhEKCXNraXBfcm93cxgBIAEoDRIRCglkZWxpbWl0ZXIYAiABKAwSEgoKbnVsbF92YWx1ZRgDIAEoDBIOCgZoZWFkZXIYBCABKAgSMQoHcXVvdGluZxgFIAEoCzIgLllkYi5Gb3JtYXRzLkNzdlNldHRpbmdzLlF1b3RpbmcaTgoHUXVvdGluZxIQCghkaXNhYmxlZBgBIAEoCBISCgpxdW90ZV9jaGFyGAIgASgMEh0KFWRvdWJsZV9xdW90ZV9kaXNhYmxlZBgDIAEoCEJXChZ0ZWNoLnlkYi5wcm90by5mb3JtYXRzWjpnaXRodWIuY29tL3lkYi1wbGF0Zm9ybS95ZGItZ28tZ2VucHJvdG8vcHJvdG9zL1lkYl9Gb3JtYXRz+AEBYgZwcm90bzM");

/**
 * @generated from message Ydb.Formats.ArrowBatchSettings
 */
export type ArrowBatchSettings = Message<"Ydb.Formats.ArrowBatchSettings"> & {
  /**
   * @generated from field: bytes schema = 1;
   */
  schema: Uint8Array;
};

/**
 * Describes the message Ydb.Formats.ArrowBatchSettings.
 * Use `create(ArrowBatchSettingsSchema)` to create a new message.
 */
export const ArrowBatchSettingsSchema: GenMessage<ArrowBatchSettings> = /*@__PURE__*/
  messageDesc(file_protos_ydb_formats, 0);

/**
 * @generated from message Ydb.Formats.CsvSettings
 */
export type CsvSettings = Message<"Ydb.Formats.CsvSettings"> & {
  /**
   * Number of rows to skip before CSV data. It should be present only in the first upsert of CSV file.
   *
   * @generated from field: uint32 skip_rows = 1;
   */
  skipRows: number;

  /**
   * Fields delimiter in CSV file. It's "," if not set.
   *
   * @generated from field: bytes delimiter = 2;
   */
  delimiter: Uint8Array;

  /**
   * String value that would be interpreted as NULL.
   *
   * @generated from field: bytes null_value = 3;
   */
  nullValue: Uint8Array;

  /**
   * First not skipped line is a CSV header (list of column names).
   *
   * @generated from field: bool header = 4;
   */
  header: boolean;

  /**
   * @generated from field: Ydb.Formats.CsvSettings.Quoting quoting = 5;
   */
  quoting?: CsvSettings_Quoting;
};

/**
 * Describes the message Ydb.Formats.CsvSettings.
 * Use `create(CsvSettingsSchema)` to create a new message.
 */
export const CsvSettingsSchema: GenMessage<CsvSettings> = /*@__PURE__*/
  messageDesc(file_protos_ydb_formats, 1);

/**
 * @generated from message Ydb.Formats.CsvSettings.Quoting
 */
export type CsvSettings_Quoting = Message<"Ydb.Formats.CsvSettings.Quoting"> & {
  /**
   * @generated from field: bool disabled = 1;
   */
  disabled: boolean;

  /**
   * @generated from field: bytes quote_char = 2;
   */
  quoteChar: Uint8Array;

  /**
   * @generated from field: bool double_quote_disabled = 3;
   */
  doubleQuoteDisabled: boolean;
};

/**
 * Describes the message Ydb.Formats.CsvSettings.Quoting.
 * Use `create(CsvSettings_QuotingSchema)` to create a new message.
 */
export const CsvSettings_QuotingSchema: GenMessage<CsvSettings_Quoting> = /*@__PURE__*/
  messageDesc(file_protos_ydb_formats, 1, 0);

