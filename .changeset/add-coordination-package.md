---
'@ydbjs/coordination': minor
---

Add coordination package with distributed semaphores support

- Implement coordination node management (create, alter, drop, describe)
- Add distributed semaphores with acquire/release operations
- Support automatic session lifecycle with keep-alive and reconnection
- Provide watch notifications for semaphore changes via EventEmitter
- Include automatic session recreation on session expiring
- Add examples for leader election, service discovery, and configuration publication
