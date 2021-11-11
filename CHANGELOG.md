# Changelog

### 2.6.0
* YDB definitions bundle and generating bundle from protobuf files have been moved to ydb-sdk-proto
  dependency package

### 2.5.0
* All authentication helper classes are now exported from top-level and ready to be used in client
  code.
* Added authentication code snippets to /examples

### 2.4.0
* Support new unified environment variables: YDB_ACCESS_TOKEN_CREDENTIALS,
  YDB_ANONYMOUS_CREDENTIALS, YDB_METADATA_CREDENTIALS, YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS
* Deprecate old credentials environment variables: YDB_TOKEN, SA_ID, SA_PRIVATE_KEY_FILE,
  SA_ACCESS_KEY_ID, SA_JSON_FILE
* Put back embedded certificate file, now certificates for YDB dedicated instances are
  concatenated with system certificates, which should allow to use embedded certificate
  for both dedicated and serverless databases.

### 2.3.0
* Provide `Primitive` helper class for easy creation of primitive values, see how it's used in
  in /scan-query example.

### 2.2.0
* Support `streamExecuteScanQuery()` method in `tableClient`
* Provide means to alter default snake_case - camelCase field names conversion when moving data
  between YDB and JS side, via `@withTypeOptions` decorator (with an example)

### 2.1.0
* Allow passing gRPC [client options](https://grpc.github.io/grpc/core/group__grpc__arg__keys.html)
  under `clientOptions` key to `Driver` constructor. This enables changing different
  gRPC settings in `tableClient` and `schemaClient` calls.

### 2.0.0
* BREAKING CHANGE: StorageSettings class exported at toplevel has changed its structure:
  the only public `storageKind` field has been renamed to `media`, type is the same. This
  was done due to underlying protobufs change, where StorageSettings message has been
  completely changed and the old StorageSettings is now known as StoragePool (with `media` field).
* Added JSON_DOCUMENT YDB primitive support.
* ExecuteStreamQuery -> StreamExecuteScanQuery in protobufs
* and many other changes in protobufs.

### 1.10.0
* Add `alterTable` method to Session class
* Put compiled protobufs to a separate 'ydb-sdk' namespace

### 1.9.0
* Pass 'x-ydb-sdk-build-info' header with library name/version to every GRPC request.
