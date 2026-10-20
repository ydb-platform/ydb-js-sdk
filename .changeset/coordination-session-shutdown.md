---
'@ydbjs/coordination': patch
---

Stop coordination sessions immediately on destroy, clear pending watch notifications and timers, and reject further operations. Support synchronous disposal while preserving graceful close and async disposal through SessionStop acknowledgment. Preserve acknowledged semaphore ownership when only the acquisition's caller signal is cancelled; return its lease for explicit release or disposal.
