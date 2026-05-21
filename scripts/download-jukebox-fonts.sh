#!/usr/bin/env bash
# Download Google Fonts used by juke-cards into packages/jukebox-ios/fonts/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/packages/jukebox-ios/fonts"
ASSETS="$ROOT/packages/tish-canvas/assets"
UA="Mozilla/5.0"

mkdir -p "$OUT" "$ASSETS"

slug() {
  echo "$1" | tr -d "'\"" | tr -d ' '
}

urlencode() {
  python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$1"
}

gstatic_url() {
  local spec="$1"
  local encoded
  encoded="$(urlencode "$spec")"
  curl -fsSL -A "$UA" "https://fonts.googleapis.com/css2?family=${encoded}&display=swap" 2>/dev/null \
    | grep -oE 'https://fonts.gstatic.com[^)]+' \
    | head -1
}

download_family() {
  local name="$1"
  local dest="$2"
  local spec="$3"
  if [[ -f "$dest" ]]; then
    return 0
  fi
  local url
  url="$(gstatic_url "$spec")"
  if [[ -z "$url" ]]; then
    echo "WARN: no URL for $name ($spec)" >&2
    return 0
  fi
  echo "  $dest"
  curl -fsSL "$url" -o "$dest"
}

FAMILIES=(
  Anton
  "Bebas Neue"
  Monoton
  Righteous
  "Fjalla One"
  Limelight
  "Rampart One"
  "Rubik Mono One"
  "Abril Fatface"
  Bungee
  Bangers
  "Erica One"
  "Fugaz One"
  Ultra
  "Vampiro One"
  Chicle
  "Russo One"
  "Sigmar One"
  "Fascinate Inline"
  Pacifico
  Lobster
  Yellowtail
  Satisfy
  Shrikhand
  "Permanent Marker"
  Fascinate
  Damion
  Cookie
  "Leckerli One"
  "Courier Prime"
  Oswald
  "Space Mono"
  "Special Elite"
  Cinzel
  "Playfair Display"
  "Poiret One"
  Arimo
  Corben
)

echo "Downloading card fonts to $OUT"
for family in "${FAMILIES[@]}"; do
  s="$(slug "$family")"
  download_family "$family" "$OUT/${s}.ttf" "$family"
  download_family "$family" "$OUT/${s}-Bold.ttf" "${family}:wght@700" || true
done

echo "Fallback font for tish-canvas embed"
download_family "Anton" "$ASSETS/Fallback-Regular.ttf" "Anton"

echo "Done ($(find "$OUT" -name '*.ttf' 2>/dev/null | wc -l | tr -d ' ') fonts in bundle dir)"
