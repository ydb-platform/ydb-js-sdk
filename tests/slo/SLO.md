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

`topic.setup` creates a fresh topic. The supervisor then starts `topic.write` and `topic.read` worker threads with the same run identity and settings. Each owns its driver, clients and telemetry provider. The workload duration starts after setup succeeds. `topic.teardown` removes the topic after successful delivery reconciliation; failed runs retain their topic until the test cluster is removed.

Each message has an application sequence number independent of the SDK's `seqNo`, a run fingerprint, partition identity and deterministic payload. The verifier checks the message length and identity header; payload-body integrity is covered by SDK unit and integration tests. A repeat of the same business ID at the same partition offset is allowed redelivery; a different offset for that ID is duplicate publication and fails the run.

The four progress counters are distinct:

- **Accepted:** `writer.write()` returned successfully.
- **Acknowledged:** a `flush()` barrier completed for the captured accepted watermark.
- **Delivered:** the reader returned the message and its payload passed validation.
- **Committed:** commit completed, or a later server-confirmed watermark covers an already observed message.

Expected partition-revocation errors are handled through redelivery and server-confirmed offsets. An aggregate is considered a revocation only when every nested error is a known revocation error. Other reader errors terminate the run.

Workers exchange only cumulative producer checkpoints through the supervisor; payloads travel through YDB. A read may precede the corresponding checkpoint, so final reconciliation uses the writer's final accepted and acknowledged counts.

After the duration expires, the supervisor stops the writer first. The writer finishes its final flush and closes its clients, then the supervisor sends its final checkpoints to the reader. The reader drains that tail, confirms commits and closes its own clients. Both workers must return successful results and exit cleanly. Every producer must have nonzero traffic and matching accepted/acknowledged/delivered/committed counts. Missing ACKs, an unread tail, a stalled partition, an unexpected worker exit, a missing result or forced termination fails the run. A worker restart cannot clear an earlier failure because this profile does not restart workers.

An acknowledged but undelivered tail is a failed delivery reconciliation; it does not by itself prove loss in server storage. Accepted messages with neither an ACK nor an observation remain uncertain. Both outcomes are failures.

| Parameter                      | Default    | Meaning                                                                      |
| ------------------------------ | ---------- | ---------------------------------------------------------------------------- |
| `WORKLOAD_DURATION`            | 60 seconds | Time until the supervisor requests producer stop; `0` runs until interrupted |
| `--topic.setup.partitions`     | 10         | Fixed partition count and number of producers                                |
| `--topic.write.rps`            | 100        | Total message generation rate                                                |
| `--topic.write.size`           | 1024       | Payload bytes, minimum 64                                                    |
| `--topic.write.codec`          | mixed      | `raw`, `gzip`, `zstd`, or all three distributed across producers             |
| `--topic.setup.topic`          | slo-topic  | Prefix for the unique topic name                                             |
| `--topic.write.drainTimeoutMs` | 120000     | Deadline for final flush, read and commit reconciliation                     |
| `--topic.write.stallTimeoutMs` | 120000     | Per-producer deadline for ACK or read/commit progress while work is pending  |
| `TOPIC_RESULT_FILE`            | unset      | Optional path for the JSON result inside the workload container              |

The supervisor bounds the final writer and reader drain by the configured deadline. SIGINT/SIGTERM marks an interrupted topic run as failed while allowing bounded cleanup.

For a short run against an existing local YDB, configure `.env` and run:

```bash
WORKLOAD_DURATION=30 npm --workspace=@ydbjs/slo run start:topic
```

## Metrics and diagnostics

Metrics include `ref=WORKLOAD_REF`. Memory series carry `worker=topic.write` or `worker=topic.read`: heap and buffer counters belong to that isolate; RSS is shared by the process and must not be summed across workers. `sdk_topic_messages{state}` exposes message progress; `sdk_memory_usage` exposes process/isolate memory. The verifier keeps compact sequence/offset ranges and an uncommitted tail; it does not retain one entry per completed message. Process memory still includes the workload and telemetry, so it is not a measurement of SDK memory alone.

`sdk_operations_total` and latency gauges describe writer flush barriers and reader read/commit batches. `sdk_retry_attempts_total` counts the initial operation attempt and stream reconnects observed while that operation is active. Correctness comes from the ledger and final result, not from a latency percentile or memory graph.

Set `DEBUG='ydbjs:*,-ydbjs:topic:writer:event,-ydbjs:topic:reader:event'` for lifecycle logs. `NODE_OPTIONS='--import ./instrument.js'` adds topic diagnostics-channel output in every worker thread.

## Validation

Oracle and worker shutdown tests run directly from TypeScript in unit CI, without compiling temporary workers or launching a subprocess. The existing SLO CI jobs run KV; Topic qualification is a separate workload run.

The Topic command preserves the setup/run/teardown phases:

```bash
node tests/slo/dist/index.js \
  --setup=topic.setup --topic.setup.partitions=10 \
  --worker=topic.write --topic.write.rps=100 --topic.write.size=1024 \
  --worker=topic.read \
  --teardown=topic.teardown
```

## KV and lightweight development

The existing KV workers retain their restart policy. Start the full KV stack with:

```bash
WORKLOAD_DURATION=600 docker compose --profile telemetry --profile chaos --profile workload-current up --build
```

For a single-node development stack without faults:

```bash
docker compose -f compose.dev.yaml up
```
