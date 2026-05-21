#!/usr/bin/env bash
# Boot Simulator, install, and launch an already-built jukebox-ios .app.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IOS_SIM_DEVICE="${IOS_SIM_DEVICE:-iPhone 17}"
IOS_JUKEBOX_BUNDLE="${IOS_JUKEBOX_BUNDLE:-sh.juke.ios}"
DERIVED="${IOS_JUKEBOX_DERIVED:-$ROOT/target/ios-jukebox-derived}"
APP="$DERIVED/Build/Products/Debug-iphonesimulator/JukeboxIos.app"

if [[ ! -d "$APP" ]]; then
  echo "App bundle not found at $APP" >&2
  echo "Build first: just dev-jukebox-ios-sim" >&2
  exit 1
fi

UDID=$(IOS_SIM_DEVICE="$IOS_SIM_DEVICE" python3 -c '
import json, os, sys
name = os.environ["IOS_SIM_DEVICE"]
for runtime in json.load(sys.stdin)["devices"].values():
    for dev in runtime:
        if dev.get("name") == name and dev.get("isAvailable"):
            print(dev["udid"])
            sys.exit(0)
sys.exit(1)
' < <(xcrun simctl list devices available -j)) || {
  echo "Simulator '$IOS_SIM_DEVICE' not found. Set IOS_SIM_DEVICE." >&2
  exit 1
}

xcrun simctl boot "$UDID" 2>/dev/null || true
open -a Simulator
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch "$UDID" "$IOS_JUKEBOX_BUNDLE"
