# Running SLO / chaos tests locally

The whole SLO stack — a multi-node YDB cluster, the chaos monkey, Prometheus/Grafana —
comes from [`ydb-slo-action`](https://github.com/ydb-platform/ydb-slo-action) and is pulled
into `compose.yaml` via a remote `include:`. `compose.override.yaml` builds the workload
image from this checkout. Nothing extra to clone: `docker compose` fetches the upstream
stack on first run.

This is the same stack CI runs, so a green local run means a green CI run.

## Prerequisites

- Docker with Compose v2.20+ (remote git `include:` support).
- Build the workload bundle once (the image copies `dist/`, it does not build inside):

  ```bash
  npm --prefix tests/slo run build
  ```

  Re-run after changing any workload under `workloads/`.

## Profiles

The stack is split by compose profiles so you only pay for what you need:

| Profile            | Brings up                         |
| ------------------ | --------------------------------- |
| `chaos`            | chaos monkey + blackhole node     |
| `telemetry`        | Prometheus + Grafana              |
| `workload-current` | the workload container (this SDK) |
| `extra-nodes`      | database-3..5 (larger cluster)    |

The storage/database nodes come up regardless — they are the cluster under test.

> **Do not** add `--abort-on-container-exit` / `--exit-code-from`. The stack has
> one-shot init containers (`storage-init`, `database-init`, `database-readiness`)
> that exit `0` by design; either flag tears the whole cluster down the moment the
> first init finishes — before the workload ever starts. Use the detached +
> `docker wait` pattern below to capture the workload's exit code.

## Run the KV workload under chaos

```bash
cd tests/slo

WORKLOAD_DURATION=600 docker compose \
  --profile telemetry \
  --profile chaos \
  --profile workload-current \
  up --build
```

`WORKLOAD_CURRENT_COMMAND` is empty by default, so the image runs its baked KV command.
Pass/fail comes from the metrics report; the run stays attached until you `Ctrl-C`.

## Run the topic workload under chaos

The topic chaos signal is **binary**: the reader verifies per-producer seqno
contiguity and exits non-zero the moment a message is lost. Telemetry is off — metrics
are meaningless once ordering breaks — so we skip the `telemetry` profile and read the
workload's exit code directly. Bring the stack up detached, then `docker wait` on the
workload container for its pass/fail code:

```bash
cd tests/slo

WORKLOAD_DURATION=600 \
WORKLOAD_CURRENT_COMMAND="--setup=topic.setup --topic.setup.partitions=10 --worker=topic.write --topic.write.rps=100 --topic.write.partitions=10 --worker=topic.read --teardown=topic.teardown" \
docker compose --profile chaos --profile workload-current up --build -d

docker compose logs -f workload-current &   # follow the run (optional)
docker wait ydb-workload-current             # blocks, prints the exit code
```

Exit code `0` = every message survived the chaos; non-zero = the run detected loss,
reorder, or a fatal SDK error (the failing reason is printed by `topic.read`/`topic.write`).

Select the runtime with `IMAGE=oven/bun` to exercise the Bun build instead of Node.

## Diagnosing a run

Two opt-in knobs, both forwarded into the workload container (empty by default):

- `DEBUG='ydbjs:*'` — full `@ydbjs/debug` output (driver, grpc, retry, topic). Note the
  `ydbjs:` prefix (not `ydb:`). Narrow it (`ydbjs:topic:*`) or drop the per-message noise
  (`ydbjs:*,-ydbjs:topic:writer:event,-ydbjs:topic:reader:event`) to keep the log readable.
- `NODE_OPTIONS='--import ./instrument.js'` — attaches `instrument.ts`, a preload that
  subscribes to the writer's and reader's `diagnostics_channel` events and prints session /
  partition / reconnect / terminal-error payloads. It is loaded out-of-band (never imported
  by a worker) so the workload code stays clean, exactly like an OpenTelemetry agent. The
  preload runs in every worker thread, which is required — `diagnostics_channel` is
  thread-local, so the subscriber must live in the same thread as the writer/reader.

```bash
cd tests/slo

DEBUG='ydbjs:*,-ydbjs:topic:writer:event,-ydbjs:topic:reader:event' \
NODE_OPTIONS='--import ./instrument.js' \
WORKLOAD_DURATION=600 \
WORKLOAD_CURRENT_COMMAND="--setup=topic.setup --topic.setup.partitions=10 --worker=topic.write --topic.write.rps=100 --topic.write.partitions=10 --worker=topic.read --teardown=topic.teardown" \
docker compose --profile chaos --profile workload-current up --build -d

docker logs -f ydb-workload-current   # DEBUG + [dc] lifecycle + [safety] on crash
```

## Teardown

```bash
docker compose \
  --profile telemetry \
  --profile chaos \
  --profile workload-current \
  down -v          # -v also drops volumes for a clean cluster next run
```

## Lightweight dev stack (no chaos)

For a quick single-node YDB + Prometheus (fast startup, for `npm run start:kv` /
`start:topic` against `localhost:2136`), use the dev compose instead:

```bash
docker compose -f compose.dev.yaml up
```
