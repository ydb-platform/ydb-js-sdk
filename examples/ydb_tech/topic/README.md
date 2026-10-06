# Topic examples for ydb.tech

This application is the source of the JavaScript and TypeScript snippets in the
topic reference on ydb.tech. It uses workspace packages from this checkout.

From the repository root, with a local YDB instance:

```sh
npm ci
npm run build -- --filter=@ydbjs/ydb-tech-topic...
npm start --workspace=@ydbjs/ydb-tech-topic
```

`YDB_CONNECTION_STRING` defaults to `grpc://localhost:2136/local`.
The application checks management operations, codecs, acknowledgments, metadata,
reader selectors and commit variants. It creates and removes uniquely named topics.

The multi-topic reader selects distinct partition IDs because this SDK currently
tracks reader sessions by partition ID across all topics.
