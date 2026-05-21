#!/usr/bin/env bash
# Build hello-ios, then launch on the simulator.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
just dev-ios-sim
exec "$ROOT/scripts/launch-hello-ios-sim.sh"
