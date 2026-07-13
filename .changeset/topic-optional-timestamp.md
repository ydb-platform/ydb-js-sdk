---
'@ydbjs/topic': patch
---

Widen the reader's internal `PartitionReadData` timestamp fields (`writtenAt`, `createdAt`) to `Timestamp | undefined` to match the stricter optional-field typing from the regenerated `@ydbjs/api`. No behavioural change.
