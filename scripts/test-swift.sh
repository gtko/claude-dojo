#!/usr/bin/env bash
# Tests Swift de la géométrie de la zone de travail (fonctions pures, sans API Accessibilité).
# Compile mac/WindowZoneGeometry.swift avec test/swift/main.swift dans un dossier temporaire, puis lance le binaire.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

command -v swiftc >/dev/null || { echo "swiftc introuvable (outils Xcode requis)" >&2; exit 1; }
swiftc -O -module-name WindowZoneTests \
  "$ROOT/mac/WindowZoneGeometry.swift" "$ROOT/test/swift/main.swift" \
  -o "$TMP/window-zone-tests"
"$TMP/window-zone-tests"
