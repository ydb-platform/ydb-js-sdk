---
'@ydbjs/core': minor
---

Let libraries layered on top of the SDK advertise themselves in the `x-ydb-sdk-build-info` header.

Frameworks (e.g. `@ydbjs/drizzle-adapter`) call `driver[kRegisterLibrary](name, version)` after constructing or borrowing a `Driver`. Registered entries are appended after the native `ydb-js-sdk/<version>` token, separated by `;`, matching the server-side parser which keys off the leading native SDK token. Repeated registrations of the same `name/version` are deduplicated; the header string is built once per registration so the per-RPC middleware just reads a cached field.

```ts
import { Driver, kRegisterLibrary } from '@ydbjs/core'

let driver = new Driver(connectionString)
driver[kRegisterLibrary]('@ydbjs/drizzle-adapter', '0.1.0')
// x-ydb-sdk-build-info: ydb-js-sdk/6.2.0;@ydbjs/drizzle-adapter/0.1.0
```
