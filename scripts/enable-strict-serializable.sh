#!/usr/bin/env bash
set -euo pipefail

# This setting belongs to TableServiceConfig, not YDB_FEATURE_FLAGS.
docker exec -i "$1" bash -ec '
    config=/tmp/enable-strict-serializable.pb.txt
    cat > "$config"
    /ydbd -s "localhost:$1" admin console configs update "$config"
' _ "${2:-2136}" <<'PROTO'
Actions {
  AddConfigItem {
    ConfigItem {
      Config {
        TableServiceConfig {
          EnableStrictSerializableIsolation: true
        }
      }
    }
  }
}
PROTO
