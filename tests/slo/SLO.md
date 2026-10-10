# SLO and topic integrity workloads

The cluster definition is shared with the pinned `ydb-slo-action` revision in `compose.yaml`. A run validates its recorded SDK revision, server images, parameters and fault schedule.

## Build

Install workspace dependencies and build the SDK from the repository root:

```bash
npm ci
npm run build
```

After changing the workload, `npm --workspace=@ydbjs/slo run build` type-checks and rebuilds its bundles. Turbo also tracks the workload sources. The image copies `dist/`; it does not compile sources during `docker build`.

## Topic integrity profile

`topic.run` coordinates separate `topic.write` and `topic.read` worker threads. Each owns its driver, clients and telemetry provider. The coordinator creates a fresh topic with a unique run ID, one producer per partition and one reader. It removes the topic after a successful run; failed runs retain their topic until the test cluster is removed.

Each message has an application sequence number independent of the SDK's `seqNo`, a run fingerprint, partition identity and deterministic payload. The verifier checks every byte. A repeat of the same business ID at the same partition offset is allowed redelivery; a different offset for that ID is duplicate publication and fails the run.

The four progress counters are distinct:

- **Accepted:** `writer.write()` returned successfully.
- **Acknowledged:** a `flush()` barrier completed for the captured accepted watermark.
- **Delivered:** the reader returned the message and its payload passed validation.
- **Committed:** commit completed, or a later server-confirmed watermark covers an already observed message.

Expected partition-revocation errors are handled through redelivery and server-confirmed offsets. An aggregate is considered a revocation only when every nested error is a known revocation error. Other reader errors terminate the run.

Workers exchange only cumulative producer checkpoints through the coordinator; payloads travel through YDB. A read may precede the corresponding checkpoint, so final reconciliation uses the writer's final accepted and acknowledged counts.

After the duration expires, the coordinator stops the writer first. The writer finishes its final flush and closes its clients, then the coordinator sends its final checkpoints to the reader. The reader drains that tail, confirms commits and closes its own clients. Both workers must return successful results and exit cleanly. Every producer must have nonzero traffic and matching accepted/acknowledged/delivered/committed counts. Missing ACKs, an unread tail, a stalled partition, an unexpected worker exit, a missing result or forced termination fails the run. A worker restart cannot clear an earlier failure because this profile does not restart workers.

An acknowledged but undelivered tail is a failed delivery reconciliation; it does not by itself prove loss in server storage. Accepted messages with neither an ACK nor an observation remain uncertain. Both outcomes are failures.

| Parameter                    | Default    | Meaning                                                                      |
| ---------------------------- | ---------- | ---------------------------------------------------------------------------- |
| `WORKLOAD_DURATION`          | 60 seconds | Time until the supervisor requests producer stop; `0` runs until interrupted |
| `--topic.run.partitions`     | 10         | Fixed partition count and number of producers                                |
| `--topic.run.rps`            | 100        | Total message generation rate                                                |
| `--topic.run.size`           | 1024       | Payload bytes, minimum 64                                                    |
| `--topic.run.codec`          | mixed      | `raw`, `gzip`, `zstd`, or all three distributed across producers             |
| `--topic.run.topic`          | slo-topic  | Prefix for the unique topic name                                             |
| `--topic.run.drainTimeoutMs` | 120000     | Deadline for final flush, read and commit reconciliation                     |
| `--topic.run.stallTimeoutMs` | 120000     | Per-producer deadline for ACK or read/commit progress while work is pending  |
| `TOPIC_RESULT_FILE`          | unset      | Optional path for the JSON result inside the workload container              |

The supervisor allows the drain deadline plus five seconds before forced termination. SIGINT/SIGTERM marks an interrupted topic run as failed while allowing bounded cleanup.

For a short run against an existing local YDB, configure `.env` and run:

```bash
WORKLOAD_DURATION=30 npm --workspace=@ydbjs/slo run start:topic
```

## Metrics and diagnostics

Metrics include `ref=WORKLOAD_REF`. Memory series carry `worker=topic.write` or `worker=topic.read`: heap and buffer counters belong to that isolate; RSS is shared by the process and must not be summed across workers. `sdk_topic_messages{state}` exposes message progress; `sdk_memory_usage` exposes process/isolate memory. The verifier retains its own ID/offset ledger, so process memory is not a measurement of SDK memory alone.

`sdk_operations_total` and latency gauges describe writer flush barriers and reader read/commit batches. `sdk_retry_attempts_total` counts the initial operation attempt and stream reconnects observed while that operation is active. Correctness comes from the ledger and final result, not from a latency percentile or memory graph.

Set `DEBUG='ydbjs:*,-ydbjs:topic:writer:event,-ydbjs:topic:reader:event'` for lifecycle logs. `NODE_OPTIONS='--import ./instrument.js'` adds topic diagnostics-channel output in every worker thread.

## CI

The `SLO` label runs the existing KV profiles and the regular `node-topic` profile. Topic failures are fatal through `fail_on_workload_error: true`. Both candidate and baseline use the current topic verifier source, built against their respective SDK revisions; the baseline does not silently use an older checker.

The CI profile uses a 50-second drain deadline so the supervisor can finish within the pinned action's 60-second post-duration allowance. Local runs retain the 120-second default.

Oracle, worker-coordination and supervisor tests run in ordinary unit CI. Heavy chaos qualification remains an explicit SLO run.

## KV and lightweight development

The existing KV workers retain their restart policy. Start the full KV stack with:

```bash
WORKLOAD_DURATION=600 docker compose --profile telemetry --profile chaos --profile workload-current up --build
```

For a single-node development stack without faults:

```bash
docker compose -f compose.dev.yaml up
```
