#!/usr/bin/env bash
# Claude Dojo : installation macOS (fond d'écran animé, hooks et statusline de Claude Code).
# Mince wrapper : les questions restent ici, toute la logique est dans src/setup.js.
# Idempotent : relançable sans erreur ni doublon. Désinstallation : uninstall.sh.
# Usage : ./install.sh [--yes] [--no-launchd] [--help]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SETUP="$SCRIPT_DIR/src/setup.js"
BUILD_SCRIPT="$SCRIPT_DIR/scripts/build-app.sh"
DOJO="$HOME/.config/claude-dojo"
APP="$HOME/Applications/DojoWallpaper.app"
SETTINGS="$HOME/.claude/settings.json"
# Pas de sondage du trousseau gh pendant l'installation (inutile ici).
export DOJO_DETECT_NO_GH_AUTH=1

# Valeurs décidées pendant les questions
NODE=""
WEATHER_NAME=""
WEATHER_LAT=""
WEATHER_LON=""
TZ_NAME=""
OWNERS=""
ROOTS=""
CALS=""
SL_ACTION="keep"
HEAVY="keep"
BREW_DO=0
MISSING=""

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

# Seul moyen de lancer setup.js : trouver un node 18+ avant toute chose.
# Ensuite, setup.js (detect) reste la référence pour le reste.
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

# Champ d'une réponse JSON de setup.js : json_field <json> <expression sur d> (vide si null ou absent).
json_field() {
  printf '%s' "$1" | "$NODE" -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=($2);process.stdout.write(v==null?'':(typeof v==='object'?JSON.stringify(v):String(v)))"
}

# Options JSON à partir de paires clé=valeur (true et false reconnus, le reste en texte).
kv_json() {
  "$NODE" -e 'const o={};for(const a of process.argv.slice(1)){const i=a.indexOf("=");const k=a.slice(0,i);const v=a.slice(i+1);o[k]=v==="true"?true:v==="false"?false:v;}process.stdout.write(JSON.stringify(o))' "$@"
}

# Lance setup.js, renvoie sa réponse JSON. Erreur : arrête avec le message de setup.js.
setup() {
  local out err
  if ! out="$("$NODE" "$SETUP" "$@")"; then
    err="$(json_field "$out" 'd.error' 2>/dev/null || true)"
    die "${err:-setup.js a échoué ($1)}"
  fi
  printf '%s' "$out"
}

# Config à partir des réponses : URL d'agenda invalides ignorées (comme avant), ~ développé par setup.js.
config_json() {
  "$NODE" -e '
const [name, lat, lon, tz, owners, roots, cals] = process.argv.slice(1);
const csv = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);
const urls = csv(cals);
const valid = urls.filter((u) => /^(https?|webcal):\/\//i.test(u));
if (valid.length !== urls.length) console.error("Attention : entrée(s) d agenda ignorée(s), attendu une URL https ou webcal.");
const cfg = {};
if (lat && lon) cfg.weather = { name, lat: Number(lat), lon: Number(lon), timezone: tz || "UTC" };
cfg.calendars = valid;
cfg.github = { owners: csv(owners) };
cfg.projects = { roots: csv(roots), onlyOwners: false };
process.stdout.write(JSON.stringify(cfg));
' "$WEATHER_NAME" "$WEATHER_LAT" "$WEATHER_LON" "$TZ_NAME" "$OWNERS" "$ROOTS" "$CALS"
}

# ── 1. Pré-requis ────────────────────────────────────────────────────────
say "Vérifications"
[ "$(uname -s)" = Darwin ] || die "Claude Dojo ne s'installe que sur macOS."
[ -f "$SETUP" ] || die "src/setup.js introuvable à côté de install.sh ($SETUP)."
[ -x "$BUILD_SCRIPT" ] || die "scripts/build-app.sh introuvable ou non exécutable ($BUILD_SCRIPT)."
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

DETECT="$(setup detect)"
SETTINGS_ERR="$(json_field "$DETECT" 'd.settings.error' 2>/dev/null || true)"
[ -z "$SETTINGS_ERR" ] || die "$SETTINGS est illisible ou invalide : corrige-le (ou déplace-le), puis relance."

# statusline : aucune (none), dojo, ou autre (other)
SL_CMD="$(json_field "$DETECT" 'd.settings.statusLine ? [d.settings.statusLine.command].concat(Array.isArray(d.settings.statusLine.args) ? d.settings.statusLine.args : []).join(" ") : ""')"
case "$SL_CMD" in
  "") SL_STATE=none ;;
  *claude-dojo/statusline.js*) SL_STATE=dojo ;;
  *) SL_STATE=other ;;
esac
HEAVY_NOW=0
[ "$(json_field "$DETECT" 'd.settings.heavyGateDojo')" = true ] && HEAVY_NOW=1
HEAVY_PERSO=0
[ "$(json_field "$DETECT" 'd.settings.heavyGatePerso')" = true ] && HEAVY_PERSO=1
CFG_EXISTS=0
[ "$(json_field "$DETECT" 'd.install.configExists')" = true ] && CFG_EXISTS=1

# ── 2. Questions ─────────────────────────────────────────────────────────
say "Configuration"
if [ "$CFG_EXISTS" = 1 ]; then
  info "config.json existant conservé ($DOJO/config.json) : modifie-le pour la météo, l'agenda ou GitHub."
else
  city=""
  if is_set DOJO_CITY; then city="$(env_val DOJO_CITY)"; else city="$(ask_text 'Ville pour la météo (vide = pas de météo)' '')"; fi
  if [ -n "$city" ]; then
    lat=""; lon=""
    if is_set DOJO_LAT && is_set DOJO_LON; then
      lat="$(env_val DOJO_LAT)"; lon="$(env_val DOJO_LON)"; WEATHER_NAME="$city"
    else
      geo="$("$NODE" "$SETUP" geocode "$city" 2>/dev/null || true)"
      glat="$(json_field "$geo" 'd.results && d.results[0] ? d.results[0].lat : ""' 2>/dev/null || true)"
      if [ -n "$glat" ]; then
        lat="$glat"
        lon="$(json_field "$geo" 'd.results[0].lon' 2>/dev/null || true)"
        WEATHER_NAME="$(json_field "$geo" 'd.results[0].name' 2>/dev/null || true)"
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
if [ "$HEAVY" = on ] && [ "$HEAVY_PERSO" = 1 ] && [ "$HEAVY_NOW" = 0 ]; then
  warn "un autre heavy-gate est déjà enregistré dans $SETTINGS : les deux se cumuleraient."
fi

# statusline : aucune → installée ; dojo → mise à jour ; autre → remplacée seulement sur demande
if [ "$SL_STATE" = other ]; then
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

# dépendances optionnelles (macmon, media-control) selon setup.js detect
[ -n "$(json_field "$DETECT" 'd.macmon && d.macmon.path')" ] || MISSING="macmon"
[ -n "$(json_field "$DETECT" 'd.mediaControl && d.mediaControl.path')" ] || MISSING="$MISSING media-control"
MISSING="${MISSING# }"
BREW_PATH="$(json_field "$DETECT" 'd.brew && d.brew.path')"
GH_PATH="$(json_field "$DETECT" 'd.gh && d.gh.path')"
if [ -n "$BREW_PATH" ]; then
  if [ -n "$MISSING" ]; then
    choice=ask
    if is_set DOJO_BREW; then choice="$(yn_from_env DOJO_BREW)"; fi
    if [ "$choice" = y ] || { [ "$choice" = ask ] && ask_yn "Installer avec brew ($MISSING) : capteurs et musique du Dojo ?" n; }; then BREW_DO=1; fi
  fi
  [ -n "$GH_PATH" ] || info "gh absent (optionnel, sert aux dépôts GitHub) : brew install gh"
else
  if [ -n "$MISSING" ]; then info "brew absent : installe $MISSING à la main pour les capteurs et la musique (optionnel)."; fi
  [ -n "$GH_PATH" ] || info "gh absent (optionnel) : https://cli.github.com"
fi

# ── 3. Installation ──────────────────────────────────────────────────────
say "Fichiers dans $DOJO"
setup install-files "$SCRIPT_DIR/src" >/dev/null

if [ "$BREW_DO" = 1 ]; then
  say "brew install $MISSING"
  # shellcheck disable=SC2086 # la liste de paquets est volontairement découpée
  if ! "$BREW_PATH" install $MISSING; then warn "brew install a échoué : capteurs et musique indisponibles."; fi
fi

if [ "$CFG_EXISTS" = 0 ]; then
  say "config.json"
  setup write-config "$(config_json)" >/dev/null
  info "créé : $DOJO/config.json (droits 0600, il peut contenir une URL privée)"
fi

say "Dépendances npm (node-ical)"
setup npm-install "$NODE" >/dev/null

say "DojoWallpaper.app (scripts/build-app.sh, sans DMG)"
BUILD_TMP="$(mktemp -d)"
trap 'rm -rf "$BUILD_TMP"' EXIT
BUILD_LOG="$DOJO/cache/build-app.log"
mkdir -p "$DOJO/cache"
VERSION="$(json_field "$(cat "$SCRIPT_DIR/src/package.json")" 'd.version')"
if ! BUILD_DIR="$BUILD_TMP/build" "$BUILD_SCRIPT" --version "$VERSION" --out "$BUILD_TMP/out" --no-dmg >"$BUILD_LOG" 2>&1; then
  tail -n 15 "$BUILD_LOG" >&2 || true
  die "compilation impossible (journal complet : $BUILD_LOG)"
fi
rm -f "$BUILD_LOG"
rm -rf "$APP"
mkdir -p "$HOME/Applications"
ditto "$BUILD_TMP/out/DojoWallpaper.app" "$APP"
MIN="$(plutil -extract LSMinimumSystemVersion raw -o - "$APP/Contents/Info.plist" 2>/dev/null || printf '?')"
info "compilée pour $(uname -m), macOS $MIN minimum : $APP"

# Les plists sont écrits avant la fusion des réglages, chargés après (comme avant).
say "LaunchAgents (écriture)"
WRITE_JSON="$(setup launchagents install "$(kv_json node="$NODE" app="$APP" noLaunchd=true)")"
while IFS= read -r p; do
  [ -n "$p" ] && info "$p"
done <<EOF
$(json_field "$WRITE_JSON" 'd.written.join("\n")')
EOF
while IFS= read -r w; do
  [ -n "$w" ] && warn "$w"
done <<EOF
$(json_field "$WRITE_JSON" 'd.warnings.join("\n")')
EOF

say "Hooks et statusline dans $SETTINGS"
merge_opts=(node="$NODE" statusLine="$SL_ACTION")
case "$HEAVY" in
  on) merge_opts+=(heavyGate=true) ;;
  off) merge_opts+=(heavyGate=false) ;;
esac
MERGE="$(setup merge-settings "$(kv_json "${merge_opts[@]}")")"
if [ "$(json_field "$MERGE" 'd.changed')" = false ]; then
  info "déjà à jour : aucune modification, aucune sauvegarde"
elif [ "$(json_field "$MERGE" 'd.before === null')" = true ]; then
  info "créé avec les hooks Dojo"
else
  info "mis à jour (ajouts Dojo uniquement)"
fi
BACKUP="$(json_field "$MERGE" 'd.backup' 2>/dev/null || true)"
[ -z "$BACKUP" ] || info "sauvegarde : $BACKUP"
case "$SL_ACTION" in
  replace) info "statusline : remplacée par celle de Dojo" ;;
  keep)
    if [ "$SL_STATE" = other ]; then info "statusline existante conservée (pour la remplacer : DOJO_STATUSLINE=y ou réponse oui)"
    else info "statusline : Dojo"; fi ;;
esac
case "$HEAVY" in
  on) info "heavy-gate : enregistré (VITEST_MAX_WORKERS=2 si absent)" ;;
  off) info "heavy-gate : non enregistré" ;;
  keep) info "heavy-gate : inchangé" ;;
esac

# ── 4. launchd ───────────────────────────────────────────────────────────
if [ "$NO_LAUNCHD" = 0 ]; then
  say "LaunchAgents : migration puis (re)chargement"
  LOAD="$(setup launchagents install "$(kv_json node="$NODE" app="$APP")")"
  while IFS= read -r n; do
    [ -n "$n" ] && info "migration : ancien LaunchAgent $n déchargé et supprimé"
  done <<EOF
$(json_field "$LOAD" 'd.migrated.join("\n")')
EOF
  while IFS= read -r l; do
    [ -n "$l" ] && info "$l : chargé"
  done <<EOF
$(json_field "$LOAD" 'd.loaded.join("\n")')
EOF
  while IFS= read -r w; do
    [ -n "$w" ] && warn "$w"
  done <<EOF
$(json_field "$LOAD" 'd.warnings.join("\n")')
EOF
else
  say "LaunchAgents : écrits mais ni chargés ni déchargés (--no-launchd)"
  while IFS= read -r w; do
    [ -n "$w" ] && warn "$w"
  done <<EOF
$(json_field "$WRITE_JSON" 'd.warnings.join("\n")')
EOF
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
