---
'@ydbjs/value': minor
'@ydbjs/query': minor
'@ydbjs/drizzle-adapter': patch
---

Add opt-in Temporal result conversion with toJs(value, { temporal: true }), new QueryClient(driver, { temporal: true }) and query(driver, { temporal: true }). Preserve the default Value/Date representations when the option is disabled.

Use the application-provided global Temporal implementation. TzDate and TzDate32 remain SDK Values because Temporal has no zoned date-only type. Preserve Drizzle's Date and numeric column representations with Temporal-enabled clients.
