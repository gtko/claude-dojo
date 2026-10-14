#!/usr/bin/env bash
# Claude Dojo : installation macOS (fond d'écran animé, hooks et statusline de Claude Code).
# Idempotent : relançable sans erreur ni doublon. Désinstallation : uninstall.sh.
# Usage : ./install.sh [--yes] [--no-launchd] [--help]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/src"
SWIFT_SRC="$SCRIPT_DIR/mac/DojoWallpaper.swift"
DOJO="$HOME/.config/claude-dojo"
APP="$HOME/Applications/DojoWallpaper.app"
LA="$HOME/Library/LaunchAgents"
CLAUDE_DIR="$HOME/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"
LABEL_AGENT="io.github.claude-dojo.agent"
LABEL_WALL="io.github.claude-dojo.wallpaper"
STAMP="$(date +%Y%m%d-%H%M%S)"

# Valeurs décidées pendant les questions
NODE=""
WEATHER_NAME=""
WEATHER_LAT=""
WEATHER_LON=""
TZ_NAME=""
OWNERS=""
ROOTS=""
CALS=""
SL_STATE=""
SL_CMD=""
SL_ACTION="set"
HEAVY="keep"
BREW_DO=0
MISSING=""
MIN=""

say()  { printf '==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'Attention : %s\n' "$*" >&2; }
die()  { printf 'Erreur : %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'TXT'
Usage : install.sh [--yes|-y] [--no-launchd] [--help]

Installe Claude Dojo : fond d'écran animé (macOS), hooks et statusline de Claude Code.

  --yes, -y      non interactif : défauts neutres (ou variables DOJO_* ci-dessous)
  --no-launchd   écrit les LaunchAgents sans les charger, ni rien décharger dans launchd
  --help         affiche cette aide

Variables d'environnement (répondent aux questions sans les poser) :
  DOJO_CITY            ville pour la météo (vide = pas de météo)
  DOJO_LAT, DOJO_LON   coordonnées, si le géocodage échoue ou pour les imposer
  DOJO_TZ              fuseau horaire de la météo (défaut : celui du système)
  DOJO_GITHUB_OWNERS   owners GitHub, séparés par des virgules (vide = désactivé)
  DOJO_PROJECT_ROOTS   dossiers de projets, séparés par des virgules (défaut : ~/Projects s'il existe)
  DOJO_CALENDARS       URL ICS ou webcal, séparées par des virgules
  DOJO_HEAVY_GATE      y/n : hook heavy-gate (PreToolUse, Bash). Non défini en --yes : inchangé
  DOJO_STATUSLINE      y/n/ask : remplacer une statusline existante (sans effet si aucune)
  DOJO_BREW            y/n : installer macmon et media-control avec brew

config.json existant : jamais écrasé, et les questions de configuration sont alors sautées.
TXT
}

# ── Options ──────────────────────────────────────────────────────────────
YES=0
NO_LAUNCHD=0
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) YES=1 ;;
    --no-launchd) NO_LAUNCHD=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Option inconnue : %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# Terminal interactif ? Sinon (ou avec --yes) : réponses par défaut.
INTERACTIVE=0
if [ "$YES" = 0 ] && { : </dev/tty; } 2>/dev/null; then INTERACTIVE=1; fi

# ── Utilitaires ──────────────────────────────────────────────────────────
# Une variable DOJO_* est « définie » même si elle est vide (vide = réponse « non »).
is_set()  { eval "[ \"\${$1+x}\" = x ]"; }
env_val() { eval "printf '%s' \"\${$1}\""; }
is_num()  { printf '%s' "$1" | grep -Eq '^-?[0-9]+(\.[0-9]+)?$'; }
xml_esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# Question texte : réponse sur stdout (défaut si vide ou non interactif).
ask_text() {
  local ans=""
  if [ "$INTERACTIVE" = 1 ]; then
    if [ -n "$2" ]; then printf '    %s [%s] : ' "$1" "$2" > /dev/tty; else printf '    %s : ' "$1" > /dev/tty; fi
    IFS= read -r ans < /dev/tty || ans=""
    ans="$(printf '%s' "$ans" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  fi
  if [ -n "$ans" ]; then printf '%s' "$ans"; else printf '%s' "$2"; fi
}

# Question oui/non : code retour 0 = oui. $2 = défaut (y|n).
ask_yn() {
  local ans="" hint="[o/N]"
  if [ "$2" = y ]; then hint="[O/n]"; fi
  if [ "$INTERACTIVE" = 1 ]; then
    printf '    %s %s ' "$1" "$hint" > /dev/tty
    IFS= read -r ans < /dev/tty || ans=""
  fi
  case "$(printf '%s' "$ans" | tr '[:upper:]' '[:lower:]')" in
    o|oui|y|yes) return 0 ;;
    n|non|no) return 1 ;;
    *) if [ "$2" = y ]; then return 0; else return 1; fi ;;
  esac
}

# Variable d'environnement oui/non/ask : affiche y, n, ask ou rien si non reconnue.
yn_from_env() {
  local v
  v="$(env_val "$1" | tr '[:upper:]' '[:lower:]')"
  case "$v" in
    y|o|yes|oui|1|true) printf 'y' ;;
    n|no|non|0|false) printf 'n' ;;
    ask) printf 'ask' ;;
    *) warn "$1=$(env_val "$1") non reconnu (attendu y ou n) : valeur par défaut utilisée." ;;
  esac
}

system_tz() {
  local l
  l="$(readlink /etc/localtime 2>/dev/null || true)"
  case "$l" in
    *zoneinfo/*) printf '%s' "${l#*zoneinfo/}" ;;
    *) printf 'UTC' ;;
  esac
}

node_ok() {
  [ -n "${1:-}" ] && [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1
}

# Node 18+ : PATH, Homebrew, /usr/local, volta, fnm, puis nvm (la version la plus récente d'abord).
find_node() {
  local c list
  c="$(command -v node 2>/dev/null || true)"
  if node_ok "$c"; then printf '%s' "$c"; return 0; fi
  for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" \
           "$HOME/.local/share/fnm/aliases/default/bin/node" \
           "$HOME/Library/Application Support/fnm/aliases/default/bin/node"; do
    if node_ok "$c"; then printf '%s' "$c"; return 0; fi
  done
  list="$(ls -1d "$HOME"/.nvm/versions/node/*/bin/node \
                  "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
                  "$HOME/Library/Application Support/fnm/node-versions"/*/installation/bin/node \
                  2>/dev/null | sort -r -V || true)"
  while IFS= read -r c; do
    if node_ok "$c"; then printf '%s' "$c"; return 0; fi
  done <<EOF
$list
EOF
  return 1
}

# Géocodage Open-Meteo : stdout = lat<TAB>lon<TAB>nom ; code retour 1 si rien trouvé.
geocode() {
  local json
  json="$(curl -fsS --max-time 15 -G \
    --data-urlencode "name=$1" --data-urlencode count=1 \
    --data-urlencode language=fr --data-urlencode format=json \
    'https://geocoding-api.open-meteo.com/v1/search' 2>/dev/null)" || return 1
  "$NODE" - "$json" <<'JS'
let j;
try { j = JSON.parse(process.argv[2]); } catch (e) { process.exit(1); }
const r = j && Array.isArray(j.results) ? j.results[0] : null;
if (!r) process.exit(1);
process.stdout.write([r.latitude, r.longitude, r.name].join('\t'));
JS
}

# Lit settings.json (sans le modifier) : absent | none | dojo | other:<commande>. Exit 2 si invalide.
probe_settings() {
  "$NODE" - "$SETTINGS" <<'JS'
const fs = require('fs');
const file = process.argv[2];
if (!fs.existsSync(file)) { console.log('absent'); process.exit(0); }
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
let s;
try {
  const raw = fs.readFileSync(file, 'utf8');
  s = raw.trim() === '' ? {} : JSON.parse(raw);
} catch (e) { console.error(file + ' : JSON invalide (' + e.message + ')'); process.exit(2); }
if (!isObj(s)) { console.error(file + ' : un objet JSON est attendu'); process.exit(2); }
if (s.hooks !== undefined && !isObj(s.hooks)) { console.error(file + " : 'hooks' doit être un objet"); process.exit(2); }
if (s.env !== undefined && !isObj(s.env)) { console.error(file + " : 'env' doit être un objet"); process.exit(2); }
const sl = s.statusLine;
if (!sl) { console.log('none'); process.exit(0); }
const cmd = isObj(sl) ? [sl.command, ...(Array.isArray(sl.args) ? sl.args : [])].join(' ') : String(sl);
if (/claude-dojo\/statusline\.js/.test(cmd)) console.log('dojo');
else console.log('other:' + cmd);
JS
}

# ── 1. Pré-requis ────────────────────────────────────────────────────────
say "Vérifications"
[ "$(uname -s)" = Darwin ] || die "Claude Dojo ne s'installe que sur macOS."
[ -d "$SRC" ] || die "dossier src/ introuvable à côté de install.sh ($SRC)."
[ -f "$SWIFT_SRC" ] || die "mac/DojoWallpaper.swift introuvable ($SWIFT_SRC)."
if [ "$YES" = 0 ] && [ "$INTERACTIVE" = 0 ]; then
  warn "pas de terminal interactif : réponses par défaut (comme --yes)."
fi

NODE_BIN="$(find_node || true)"
if [ -z "$NODE_BIN" ]; then
  die "Node.js 18 ou plus est introuvable (PATH, Homebrew, /usr/local, volta, nvm, fnm).
  Installe-le avec : brew install node"
fi
NODE="$(cd "$(dirname "$NODE_BIN")" && pwd -P)/$(basename "$NODE_BIN")"
info "Node.js $("$NODE" -p process.version) : $NODE"

if ! swiftc --version >/dev/null 2>&1; then
  if ask_yn "Lancer maintenant l'installation des Xcode Command Line Tools (xcode-select --install) ?" n; then
    xcode-select --install >/dev/null 2>&1 || true
    die "installation lancée : attends la fin de l'installation Xcode, puis relance install.sh."
  fi
  die "swiftc introuvable. Installe les Xcode Command Line Tools : xcode-select --install"
fi
info "swiftc disponible"

PROBE="$(probe_settings)" || die "$SETTINGS est illisible ou invalide : corrige-le (ou déplace-le), puis relance."
case "$PROBE" in
  other:*) SL_STATE=other; SL_CMD="${PROBE#other:}" ;;
  *) SL_STATE="$PROBE" ;;
esac

# ── 2. Questions ─────────────────────────────────────────────────────────
say "Configuration"
CFG_EXISTS=0
if [ -f "$DOJO/config.json" ]; then CFG_EXISTS=1; fi

if [ "$CFG_EXISTS" = 1 ]; then
  info "config.json existant conservé ($DOJO/config.json) : modifie-le pour la météo, l'agenda ou GitHub."
else
  city=""
  if is_set DOJO_CITY; then city="$(env_val DOJO_CITY)"; else city="$(ask_text 'Ville pour la météo (vide = pas de météo)' '')"; fi
  if [ -n "$city" ]; then
    lat=""; lon=""; geo=""
    if is_set DOJO_LAT && is_set DOJO_LON; then
      lat="$(env_val DOJO_LAT)"; lon="$(env_val DOJO_LON)"; WEATHER_NAME="$city"
    else
      geo="$(geocode "$city" 2>/dev/null || true)"
      if [ -n "$geo" ]; then
        lat="$(printf '%s' "$geo" | cut -f1)"; lon="$(printf '%s' "$geo" | cut -f2)"
        WEATHER_NAME="$(printf '%s' "$geo" | cut -f3)"
        info "Ville trouvée : $WEATHER_NAME ($lat, $lon)"
      else
        warn "géocodage impossible pour « $city »."
        lat="$(ask_text 'Latitude' '')"; lon="$(ask_text 'Longitude' '')"; WEATHER_NAME="$city"
      fi
    fi
    if is_num "$lat" && is_num "$lon"; then
      WEATHER_LAT="$lat"; WEATHER_LON="$lon"
      if is_set DOJO_TZ; then TZ_NAME="$(env_val DOJO_TZ)"; else TZ_NAME="$(ask_text 'Fuseau horaire de la météo' "$(system_tz)")"; fi
      if [ -z "$TZ_NAME" ]; then TZ_NAME="$(system_tz)"; fi
    else
      warn "pas de coordonnées valides : météo désactivée (DOJO_LAT et DOJO_LON, ou relance en interactif)."
    fi
  fi

  if is_set DOJO_GITHUB_OWNERS; then OWNERS="$(env_val DOJO_GITHUB_OWNERS)"; else OWNERS="$(ask_text 'Owners GitHub des dépôts perso, séparés par des virgules (vide = désactivé)' '')"; fi

  def_roots=""
  if [ -d "$HOME/Projects" ]; then def_roots="$HOME/Projects"; fi
  if is_set DOJO_PROJECT_ROOTS; then ROOTS="$(env_val DOJO_PROJECT_ROOTS)"; else ROOTS="$(ask_text 'Dossiers de projets, séparés par des virgules (vide = aucun)' "$def_roots")"; fi

  if is_set DOJO_CALENDARS; then CALS="$(env_val DOJO_CALENDARS)"; else CALS="$(ask_text 'Agendas ICS ou webcal, séparés par des virgules (vide = aucun)' '')"; fi
  info "Météo : ${WEATHER_NAME:-aucune} | GitHub : ${OWNERS:-désactivé} | Projets : ${ROOTS:-aucun} | Agendas : $(printf '%s' "$CALS" | tr ',' '\n' | grep -c . || true)"
fi

# heavy-gate : non défini en --yes = état actuel conservé ; défaut interactif = état actuel
HEAVY_NOW=0
if grep -q 'claude-dojo/heavy-gate\.js' "$SETTINGS" 2>/dev/null; then HEAVY_NOW=1; fi
if is_set DOJO_HEAVY_GATE; then
  case "$(yn_from_env DOJO_HEAVY_GATE)" in
    y) HEAVY=on ;;
    n) HEAVY=off ;;
    *) HEAVY=keep ;;
  esac
elif [ "$INTERACTIVE" = 1 ]; then
  def=n; if [ "$HEAVY_NOW" = 1 ]; then def=y; fi
  if ask_yn "Activer heavy-gate (limite les suites lourdes lancées en parallèle sur Bash) ?" "$def"; then HEAVY=on; else HEAVY=off; fi
fi
if [ "$HEAVY" = on ] && grep -q 'heavy-gate\.js' "$SETTINGS" 2>/dev/null && [ "$HEAVY_NOW" = 0 ]; then
  warn "un autre heavy-gate est déjà enregistré dans $SETTINGS : les deux se cumuleraient."
fi

# statusline : aucune → installée ; dojo → mise à jour ; autre → remplacée seulement sur demande
if [ "$SL_STATE" = other ]; then
  SL_ACTION=keep
  sl_choice=ask
  if is_set DOJO_STATUSLINE; then sl_choice="$(yn_from_env DOJO_STATUSLINE)"; fi
  case "$sl_choice" in
    y) SL_ACTION=replace ;;
    ask)
      if [ "$INTERACTIVE" = 1 ] && ask_yn "Une statusline existe déjà (${SL_CMD:0:100}). La remplacer par celle de Dojo ?" n; then
        SL_ACTION=replace
      fi ;;
  esac
fi

# dépendances optionnelles
for t in macmon media-control; do
  if ! command -v "$t" >/dev/null 2>&1; then MISSING="$MISSING $t"; fi
done
MISSING="${MISSING# }"
if command -v brew >/dev/null 2>&1; then
  if [ -n "$MISSING" ]; then
    choice=ask
    if is_set DOJO_BREW; then choice="$(yn_from_env DOJO_BREW)"; fi
    if [ "$choice" = y ] || { [ "$choice" = ask ] && ask_yn "Installer avec brew ($MISSING) : capteurs et musique du Dojo ?" n; }; then BREW_DO=1; fi
  fi
  command -v gh >/dev/null 2>&1 || info "gh absent (optionnel, sert aux dépôts GitHub) : brew install gh"
else
  if [ -n "$MISSING" ]; then info "brew absent : installe $MISSING à la main pour les capteurs et la musique (optionnel)."; fi
  command -v gh >/dev/null 2>&1 || info "gh absent (optionnel) : https://cli.github.com"
fi

# ── 3. Installation ──────────────────────────────────────────────────────
say "Fichiers dans $DOJO"
mkdir -p "$DOJO/cache" "$LA" "$CLAUDE_DIR" "$HOME/Applications"
for item in "$SRC"/*; do
  [ -e "$item" ] || continue
  name="$(basename "$item")"
  case "$name" in config.json|cache|node_modules) continue ;; esac
  if [ -d "$item" ]; then
    rm -rf "${DOJO:?}/$name"
    cp -R "$item" "$DOJO/$name"
  else
    cp -f "$item" "$DOJO/$name"
  fi
done

if [ "$BREW_DO" = 1 ]; then
  say "brew install $MISSING"
  # shellcheck disable=SC2086 # la liste de paquets est volontairement découpée
  if ! brew install $MISSING; then warn "brew install a échoué : capteurs et musique indisponibles."; fi
fi

if [ "$CFG_EXISTS" = 0 ]; then
  say "config.json"
  "$NODE" - "$DOJO/config.json" "$WEATHER_NAME" "$WEATHER_LAT" "$WEATHER_LON" "$TZ_NAME" "$OWNERS" "$ROOTS" "$CALS" <<'JS'
const fs = require('fs');
const [file, name, lat, lon, tz, owners, roots, cals] = process.argv.slice(2);
const csv = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);
const expand = (p) => p.replace(/^~(?=$|\/)/, process.env.HOME);
const cfg = {};
if (lat && lon) cfg.weather = { name, lat: Number(lat), lon: Number(lon), timezone: tz || 'UTC' };
const urls = csv(cals);
const valid = urls.filter((u) => /^(https?|webcal):\/\//i.test(u));
if (valid.length !== urls.length) console.error("Attention : entrée(s) d'agenda ignorée(s), attendu une URL https ou webcal.");
cfg.calendars = valid;
cfg.github = { owners: csv(owners) };
cfg.projects = { roots: csv(roots).map(expand), onlyOwners: false };
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
JS
  info "créé : $DOJO/config.json (droits 0600, il peut contenir une URL privée)"
fi

say "Dépendances npm (node-ical)"
NPM="$(dirname "$NODE")/npm"
if [ ! -x "$NPM" ]; then NPM="$(command -v npm || true)"; fi
[ -n "$NPM" ] || die "npm introuvable (il vient normalement avec node)."
( cd "$DOJO" && PATH="$(dirname "$NODE"):$PATH" "$NPM" install --omit=dev --no-audit --no-fund --silent ) \
  || die "npm install a échoué dans $DOJO (réseau ?). Relance install.sh une fois la connexion rétablie."

say "DojoWallpaper.app (compilation Swift)"
mkdir -p "$APP/Contents/MacOS"
ARCH="$(uname -m)"
BUILD_LOG="$DOJO/cache/swiftc.log"
rm -f "$APP/Contents/MacOS/DojoWallpaper.new"
for v in 11.0 12.0 13.0 14.0; do
  if swiftc -O "$SWIFT_SRC" -o "$APP/Contents/MacOS/DojoWallpaper.new" \
       -framework Cocoa -framework WebKit -target "$ARCH-apple-macos$v" >"$BUILD_LOG" 2>&1; then
    MIN="$v"
    break
  fi
  info "échec pour macOS $v minimum, essai suivant"
done
if [ -z "$MIN" ]; then
  tail -n 15 "$BUILD_LOG" >&2 || true
  die "compilation impossible (journal complet : $BUILD_LOG)"
fi
mv -f "$APP/Contents/MacOS/DojoWallpaper.new" "$APP/Contents/MacOS/DojoWallpaper"
rm -f "$BUILD_LOG"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>$LABEL_WALL</string>
  <key>CFBundleName</key><string>DojoWallpaper</string>
  <key>CFBundleExecutable</key><string>DojoWallpaper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>$MIN</string>
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSAppleEventsUsageDescription</key><string>Ramener la fenêtre d'une session Claude au clic sur son ninja.</string>
</dict></plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1 || warn "signature ad hoc impossible : Gatekeeper pourrait bloquer l'app."
info "compilée pour $ARCH, macOS $MIN minimum : $APP"

say "LaunchAgents (écriture)"
node_x="$(xml_esc "$NODE")"
dojo_x="$(xml_esc "$DOJO")"
app_x="$(xml_esc "$APP")"
la_path="/opt/homebrew/bin:/usr/local/bin:$(xml_esc "$(dirname "$NODE")"):/usr/bin:/bin:/usr/sbin:/sbin"
cat > "$LA/$LABEL_AGENT.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL_AGENT</string>
  <key>ProgramArguments</key><array><string>$node_x</string><string>$dojo_x/agent-mac.js</string></array>
  <key>WorkingDirectory</key><string>$dojo_x</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$la_path</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$dojo_x/cache/agent.log</string>
  <key>StandardErrorPath</key><string>$dojo_x/cache/agent.log</string>
</dict></plist>
PLIST
cat > "$LA/$LABEL_WALL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL_WALL</string>
  <key>ProgramArguments</key><array><string>$app_x/Contents/MacOS/DojoWallpaper</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardOutPath</key><string>$dojo_x/cache/wallpaper.log</string>
  <key>StandardErrorPath</key><string>$dojo_x/cache/wallpaper.log</string>
</dict></plist>
PLIST
info "$LA/$LABEL_AGENT.plist"
info "$LA/$LABEL_WALL.plist"

say "Hooks et statusline dans $SETTINGS"
merge_settings() {
  "$NODE" - "$SETTINGS" "$NODE" "$DOJO" "$HEAVY" "$SL_ACTION" "$STAMP" <<'JS'
const fs = require('fs');
const path = require('path');
const [file, node, dojo, heavyMode, slAction, stamp] = process.argv.slice(2);

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd'];
const RE = {
  hook: /claude-dojo\/hook\.js/,
  heavy: /claude-dojo\/heavy-gate\.js/,
  statusline: /claude-dojo\/statusline\.js/,
};
const q = (p) => '"' + p + '"';
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// Commande complète, quel que soit le format (« command » seule ou « command » + « args »)
const cmdOf = (h) => [h.command, ...(Array.isArray(h.args) ? h.args : [])].join(' ');
const isDojo = (h, re) => isObj(h) && re.test(cmdOf(h));
const hasDojo = (list, re) => Array.isArray(list) && list.some((g) => isObj(g) && Array.isArray(g.hooks) && g.hooks.some((h) => isDojo(h, re)));

// Retire les entrées dojo d'un événement et insère « canonical » à la place de la première occurrence.
// canonical = null : suppression seule.
function setDojoGroup(list, re, canonical) {
  const out = [];
  let at = -1;
  for (const g of list) {
    if (!isObj(g) || !Array.isArray(g.hooks) || !g.hooks.some((h) => isDojo(h, re))) { out.push(g); continue; }
    if (at < 0) at = out.length;
    const rest = g.hooks.filter((h) => !isDojo(h, re));
    if (rest.length) out.push({ ...g, hooks: rest });
  }
  if (canonical) { if (at < 0) out.push(canonical); else out.splice(at, 0, canonical); }
  return out;
}

let before = null;
let s = {};
if (fs.existsSync(file)) {
  before = fs.readFileSync(file, 'utf8');
  s = before.trim() === '' ? {} : JSON.parse(before);
}
if (!isObj(s.hooks)) s.hooks = {};

for (const ev of EVENTS) {
  const list = Array.isArray(s.hooks[ev]) ? s.hooks[ev] : [];
  s.hooks[ev] = setDojoGroup(list, RE.hook, {
    hooks: [{ type: 'command', command: q(node) + ' ' + q(dojo + '/hook.js'), async: true }],
  });
}

if (heavyMode === 'on') {
  s.hooks.PreToolUse = setDojoGroup(s.hooks.PreToolUse, RE.heavy, {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: q(node) + ' ' + q(dojo + '/heavy-gate.js'), timeout: 10 }],
  });
  if (!isObj(s.env)) s.env = {};
  if (s.env.VITEST_MAX_WORKERS === undefined) s.env.VITEST_MAX_WORKERS = '2';
} else if (heavyMode === 'off') {
  const had = hasDojo(s.hooks.PreToolUse, RE.heavy);
  if (Array.isArray(s.hooks.PreToolUse)) s.hooks.PreToolUse = setDojoGroup(s.hooks.PreToolUse, RE.heavy, null);
  if (had && isObj(s.env) && s.env.VITEST_MAX_WORKERS === '2') {
    delete s.env.VITEST_MAX_WORKERS;
    if (Object.keys(s.env).length === 0) delete s.env;
  }
}

const statusLine = { type: 'command', command: q(node) + ' ' + q(dojo + '/statusline.js'), refreshInterval: 30 };
if (slAction === 'replace') s.statusLine = statusLine;
else if (slAction === 'set' && (!s.statusLine || isDojo(s.statusLine, RE.statusline))) s.statusLine = statusLine;

const after = JSON.stringify(s, null, 2) + '\n';
if (before !== null && after === before) { console.log('RESULT:unchanged'); process.exit(0); }
if (before !== null) {
  const bak = file + '.bak-' + stamp;
  fs.copyFileSync(file, bak);
  console.log('BACKUP:' + bak);
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, after);
console.log('RESULT:' + (before === null ? 'created' : 'updated'));
JS
}
MERGE_OUT="$(merge_settings)" || die "fusion de $SETTINGS impossible : fichier laissé tel quel."
case "$MERGE_OUT" in
  *RESULT:unchanged*) info "déjà à jour : aucune modification, aucune sauvegarde" ;;
  *RESULT:created*) info "créé avec les hooks Dojo" ;;
  *RESULT:updated*) info "mis à jour (ajouts Dojo uniquement)" ;;
esac
case "$MERGE_OUT" in
  *BACKUP:*) info "sauvegarde : $(printf '%s\n' "$MERGE_OUT" | sed -n 's/^BACKUP://p')" ;;
esac
case "$SL_ACTION" in
  replace) info "statusline : remplacée par celle de Dojo" ;;
  set) info "statusline : Dojo" ;;
  keep) info "statusline existante conservée (pour la remplacer : DOJO_STATUSLINE=y ou réponse oui)" ;;
esac
case "$HEAVY" in
  on) info "heavy-gate : enregistré (VITEST_MAX_WORKERS=2 si absent)" ;;
  off) info "heavy-gate : non enregistré" ;;
  keep) info "heavy-gate : inchangé" ;;
esac

# ── 4. launchd ───────────────────────────────────────────────────────────
UIDN="$(id -u)"
if [ "$NO_LAUNCHD" = 0 ]; then
  say "LaunchAgents : migration puis (re)chargement"
  for p in "$LA"/*claude-dojo*.plist; do
    [ -e "$p" ] || continue
    name="$(basename "$p" .plist)"
    case "$name" in io.github.claude-dojo.*) continue ;; esac
    launchctl bootout "gui/$UIDN/$name" 2>/dev/null || true
    rm -f "$p"
    info "migration : ancien LaunchAgent $name déchargé et supprimé"
  done
  for label in "$LABEL_AGENT" "$LABEL_WALL"; do
    launchctl bootout "gui/$UIDN/$label" 2>/dev/null || true
    i=0
    # bootout est asynchrone : on attend le déchargement avant de recharger
    while [ "$i" -lt 10 ] && launchctl print "gui/$UIDN/$label" >/dev/null 2>&1; do sleep 0.5; i=$((i + 1)); done
    if launchctl bootstrap "gui/$UIDN" "$LA/$label.plist" 2>/dev/null; then
      info "$label : chargé"
    else
      warn "$label : chargement impossible. Essaie : launchctl bootstrap gui/$UIDN $LA/$label.plist"
    fi
  done
else
  say "LaunchAgents : écrits mais ni chargés ni déchargés (--no-launchd)"
  for p in "$LA"/*claude-dojo*.plist; do
    [ -e "$p" ] || continue
    name="$(basename "$p" .plist)"
    case "$name" in io.github.claude-dojo.*) continue ;; esac
    warn "ancien LaunchAgent $name laissé en place (--no-launchd). Relance sans --no-launchd pour le retirer."
  done
fi

# ── 5. Récapitulatif ─────────────────────────────────────────────────────
say "Claude Dojo est installé"
info "Dossier         : $DOJO (config.json, cache/, agent et wallpaper)"
info "Fond d'écran    : $APP (macOS $MIN minimum)"
if [ "$NO_LAUNCHD" = 0 ]; then
  info "Agents          : agent-mac sur http://localhost:7777 et fond d'écran, démarrent à l'ouverture de session"
else
  info "Agents          : non chargés (--no-launchd), à charger ensuite avec install.sh sans cette option"
fi
info "Claude Code     : 6 hooks Dojo dans $SETTINGS"
info "Autorisation    : au premier clic sur un ninja, macOS demande l'accès « Automatisation » : autorise DojoWallpaper"
info "                  (Réglages Système > Confidentialité et sécurité > Automatisation)"
info "Menu            : icône Dojo dans la barre des menus (mode interactif, recharger, quitter)"
info "Réglages        : modifie $DOJO/config.json (rechargé à chaud), puis relance install.sh si besoin"
info "Désinstallation : ./uninstall.sh (depuis le dépôt)"
info "Le dossier du dépôt peut être supprimé : aucun chemin vers lui n'a été enregistré."
