# juke.sh monorepo — Tish + Lattish build pipeline
#
# Artifacts land in packages/jukebox/public/dist:
#   juke-cards.js       (@spacedevin/juke-cards browser bundle)
#   vendor.js           (Three.js + Tone.js + scene bridge)
#   jukebox.js          (Lattish SPA + inlined Lattish runtime)

export CARGO_TARGET_DIR := justfile_directory() + "/target"
TISH_ROOT := env_var_or_default("TISH_ROOT", justfile_directory() + "/../tish")
TISH := env_var_or_default("TISH", "tish")
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
