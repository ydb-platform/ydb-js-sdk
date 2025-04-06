/**
 * # @ydbjs/value
 *
 * The `@ydbjs/value` package provides utilities for working with YDB values and types in JavaScript/TypeScript.
 * It includes classes and functions for encoding, decoding, and converting YDB values to and from native JavaScript types.
 *
 * ## Features
 * - Support for all YDB primitive types (e.g., `BOOL`, `INT32`, `STRING`, etc.).
 * - Support for complex types like `List`, `Tuple`, `Struct`, `Dict`, and `Optional`.
 * - Conversion between YDB values and native JavaScript types.
 * - Type-safe handling of YDB values with TypeScript.
 *
 * ## Installation
 *
 * Install the package via npm:
 *
 * ```sh
 * npm install @ydbjs/value@6.0.0-alpha.2
 * ```
 *
 * ## Usage
 *
 * ### Encoding JavaScript Values to YDB Values
 *
 * ```ts
 * import { fromJs } from '@ydbjs/value';
 *
 * const ydbValue = fromJs({ key: 'value' }); // Converts a JavaScript object to a YDB Struct.
 * ```
 *
 * ### Decoding YDB Values to JavaScript
 *
 * ```ts
 * import { toJs } from '@ydbjs/value';
 *
 * const jsValue = toJs(ydbValue); // Converts a YDB value back to a native JavaScript object.
 * ```
 *
 * ### Working with YDB Types
 *
 * ```ts
 * import { PrimitiveType, TypeKind } from '@ydbjs/value';
 *
 * const intType = new PrimitiveType(Ydb.Type_PrimitiveTypeId.INT32);
 * ```
 *
 * ## Development
 *
 * - Build the package:
 *   ```sh
 *   npm run build
 *   ```
 * - Run tests:
 *   ```sh
 *   npm test
 *   ```
 *
 * ## License
 *
 * This package is licensed under the Apache 2.0 License.
 */
