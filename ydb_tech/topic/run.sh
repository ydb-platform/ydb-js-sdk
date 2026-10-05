#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
npm start --workspace=@ydbjs/ydb-tech-topic
