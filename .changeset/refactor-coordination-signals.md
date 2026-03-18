---
'@ydbjs/coordination': minor
---

Refactor coordination session architecture and signal contracts

- Clean up file structure: delete dead files (session-stream, session-utils), merge node-runtime into node.ts, move try-acquire to errors.ts, move transport FSM into session-state.ts
- Fix signal ownership: session owns its own AbortController (not delegated to transport), lease owns its own AbortController (not linked to session)
- Add typed error classes: SessionClosedError, SessionExpiredError, LeaseReleasedError, LeaderChangedError, ObservationEndedError — all exported for instanceof checks
- Simplify Lease: single #releasePromise pattern, delegates release to Semaphore.release()
- Simplify Mutex: Lock is now a type alias for Lease (was empty subclass)
- Simplify Election: accepts Semaphore directly (no longer knows about transport)
- Move client to SessionTransport constructor (was passed on every connect)
- Remove emit_error effect (redundant with mark_expired)
- Remove waitReady proxy from SessionRuntime (use transport.waitReady directly)
- Use Promise.withResolvers throughout (project convention)
- Add integration tests for session lifecycle, lease signals, and user signal cancellation
- Add e2e tests for race conditions, misuse scenarios, and typed error contracts
