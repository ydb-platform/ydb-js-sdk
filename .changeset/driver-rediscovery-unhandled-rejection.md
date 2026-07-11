---
'@ydbjs/core': patch
---

Fix process crash when a background rediscovery round fails. The periodic discovery loop scheduled its rounds as floating promises, so a terminally failed round (e.g. the discovery endpoint dropping mid-round until the per-round timeout aborted the retries) escalated to an `unhandledRejection` and killed the process. Failed background rounds are now caught and logged; the connection pool keeps serving last-known endpoints and the next interval tick retries.
