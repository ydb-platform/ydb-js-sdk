---
'@ydbjs/query': minor
---

Add session pool for query service

- Implement Session class with IDLE/BUSY/CLOSED states and attachSession keepalive
- Implement SessionPool with acquire/release pattern (default maxSize: 50)
- Integrate SessionPool with Query class and transaction execution
- Add 13 new tests (7 unit + 6 integration)

Sessions are now automatically pooled and reused between queries and transactions, eliminating the overhead of creating a new session for every operation. Configure pool size with `query(driver, { maxSize: 100 })`.
