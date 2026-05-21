# juke.sh monorepo — Tish + Lattish build pipeline
#
# Artifacts land in packages/jukebox/public/dist:
#   juke-cards.js       (@spacedevin/juke-cards browser bundle)
#   vendor.js           (Three.js + Tone.js + scene bridge)
#   jukebox.js          (Lattish SPA + inlined Lattish runtime)

export CARGO_TARGET_DIR := justfile_directory() + "/target"
TISH_ROOT := env_var_or_default("TISH_ROOT", justfile_directory() + "/../tish")
TISH := env_var_or_default("TISH", "tish")
TISH_APPLE := justfile_directory() + "/../tish/tish-apple"
TISH_FMT := env_var_or_default("TISH_FMT", TISH_ROOT + "/target/release/tish-fmt")
TISH_LINT := env_var_or_default("TISH_LINT", TISH_ROOT + "/target/release/tish-lint")

default:
    @just --list

# --- juke-cards ---

build-cards:
    npm run build --workspace=@spacedevin/juke-cards

test-cards:
    npm test --workspace=@spacedevin/juke-cards

# --- bridges vendor bundle ---

build-vendor:
    npm run build --workspace=@spacedevin/juke-bridges
    mkdir -p "{{ justfile_directory() }}/packages/jukebox/public/dist"
    cp "{{ justfile_directory() }}/packages/bridges/dist/vendor.js" \
       "{{ justfile_directory() }}/packages/jukebox/public/dist/vendor.js"

# Optional: prebuilt Lattish.js (not loaded by boot.js — runtime is inlined in jukebox.js)
build-lattish-runtime:
    mkdir -p "{{ justfile_directory() }}/packages/jukebox/public/dist"
    cp "{{ justfile_directory() }}/node_modules/@tishlang/lattish/dist/Lattish.js" \
       "{{ justfile_directory() }}/packages/jukebox/public/dist/lattish-runtime.js"

# --- jukebox SPA ---

build-app:
    npm run build --workspace=@spacedevin/jukebox

build: build-app

quick: build-app

dev: build
    cd "{{ justfile_directory() }}/packages/jukebox" && \
    {{ TISH }} run --feature fs --feature http --feature process dev-server.tish

serve: dev

test: test-cards

# Optional: rebuild on .tish changes (requires fswatch or similar)
dev-watch:
    #!/usr/bin/env bash
    set -euo pipefail
    while true; do
      just quick || true
      fswatch -1 -r packages/jukebox/src packages/juke-cards/src
    done

fmt:
    {{ TISH_FMT }} packages/juke-cards/src packages/jukebox/src

fmt-check:
    {{ TISH_FMT }} --check packages/juke-cards/src packages/jukebox/src

lint:
    {{ TISH_LINT }} packages/juke-cards/src packages/jukebox/src

clean:
    rm -rf packages/jukebox/public/dist packages/juke-cards/dist packages/juke-cards/lib packages/bridges/dist target

# --- iOS native (tish-apple) ---

IOS_SIM_DEVICE := env_var_or_default("IOS_SIM_DEVICE", "iPhone 17")
IOS_HELLO_DERIVED := justfile_directory() + "/target/ios-hello-derived"
IOS_HELLO_PROJECT := TISH_APPLE + "/examples/hello-ios/ios-shell/HelloIos.xcodeproj"
IOS_HELLO_BUNDLE := "com.tishlang.helloios"

build-hello-ios:
    cd "{{ TISH_APPLE }}/examples/hello-ios" && npm install && npm run build

# Compile hello-ios for the simulator (staticlib + Xcode link).
dev-ios-sim: build-hello-ios
    xcodebuild -project "{{ IOS_HELLO_PROJECT }}" \
      -scheme HelloIos \
      -destination 'platform=iOS Simulator,name={{ IOS_SIM_DEVICE }}' \
      -derivedDataPath "{{ IOS_HELLO_DERIVED }}" \
      build

# Launch an already-built hello-ios on the simulator (no rebuild).
launch-hello-ios-sim:
    "{{ justfile_directory() }}/scripts/launch-hello-ios-sim.sh"

# Build + launch (convenience when you want a full refresh).
run-hello-ios-sim:
    "{{ justfile_directory() }}/scripts/run-hello-ios-sim.sh"

build-ios:
    cd "{{ justfile_directory() }}/packages/jukebox-ios" && npm install && npm run build

IOS_JUKEBOX_DERIVED := justfile_directory() + "/target/ios-jukebox-derived"
IOS_JUKEBOX_PROJECT := justfile_directory() + "/packages/jukebox-ios/ios-shell/JukeboxIos.xcodeproj"
IOS_JUKEBOX_BUNDLE := "sh.juke.ios"

# Compile jukebox-ios for the simulator (staticlib + Xcode link).
dev-jukebox-ios-sim: build-ios
    xcodebuild -project "{{ IOS_JUKEBOX_PROJECT }}" \
      -scheme JukeboxIos \
      -destination 'platform=iOS Simulator,name={{ IOS_SIM_DEVICE }}' \
      -derivedDataPath "{{ IOS_JUKEBOX_DERIVED }}" \
      build

# Launch an already-built jukebox-ios on the simulator (no rebuild).
launch-jukebox-ios-sim:
    "{{ justfile_directory() }}/scripts/launch-jukebox-ios-sim.sh"

# Build + launch jukebox-ios on the simulator.
run-jukebox-ios-sim:
    "{{ justfile_directory() }}/scripts/run-jukebox-ios-sim.sh"
