---
'@ydbjs/query': major
'@ydbjs/drizzle-adapter': patch
'@ydbjs/langchain': patch
---

Export the raw QueryClient class from the package root with retrySession(options, callback) and retryTransaction(options, callback) as its execution entry points. Options may be omitted, but the callback is always last. Each callback receives an executor and the current attempt's cancellation signal; execute() and stream() belong to that executor. The root client has no execute(), do(), transaction() or stream() methods. Retry policy belongs to the callback, while statement signal and timeout options can cap individual operations within the callback budget.

Rename the callable tagged client type to SQLClient and migrate the Drizzle and LangChain integrations. query(driver) and query(client) provide the convenient tagged API, preserving sql.do(), sql.begin(), sql.transaction(), result shapes and repeat-await behavior over the same execution engine and pool.

Streaming is available only from executors inside SDK-owned retry callbacks. The SDK owns retry boundaries and revokes streams when their callback ends.

Keep tagged query bindings stable across retries; raw retry callbacks may build new parameters on each attempt, while each statement snapshots its inputs before consumption. Revoke executors and unfinished streams when their callback ends, and prevent replay after a confirmed commit. Separate stream cancellation from session loss and preserve caller cancellation reasons. Expose beforeCommit for precommit work while retaining onCommit for transactional Topic compatibility.

Reject commit-hook registration after preparation starts, and observe all started hooks even when another hook throws synchronously.
