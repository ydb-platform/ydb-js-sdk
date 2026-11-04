---
'@ydbjs/query': patch
---

Continue serving queued queries after session creation fails, propagate cancellation into replacement session creation, and prevent repeated lease disposal from lending one session to concurrent callers. Reject invalid session-pool bounds and retire sessions that cannot safely be reused after interrupted queries.

Centralize pool ownership and shutdown transitions in one state machine. Bound admitted operations before driver readiness as well as queued acquisitions, while allowing already accepted work to finish retries during graceful shutdown.
