#!/usr/bin/env bash
# Build jukebox-ios, then launch on the simulator.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
just dev-jukebox-ios-sim
exec "$ROOT/scripts/launch-jukebox-ios-sim.sh"
