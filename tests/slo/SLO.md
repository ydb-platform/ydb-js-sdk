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

| Parameter                              | Default    | Meaning                                                                      |
| -------------------------------------- | ---------- | ---------------------------------------------------------------------------- |
| `WORKLOAD_DURATION`                    | 60 seconds | Time until the supervisor requests producer stop; `0` runs until interrupted |
| `--topic.run.partitions`               | 10         | Fixed partition count and number of producers                                |
| `--topic.run.rps`                      | 100        | Total message generation rate; `0` uses a bounded pending-message window     |
| `--topic.run.writers`                  | 1          | Number of producer workers, up to the partition count                        |
| `--topic.run.inFlight`                 | 8192       | Maximum accepted-but-uncommitted messages with `rps=0`                       |
| `--topic.run.writeSpeedBytesPerSecond` | 0          | Per-partition server write quota; `0` uses the server default                |
| `--topic.run.retentionStorageMb`       | 0          | Per-partition storage retention; positive values replace time retention      |
| `--topic.run.auth`                     | unset      | `login` enables short-lived token renewal verification                       |
| `--topic.run.size`                     | 1024       | Payload bytes, minimum 64                                                    |
| `--topic.run.codec`                    | mixed      | `raw`, `gzip`, `zstd`, or all three distributed across producers             |
| `--topic.run.topic`                    | slo-topic  | Prefix for the unique topic name                                             |
| `--topic.run.drainTimeoutMs`           | 120000     | Deadline for final flush, read and commit reconciliation                     |
| `--topic.run.stallTimeoutMs`           | 120000     | Per-producer deadline for ACK or read/commit progress while work is pending  |
| `TOPIC_RESULT_FILE`                    | unset      | Optional path for the JSON result inside the workload container              |

The supervisor allows the drain deadline plus five seconds before forced termination. SIGINT/SIGTERM marks an interrupted topic run as failed while allowing bounded cleanup.

For a short run against an existing local YDB, configure `.env` and run:

```bash
WORKLOAD_DURATION=30 npm --workspace=@ydbjs/slo run start:topic
```

## Metrics and diagnostics

Metrics include `ref=WORKLOAD_REF`. Memory series carry `worker=topic.write` (or `topic.write.N` with multiple producers) or `worker=topic.read`: heap and buffer counters belong to that isolate; RSS is shared by the process and must not be summed across workers. `sdk_topic_messages{state}` exposes message progress; `sdk_memory_usage` exposes process/isolate memory. The verifier compresses consecutive offsets into ranges and removes committed-prefix entries. `sdk_topic_verifier_entries` reports retained ranges and outstanding commit entries. Offset gaps remain exact; more than 10,000 disjoint ranges per producer fails the verifier. Process memory still includes the workload itself.

`sdk_operations_total` and latency gauges describe writer flush barriers and reader read/commit batches. `sdk_retry_attempts_total` counts the initial operation attempt and stream reconnects observed while that operation is active. Correctness comes from the ledger and final result, not from a latency percentile or memory graph.

Set `DEBUG='ydbjs:*,-ydbjs:topic:writer:event,-ydbjs:topic:reader:event'` for lifecycle logs. `NODE_OPTIONS='--import ./instrument.js'` adds topic diagnostics-channel output in every worker thread.

## CI

The `SLO` label runs the existing KV profiles and the regular `node-topic` profile. Topic failures are fatal through `fail_on_workload_error: true`. Both candidate and baseline use the current topic verifier source, built against their respective SDK revisions; the baseline does not silently use an older checker.

The CI profile uses a 50-second drain deadline so the supervisor can finish within the pinned action's 60-second post-duration allowance. Local runs retain the 120-second default.

Oracle, worker-coordination and supervisor tests run in ordinary unit CI. Heavy chaos qualification remains an explicit SLO run.

## Nightly stability

The `Nightly topic stability` workflow runs daily at 22:17 UTC (01:17 Europe/Minsk) after it reaches the default branch. Each Node.js 22/24/26 and Bun job runs for four hours on `large-runner-js-sdk`, using TLS, two database nodes, no chaos and no baseline workload. Runtime image tags track their major release; the result records the actual runtime version and container image ID.

The profile runs without an RPS limit (`rps=0`): four producer workers feed one reader across 24 partitions with 32 KiB payloads and mixed RAW/GZIP/ZSTD codecs. Producers own disjoint partitions and share an 8,192-message budget, divided equally between them. Reader commits release capacity, bounding accepted-but-uncommitted payloads to 256 MiB before SDK, codec and verifier overhead. `writers` defaults to one outside the nightly profile; positive `rps` retains paced generation.

The topic write quota is explicitly set to 50 MiB/s per partition (`writeSpeedBytesPerSecond=52428800`), avoiding the default topic quota as a low artificial ceiling.

Each workload container gets 6 CPU and 12 GiB on the 24 CPU / 72 GiB runner. Topic retention is limited to 512 MiB per partition (12 GiB total before storage overhead), protecting the runner's 93 GiB disk during sustained writing. Final flush/read/commit drain is limited to 50 seconds.

Throughput is an observed limit of the whole workload, including payload verification, commit, network and YDB. `suppliedFraction` reports the fraction of one-second samples with acknowledged messages still awaiting delivery; `minimumSuppliedFraction` retains the lowest window value. A low fraction indicates that the reader may be waiting for producers. A nonempty backlog alone does not prove a runtime CPU limit. Prometheus retains pending-message counts and process CPU time alongside throughput and memory; CPU and RSS cover all worker threads and must not be summed across workers.

`--topic.run.auth=login` uses the disposable cluster's built-in root account and five-minute login tokens. Each worker must observe an accepted changed token and subsequent successful traffic after the old token expired on the same stream. Reconnecting with a new token does not satisfy that check.

Run manually from Actions with a selected runtime and a duration of 1,200–14,400 seconds. The workflow never cancels an active nightly when another run is queued. Separate jobs have separate clusters; use dedicated runners because the upstream Compose services use fixed container names.

`--topic.run.stability=true` enables absolute checks inside the workload, independently of report comparisons:

- One sample per second; a gap above ten seconds fails after warmup.
- Five minutes of warmup, then five-minute windows. At least a baseline and one comparison window must finish.
- With `rps=0`, the first post-warmup window establishes observed throughput; subsequent windows must sustain at least 80% of it, with nonzero progress and backlog within the configured message budget. With a positive `rps`, the existing 90% rate and ten-second backlog limits apply.
- Successful flush and read/commit operations must complete within ten seconds after warmup. Existing p50/p95/p99 gauges remain available for diagnosis.
- RSS must stay below 2 GiB, including warmup. Compared with the first complete post-warmup window, subsequent window minima may grow by at most 256 MiB RSS, 64 MiB V8 heap/external memory and 32 MiB ArrayBuffers. Bun uses JavaScriptCore heap/native counters with 64 MiB growth limits instead of its incomplete Node-compatible counters.
- Every accepted message must pass payload, ACK, delivery and commit reconciliation. Missing results, process errors, OOM and interrupted runs fail.

Writer stability uses accepted/acknowledged progress and writer-isolate memory. Reader stability uses writer checkpoints, verified delivery and commits, and reader-isolate memory. Final results include both window reports; all workers must pass. RSS remains shared and is never summed. Steady-state checks stop when generation stops; the reader continues final drain.

Window minima reduce sensitivity to normal GC cycles; they are stability bounds, not proof that every retained allocation is a leak. No forced GC or reconnect is used to hide accumulation. Final drained memory is recorded separately. The result and window logs include the measured counters; monitor failures are sticky even if later samples recover.

For a short local verification of the memory and throughput checks without `auth=login`, set `--topic.run.warmupSeconds=10 --topic.run.windowSeconds=20` and run for at least 90 seconds. Token-renewal verification needs a run longer than the five-minute token lifetime. Short verification does not qualify the four-hour nightly profile. A TLS-enabled YDB endpoint and its trusted CA are required to reproduce TLS-specific failures.

`topic-result.json`, container state, source commit and workload logs are retained for 14 days. The shared action also collects Prometheus metrics and cluster logs. Initial limits are explicit acceptance criteria; adjust them only alongside evidence from the same offered load and runner resources.

## KV and lightweight development

The existing KV workers retain their restart policy. Start the full KV stack with:

```bash
WORKLOAD_DURATION=600 docker compose --profile telemetry --profile chaos --profile workload-current up --build
```

For a single-node development stack without faults:

```bash
docker compose -f compose.dev.yaml up
```
