#!/usr/bin/env bash
# Build jukebox iOS staticlib (simulator by default).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TRIPLE="${IOS_TRIPLE:-aarch64-apple-ios-sim}"
TISH="${TISH:-tish}"
cd "$ROOT/packages/jukebox-ios"
npm run build -- --ios-triple "$TRIPLE" "$@"
