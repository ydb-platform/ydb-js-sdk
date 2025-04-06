# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [5.11.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v5.10.0...v5.11.0) (2025-03-24)


### Features

* enhance static credentials authentication with token refresh interval and improved token handling ([444a34d](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/444a34d19bf4b0acdee4909f0c4f035c7be700e0))


### Bug Fixes

* avoid unnecessary variable declaration in consumed units example ([dd5ebcd](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/dd5ebcd9fffb29e3260f2f285f768451e232f11e))

## [5.10.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v5.9.1...v5.10.0) (2025-03-19)


### Features

* add sessionTrailerCallbackSymbol and support for trailer callbacks in QueryClient ([d9ae990](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/d9ae9905129f203611d0e6fc4fcf3bb42385efe6))


### Bug Fixes

* do not remove session tx id if txMeta empty. ([b3e1c01](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/b3e1c01fbcb1ad3b981b4350ea365fe5c988550c))

## [5.9.1](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v5.9.0...v5.9.1) (2025-02-15)


### Bug Fixes

* correct get IAM token with authorized key ([8111762](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/8111762ddb125aa63fd88ff49eb3034ccf26b12c))
* **driver:** bring endpoint and connection string to just a host ([7bf10b0](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/7bf10b0a25c8ccfefec275a8720233d2b94f7860))
* export QuerySession from root ([cfd1efa](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/cfd1efa1c2fc4e5c18f5ea3a63bbef20725ed6b3))
* fixed database connection URL ([77800f1](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/77800f1502f27dabe74c21d71c0c66d4e26062ae))
* fixed database connection URL ([27f64d5](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/27f64d5c41588b1b122f684e2b585cbde27b716c))

## [5.9.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v5.8.0...v5.9.0) (2025-02-11)


### Features

* enhance UUID handling ([12704a6](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/12704a6193aa4573ff437f2a8afc546bc8aff2f4))
* **table:** add support for unique index ([6d2946c](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/6d2946c7dafa445372fc72e99f7479af34e08914))
* update Long type usage and improve UUID generation in topic client ([058b5a4](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/058b5a4730c32773afd8c7748a093e2ed41b1b9f))

## [5.8.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v5.7.0...v5.8.0) (2024-10-30)


### Features

* rename poolId to resourcePool and deprecate ([74de142](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/74de1429fd02ffc862d208daf671245f543c01ce))

## [5.7.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v5.6.0...v5.7.0) (2024-10-30)


### Features

* add support for poolId parameter in query service requests ([1098749](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/1098749259cee66942987e14e25a77dbba08e206))

## [5.6.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v5.5.3...v5.6.0) (2024-10-29)


### Features

* update ydb-sdk-proto dep ([e4ff812](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/e4ff812a43092fcbc643e5f0df525425e1c965de))

## [5.5.3](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v5.5.2...v5.5.3) (2024-10-22)


### Bug Fixes

* topic stream auth in cloud ([6adca13](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/6adca13c4b470e73fb300cdda0340b135fa66377))

## [5.5.2](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v5.5.1...v5.5.2) (2024-10-15)


### Bug Fixes

* fix topic example and make Context publically available ([644c116](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/644c116255eda9431538b1db0d91d36e6b978710))
* update protobufjs to the latest version and add dependencies to protobufjs in the proto file ([509ea47](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/509ea478bed3399d237b39d3482e8d9986ffd8d1))

## [5.5.1](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v5.5.0...v5.5.1) (2024-10-03)


### Bug Fixes

* add explicit dependency on protobufjs package ([031d2be](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/031d2bed5939e67e2c75e1cd47209a2bffbb2627))

## [5.5.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v5.4.0...v5.5.0) (2024-09-30)


### Features

* add retrier to the topics ([03fc7f9](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/03fc7f907fba641f3aaaf752875220de0e607e6b))

## [5.4.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v5.3.5...v5.4.0) (2024-09-27)


### Features

* add idempotent option to tableClient session.executeQuery ([89df57e](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/89df57eeb39a322af7dfbe84ce25c20549cce70b))

## [5.3.5](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v5.3.4...v5.3.5) (2024-09-26)


### Bug Fixes

* "Call cancelled" error ([ee14b9f](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/ee14b9f386059a97b41ebe417fab905ea72b18ba))

## [5.3.4](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v5.3.3...v5.3.4) (2024-08-20)


### Bug Fixes

* initial version of topic service client ([2db4f42](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/2db4f424f8da9f8751a7efe847eb8cad3a02633d))

## [5.3.3](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v5.3.2...v5.3.3) (2024-07-04)


### Bug Fixes

* add DECLARE that is still required by YDB 24.1 ([8920fee](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/8920feec8ff45ca0210019d57a6b92cc5e2e9880))
* query service switched to new retryer ([43ce40b](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/43ce40b4b354e585f750ef9ba14331013352e7f9))

## [5.3.2](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v5.3.1...v5.3.2) (2024-03-28)


### Bug Fixes

* add opFinished in query service result ([cf2959c](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/cf2959c4eae01bb5f5e07090e85cd7499f79be6c))

## [5.3.1](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v5.3.0...v5.3.1) (2024-03-26)


### Bug Fixes

* visibility of RowType type ([c1f258d](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/c1f258d57f5158b926345d505951f5f5dd93c579))

## [5.3.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v5.2.0...v5.3.0) (2024-03-25)


### Features

* add YDB Query Service client ([f7a5958](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/f7a59582d468c59af8384885cdf9328dad48abbb))

## [5.2.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v5.1.1...v5.2.0) (2024-02-27)


### Features

* large code files are separated ([f94dbcb](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/f94dbcb31f4c17eeb7713d44f5115c2f7f5ea927), [e624b04](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/e624b04dfa85c022e5a5a16308eab2ad13587a42))

## [5.1.1](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v5.1.0...v5.1.1) (2023-09-04)

### Bug Fixes

* quick fix husky install problem arises during SDK update ([03beecc](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/03beeccde530ea7050608502a8167a9a4a13c47d))

## [5.1.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v5.0.0...v5.1.0) (2023-08-31)


### Features

* a dummy feature to check the release action ([268d427](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/268d42763ce2feb3ba0fa8935b514d4c31ae7b58))

## [5.0.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v4.6.0...v5.0.0) (2023-05-15)


### ⚠ BREAKING CHANGES

* remove string type

### Features

* remove string type ([dfaa81e](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/dfaa81eaf7ce3e8e10b6427c0f966d07df1e6325))


### Bug Fixes

* bugfix long type parsing ([4bbecf7](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/4bbecf74885dc2b95b7c6888fffb4dacd43e0a74))
* bugfix vaiant tuple parse ([283be5d](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/283be5d504a7a41c0ac47fb175e692b68857b8dd))

## [4.6.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v4.5.0...v4.6.0) (2023-05-10)


### Features

* add logging to retryable decorator ([dc747b0](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/dc747b081bc44d80a3a4c112d193f05d19d0ee6b))
* add retries to static and IAM credentials services ([783d977](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/783d9778f510c0a23ef5bca7bdc5be99c8631945))
* update errors classes list ([3d860b8](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/3d860b800e3540ef77f346c9308b1ca85bb64c0e))


### Bug Fixes

* fix withTimeout hanging when errored ([83409c5](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/83409c58919b98971dcc15889234c65aeb11fb56))

## [4.5.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v4.4.0...v4.5.0) (2023-04-19)


### Features

* add `family` option to Column constructor ([06a955d](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/06a955dde9f96cccd5a38f146576e1008e1288cf))
* add all defined options to `createTable` functions ([feb2570](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/feb2570b44df5850f2431207794db3eea97d5e10))
* add describeTableOptions function ([b532c90](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/b532c90fc9c34622d16d8b923cbfaccfc93c7351))

## [4.4.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v4.3.0...v4.4.0) (2023-04-19)


### Features

* explain query request ([25354e8](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/25354e8d2139c05cbc1bceb1b24b26f418db59c4))

## [4.3.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v4.2.0...v4.3.0) (2023-04-04)


### Features

* add language_id support for slo workflow ([f7fee49](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/f7fee49e11506a001c95944d701516a54dc36714))

## [4.2.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v4.1.0...v4.2.0) (2023-03-28)


### Features

* make variant type converting to YDB native working ([2c0a9d9](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/2c0a9d9fbcf287ab98e6838270f3337b48e0e7ab))
* make variant type parsing working ([5320024](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/5320024ed8136381d9442a76127b21096b4c6cb3))

## [4.1.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v4.0.0...v4.1.0) (2023-03-16)


### Features

* add error code number ([90d71c1](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/90d71c1e1ae60994c0fb4d0b42c22b55fece239f))

## [4.0.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v3.9.0...v4.0.0) (2023-03-07)


### ⚠ BREAKING CHANGES

* remove pino from deps, add setupLogger
* move optional deps to peerDeps

### Features

* add backward compatibility for `setDefaultLogger` ([bd637bc](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/bd637bc3f888b16bcd80af839b3989c456e20275))
* add custom logger examples ([11273aa](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/11273aa1775f84bb1d0c19edb2a8b7923961c1d4))
* add slo-workload ([a916f19](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/a916f19ccef66094b0e71ee3a56216d89ca2a830))
* lock engine&gt;npm version ([f35dc42](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/f35dc426e2e7081908a7d8d904e58fc514c98d2d))


### Bug Fixes

* import type from `@yandex-cloud/nodejs-sdk` ([331074b](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/331074b4f5d31e037de901990eedc5fb97723f94))
* move optional deps to peerDeps ([701bb6c](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/701bb6cdf83a0bef219e70d918bd0244c42bdf4e))
* remove pino from deps, add setupLogger ([fb77499](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/fb77499345e100d98095c94e850928e127a90d0c))
* update MetadataAuthService to load module async way ([2d9be70](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/2d9be7082efa840b69b8ab44b5960f5388a7f49e))

## [3.9.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v3.8.1...v3.9.0) (2023-02-09)


### Features

* add alter table async mode handling ([9c18405](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/9c184053009e97fc7914ee542f3cd6382979f4db))
* add parameters to alterTable ([648a6ca](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/648a6ca21e7cb4ea732dc364816042bfc4f51ac6))


### Bug Fixes

* bugfix MissingStatus import ([1835a85](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/1835a85b343baae4ff894636421db7f92a83e0c2))

## [3.8.1](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v3.8.0...v3.8.1) (2023-01-13)


### Bug Fixes

* **tests:** update timeouts to run tests correctly ([82bc6b7](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/82bc6b77e2e2c35cc2872d3e42c4b337281fba50))

## [3.8.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v3.7.1...v3.8.0) (2023-01-13)


### Features

* update ydb-sdk-proto to 1.1.0 ([8106921](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/81069216712830c51cd3ca6168889e42e27bff2c))

## [3.7.1](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v3.7.0...v3.7.1) (2023-01-12)


### Bug Fixes

* **deps:** update luxon, jsonwebtoken and YC sdk ([60ba72d](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/60ba72d4b69df87e582e033b3c0af4653f700cef))

## [3.7.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v3.6.1...v3.7.0) (2022-12-05)


### Features

* add staticAuthService and examples ([4592026](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/4592026cfdf081de2c4036ce8ea794340ea05ec0))
* update ydb-sdk-proto package ([a0ff3ea](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/a0ff3eac20606d19532317a0491ade0fea24e24c))

## [3.6.1](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v3.6.0...v3.6.1) (2022-11-28)


### Bug Fixes

* **auth:** new IAM auth grpc service per token update ([341872a](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/341872abf300c27fd2d9d91703d8d2ebd94cfe68))

## [3.6.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v3.5.0...v3.6.0) (2022-11-21)


### Features

* add data columns and sync/async index to TableIndex ([7304dce](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/7304dcecb06befd43f854d313ff4b4d0f2737b67))

## [3.5.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v3.4.4...v3.5.0) (2022-11-15)


### Features

* add custom logger ([2d411cd](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/2d411cd5e613d07ebefdde8f34d582981fc0fedf)), closes [#191](https://github.com/ydb-platform/ydb-nodejs-sdk/issues/191)


### Bug Fixes

* **deps:** update logging packages to latest ([ad8dbd2](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/ad8dbd25ddfe8eb9a4617cb9f34a85ddb83d9aae))

## [3.4.4](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v3.4.3...v3.4.4) (2022-10-20)


### Bug Fixes

* **certs:** regenerate certs.json ([b876431](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/b87643186bed54a2987c54365b0cb14216b63c3e))
* inline certificates content ([7791a93](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/7791a930c6630b43a4320a549f1ed465574bba29))

## [3.4.3](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v3.4.2...v3.4.3) (2022-10-18)


### Bug Fixes

* **build:** bugfix npm package ([4db3425](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/4db3425af082ab1c6756de05daf6a0392c421f31))

## [3.4.2](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v3.4.1...v3.4.2) (2022-10-18)


### Bug Fixes

* **build:** fix es module build ([8d4715b](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/8d4715bb3c5b0c7073787cbf6f0c9741d6e13fc3))

## [3.4.1](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v3.4.0...v3.4.1) (2022-09-13)


### Bug Fixes

* certificates path for bundling compilation ([ebc10ad](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/ebc10ad1b6e3e6c772b30c8252f3cdab3823898e)), closes [#173](https://github.com/ydb-platform/ydb-nodejs-sdk/issues/173)

## [3.4.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v3.3.2...v3.4.0) (2022-08-12)


### Features

* introduce new type aliases: Types.BYTES & Types.TEXT ([61c17dc](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/61c17dc41838a425e3e2fff30e8a6ea763d15dd2))


### Bug Fixes

* the expected type of TypedData.yson() arg should be Buffer ([cd327de](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/cd327de3ca3ae08942a61272cb54133866eee0e6))

### [3.3.2](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v3.3.1...v3.3.2) (2022-05-27)


### Bug Fixes

* correctly access internal certs from compiled sources ([f7e520d](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/f7e520dbc7ef1fd31cb30684a66b3daa22792f03)), closes [#163](https://github.com/ydb-platform/ydb-nodejs-sdk/issues/163)

### [3.3.1](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v3.3.0...v3.3.1) (2022-05-26)


### Bug Fixes

* correctly access package.json ([5bba0d9](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/5bba0d9847562a56cec6b5f0648d7382e1edbeed))

## [3.3.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v3.2.0...v3.3.0) (2022-05-20)


### Features

* add esnext target to support using library via ES modules ([09deade](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/09deade911096c1ea86d437add6853c0e540ee38)), closes [#145](https://github.com/ydb-platform/ydb-nodejs-sdk/issues/145)

## [3.2.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v3.1.1...v3.2.0) (2022-05-20)


### Features

* process 'session-close' server hint from trailing metadata ([d9c15ba](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/d9c15bacaa1907f6f206ba1f2ca63bbc4da16c26))


### Bug Fixes

* acquire new session once free slot becomes available in pool ([4500226](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/4500226c058707aab8f5f78f0a8ba9d6da6aad4d))

### [3.1.1](https://www.github.com/ydb-platform/ydb-nodejs-sdk/compare/v3.1.0...v3.1.1) (2022-05-13)


### Bug Fixes

* add `muteNonExistingTableErrors` to `DropTableSettings` class ([c2f6037](https://www.github.com/ydb-platform/ydb-nodejs-sdk/commit/c2f60374862f7e0307521254c58e543fb6c12a30)), closes [#141](https://www.github.com/ydb-platform/ydb-nodejs-sdk/issues/141)

## [3.1.0](https://www.github.com/ydb-platform/ydb-nodejs-sdk/compare/v3.0.0...v3.1.0) (2022-05-12)


### Features

* use newer @yandex-cloud/nodejs-sdk package based on grpc-js ([2d37272](https://www.github.com/ydb-platform/ydb-nodejs-sdk/commit/2d372729a9a89a96e4342787b86448dab4762be7)), closes [#146](https://www.github.com/ydb-platform/ydb-nodejs-sdk/issues/146)

## [3.0.0](https://www.github.com/ydb-platform/ydb-nodejs-sdk/compare/v2.9.2...v3.0.0) (2022-03-02)


### ⚠ BREAKING CHANGES

* all signatures of SchemeClient's methods now have optional `settings` parameter instead of `operationParams`.
    - Before: `makeDirectory(path, operationParams?)`
      After: `makeDirectory(path, {operationParams: ...}?)`
    - Before: `removeDirectory(path, operationParams?)`
      After: `removeDirectory(path, {operationParams: ...}?)`
    - Before: `listDirectory(path, operationParams?)`
      After: `listDirectory(path, {operationParams: ...}?)`
    - Before: `describePath(path, operationParams?)`
      After: `describePath(path, {operationParams: ...}?)`
    - Before: `modifyPermissions(path, ..., ..., operationParams?)`
      After: `modifyPermissions(path, ..., ..., {operationParams: ...}?)`
* TypedData fields have identity conversion to YDB column names instead of camelCase to snake_case. Use `@withTypeOptions({namesConversion:snakeToCamelCaseConversion})` for backward compatibility.
* several types have changed their representation, namely
    - struct value is present as object instead of array
    - decimal value is present as string instead of bigint
      (it wasn't working for float values before)
    - fix uuid and tz-date types conversion (it wasn't working before)
* signatures of most methods in TableSession are changed:
    - executeQuery
      Before: `(query, params, txControl, operationParams?, settings?, collectStats?)`
      After: `(query, params, txControl, settings?)`
    - describeTable
      Before: `(tablePath: string, operationParams?)|(tablePath, describeTableParams?)`
      After: `(tablePath, settings?)`
    - commitTransaction
      Before: `(txControl, operationParams?)`
      After: `(txControl, settings?)` (and `collectStats` support)
    - createTable, alterTable, dropTable, beginTransaction, rollbackTransaction, prepareQuery,
      bulkUpsert
      Before: `(<required params>, operationParams?)`
      After: `(<required params>, settings?)`
* `tablePath` in `bulkUpsert` and `readTable` methods must be without database prefix
* Primitive class is renamed to `TypedValues`
* signatures of Driver, getCredentialsFromEnv and *AuthService classes are changed:
    - Driver:
      Before: `new Driver(entryPoint, dbName, authService, ...)`
      After: `new Driver({connectionString: "...", authService: ..., ...})`
      or `new Driver({endpoint: "...", database: "...", authService: ..., ...})`
    - *AuthService - `database` and `sslCredentials` are no longer needed in *AuthService constructors
      (ssl credentials option is now initialized in the driver if it's necessary)
      Before: `const authService = new MetadataAuthService(dbName, sslCredentials);`
      After: `const authService = new MetadataAuthService();`
    - getCredentialsFromEnv:
      Before: `const authService = getCredentialsFromEnv(endpoint, database, logger);`
      After: `const authService = getCredentialsFromEnv();` (logger is optional)
* old environment variables are no longer supported. Use YDB_ACCESS_TOKEN_CREDENTIALS instead of YDB_TOKEN, YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS instead of SA_ID, SA_PRIVATE_KEY_FILE, SA_ACCESS_KEY_ID and SA_JSON_FILE.

### Features

* add more methods and fields to type helper classes ([82f26ea](https://www.github.com/ydb-platform/ydb-nodejs-sdk/commit/82f26eaaad902ca832cbfece2e85536642c4f53b))
* implement `Types` and `TypedValues` helper classes ([029db0e](https://www.github.com/ydb-platform/ydb-nodejs-sdk/commit/029db0ee5e0996a9e73e19dcd5a5fb846b3d6332))
* implement new type conversions and fix existing type conversions ([0edbcdd](https://www.github.com/ydb-platform/ydb-nodejs-sdk/commit/0edbcdd09997e7644825c6bd3b015549c5356211))
* reorganize Driver and credentials to simplify SDK usage ([6526378](https://www.github.com/ydb-platform/ydb-nodejs-sdk/commit/6526378c501addd6a8ab75f9a6fd8f172fc79c26))
* replace grpc with @grpc/grpc-js ([1bd8d06](https://www.github.com/ydb-platform/ydb-nodejs-sdk/commit/1bd8d06f75c68eed1ec8c855ecab0d0b4bfe7bc4))


### Bug Fixes

* don't use database in `tablePath` for `bulkUpsert` and `readTable` methods ([d416d59](https://www.github.com/ydb-platform/ydb-nodejs-sdk/commit/d416d59e44a34088d2909bf28d9c3b8535ff2d59))
* error message in test-utils ([af39fd1](https://www.github.com/ydb-platform/ydb-nodejs-sdk/commit/af39fd1178d22aa8fc558d6a4ef6f80d53acd3a5))
* little fixes in examples ([9c19b95](https://www.github.com/ydb-platform/ydb-nodejs-sdk/commit/9c19b95dd541705673844aaf960b36c67e2b7b48))


### Miscellaneous

* drop support of old environment variables ([963819a](https://www.github.com/ydb-platform/ydb-nodejs-sdk/commit/963819af9209a45749f5118077f1da4bdb390fa6))
* reorganize signature of SchemeClient's methods ([734d57a](https://www.github.com/ydb-platform/ydb-nodejs-sdk/commit/734d57a2dd7c655cf727b96df415212504339cf8))
* reorganize signatures of TableSession's methods ([431f149](https://www.github.com/ydb-platform/ydb-nodejs-sdk/commit/431f1491bf880f3ba9541d9455d8dd2f2b7849e6))
* use identity names conversion in TypedData ([275598a](https://www.github.com/ydb-platform/ydb-nodejs-sdk/commit/275598aa444e1e977386a3dadd02bbc9ba01f38e))

### [2.9.2](https://www.github.com/ydb-platform/ydb-nodejs-sdk/compare/v2.9.1...v2.9.2) (2022-02-09)


### Bug Fixes

* **MetadataAuthService:** remove ssl defaults for grpc scheme ([40523f7](https://www.github.com/ydb-platform/ydb-nodejs-sdk/commit/40523f796f281bbba6de23c6c86013d1bb794d0b))

### [2.9.1](https://www.github.com/ydb-platform/ydb-nodejs-sdk/compare/v2.9.0...v2.9.1) (2022-01-21)


### Bug Fixes

* **package.json:** move pino-pretty to dependencies ([bf739d2](https://www.github.com/ydb-platform/ydb-nodejs-sdk/commit/bf739d20f5c66fb3ce4381a31e1a410fa9e22b2d))

## [2.9.0](https://www.github.com/ydb-platform/ydb-nodejs-sdk/compare/v2.8.1...v2.9.0) (2021-12-29)


### Features

* **describeTable:** add new function signature ([4e2106d](https://www.github.com/ydb-platform/ydb-nodejs-sdk/commit/4e2106d4eb23ff3bd1ca777222bfd53ad85fa6ed))
* **executeQuery:** add collectStats parameter ([bae40fa](https://www.github.com/ydb-platform/ydb-nodejs-sdk/commit/bae40fa507bd064763178cfb4954b936da1c7b76))


### Bug Fixes

* **examples:** remove package-lock.json from examples repo ([b80de4e](https://www.github.com/ydb-platform/ydb-nodejs-sdk/commit/b80de4eb9e99458067b525984d5d041f1bef73b4))

### [2.8.1](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v2.8.0...v2.8.1) (2021-12-14)

## [2.8.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v2.7.0...v2.8.0) (2021-12-09)


### Features

* **tableClient:** implement bulkUpsert method ([a4b63f6](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/a4b63f6b7fabde3f1411b95575b6cbf7eac6c371))

## [2.7.0](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v2.6.3...v2.7.0) (2021-12-03)


### Features

* **tableClient:** implement streamReadTable call ([1809215](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/1809215c8317f79a64f476d42236d337f1b334c5))

### [2.6.3](https://github.com/ydb-platform/ydb-nodejs-sdk/compare/v2.6.2...v2.6.3) (2021-12-02)


### Bug Fixes

* **ssl:** no more SSL connection attempts for grpc:// endpoints ([7c517aa](https://github.com/ydb-platform/ydb-nodejs-sdk/commit/7c517aae5c8f9d069de16fec714e3581dfe8f922))

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
* Add `alterTable` method to TableSession class
* Put compiled protobufs to a separate 'ydb-sdk' namespace

### 1.9.0
* Pass 'x-ydb-sdk-build-info' header with library name/version to every GRPC request.
