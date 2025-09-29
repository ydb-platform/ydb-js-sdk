---
title: Advanced
---

# Advanced Topics

This section dives deeper into resilience, failure handling, and direct access to YDB services. Use it when you need precise control over execution behavior, recovery, and performance.

## Retries & Idempotency

- Explains which error codes are retryable and when retries are safe.
- Shows how `.idempotent(true)` affects single‑call retries and how to design idempotent business logic in transactions.
- Covers retry strategy considerations for Topic streaming.
- See: `/advanced/retries`.

## Error Handling

- Describes SDK error types (e.g., `YDBError`, `CommitError`) and how to distinguish them.
- Demonstrates structured error logging and extracting issues for diagnostics.
- Provides patterns for handling aborts and timeouts consistently.
- See: `/advanced/errors`.

## Low‑level Clients (driver)

- How to create gRPC clients via `driver.createClient(ServiceDefinition)`.
- When and why to use low‑level services (Discovery, Scheme, etc.).
- Auth, TLS/mTLS considerations for service clients.
- See: `/advanced/driver-low-level`.
