#!/usr/bin/env bash
# Construit DojoWallpaper.app (binaire universel arm64 + x86_64) puis ClaudeDojo-<version>.dmg.
#
# Usage : scripts/build-app.sh [--version X] [--out DIR] [--no-dmg]
#   --version X   version sans le « v » (défaut : $VERSION, sinon `git describe --tags --always`)
#   --out DIR     dossier de sortie (défaut : dist/ à la racine du dépôt)
#   --no-dmg      produit seulement DojoWallpaper.app
#   -h, --help    affiche l'aide
#
# Variable optionnelle : BUILD_DIR (fichiers intermédiaires, défaut : build/ à la racine du dépôt).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="DojoWallpaper"
BUNDLE_ID="io.github.claude-dojo.app"
MIN_MACOS="12.0"
VOLNAME="Claude Dojo"
VERSION_RE='^[0-9A-Za-z][0-9A-Za-z._+-]*$'

VERSION="${VERSION:-}"
OUT_DIR="$ROOT/dist"
BUILD_DIR="${BUILD_DIR:-$ROOT/build}"
MAKE_DMG=1

die() {
  echo "build-app.sh: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage : scripts/build-app.sh [--version X] [--out DIR] [--no-dmg]

  --version X   version sans le « v » (défaut : $VERSION, sinon git describe --tags --always)
  --out DIR     dossier de sortie (défaut : dist/ à la racine du dépôt)
  --no-dmg      produit seulement DojoWallpaper.app
  -h, --help    affiche cette aide

Variable optionnelle : BUILD_DIR (intermédiaires, défaut : build/ à la racine du dépôt).
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      [[ $# -ge 2 ]] || die "--version exige une valeur"
      VERSION="$2"
      shift 2
      ;;
    --out)
      [[ $# -ge 2 ]] || die "--out exige un dossier"
      OUT_DIR="$2"
      shift 2
      ;;
    --no-dmg)
      MAKE_DMG=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "option inconnue : $1 (voir --help)"
      ;;
  esac
done

# 1) Version : argument, puis variable d'environnement, puis git describe.
if [[ -z "$VERSION" ]]; then
  VERSION="$(git -C "$ROOT" describe --tags --always 2>/dev/null || true)"
fi
VERSION="${VERSION#v}"
[[ -n "$VERSION" ]] || die "version introuvable : passez --version X"
[[ $VERSION =~ $VERSION_RE ]] || die "version invalide : $VERSION"

# Outils requis.
REQUIRED_TOOLS=(swiftc lipo codesign plutil ditto npm)
if [[ "$MAKE_DMG" -eq 1 ]]; then
  REQUIRED_TOOLS+=(hdiutil)
fi
for tool in "${REQUIRED_TOOLS[@]}"; do
  command -v "$tool" >/dev/null 2>&1 || die "outil requis absent : $tool"
done

SRC_DIR="$ROOT/src"
MAC_DIR="$ROOT/mac"
shopt -s nullglob
SWIFT_SOURCES=("$MAC_DIR"/*.swift)
shopt -u nullglob
[[ ${#SWIFT_SOURCES[@]} -gt 0 ]] || die "aucune source Swift dans $MAC_DIR"
[[ -f "$SRC_DIR/package.json" && -f "$SRC_DIR/package-lock.json" ]] || die "src/ incomplet (package.json, package-lock.json)"

mkdir -p "$OUT_DIR" "$BUILD_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
BUILD_DIR="$(cd "$BUILD_DIR" && pwd)"
WORK="$BUILD_DIR/work"
rm -rf "$WORK"
mkdir -p "$WORK"

APP="$OUT_DIR/$APP_NAME.app"
DMG="$OUT_DIR/ClaudeDojo-$VERSION.dmg"
rm -rf "$APP"

# 2) Compilation : un binaire par architecture, fusionné en binaire universel.
echo "==> Compilation Swift (${#SWIFT_SOURCES[@]} source(s), minimum macOS $MIN_MACOS)"
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos$MIN_MACOS" \
    -module-name "$APP_NAME" \
    "${SWIFT_SOURCES[@]}" \
    -o "$WORK/$APP_NAME-$arch" \
    -framework Cocoa -framework WebKit -framework SwiftUI
done

# 3) Bundle .app : binaire, Info.plist, runtime Node.
echo "==> Assemblage du bundle $APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
lipo -create "$WORK/$APP_NAME-arm64" "$WORK/$APP_NAME-x86_64" -output "$APP/Contents/MacOS/$APP_NAME"
chmod 755 "$APP/Contents/MacOS/$APP_NAME"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>$APP_NAME</string>
	<key>CFBundleIdentifier</key>
	<string>$BUNDLE_ID</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>$APP_NAME</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>$VERSION</string>
	<key>CFBundleVersion</key>
	<string>$VERSION</string>
	<key>LSMinimumSystemVersion</key>
	<string>$MIN_MACOS</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsLocalNetworking</key>
		<true/>
		<key>NSExceptionDomains</key>
		<dict>
			<key>localhost</key>
			<dict>
				<key>NSExceptionAllowsInsecureHTTPLoads</key>
				<true/>
			</dict>
		</dict>
	</dict>
</dict>
</plist>
PLIST
plutil -lint "$APP/Contents/Info.plist"

# Runtime : copie de src/ (sans config.json ni node_modules locaux), dépendances de production installées
# dans une copie de travail, puis déplacées dans Contents/Resources/runtime.
echo "==> Runtime Node (src/ + node_modules de production)"
RUNTIME_TMP="$WORK/runtime"
mkdir -p "$RUNTIME_TMP"
cp -R "$SRC_DIR/." "$RUNTIME_TMP/"
rm -rf "$RUNTIME_TMP/config.json" "$RUNTIME_TMP/node_modules"
find "$RUNTIME_TMP" -name .DS_Store -delete
(cd "$RUNTIME_TMP" && npm ci --omit=dev --no-audit --no-fund)
mv "$RUNTIME_TMP" "$APP/Contents/Resources/runtime"

# 4) Signature ad hoc.
echo "==> Signature ad hoc"
xattr -cr "$APP"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

# 5) DMG : app + lien vers /Applications. Pas de mise en page Finder (fragile en CI).
if [[ "$MAKE_DMG" -eq 1 ]]; then
  echo "==> DMG $DMG"
  STAGE="$WORK/dmg"
  mkdir -p "$STAGE"
  ditto "$APP" "$STAGE/$APP_NAME.app"
  ln -s /Applications "$STAGE/Applications"
  rm -f "$DMG"
  hdiutil create -volname "$VOLNAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
fi

rm -rf "$WORK"

echo "==> Terminé"
echo "App : $APP"
if [[ "$MAKE_DMG" -eq 1 ]]; then
  echo "DMG : $DMG"
fi
