#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
npm start --workspace=@ydbjs/ydb-tech-topic
