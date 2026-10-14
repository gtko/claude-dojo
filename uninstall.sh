#!/usr/bin/env bash
# Claude Dojo : désinstallation (LaunchAgents, app, entrées dojo de settings.json).
# Ne retire que ce que install.sh a ajouté. Usage : ./uninstall.sh [--yes] [--no-launchd] [--purge]
set -euo pipefail

DOJO="$HOME/.config/claude-dojo"
APP="$HOME/Applications/DojoWallpaper.app"
LA="$HOME/Library/LaunchAgents"
CLAUDE_DIR="$HOME/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"
STATE_DIR="$CLAUDE_DIR/dojo"
STAMP="$(date +%Y%m%d-%H%M%S)"

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

# Node 18+ : mêmes emplacements que install.sh (PATH, Homebrew, volta, fnm, nvm).
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

[ "$(uname -s)" = Darwin ] || die "Claude Dojo ne s'installe que sur macOS, rien à désinstaller ici."

if [ "$YES" = 0 ] && [ "$INTERACTIVE" = 1 ]; then
  if ! ask_yn "Désinstaller Claude Dojo ?" n; then
    say "Annulé, rien n'a été modifié."
    exit 0
  fi
fi

# ── 1. LaunchAgents ──────────────────────────────────────────────────────
say "LaunchAgents"
UIDN="$(id -u)"
if [ "$NO_LAUNCHD" = 1 ]; then
  info "--no-launchd : launchd n'est pas touché (les plists restent en place)."
else
  for label in io.github.claude-dojo.agent io.github.claude-dojo.wallpaper; do
    launchctl bootout "gui/$UIDN/$label" 2>/dev/null || true
  done
  # Labels actuels et anciens (com.<auteur>.claude-dojo.*) uniquement : pas de glob *claude-dojo*.
  for p in "$LA/io.github.claude-dojo.agent.plist" "$LA/io.github.claude-dojo.wallpaper.plist" "$LA"/com.*.claude-dojo.agent.plist "$LA"/com.*.claude-dojo.wallpaper.plist; do
    [ -e "$p" ] || continue
    name="$(basename "$p" .plist)"
    launchctl bootout "gui/$UIDN/$name" 2>/dev/null || true
    rm -f "$p"
    info "déchargé et supprimé : $name"
  done
fi

# ── 2. Application ───────────────────────────────────────────────────────
say "Application"
if [ -e "$APP" ]; then
  rm -rf "${APP:?}"
  info "supprimée : $APP"
else
  info "absente : $APP"
fi

# ── 3. settings.json (entrées dojo uniquement) ───────────────────────────
say "Claude Code : settings.json"
NODE_BIN="$(find_node || true)"
if [ -z "$NODE_BIN" ]; then
  warn "node introuvable : settings.json non modifié. Retire à la main les entrées claude-dojo, ou relance avec node installé."
elif [ ! -f "$SETTINGS" ]; then
  info "absent : rien à retirer"
else
  NODE="$(cd "$(dirname "$NODE_BIN")" && pwd -P)/$(basename "$NODE_BIN")"
  clean_settings() {
    "$NODE" - "$SETTINGS" "$STAMP" <<'JS'
const fs = require('fs');
const path = require('path');
const [file, stamp] = process.argv.slice(2);
const RE = {
  hook: /claude-dojo\/hook\.js/,
  heavy: /claude-dojo\/heavy-gate\.js/,
  statusline: /claude-dojo\/statusline\.js/,
};
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const cmdOf = (h) => [h.command, ...(Array.isArray(h.args) ? h.args : [])].join(' ');
const isDojo = (h, re) => isObj(h) && re.test(cmdOf(h));

let before;
let s;
try {
  before = fs.readFileSync(file, 'utf8');
  s = before.trim() === '' ? {} : JSON.parse(before);
} catch (e) {
  console.error(file + ' : JSON invalide (' + e.message + ')');
  process.exit(2);
}
if (!isObj(s)) { console.error(file + ' : un objet JSON est attendu'); process.exit(2); }

let touched = false;
let heavyRemoved = false;
if (isObj(s.hooks)) {
  for (const ev of Object.keys(s.hooks)) {
    const list = s.hooks[ev];
    if (!Array.isArray(list)) continue;
    let evTouched = false;
    const out = [];
    for (const g of list) {
      if (!isObj(g) || !Array.isArray(g.hooks)) { out.push(g); continue; }
      const kept = g.hooks.filter((h) => {
        if (isDojo(h, RE.heavy)) { heavyRemoved = true; return false; }
        return !isDojo(h, RE.hook);
      });
      if (kept.length === g.hooks.length) { out.push(g); continue; }
      evTouched = true;
      if (kept.length) out.push({ ...g, hooks: kept });
    }
    if (evTouched) {
      touched = true;
      if (out.length) s.hooks[ev] = out; else delete s.hooks[ev];
    }
  }
  if (touched && Object.keys(s.hooks).length === 0) delete s.hooks;
}
if (isDojo(s.statusLine, RE.statusline)) { delete s.statusLine; touched = true; }
// VITEST_MAX_WORKERS n'est retiré que s'il vaut "2" et que heavy-gate dojo vient d'être retiré
if (heavyRemoved && isObj(s.env) && s.env.VITEST_MAX_WORKERS === '2') {
  delete s.env.VITEST_MAX_WORKERS;
  touched = true;
  if (Object.keys(s.env).length === 0) delete s.env;
}

if (!touched) { console.log('RESULT:unchanged'); process.exit(0); }
const bak = file + '.bak-' + stamp;
fs.copyFileSync(file, bak);
console.log('BACKUP:' + bak);
fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
console.log('RESULT:updated');
JS
  }
  if OUT="$(clean_settings)"; then
    case "$OUT" in
      *RESULT:updated*) info "entrées dojo retirées (hooks, statusline, heavy-gate si présent)" ;;
      *) info "aucune entrée dojo : fichier inchangé, aucune sauvegarde" ;;
    esac
    case "$OUT" in
      *BACKUP:*) info "sauvegarde : $(printf '%s\n' "$OUT" | sed -n 's/^BACKUP://p')" ;;
    esac
  else
    warn "settings.json illisible ou invalide : laissé tel quel."
  fi
fi

# ── 4. Configuration et états ────────────────────────────────────────────
say "Configuration"
if [ -d "$DOJO" ]; then
  if [ "$PURGE" = 1 ]; then
    rm -rf "${DOJO:?}"
    info "supprimée (--purge) : $DOJO"
  elif ask_yn "Supprimer $DOJO (config.json avec tes réglages, cache) ?" n; then
    rm -rf "${DOJO:?}"
    info "supprimée : $DOJO"
  else
    info "conservée : $DOJO (relance avec --purge pour la supprimer)"
  fi
else
  info "absente : $DOJO"
fi

if [ -d "$STATE_DIR" ]; then
  if ask_yn "Supprimer les états de session $STATE_DIR (utilisés par le fond d'écran) ?" n; then
    rm -rf "${STATE_DIR:?}"
    info "supprimés : $STATE_DIR"
  else
    info "conservés : $STATE_DIR"
  fi
fi

say "Claude Dojo est désinstallé"
info "Rien d'autre n'a été modifié : hooks, réglages, modèles et plugins de Claude Code sont intacts."
