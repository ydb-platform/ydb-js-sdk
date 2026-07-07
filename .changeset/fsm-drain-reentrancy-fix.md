---
'@ydbjs/fsm': patch
---

Fix two event-drain correctness issues in the machine runtime:

- An event dispatched synchronously from within a transition is now processed after the current transition's state change is applied, instead of being run re‑entrantly against the stale (pre‑transition) state.
- `close()` now waits for an in‑flight drain to finish and drains any tail before sealing the output stream, so outputs from events queued during that drain are not dropped.
