---
'@ydbjs/fsm': minor
---

Surface internal machine faults to output consumers. When a transition, effect, or ingest source throws, the runtime still tears the machine down, but its output async-iterator now rethrows the stop reason after draining instead of ending silently. Consumers iterating the machine observe the failure and can run their terminal handling, rather than mistaking a fault for a graceful close (which would strand a consumer awaiting a terminal signal).

The fault is delivered through the output queue itself via a new `AsyncQueue.fail(error)` primitive (seals the queue like `close()`, but the iterator throws `error` once the buffer drains). The runtime iterator stays a direct queue passthrough — wrapping it in an extra async generator would add a per-item microtask that reorders delivery for latency-sensitive consumers.
