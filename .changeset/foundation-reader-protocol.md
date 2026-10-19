---
'@ydbjs/topic': patch
---

Preserve complete-response read credit across reconnects and account for releases during backoff. Track partition-session identities and pending commits through replacement and retirement, expire unreassigned partitions, and treat oversized read responses as terminal errors. Split sparse commit replay into bounded requests so reconnect cannot combine valid individual commits into an oversized frame.
