#!/usr/bin/env bash
# Claude Dojo : désinstallation (LaunchAgents, app, entrées dojo de settings.json).
# Mince wrapper : les questions restent ici, toute la logique est dans src/setup.js.
# Ne retire que ce que install.sh a ajouté. Usage : ./uninstall.sh [--yes] [--no-launchd] [--purge]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SETUP="$SCRIPT_DIR/src/setup.js"
DOJO="$HOME/.config/claude-dojo"
APP="$HOME/Applications/DojoWallpaper.app"
SETTINGS="$HOME/.claude/settings.json"
STATE_DIR="$HOME/.claude/dojo"
export DOJO_DETECT_NO_GH_AUTH=1

NODE=""

say()  { printf '==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'Attention : %s\n' "$*" >&2; }
die()  { printf 'Erreur : %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'TXT'
Usage : uninstall.sh [--yes|-y] [--no-launchd] [--purge] [--help]

Désinstalle Claude Dojo : LaunchAgents, DojoWallpaper.app et entrées dojo de settings.json.
Les autres hooks, réglages et plugins ne sont jamais modifiés.

  --yes, -y      sans question : garde config.json et ~/.claude/dojo
  --no-launchd   ne touche pas à launchd (ni déchargement, ni suppression des plists)
  --purge        supprime ~/.config/claude-dojo (config.json et cache) sans demander
  --help         affiche cette aide
TXT
}

# ── Options ──────────────────────────────────────────────────────────────
YES=0
NO_LAUNCHD=0
PURGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) YES=1 ;;
    --no-launchd) NO_LAUNCHD=1 ;;
    --purge) PURGE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Option inconnue : %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

INTERACTIVE=0
if [ "$YES" = 0 ] && { : </dev/tty; } 2>/dev/null; then INTERACTIVE=1; fi

# Question oui/non : code retour 0 = oui. $2 = défaut (y|n). Sans terminal ou avec --yes : défaut.
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

node_ok() {
  [ -n "${1:-}" ] && [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1
}

# Seul moyen de lancer setup.js : trouver un node 18+ (mêmes emplacements que install.sh).
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

bool() { if [ "$1" = 1 ]; then printf true; else printf false; fi; }

# Lance setup.js, renvoie sa réponse JSON. Erreur : arrête avec le message de setup.js.
setup() {
  local out err
  if ! out="$("$NODE" "$SETUP" "$@")"; then
    err="$(json_field "$out" 'd.error' 2>/dev/null || true)"
    die "${err:-setup.js a échoué ($1)}"
  fi
  printf '%s' "$out"
}

[ "$(uname -s)" = Darwin ] || die "Claude Dojo ne s'installe que sur macOS, rien à désinstaller ici."

if [ "$YES" = 0 ] && [ "$INTERACTIVE" = 1 ]; then
  if ! ask_yn "Désinstaller Claude Dojo ?" n; then
    say "Annulé, rien n'a été modifié."
    exit 0
  fi
fi

NODE_BIN="$(find_node || true)"
if [ -z "$NODE_BIN" ]; then
  die "Node.js 18 ou plus est introuvable : setup.js ne peut pas tourner. Installe node (brew install node), puis relance."
fi
NODE="$(cd "$(dirname "$NODE_BIN")" && pwd -P)/$(basename "$NODE_BIN")"

# Questions : config.json (si présent, sans --purge) et états de session
DROP_CFG=$PURGE
if [ -d "$DOJO" ] && [ "$PURGE" = 0 ]; then
  if ask_yn "Supprimer $DOJO (config.json avec tes réglages, cache) ?" n; then DROP_CFG=1; fi
fi
DROP_STATES=0
if [ -d "$STATE_DIR" ]; then
  if ask_yn "Supprimer les états de session $STATE_DIR (utilisés par le fond d'écran) ?" n; then DROP_STATES=1; fi
fi

# ── Désinstallation (setup.js : LaunchAgents, app, settings.json, config, états) ──
OUT="$(setup uninstall "$(kv_json noLaunchd="$(bool "$NO_LAUNCHD")" purge="$(bool "$DROP_CFG")" states="$(bool "$DROP_STATES")")")"

say "LaunchAgents"
if [ "$NO_LAUNCHD" = 1 ]; then
  info "--no-launchd : launchd n'est pas touché (les plists restent en place)."
else
  while IFS= read -r name; do
    [ -n "$name" ] && info "déchargé et supprimé : $name"
  done <<EOF
$(json_field "$OUT" 'd.launchAgents.removed.join("\n")')
EOF
fi

say "Application"
REMOVED_APPS="$(json_field "$OUT" 'd.appRemoved.join("\n")')"
if [ -n "$REMOVED_APPS" ]; then
  while IFS= read -r p; do
    [ -n "$p" ] && info "supprimée : $p"
  done <<EOF
$REMOVED_APPS
EOF
else
  info "absente : $APP"
fi
REMAINING_APP="$(json_field "$OUT" 'd.appRemaining')"
if [ -n "$REMAINING_APP" ]; then
  warn "DojoWallpaper.app non retiré (dossier non inscriptible) : $REMAINING_APP. Glisse-le dans la Corbeille."
fi

say "Claude Code : settings.json"
if [ "$(json_field "$OUT" 'd.settings.error' 2>/dev/null || true)" != "" ]; then
  warn "settings.json illisible ou invalide : laissé tel quel."
elif [ ! -f "$SETTINGS" ]; then
  info "absent : rien à retirer"
elif [ "$(json_field "$OUT" 'd.settings.changed')" = true ]; then
  info "entrées dojo retirées (hooks, statusline, heavy-gate si présent)"
  BACKUP="$(json_field "$OUT" 'd.settings.backup' 2>/dev/null || true)"
  [ -z "$BACKUP" ] || info "sauvegarde : $BACKUP"
else
  info "aucune entrée dojo : fichier inchangé, aucune sauvegarde"
fi

say "Configuration"
if [ "$(json_field "$OUT" 'd.config.existed')" = true ]; then
  if [ "$DROP_CFG" = 1 ]; then info "supprimée : $DOJO"; else info "conservée : $DOJO (relance avec --purge pour la supprimer)"; fi
else
  info "absente : $DOJO"
fi
if [ -d "$STATE_DIR" ]; then
  if [ "$DROP_STATES" = 1 ]; then info "supprimés : $STATE_DIR"; else info "conservés : $STATE_DIR"; fi
fi

say "Claude Dojo est désinstallé"
info "Rien d'autre n'a été modifié : hooks, réglages, modèles et plugins de Claude Code sont intacts."
