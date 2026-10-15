#!/usr/bin/env node
// Claude Dojo : logique d'installation et de désinstallation (le gros de install.sh et uninstall.sh).
// Usage : node setup.js <commande> [argument]
//   argument : JSON en ligne de commande, ou « - » pour lire le JSON sur stdin.
// Sortie : une ligne JSON sur stdout. Succès : exit 0 {"ok":true,...}. Erreur : exit 1 {"ok":false,"error":"..."}.
// Node >= 18, aucune dépendance. Le HOME est relu à chaque appel (process.env.HOME, sinon os.homedir()).
// Sous Windows (win32) : USERPROFILE (sinon os.homedir()) ; HOME est ignoré (Git Bash l'exporte sous forme /c/Users/...).
// Démarrage Windows : clé HKCU\...\Run + lanceur VBScript sans fenêtre (voir « Windows » plus bas).
// Tous les processus externes sont lancés avec execFile et un tableau d'arguments (jamais de shell).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');

const WIN = process.platform === 'win32';
const LABEL_AGENT = 'io.github.claude-dojo.agent';
const LABEL_WALL = 'io.github.claude-dojo.wallpaper';
const LEGACY_RE = /^com\.[^.]+\.claude-dojo\.(agent|wallpaper)$/;
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd'];
// Séparateur « / » ou « \ » : les commandes de hooks sous Windows contiennent des antislashes.
const RE = {
  hook: /claude-dojo[\\/]hook\.js/,
  heavy: /claude-dojo[\\/]heavy-gate\.js/,
  statusline: /claude-dojo[\\/]statusline\.js/,
};
const RE_ANY_HEAVY = /heavy-gate\.js/;
const AGENT_PORT = 7777;
// Thèmes : un dossier par thème (themes/<id>/). Fonds personnalisés : copiés dans backgrounds/.
const THEME_ID_RE = /^[a-z0-9-]+$/;
const DEFAULT_THEME = 'naruto';
const BG_EXT = ['.jpg', '.jpeg', '.png', '.heic', '.webp'];
const BG_MAX_BYTES = 50 * 1024 * 1024;
// Options terminal (config.json, clé terminal) : Ghostty, Terminal.app, zsh (welcome).
const TERM_KEYS = ['ghostty', 'terminalApp', 'welcome'];
// src/terminal/ (welcome.zsh) est copié sous ce nom dans la config : « terminal/ » y désigne les fichiers générés.
const TERM_SRC_INSTALLED = 'terminal-src';
// Windows : valeurs HKCU\...\Run gérées par setup.js, valeur écrite par le réglage « démarrer avec Windows » de l'exe,
// et exe du fond d'écran (windows/bin/, téléchargé ou compilé).
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_AGENT = 'ClaudeDojoAgent';
const RUN_WALL = 'ClaudeDojoWallpaper';
const RUN_WALL_TOGGLE = 'DojoWallpaper';
const WIN_EXE = 'DojoWallpaper.exe';
const WIN_LAUNCHER = 'start-agent.vbs';
const WIN_ZIP = 'DojoWallpaper-windows-x64.zip';
const RELEASE_URL = 'https://github.com/gtko/claude-dojo/releases/download';
const DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

class SetupError extends Error {}
const fail = (msg) => { throw new SetupError(msg); };

// ── Chemins (HOME relu à chaque appel) ───────────────────────────────────
// Sous Windows, USERPROFILE prime sur HOME (comme install.ps1 et uninstall.ps1 l'annoncent) : Git Bash exporte HOME
// sous forme /c/Users/..., et un HOME Windows ne doit pas écarter le profil. os.homedir() relit USERPROFILE aussi.
const home = () => {
  if (WIN) return process.env.USERPROFILE || os.homedir();
  return process.env.HOME || os.homedir();
};
// Dossiers où DojoWallpaper.app peut être installé : ~/Applications (install.sh), puis /Applications (DMG).
// DOJO_APPS_DIRS (liste séparée par « : ») les remplace : les tests l'utilisent pour ne rien toucher hors du HOME temporaire.
const APP_NAME = 'DojoWallpaper.app';
const appDirs = () => {
  const fromEnv = (process.env.DOJO_APPS_DIRS || '').split(path.delimiter).filter(Boolean);
  return fromEnv.length ? fromEnv : [path.join(home(), 'Applications'), '/Applications'];
};
const paths = {
  dojo: () => path.join(home(), '.config', 'claude-dojo'),
  settings: () => path.join(home(), '.claude', 'settings.json'),
  stateDir: () => path.join(home(), '.claude', 'dojo'),
  launchAgents: () => path.join(home(), 'Library', 'LaunchAgents'),
  app: () => path.join(appDirs()[0], APP_NAME),
  // Windows : exe du fond d'écran et lanceur VBScript de l'agent, dans le dossier d'installation.
  exeDir: () => path.join(paths.dojo(), 'windows', 'bin'),
  exe: () => path.join(paths.exeDir(), WIN_EXE),
  launcher: () => path.join(paths.dojo(), WIN_LAUNCHER),
  backgrounds: () => path.join(paths.dojo(), 'backgrounds'),
  // DOJO_THEMES_DIR ne sert qu'aux tests (dossier de thèmes factice) ; sinon ceux du runtime.
  themes: () => path.join(process.env.DOJO_THEMES_DIR || __dirname, 'themes'),
  // Fichiers générés des options terminal (theme/, ghostty.conf, welcome.zsh).
  terminal: () => path.join(paths.dojo(), 'terminal'),
  // Source de welcome.zsh : copie installée (terminal-src/, voir installFiles) si elle existe, sinon terminal/ à côté
  // de setup.js (dépôt, app). Jamais le dossier généré. DOJO_TERMINAL_DIR ne sert qu'aux tests.
  terminalSrc: () => {
    if (process.env.DOJO_TERMINAL_DIR) return process.env.DOJO_TERMINAL_DIR;
    const installed = path.join(__dirname, TERM_SRC_INSTALLED);
    return fs.existsSync(installed) ? installed : path.join(__dirname, 'terminal');
  },
};

// ── Utilitaires ──────────────────────────────────────────────────────────
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cmdOf = (h) => [h.command, ...(Array.isArray(h.args) ? h.args : [])].join(' ');
const isDojo = (h, re) => isObj(h) && re.test(cmdOf(h));
// Argument pour un shell POSIX (Claude Code lance les commandes de hooks via sh -c) : guillemets doubles,
// avec \ " $ ` échappés. Pour un chemin ordinaire, le texte produit est celui d'avant (réglages déjà installés inchangés).
const q = (p) => '"' + String(p).replace(/["\\$`]/g, '\\$&') + '"';
// Même rôle pour une commande de hook sous Windows (cmd, PowerShell ou bash de Git) : guillemets doubles, antislashes
// intacts (q les doublerait). Un chemin avec " $ ` % est refusé : il serait interprété différemment selon le shell.
const cmdArg = (p, win = WIN) => {
  if (!win) return q(p);
  const s = String(p);
  if (/["$`%]/.test(s)) fail(`chemin refusé pour une commande de hook (caractère spécial) : ${s}`);
  return '"' + s + '"';
};
// Script du dossier d'installation, avec le séparateur de la plateforme (chemin Windows : antislashes).
const scriptPath = (dojo, name, win = WIN) => (win ? path.win32.join(dojo, name) : dojo + '/' + name);
const pad = (n) => String(n).padStart(2, '0');
const stampNow = () => {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};
const archName = () => (os.arch() === 'x64' ? 'x86_64' : os.arch());

function isExec(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch { return false; }
}
// Chemin canonique : dossier résolu (comme « pwd -P » dans install.sh), nom du binaire conservé.
function canonical(p) {
  try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return p; }
}
function pathDirs() {
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean);
}
// Sous Windows, les dossiers POSIX (Homebrew, /usr/bin) n'ont pas de sens : on les écarte.
const posixOnly = (d) => !WIN || !d.startsWith('/');
function searchDirs(extra = []) {
  return [...new Set([...pathDirs(), ...extra, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
    path.join(home(), '.local', 'bin')].filter(posixOnly))];
}
function findBin(name, extra = []) {
  // Sous Windows, un nom sans extension désigne un .exe (node -> node.exe).
  const file = WIN && !path.extname(name) ? name + '.exe' : name;
  for (const d of searchDirs(extra)) {
    const p = path.join(d, file);
    if (isExec(p)) return p;
  }
  return null;
}
const binInfo = (p) => (p ? { path: canonical(p) } : null);

// Lance un binaire sans shell. Ne lève jamais : renvoie { ok, code, stdout, stderr }.
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10000, maxBuffer: 4 << 20, ...opts }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Node 18+ ─────────────────────────────────────────────────────────────
// Version d'un binaire node (null si inutilisable).
function nodeVersion(bin) {
  try {
    return execFileSync(bin, ['-p', 'process.versions.node'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch { return null; }
}
const nodeMajorOk = (v) => !!v && Number(String(v).split('.')[0]) >= 18;

// Dossiers de versions (nvm, fnm) : les plus récents d'abord.
function versionedBins(base, rel, file = 'node') {
  let names = [];
  try { names = fs.readdirSync(base); } catch { return []; }
  const key = (s) => (s.match(/\d+/g) || []).map(Number);
  return names
    .map((n) => ({ n, k: key(n) }))
    .sort((a, b) => {
      for (let i = 0; i < Math.max(a.k.length, b.k.length); i++) {
        const d = (b.k[i] || 0) - (a.k[i] || 0);
        if (d) return d;
      }
      return 0;
    })
    .map(({ n }) => path.join(base, n, rel, file));
}

// Windows : node.exe dans PATH, Program Files, volta, nvm-windows (NVM_HOME, sinon %APPDATA%\nvm : un dossier par version).
function winNodeCandidates() {
  const h = home();
  const nvmHome = process.env.NVM_HOME || path.join(process.env.APPDATA || path.join(h, 'AppData', 'Roaming'), 'nvm');
  return [
    ...pathDirs().map((d) => path.join(d, 'node.exe')),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(h, '.volta', 'bin', 'node.exe'),
    ...versionedBins(nvmHome, '', 'node.exe'),
  ];
}

function nodeCandidates() {
  if (WIN) return winNodeCandidates();
  const h = home();
  const fixed = [
    ...pathDirs().map((d) => path.join(d, 'node')),
    path.join(paths.dojo(), 'node', 'bin', 'node'),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    path.join(h, '.volta', 'bin', 'node'),
    path.join(h, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'node'),
    path.join(h, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin', 'node'),
  ];
  const nvm = versionedBins(path.join(h, '.nvm', 'versions', 'node'), 'bin');
  const fnm1 = versionedBins(path.join(h, '.local', 'share', 'fnm', 'node-versions'), path.join('installation', 'bin'));
  const fnm2 = versionedBins(path.join(h, 'Library', 'Application Support', 'fnm', 'node-versions'), path.join('installation', 'bin'));
  return [...new Set([...fixed, ...nvm, ...fnm1, ...fnm2])];
}

// Premier node 18+ trouvé. Sinon le premier node présent (ok:false). Sinon null.
function findNode() {
  let firstPresent = null;
  for (const c of nodeCandidates()) {
    if (!isExec(c)) continue;
    const v = nodeVersion(c);
    if (!v) continue;
    const info = { path: canonical(c), version: v, ok: nodeMajorOk(v) };
    if (info.ok) return info;
    if (!firstPresent) firstPresent = info;
  }
  return firstPresent;
}

// ── detect ───────────────────────────────────────────────────────────────
function probeSettings() {
  const file = paths.settings();
  const out = { path: file, exists: fs.existsSync(file), statusLine: null, heavyGatePerso: false, heavyGateDojo: false, hooksDojo: false, error: null };
  if (!out.exists) return out;
  let s;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    s = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch (e) { out.error = `${file} : JSON invalide (${e.message})`; return out; }
  if (!isObj(s)) { out.error = `${file} : un objet JSON est attendu`; return out; }
  if (s.hooks !== undefined && !isObj(s.hooks)) { out.error = `${file} : 'hooks' doit être un objet`; return out; }
  if (s.env !== undefined && !isObj(s.env)) { out.error = `${file} : 'env' doit être un objet`; return out; }

  const sl = s.statusLine;
  if (isObj(sl)) out.statusLine = sl;
  else if (sl) out.statusLine = { command: String(sl) };

  const events = isObj(s.hooks) ? s.hooks : {};
  for (const [ev, groups] of Object.entries(events)) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of isObj(g) && Array.isArray(g.hooks) ? g.hooks : []) {
        if (RE.hook.test(cmdOf(h))) out.hooksDojo = true;
        if (ev === 'PreToolUse' && RE.heavy.test(cmdOf(h))) out.heavyGateDojo = true;
        else if (ev === 'PreToolUse' && RE_ANY_HEAVY.test(cmdOf(h))) out.heavyGatePerso = true;
      }
    }
  }
  return out;
}

function listLaunchAgentLabels(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => n.endsWith('.plist'))
    .map((n) => n.slice(0, -'.plist'.length))
    .filter((l) => l === LABEL_AGENT || l === LABEL_WALL || LEGACY_RE.test(l));
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(paths.dojo(), 'config.json'), 'utf8')); } catch { return null; }
}

// ── state.json : ce que Dojo a posé dans settings.json et doit donc retirer (dossier de config) ──
// Aujourd'hui : VITEST_MAX_WORKERS, avec la valeur que Dojo a écrite. Fichier absent ou illisible = rien n'est à Dojo.
const stateFile = () => path.join(paths.dojo(), 'state.json');
function readState() {
  try { const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); return isObj(s) ? s : {}; } catch { return {}; }
}
// Valeur de VITEST_MAX_WORKERS posée par Dojo, ou null si Dojo ne l'a pas posée.
function managedVitest() {
  const m = readState().managed;
  return isObj(m) && typeof m.vitestMaxWorkers === 'string' ? m.vitestMaxWorkers : null;
}
// key/value : propriété posée par Dojo dans state.managed ; value null = oubliée.
function setManaged(key, value) {
  const state = readState();
  const managed = isObj(state.managed) ? { ...state.managed } : {};
  if (value === null) delete managed[key]; else managed[key] = value;
  if (Object.keys(managed).length) state.managed = managed; else delete state.managed;
  const file = stateFile();
  if (Object.keys(state).length === 0) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}
// value : valeur posée par Dojo, ou null pour oublier la propriété.
function setManagedVitest(value) { setManaged('vitestMaxWorkers', value); }

async function detect() {
  const node = findNode();
  const gh = findBin('gh');
  let authed = false;
  // DOJO_DETECT_NO_GH_AUTH=1 : pas de sondage (tests, trousseau). Le jeton n'est jamais renvoyé.
  if (gh && process.env.DOJO_DETECT_NO_GH_AUTH !== '1') authed = (await run(gh, ['auth', 'token'], { timeout: 5000 })).ok;
  const dojo = paths.dojo();
  const labels = WIN ? [] : listLaunchAgentLabels(paths.launchAgents());
  return {
    ok: true,
    node: node ? { path: node.path, version: node.version, ok: node.ok } : { path: null, version: null, ok: false },
    brew: binInfo(findBin('brew', ['/opt/homebrew/bin', '/usr/local/bin'])),
    macmon: binInfo(findBin('macmon')),
    mediaControl: binInfo(findBin('media-control')),
    swiftc: binInfo(findBin('swiftc', ['/usr/bin'])),
    gh: gh ? { path: canonical(gh), authed } : { path: null, authed: false },
    claude: binInfo(findBin('claude')),
    settings: probeSettings(),
    install: {
      installed: fs.existsSync(path.join(dojo, WIN ? 'agent-win.js' : 'agent-mac.js')) || labels.length > 0,
      configDir: dojo,
      configExists: fs.existsSync(path.join(dojo, 'config.json')),
      launchAgents: labels,
      // Windows seulement : entrées HKCU\...\Run posées par setup.js (lecture seule).
      ...(WIN ? { autostart: autostartState() } : {}),
    },
    config: readConfig(),
    home: home(),
    arch: archName(),
    platform: process.platform,
  };
}

// ── settings.json : fusion douce (même logique que install.sh) ───────────
// Retire les entrées dojo d'une liste et insère « canonical » à la place de la première occurrence.
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

// Lit settings.json sans le modifier. before = texte brut (null si absent).
// norm = même contenu reformaté (2 espaces) : base du diff et de la détection de changement.
// Un fichier déjà à jour n'est donc jamais réécrit, même si sa mise en forme diffère.
function readSettingsFile(file) {
  if (!fs.existsSync(file)) return { before: null, norm: null, obj: {} };
  const before = fs.readFileSync(file, 'utf8');
  let obj;
  try { obj = before.trim() === '' ? {} : JSON.parse(before); } catch (e) { fail(`${file} : JSON invalide (${e.message})`); }
  if (!isObj(obj)) fail(`${file} : un objet JSON est attendu`);
  if (obj.hooks !== undefined && !isObj(obj.hooks)) fail(`${file} : 'hooks' doit être un objet`);
  if (obj.env !== undefined && !isObj(obj.env)) fail(`${file} : 'env' doit être un objet`);
  return { before, norm: JSON.stringify(obj, null, 2) + '\n', obj };
}

// Diff ligne à ligne (LCS) : « + » ajoutée, « - » retirée. Les réglages sont petits.
function lineDiff(a, b) {
  const split = (t) => (t === null ? [] : t.replace(/\n$/, '').split('\n'));
  const A = split(a), B = split(b);
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push('- ' + A[i]); i++; }
    else { out.push('+ ' + B[j]); j++; }
  }
  while (i < n) out.push('- ' + A[i++]);
  while (j < m) out.push('+ ' + B[j++]);
  return out.join('\n');
}

// Seuils heavy-gate calculés comme dans heavy-gate.js (indicatif pour l'aperçu).
function heavyThresholds() {
  const cores = os.cpus().length;
  const memGiB = Math.round(os.totalmem() / 2 ** 30);
  return {
    HEAVY_GATE_MAX: Math.max(2, Math.floor(cores / 3)),
    HEAVY_GATE_MAX_NODE: Math.max(2, memGiB * 2),
    cores,
    memGiB,
  };
}

// Transformation de l'objet settings (mutation sur place).
// o.win : plateforme des commandes (défaut : celle de ce processus). Sous Windows : antislashes, matcher PowerShell aussi.
function mergeTransform(s, o) {
  const { node, dojo } = o;
  const win = o.win === undefined ? WIN : o.win === true;
  const wantHooks = o.hooks !== false;
  const wantHeavy = o.heavyGate === true;
  if (wantHooks || wantHeavy) { if (!isObj(s.hooks)) s.hooks = {}; }

  if (wantHooks) {
    for (const ev of HOOK_EVENTS) {
      const list = Array.isArray(s.hooks[ev]) ? s.hooks[ev] : [];
      s.hooks[ev] = setDojoGroup(list, RE.hook, {
        hooks: [{ type: 'command', command: cmdArg(node, win) + ' ' + cmdArg(scriptPath(dojo, 'hook.js', win), win), async: true }],
      });
    }
  } else if (isObj(s.hooks)) {
    for (const ev of Object.keys(s.hooks)) {
      if (Array.isArray(s.hooks[ev])) s.hooks[ev] = setDojoGroup(s.hooks[ev], RE.hook, null);
    }
  }

  const vw = o.vitestWorkers !== undefined ? o.vitestWorkers : (wantHeavy ? true : undefined);
  const vwValue = vw === true ? '2' : (typeof vw === 'number' && vw > 0 ? String(Math.floor(vw)) : null);

  if (wantHeavy) {
    s.hooks.PreToolUse = setDojoGroup(Array.isArray(s.hooks.PreToolUse) ? s.hooks.PreToolUse : [], RE.heavy, {
      matcher: win ? 'Bash|PowerShell' : 'Bash',
      hooks: [{ type: 'command', command: cmdArg(node, win) + ' ' + cmdArg(scriptPath(dojo, 'heavy-gate.js', win), win), timeout: 10 }],
    });
  } else if (o.heavyGate === false) {
    if (isObj(s.hooks) && Array.isArray(s.hooks.PreToolUse)) s.hooks.PreToolUse = setDojoGroup(s.hooks.PreToolUse, RE.heavy, null);
    dropManagedVitest(s, o.managedVitest);
  }

  // VITEST_MAX_WORKERS n'est posé que s'il est absent : une valeur déjà présente est à l'utilisateur.
  let vitestSet = null;
  if (vwValue) {
    if (!isObj(s.env)) s.env = {};
    if (s.env.VITEST_MAX_WORKERS === undefined) { s.env.VITEST_MAX_WORKERS = vwValue; vitestSet = vwValue; }
  }

  const statusLine = { type: 'command', command: cmdArg(node, win) + ' ' + cmdArg(scriptPath(dojo, 'statusline.js', win), win), refreshInterval: 30 };
  if (o.statusLine === 'replace') s.statusLine = statusLine;
  else if (o.statusLine === 'keep' && (!s.statusLine || isDojo(s.statusLine, RE.statusline))) s.statusLine = statusLine;
  // 'none' : statusLine jamais touchée
  return { vitestSet };
}

// Retire VITEST_MAX_WORKERS seulement si Dojo l'a posé, et seulement avec la valeur qu'il a écrite.
function dropManagedVitest(s, managed) {
  if (managed === null || !isObj(s.env) || s.env.VITEST_MAX_WORKERS !== managed) return false;
  delete s.env.VITEST_MAX_WORKERS;
  if (Object.keys(s.env).length === 0) delete s.env;
  return true;
}

// Tient la propriété VITEST à jour après une écriture : valeur posée par Dojo (set) mémorisée ;
// sinon oubliée si la valeur mémorisée n'est plus dans settings (retirée ou changée à la main).
function syncVitestMark(settings, set = null) {
  if (set !== null) { setManagedVitest(set); return; }
  const m = managedVitest();
  if (m !== null && !(isObj(settings.env) && settings.env.VITEST_MAX_WORKERS === m)) setManagedVitest(null);
}

// Retire uniquement ce que dojo a ajouté (même logique que uninstall.sh). Renvoie true si modifié.
function unmergeTransform(s, managed) {
  let touched = false;
  if (isObj(s.hooks)) {
    for (const ev of Object.keys(s.hooks)) {
      const list = s.hooks[ev];
      if (!Array.isArray(list)) continue;
      let evTouched = false;
      const out = [];
      for (const g of list) {
        if (!isObj(g) || !Array.isArray(g.hooks)) { out.push(g); continue; }
        const kept = g.hooks.filter((h) => {
          if (isDojo(h, RE.heavy)) return false;
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
  if (dropManagedVitest(s, managed)) touched = true;
  return touched;
}

// Fichier réel : si file est un lien symbolique (dotfiles), sa cible. Le lien n'est jamais remplacé.
function realFile(file) {
  try { return fs.lstatSync(file).isSymbolicLink() ? linkTarget(file) : file; } catch { return file; }
}

// Écriture atomique : tmp à côté du vrai fichier, puis renameSync. Le mode d'origine est conservé.
function writeAtomic(file, content) {
  const target = realFile(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let mode = null;
  try { mode = fs.statSync(target).mode & 0o777; } catch { /* nouveau fichier */ }
  const tmp = target + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, content);
    if (mode !== null) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// Écriture commune : sauvegarde horodatée si le fichier existait, puis écriture atomique (sauf dryRun).
function commitSettings(file, before, after, dryRun) {
  let backup = null;
  if (!dryRun) {
    if (before !== null) {
      backup = file + '.bak-' + stampNow();
      fs.copyFileSync(file, backup);
    }
    writeAtomic(file, after);
  }
  return backup;
}

function settingsResult(file, norm, after, changed, dryRun, backup, extra = {}) {
  return {
    ok: true,
    changed,
    dryRun,
    file,
    backup,
    before: norm === null ? null : JSON.parse(norm),
    after: JSON.parse(after),
    diff: changed ? lineDiff(norm, after) : '',
    ...extra,
  };
}

function mergeSettings(opts = {}) {
  const file = paths.settings();
  const dryRun = opts.dryRun === true;
  let node = opts.node;
  if (!node) {
    const found = findNode();
    if (!found) fail(WIN
      ? 'Node.js 18 ou plus est introuvable (PATH, Program Files, volta, nvm-windows).'
      : 'Node.js 18 ou plus est introuvable (PATH, Homebrew, /usr/local, volta, nvm, fnm).');
    node = found.path;
  }
  const o = {
    node: canonical(node),
    dojo: paths.dojo(),
    hooks: opts.hooks !== false,
    statusLine: opts.statusLine || 'keep',
    heavyGate: typeof opts.heavyGate === 'boolean' ? opts.heavyGate : undefined,
    vitestWorkers: opts.vitestWorkers,
    managedVitest: managedVitest(),
  };
  if (!['replace', 'keep', 'none'].includes(o.statusLine)) fail("statusLine doit valoir replace, keep ou none.");
  const { before, norm, obj } = readSettingsFile(file);
  const { vitestSet } = mergeTransform(obj, o);
  const after = JSON.stringify(obj, null, 2) + '\n';
  const changed = norm === null || after !== norm;
  const backup = changed ? commitSettings(file, before, after, dryRun) : null;
  if (!dryRun) syncVitestMark(obj, vitestSet);
  return settingsResult(file, norm, after, changed, dryRun, backup, {
    heavyGateThresholds: o.heavyGate === true ? heavyThresholds() : null,
  });
}

function unmergeSettings(opts = {}) {
  const file = paths.settings();
  const dryRun = opts.dryRun === true;
  const { before, norm, obj } = readSettingsFile(file);
  if (before === null) {
    if (!dryRun) syncVitestMark(obj);
    return { ok: true, changed: false, dryRun, file, backup: null, before: null, after: null, diff: '' };
  }
  const touched = unmergeTransform(obj, managedVitest());
  const after = JSON.stringify(obj, null, 2) + '\n';
  const changed = touched && after !== norm;
  const backup = changed ? commitSettings(file, before, after, dryRun) : null;
  if (!dryRun) syncVitestMark(obj);
  return settingsResult(file, norm, after, changed, dryRun, backup);
}

// ── Entrées : JSON en argument, ou « - » pour stdin ─────────────────────
function readArg(arg) {
  if (arg === '-') { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } }
  return arg === undefined ? '' : String(arg);
}
function parseJsonArg(arg) {
  const text = readArg(arg);
  if (text.trim() === '') return {};
  try { return JSON.parse(text); } catch (e) { fail(`JSON invalide en argument : ${e.message}`); }
}

// ── config.json ──────────────────────────────────────────────────────────
const isStrList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isUrlLike = (u) => typeof u === 'string' && /^(https?|webcal):\/\//i.test(u);
const toNum = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return NaN;
};
const expandHome = (p) => p.replace(/^~(?=$|\/)/, home());

// Merge profond : les objets se fusionnent, les listes et valeurs scalaires sont remplacées.
function deepMerge(base, add) {
  if (!isObj(base) || !isObj(add)) return add;
  const out = { ...base };
  for (const [k, v] of Object.entries(add)) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function normalizePatch(p) {
  if (!isObj(p)) fail('la configuration doit être un objet JSON.');
  const out = JSON.parse(JSON.stringify(p));
  if (isObj(out.weather)) {
    for (const k of ['lat', 'lon']) {
      if (out.weather[k] === undefined) continue;
      const n = toNum(out.weather[k]);
      if (!Number.isFinite(n)) fail(`weather.${k} doit être numérique.`);
      out.weather[k] = n;
    }
  }
  if (isObj(out.projects) && Array.isArray(out.projects.roots)) {
    out.projects.roots = out.projects.roots.map((r) => (typeof r === 'string' ? expandHome(r) : r));
  }
  if (typeof out.background === 'string') out.background = expandHome(out.background);
  if (isObj(out.backgroundByTheme)) {
    for (const k of Object.keys(out.backgroundByTheme)) {
      if (typeof out.backgroundByTheme[k] === 'string') out.backgroundByTheme[k] = expandHome(out.backgroundByTheme[k]);
    }
  }
  return out;
}

function validateConfig(c) {
  const w = c.weather;
  if (w !== undefined && w !== null) {
    if (!isObj(w)) fail('weather doit être un objet {name, lat, lon, timezone}.');
    if (!Number.isFinite(w.lat) || w.lat < -90 || w.lat > 90) fail('weather.lat doit être un nombre entre -90 et 90.');
    if (!Number.isFinite(w.lon) || w.lon < -180 || w.lon > 180) fail('weather.lon doit être un nombre entre -180 et 180.');
    if (typeof w.name !== 'string') fail('weather.name doit être une chaîne.');
    if (w.timezone !== undefined && typeof w.timezone !== 'string') fail('weather.timezone doit être une chaîne.');
  }
  if (c.calendars !== undefined) {
    if (!isStrList(c.calendars)) fail('calendars doit être une liste de chaînes.');
    // L'URL n'est pas citée dans le message : c'est souvent une adresse privée.
    if (!c.calendars.every(isUrlLike)) fail('entrée d\'agenda invalide : attendu une URL https ou webcal.');
  }
  if (c.github !== undefined && c.github !== null) {
    if (!isObj(c.github)) fail('github doit être un objet {owners}.');
    if (c.github.owners !== undefined && !isStrList(c.github.owners)) fail('github.owners doit être une liste de chaînes.');
  }
  if (c.projects !== undefined && c.projects !== null) {
    if (!isObj(c.projects)) fail('projects doit être un objet {roots, onlyOwners}.');
    if (c.projects.roots !== undefined && !isStrList(c.projects.roots)) fail('projects.roots doit être une liste de chaînes.');
    if (c.projects.onlyOwners !== undefined && typeof c.projects.onlyOwners !== 'boolean') fail('projects.onlyOwners doit être un booléen.');
  }
  if (c.sentry !== undefined && c.sentry !== null) {
    if (!isObj(c.sentry)) fail('sentry doit être un objet {token, org}.');
    for (const k of ['token', 'org']) {
      if (c.sentry[k] !== undefined && typeof c.sentry[k] !== 'string') fail(`sentry.${k} doit être une chaîne.`);
    }
  }
  if (c.wallpapers !== undefined && c.wallpapers !== null) {
    if (!isObj(c.wallpapers)) fail('wallpapers doit être un objet {autoDownload}.');
    if (c.wallpapers.autoDownload !== undefined && typeof c.wallpapers.autoDownload !== 'boolean') {
      fail('wallpapers.autoDownload doit être un booléen (true ou false).');
    }
  }
  if (c.theme !== undefined && c.theme !== null && !(typeof c.theme === 'string' && THEME_ID_RE.test(c.theme))) {
    fail('theme doit être un identifiant (lettres minuscules, chiffres, tirets).');
  }
  if (c.background !== undefined && c.background !== null && !(typeof c.background === 'string' && path.isAbsolute(c.background))) {
    fail('background doit être null ou un chemin absolu.');
  }
  if (c.backgroundByTheme !== undefined && c.backgroundByTheme !== null) {
    if (!isObj(c.backgroundByTheme)) fail('backgroundByTheme doit être un objet {identifiant de thème: chemin}.');
    for (const [theme, bg] of Object.entries(c.backgroundByTheme)) {
      if (!THEME_ID_RE.test(theme)) fail('backgroundByTheme : identifiant de thème invalide.');
      if (bg === null) continue;
      if (bg !== THEME_BG_ID && !(typeof bg === 'string' && path.isAbsolute(bg))) fail('backgroundByTheme : chemin absolu, null ou theme attendu.');
      checkBackgroundPath(bg, 'backgroundByTheme');
    }
  }
  if (c.terminal !== undefined && c.terminal !== null) {
    if (!isObj(c.terminal)) fail('terminal doit être un objet {ghostty, terminalApp, welcome} de booléens.');
    for (const k of TERM_KEYS) {
      if (c.terminal[k] !== undefined && typeof c.terminal[k] !== 'boolean') fail(`terminal.${k} doit être un booléen.`);
    }
  }
  validateWindowZone(c.windowZone);
}

// Zone de travail : { enabled, margin (pt), reserveTop, exclude: [bundle ids] }. Tous les champs sont facultatifs.
const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const WINDOW_ZONE_DEFAULTS = { enabled: false, margin: 8, reserveTop: true, exclude: [] };
const WINDOW_ZONE_MAX_MARGIN = 64;   // même borne que WindowZoneConfig.marginRange (Swift)
const WINDOW_ZONE_MAX_EXCLUDE = 200;

function validateWindowZone(z) {
  if (z === undefined || z === null) return;
  if (!isObj(z)) fail('windowZone doit être un objet {enabled, margin, reserveTop, exclude}.');
  if (z.enabled !== undefined && typeof z.enabled !== 'boolean') fail('windowZone.enabled doit être un booléen.');
  if (z.reserveTop !== undefined && typeof z.reserveTop !== 'boolean') fail('windowZone.reserveTop doit être un booléen.');
  if (z.margin !== undefined && !(typeof z.margin === 'number' && Number.isFinite(z.margin) && z.margin >= 0 && z.margin <= WINDOW_ZONE_MAX_MARGIN)) {
    fail(`windowZone.margin doit être un nombre entre 0 et ${WINDOW_ZONE_MAX_MARGIN} (points).`);
  }
  if (z.exclude !== undefined) {
    if (!isStrList(z.exclude)) fail('windowZone.exclude doit être une liste d\'identifiants d\'application (bundle ids).');
    if (z.exclude.length > WINDOW_ZONE_MAX_EXCLUDE) fail(`windowZone.exclude : ${WINDOW_ZONE_MAX_EXCLUDE} entrées au maximum.`);
    if (!z.exclude.every((b) => BUNDLE_ID_RE.test(b))) fail('windowZone.exclude : identifiant d\'application invalide (ex. com.apple.Safari).');
  }
}

// wallpapers.autoDownload (config.json, défaut true) : seul false coupe le téléchargement automatique
// (wallpapers sync sans thème, needsSync de set-theme). Ne concerne pas le champ wallpapers de theme.json.
const autoDownloadOf = (cfg) => !(isObj(cfg) && isObj(cfg.wallpapers) && cfg.wallpapers.autoDownload === false);

// Galerie d'un thème : fichier directement dans backgrounds/<theme>/ (un seul niveau). Renvoie l'id du thème, ou null.
function galleryOwner(file) {
  const rel = path.relative(paths.backgrounds(), path.resolve(file)).split(path.sep);
  return rel.length === 2 && THEME_ID_RE.test(rel[0]) && rel[1] !== '' ? rel[0] : null;
}

// config.background (si fourni, non null) : même règle que set-background, c.-à-d. un fichier directement dans backgrounds/
// ou dans une galerie backgrounds/<theme>/, extension autorisée, jamais un lien symbolique (fichier ou dossier de galerie).
// Vérifié sur la seule valeur envoyée, pas sur config.json entier. label : nom du champ, pour les messages.
// Sentinelle « theme » (backgroundByTheme seulement) : fond du thème choisi explicitement, ce n'est pas un chemin.
function checkBackgroundPath(p, label = 'background') {
  if (label === 'backgroundByTheme' && p === THEME_BG_ID) return;
  const file = path.resolve(p);
  const root = paths.backgrounds();
  const direct = path.dirname(file) === root;
  const owner = direct ? null : galleryOwner(file);
  if ((!direct && owner === null) || !BG_EXT.includes(path.extname(file).toLowerCase())) {
    fail(`${label} doit être null ou une image copiée dans ${root} (jpg, jpeg, png, heic ou webp), ou dans sa galerie. Utilisez set-background ou wallpapers use.`);
  }
  const isLink = (f) => { try { return fs.lstatSync(f).isSymbolicLink(); } catch { return false; } };
  if (isLink(file)) fail(`${label} : lien symbolique refusé : ${file}`);
  if (owner !== null && (isLink(path.dirname(file)) || isLink(root))) fail(`${label} : lien symbolique refusé dans le dossier de galerie.`);
}

// Écrit config.json (0600, dossier 0700). Ne renvoie jamais les valeurs (le jeton Sentry en fait partie).
function writeConfig(input) {
  const patch = normalizePatch(input);
  if (typeof patch.background === 'string') checkBackgroundPath(patch.background);
  const dir = paths.dojo();
  const file = path.join(dir, 'config.json');
  let existing = {};
  if (fs.existsSync(file)) {
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      fail(`config.json existant illisible (${e.message}) : corrige-le ou déplace-le.`);
    }
    if (!isObj(existing)) fail('config.json existant : un objet JSON est attendu.');
  }
  const merged = deepMerge(existing, patch);
  // weather décrit un seul lieu : il remplace l'ancien en entier (sinon le fuseau d'une ancienne ville resterait).
  if (Object.prototype.hasOwnProperty.call(patch, 'weather')) merged.weather = patch.weather;
  for (const k of Object.keys(patch)) if (patch[k] === null) delete merged[k];
  if (isObj(merged.backgroundByTheme)) {
    for (const k of Object.keys(merged.backgroundByTheme)) if (merged.backgroundByTheme[k] === null) delete merged.backgroundByTheme[k];
  }
  validateConfig(merged);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  // Windows : pas de mode POSIX (le fichier reste dans le profil de l'utilisateur, ACL par défaut).
  return { ok: true, path: file, mode: WIN ? null : '0600', keys: Object.keys(merged) };
}

// Zone de travail effective : valeurs de config.json complétées par les défauts (désactivée par défaut).
function windowZoneInfo() {
  const cfg = readConfig();
  const z = cfg && isObj(cfg.windowZone) ? cfg.windowZone : {};
  const out = { ...WINDOW_ZONE_DEFAULTS, exclude: [] };
  try { validateWindowZone(z); } catch { return { ok: true, windowZone: out }; }
  if (typeof z.enabled === 'boolean') out.enabled = z.enabled;
  if (typeof z.reserveTop === 'boolean') out.reserveTop = z.reserveTop;
  if (typeof z.margin === 'number') out.margin = z.margin;
  if (Array.isArray(z.exclude)) out.exclude = [...new Set(z.exclude)];
  return { ok: true, windowZone: out };
}

// Géocodage Open-Meteo (même requête que install.sh, timeout 8 s).
async function geocode(city) {
  const name = String(city || '').trim();
  if (!name) fail('ville vide.');
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.searchParams.set('name', name);
  url.searchParams.set('count', '1');
  url.searchParams.set('language', 'fr');
  url.searchParams.set('format', 'json');
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (e) { fail(`géocodage impossible (réseau ?) : ${e.message}`); }
  if (!res.ok) fail(`géocodage : réponse HTTP ${res.status}.`);
  let j;
  try { j = await res.json(); } catch { fail('géocodage : réponse invalide.'); }
  const list = j && Array.isArray(j.results) ? j.results : [];
  return {
    ok: true,
    results: list.map((r) => ({
      name: r.name, country: r.country || null, lat: r.latitude, lon: r.longitude, timezone: r.timezone || null,
    })),
  };
}

// ── Copie du runtime ─────────────────────────────────────────────────────
const isInside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const RUNTIME_FILES = new Set(['package.json', 'package-lock.json', 'config.example.json']);
const RUNTIME_DIRS = new Set(['wallpaper', 'themes', 'node_modules']);
// Windows seulement : src/windows/ (media.ps1). Son bin/ (DojoWallpaper.exe) n'est pas du runtime : jamais effacé.
const WIN_RUNTIME_DIRS = new Set(['windows']);
const KEEP_IN_DEST = { windows: ['bin'] };

// Cible d'un lien symbolique : son realpath, ou sa cible lexicale s'il est cassé.
function linkTarget(link) {
  try { return fs.realpathSync(link); } catch { return path.resolve(path.dirname(link), fs.readlinkSync(link)); }
}
const refuseLink = (rel) => fail(`lien symbolique refusé (pointe hors du dossier source) : ${rel}`);

// Parcourt l'arbre sans jamais suivre un lien ; un lien dont la cible sort de root fait échouer.
function assertLinksInside(dir, root) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      if (!isInside(linkTarget(p), root)) refuseLink(path.relative(root, p));
    } else if (ent.isDirectory()) {
      assertLinksInside(p, root);
    }
  }
}

// Copie src/ vers ~/.config/claude-dojo. config.json et cache/ ne sont jamais écrasés.
// Les liens ne sont jamais suivis : ceux qui pointent dans le dossier source sont recopiés comme liens,
// ceux qui sortent (y compris dans node_modules) font échouer l'installation avant toute écriture.
function installFiles(srcDir) {
  if (!srcDir || srcDir.trim() === '') fail('dossier source manquant.');
  const src = path.resolve(srcDir);
  let real;
  try { real = fs.realpathSync(src); } catch { fail(`dossier source introuvable : ${src}`); }
  if (!fs.statSync(real).isDirectory()) fail(`dossier source attendu : ${src}`);

  const items = [];
  for (const name of fs.readdirSync(real).sort()) {
    if (name === 'config.json' || name === 'cache') continue;
    const from = path.join(real, name);
    const lst = fs.lstatSync(from);
    let st = lst;
    if (lst.isSymbolicLink()) {
      if (!isInside(linkTarget(from), real)) refuseLink(name);
      try { st = fs.statSync(from); } catch { continue; } // lien cassé au premier niveau : ignoré
    }
    if (st.isDirectory() && (RUNTIME_DIRS.has(name) || (WIN && WIN_RUNTIME_DIRS.has(name)))) {
      if (lst.isDirectory()) assertLinksInside(from, real);
      items.push({ name, from, dir: true });
    } else if (st.isDirectory() && name === 'terminal') {
      // welcome.zsh : sous terminal-src/ (et non terminal/, réservé aux fichiers générés des options terminal).
      if (lst.isDirectory()) assertLinksInside(from, real);
      items.push({ name: TERM_SRC_INSTALLED, from, dir: true });
    } else if (st.isFile() && (name.endsWith('.js') || RUNTIME_FILES.has(name))) {
      items.push({ name, from, dir: false });
    }
  }

  const dest = paths.dojo();
  fs.mkdirSync(dest, { recursive: true });
  fs.mkdirSync(path.join(dest, 'cache'), { recursive: true });
  const copied = [];
  for (const { name, from, dir } of items) {
    const to = path.join(dest, name);
    if (dir) clearDest(to, KEEP_IN_DEST[name]);
    fs.cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true });
    copied.push(dir ? name + '/' : name);
  }
  return { ok: true, copied, dest };
}

// Vide la destination d'un dossier du runtime avant recopie. keep : entrées à garder (windows/bin).
function clearDest(to, keep = []) {
  if (keep.length === 0) { fs.rmSync(to, { recursive: true, force: true }); return; }
  let names = [];
  try { names = fs.readdirSync(to); } catch { return; }
  for (const n of names) if (!keep.includes(n)) fs.rmSync(path.join(to, n), { recursive: true, force: true });
}

// npm install --omit=dev dans ~/.config/claude-dojo (node-ical), avec le npm du node détecté.
async function npmInstall(nodePath) {
  const dest = paths.dojo();
  if (!fs.existsSync(path.join(dest, 'package.json'))) fail(`package.json absent de ${dest} : lance d'abord install-files.`);
  const nodeBin = nodePath || (findNode() || {}).path || null;
  const npmArgs = ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent'];
  let cmd;
  let args = npmArgs;
  if (WIN) {
    // npm.cmd ne se lance pas sans shell : on exécute node sur npm-cli.js, rangé à côté de node.exe.
    const cli = nodeBin ? path.join(path.dirname(nodeBin), 'node_modules', 'npm', 'bin', 'npm-cli.js') : null;
    if (!cli || !fs.existsSync(cli)) fail('npm introuvable (npm-cli.js à côté de node.exe).');
    cmd = nodeBin;
    args = [cli, ...npmArgs];
  } else {
    cmd = nodeBin ? path.join(path.dirname(nodeBin), 'npm') : null;
    if (!cmd || !isExec(cmd)) cmd = findBin('npm');
    if (!cmd) fail('npm introuvable (il vient normalement avec node).');
  }
  const env = {
    ...process.env,
    PATH: [nodeBin ? path.dirname(nodeBin) : null, process.env.PATH].filter(Boolean).join(path.delimiter),
  };
  const r = await run(cmd, args, { cwd: dest, env, timeout: 600000, maxBuffer: 16 << 20 });
  if (!r.ok) fail(`npm install a échoué dans ${dest} (réseau ?). Relance l'installation une fois la connexion rétablie.`);
  return { ok: true, dest, nodeModules: fs.existsSync(path.join(dest, 'node_modules')) };
}

// ── Mise à jour du runtime (après remplacement de DojoWallpaper.app) ─────
// Remplacer l'app ne touche pas à ~/.config/claude-dojo : au lancement, l'app appelle cette commande avec son runtime
// embarqué (srcDir). Si le dojo est configuré et que ce runtime est plus récent que l'installé, il est recopié
// (installFiles), puis l'agent redémarre (launchctl kickstart, seulement si son LaunchAgent existe et que launchd
// n'est pas désactivé). Versions comparées en major.minor.patch, sans dépendance. Jamais de rétrogradation.
// Renvoie { upgraded, from, to, restarted, reason } ; reason : not-configured, invalid-version, up-to-date,
// downgrade, volume (app lancée depuis un DMG ou une copie translocalisée) ou done.
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const parseVersion = (v) => {
  const m = typeof v === 'string' ? SEMVER_RE.exec(v.trim()) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
// Négatif si a < b, nul si égales, positif si a > b.
const compareVersions = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};
// Version lue dans un package.json (null si absent ou illisible).
function packageVersion(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).version ?? null; } catch { return null; }
}
const isTransientApp = (p) => p.startsWith('/Volumes/') || p.includes('/AppTranslocation/');

async function upgradeRuntime(srcDir, opts = {}) {
  if (!srcDir || srcDir.trim() === '') fail('dossier source manquant.');
  const o = isObj(opts) ? opts : {};
  const dest = paths.dojo();
  const from = packageVersion(path.join(dest, 'package.json'));
  const to = packageVersion(path.join(path.resolve(srcDir), 'package.json'));
  const result = (upgraded, reason, restarted = false) => ({ ok: true, upgraded, from, to, restarted, reason });
  if (!fs.existsSync(path.join(dest, 'config.json'))) return result(false, 'not-configured');
  const embedded = parseVersion(to);
  const installed = parseVersion(from);
  if (!embedded || !installed) return result(false, 'invalid-version');
  const cmp = compareVersions(embedded, installed);
  if (cmp === 0) return result(false, 'up-to-date');
  if (cmp < 0) return result(false, 'downgrade');
  if (o.appPath && isTransientApp(path.resolve(String(o.appPath)))) return result(false, 'volume');
  installFiles(srcDir);
  let restarted = false;
  if (o.noLaunchd !== true && fs.existsSync(plistPath(LABEL_AGENT))) {
    restarted = (await run('launchctl', ['kickstart', '-k', `gui/${uid()}/${LABEL_AGENT}`])).ok;
  }
  return result(true, 'done', restarted);
}

// ── LaunchAgents (launchctl uniquement via execFile ; --dry-run ne fait rien) ──
const uid = () => process.getuid();
const plistPath = (label) => path.join(paths.launchAgents(), label + '.plist');

function legacyLabels() {
  return listLaunchAgentLabels(paths.launchAgents()).filter((l) => LEGACY_RE.test(l)).sort();
}

function agentPlist(node, dojo) {
  const d = xmlEsc(dojo);
  const n = xmlEsc(node);
  const la = xmlEsc(['/opt/homebrew/bin', '/usr/local/bin', path.dirname(node), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL_AGENT}</string>
  <key>ProgramArguments</key><array><string>${n}</string><string>${d}/agent-mac.js</string></array>
  <key>WorkingDirectory</key><string>${d}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${la}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${d}/cache/agent.log</string>
  <key>StandardErrorPath</key><string>${d}/cache/agent.log</string>
</dict></plist>
`;
}

function wallpaperPlist(appBin, dojo) {
  const d = xmlEsc(dojo);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL_WALL}</string>
  <key>ProgramArguments</key><array><string>${xmlEsc(appBin)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardOutPath</key><string>${d}/cache/wallpaper.log</string>
  <key>StandardErrorPath</key><string>${d}/cache/wallpaper.log</string>
</dict></plist>
`;
}

// Le bundle lancé par le LaunchAgent doit être dans un dossier d'appDirs() : ni volume monté (DMG), ni AppTranslocation
// (app lancée depuis un DMG ou Téléchargements, dont le chemin disparaît à l'éjection).
const APP_MOVE_MSG = 'Déplace DojoWallpaper.app dans /Applications puis relance-la.';
function checkAppLocation(app) {
  const resolved = path.resolve(app);
  let real = resolved;
  try { real = fs.realpathSync(resolved); } catch { /* absent : chemin tel quel */ }
  if (isTransientApp(resolved) || isTransientApp(real)) fail(APP_MOVE_MSG);
  if (!appDirs().map((d) => path.resolve(d)).includes(path.dirname(resolved))) fail(APP_MOVE_MSG);
}

// Binaire du fond d'écran : json.app, sinon /Applications si présent, sinon l'app compilée dans ~/Applications.
function wallpaperBinary(appOpt) {
  const sysApp = path.join(appDirs()[appDirs().length - 1], APP_NAME);
  const app = appOpt || (fs.existsSync(sysApp) ? sysApp : paths.app());
  return path.join(app, 'Contents', 'MacOS', 'DojoWallpaper');
}

// Attend le déchargement (bootout est asynchrone), puis charge. Renvoie null ou un message d'avertissement.
async function bootstrapLabel(label, file) {
  await run('launchctl', ['bootout', `gui/${uid()}/${label}`]);
  for (let i = 0; i < 10; i++) {
    const r = await run('launchctl', ['print', `gui/${uid()}/${label}`]);
    if (!r.ok) break;
    await sleep(500);
  }
  const r = await run('launchctl', ['bootstrap', `gui/${uid()}`, file]);
  return r.ok ? null : `${label} : chargement impossible. Essaie : launchctl bootstrap gui/${uid()} ${file}`;
}

async function launchAgentsInstall(opts = {}) {
  const dryRun = opts.dryRun === true;
  const noLaunchd = opts.noLaunchd === true;
  if (opts.app) checkAppLocation(String(opts.app));
  const found = opts.node || (findNode() || {}).path;
  if (!found) fail('Node.js 18 ou plus est introuvable : impossible d\'écrire les LaunchAgents.');
  const node = canonical(found);
  const dojo = paths.dojo();
  const agent = { label: LABEL_AGENT, path: plistPath(LABEL_AGENT), content: agentPlist(node, dojo) };
  const wall = { label: LABEL_WALL, path: plistPath(LABEL_WALL), content: wallpaperPlist(wallpaperBinary(opts.app), dojo) };
  const plists = [agent, wall];
  // Anciens labels com.*.claude-dojo.* retirés (bootout + suppression du plist). Avec --no-launchd : rien retiré.
  // migrated = les labels retirés, ou ceux qui le seraient en dryRun.
  const migrated = [];
  const commands = [];
  const warnings = [];
  const loaded = [];
  for (const name of legacyLabels()) {
    if (noLaunchd) { warnings.push(`ancien LaunchAgent ${name} laissé en place (--no-launchd).`); continue; }
    migrated.push(name);
    commands.push(`launchctl bootout gui/${uid()}/${name}`, `rm ${plistPath(name)}`);
  }
  for (const p of plists) {
    if (!noLaunchd) commands.push(`launchctl bootout gui/${uid()}/${p.label}`, `launchctl bootstrap gui/${uid()} ${p.path}`);
  }
  if (dryRun) {
    return { ok: true, dryRun: true, migrated, plists: plists.map(({ label, path: pp, content }) => ({ label, path: pp, content })), commands };
  }
  fs.mkdirSync(paths.launchAgents(), { recursive: true });
  for (const p of plists) fs.writeFileSync(p.path, p.content);
  if (noLaunchd) {
    return { ok: true, dryRun: false, written: plists.map((p) => p.path), migrated, loaded, warnings };
  }
  for (const name of migrated) {
    await run('launchctl', ['bootout', `gui/${uid()}/${name}`]);
    fs.rmSync(plistPath(name), { force: true });
  }
  for (const p of plists) {
    const w = await bootstrapLabel(p.label, p.path);
    if (w) warnings.push(w); else loaded.push(p.label);
  }
  return { ok: true, dryRun: false, written: plists.map((p) => p.path), migrated, loaded, warnings };
}

async function launchAgentsUninstall(opts = {}) {
  const dryRun = opts.dryRun === true;
  if (opts.noLaunchd === true) return { ok: true, dryRun, skipped: true, removed: [], commands: [] };
  const labels = [LABEL_AGENT, LABEL_WALL];
  const existing = listLaunchAgentLabels(paths.launchAgents());
  const all = [...new Set([...labels, ...existing])];
  const commands = [];
  for (const l of all) commands.push(`launchctl bootout gui/${uid()}/${l}`);
  const removed = [];
  for (const l of all) {
    if (!fs.existsSync(plistPath(l))) continue;
    commands.push(`rm ${plistPath(l)}`);
    removed.push(l);
  }
  if (!dryRun) {
    for (const l of all) await run('launchctl', ['bootout', `gui/${uid()}/${l}`]);
    for (const l of removed) fs.rmSync(plistPath(l), { force: true });
  }
  return { ok: true, dryRun, skipped: false, removed, commands };
}

// ── Windows : démarrage automatique, lanceur sans fenêtre, DojoWallpaper.exe ─────────────
// Démarrage : valeurs HKCU\...\Run (utilisateur courant, sans élévation). L'agent est lancé par wscript.exe via un
// petit .vbs : node tourne sans console. DOJO_SKIP_REGISTRY=1 : le registre n'est ni écrit ni effacé (le lanceur, lui, l'est).
const regSkipped = () => process.env.DOJO_SKIP_REGISTRY === '1';
const winSys = (rel) => (process.env.SystemRoot ? path.join(process.env.SystemRoot, rel) : path.basename(rel));
const regExe = () => winSys(path.join('System32', 'reg.exe'));
const wscriptExe = () => winSys(path.join('System32', 'wscript.exe'));
const powershellExe = () => winSys(path.join('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
const regRunOpts = { windowsHide: true, timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };

// Arguments de reg.exe (fonctions pures).
const regArgs = {
  add: (name, data) => ['add', RUN_KEY, '/v', name, '/t', 'REG_SZ', '/d', data, '/f'],
  del: (name) => ['delete', RUN_KEY, '/v', name, '/f'],
  query: (name) => ['query', RUN_KEY, '/v', name],
};

// Donnée de la valeur Run, ou null si elle est absente (ou reg.exe indisponible).
function regValue(name) {
  let out;
  try { out = execFileSync(regExe(), regArgs.query(name), regRunOpts); } catch { return null; }
  const m = new RegExp('^\\s*' + name + '\\s+REG_SZ\\s+(.*?)\\s*$', 'm').exec(out);
  return m ? m[1] : null;
}

function setRunValue(name, data) {
  try { execFileSync(regExe(), regArgs.add(name, data), regRunOpts); } catch (e) {
    fail(`registre : écriture de ${name} impossible (${String(e.stderr || e.message).trim()})`);
  }
}

function skipRegistry() {
  process.stderr.write('Windows : registre non modifié (DOJO_SKIP_REGISTRY=1).\n');
}

// Lecture seule : valeurs Dojo présentes dans HKCU\...\Run.
function autostartState() {
  return { agent: regValue(RUN_AGENT) !== null, wallpaper: regValue(RUN_WALL) !== null };
}

// Chaîne littérale VBScript. Les caractères hors ASCII (et les contrôles) deviennent ChrW(n), unité UTF-16 par unité :
// wscript lit le fichier en ANSI, un chemin accentué y serait corrompu.
function vbsStr(s) {
  const parts = [];
  let run = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c < 0x7f) { run += s[i] === '"' ? '""' : s[i]; continue; }
    if (run) { parts.push(`"${run}"`); run = ''; }
    parts.push(`ChrW(${c})`);
  }
  if (run || parts.length === 0) parts.push(`"${run}"`);
  return parts.join(' & ');
}

// Lanceur : node lance agent-win.js, fenêtre masquée (0), sans attendre (False). Fichier en ASCII pur.
function launcherVbs(node, dojo) {
  const cmd = `${cmdArg(node, true)} ${cmdArg(scriptPath(dojo, 'agent-win.js', true), true)}`;
  return [
    "' Claude Dojo : lancement de l'agent sans fenetre. Genere par setup.js, ne pas modifier.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = ${vbsStr(dojo)}`,
    `sh.Run ${vbsStr(cmd)}, 0, False`,
    '',
  ].join('\r\n');
}

// Valeur Run de l'agent : wscript.exe en mode batch (sans boîte de dialogue) sur le lanceur.
const launcherRunData = (file) => `${cmdArg(wscriptExe(), true)} //B //Nologo ${cmdArg(file, true)}`;

// Écrit le lanceur et pose les valeurs Run : agent, et fond d'écran si son exe est présent.
// noLaunchd : lanceur seul (équivalent du « écrire sans charger » de macOS). Renvoie la même forme que launchagents (macOS).
function autostartInstall(opts = {}) {
  const dryRun = opts.dryRun === true;
  const found = opts.node || (findNode() || {}).path;
  if (!found) fail('Node.js 18 ou plus est introuvable : impossible de créer le lanceur de l\'agent.');
  const node = canonical(found);
  const launcher = paths.launcher();
  const values = [{ name: RUN_AGENT, data: launcherRunData(launcher) }];
  if (fs.existsSync(paths.exe())) values.push({ name: RUN_WALL, data: cmdArg(paths.exe(), true) });
  const content = launcherVbs(node, paths.dojo());
  if (dryRun) return { ok: true, dryRun: true, written: [], migrated: [], loaded: [], warnings: [], launcher: { path: launcher, content }, values };
  writeAtomic(launcher, content);
  const warnings = [];
  const loaded = [];
  if (opts.noLaunchd !== true) {
    if (regSkipped()) {
      skipRegistry();
      warnings.push('registre : valeurs Run non posées (DOJO_SKIP_REGISTRY=1).');
    } else {
      for (const v of values) { setRunValue(v.name, v.data); loaded.push(v.name); }
    }
  }
  return { ok: true, dryRun: false, written: [launcher], migrated: [], loaded, warnings };
}

// Retire les valeurs Run de Dojo, et celle de l'exe (« DojoWallpaper ») seulement si elle pointe vers notre exe.
// Le lanceur est supprimé. Même forme que launchagents uninstall (macOS).
function autostartUninstall(opts = {}) {
  const dryRun = opts.dryRun === true;
  if (opts.noLaunchd === true) return { ok: true, dryRun, skipped: true, removed: [], commands: [], warnings: [] };
  const targets = [RUN_AGENT, RUN_WALL].filter((n) => regValue(n) !== null);
  const toggle = regValue(RUN_WALL_TOGGLE);
  if (toggle !== null && toggle.includes(paths.exe())) targets.push(RUN_WALL_TOGGLE);
  const commands = targets.map((n) => `reg delete "${RUN_KEY}" /v ${n} /f`);
  const removed = [];
  const warnings = [];
  if (!dryRun) {
    if (regSkipped()) skipRegistry();
    else {
      for (const name of targets) {
        try { execFileSync(regExe(), regArgs.del(name), regRunOpts); removed.push(name); } catch (e) {
          warnings.push(`${name} : suppression impossible (${String(e.stderr || e.message).trim()})`);
        }
      }
    }
    fs.rmSync(paths.launcher(), { force: true });
  }
  return { ok: true, dryRun, skipped: false, removed: dryRun ? targets : removed, commands, warnings };
}

// ── DojoWallpaper.exe ────────────────────────────────────────────────────
// Ordre : DOJO_SKIP_EXE=1 : rien. Sinon le zip de la release GitHub de la version installée (sha256 obligatoire), puis
// compilation par windows/build.ps1 depuis le dépôt (SDK .NET). L'exe installé est remplacé à chaque appel (réinstaller =
// mettre à jour). Si les deux échouent et qu'un exe est déjà là, il est gardé et signalé. Pas d'élévation. L'agent et les
// hooks fonctionnent sans l'exe. deps.get / deps.build : injectables (tests).
async function ensureWallpaperExe(deps = {}) {
  if (!WIN) return { ok: true, installed: false, skipped: 'non-windows' };
  if (process.env.DOJO_SKIP_EXE === '1') return { ok: true, installed: false, skipped: 'DOJO_SKIP_EXE=1', path: paths.exe() };
  const exe = paths.exe();
  const hadExe = fs.existsSync(exe);
  const reasons = [];
  const version = packageVersion(path.join(paths.dojo(), 'package.json'));
  if (parseVersion(version)) {
    try { await downloadExe(version, deps.get); return wallpaperReady(exe, 'release'); } catch (e) { reasons.push(`téléchargement : ${e.message}`); }
  } else {
    reasons.push('version inconnue (package.json)');
  }
  try { await (deps.build || buildExe)(); return wallpaperReady(exe, 'build'); } catch (e) { reasons.push(`compilation : ${e.message}`); }
  if (hadExe) {
    return {
      ...wallpaperReady(exe, 'kept'),
      message: `DojoWallpaper.exe non remplacé (${reasons.join(' ; ')}) : la version déjà installée est gardée.`,
    };
  }
  return {
    ok: true,
    installed: false,
    path: exe,
    message: `DojoWallpaper.exe absent, fond d'écran non installé (${reasons.join(' ; ')}). L'agent et les hooks fonctionnent sans lui. `
      + 'Pour le fond : installe le SDK .NET 8 (winget install --id Microsoft.DotNet.SDK.8 -e) puis relance, ou réessaie quand la release est disponible.',
  };
}

// Exe en place : si l'agent démarre avec Windows, le fond d'écran démarre aussi.
function wallpaperReady(exe, source) {
  const out = { ok: true, installed: true, path: exe, source, autostart: null };
  if (!regSkipped() && regValue(RUN_AGENT) !== null) {
    try { setRunValue(RUN_WALL, cmdArg(exe, true)); out.autostart = RUN_WALL; } catch (e) { out.warning = e.message; }
  }
  return out;
}

// GET https natif, suit les redirections (https seulement), plafonne la taille. Renvoie un Buffer.
function httpsBuffer(url, maxBytes, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'claude-dojo-setup', Accept: 'application/octet-stream' },
      timeout: 60000,
    }, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url);
        if (next.protocol !== 'https:') return reject(new Error('redirection hors https refusée'));
        if (redirects <= 0) return reject(new Error('trop de redirections'));
        return resolve(httpsBuffer(next.href, maxBytes, redirects - 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error(`HTTP ${code}`)); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) req.destroy(new Error('taille maximale dépassée'));
        else chunks.push(c);
      });
      res.on('end', () => (size > maxBytes ? reject(new Error('taille maximale dépassée')) : resolve(Buffer.concat(chunks))));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('délai dépassé')));
    req.on('error', reject);
  });
}

// Copie le contenu d'un dossier extrait (DojoWallpaper.exe et ses dépendances) dans windows/bin de l'installation.
// Remplacement complet, sauf les fichiers de l'utilisateur (dojo-wallpaper.json : réglages du fond, menu « Open config »).
const EXE_USER_FILES = ['dojo-wallpaper.json'];
function installExeFiles(srcDir) {
  clearDest(paths.exeDir(), EXE_USER_FILES);
  fs.mkdirSync(paths.exeDir(), { recursive: true });
  fs.cpSync(srcDir, paths.exeDir(), { recursive: true, dereference: false });
}

// Zip de la release : sha256 demandé d'abord (absent, 404 compris : rien n'est installé, l'appelant passe à la
// compilation), puis le zip est téléchargé dans un dossier temporaire neuf, sa somme vérifiée, et extrait par Expand-Archive.
// get : injectable (tests), même contrat que httpsBuffer.
async function downloadExe(version, get = httpsBuffer) {
  const base = `${RELEASE_URL}/v${version}/${WIN_ZIP}`;
  let sha;
  try { sha = (await get(`${base}.sha256`, 4096)).toString('utf8'); } catch (e) {
    throw new Error(`somme SHA-256 indisponible (${e.message})`);
  }
  const want = (sha.trim().split(/\s+/)[0] || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) throw new Error('fichier SHA-256 illisible');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-exe-'));
  try {
    const data = await get(base, DOWNLOAD_MAX_BYTES);
    const got = crypto.createHash('sha256').update(data).digest('hex');
    if (want !== got) throw new Error('somme SHA-256 incorrecte');
    const zip = path.join(tmp, WIN_ZIP);
    fs.writeFileSync(zip, data);
    const staging = path.join(tmp, 'extract');
    const r = await run(powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      'Expand-Archive -LiteralPath $env:DOJO_ZIP -DestinationPath $env:DOJO_OUT -Force'],
    { env: { ...process.env, DOJO_ZIP: zip, DOJO_OUT: staging }, timeout: 180000, windowsHide: true });
    if (!r.ok) throw new Error('extraction impossible (Expand-Archive)');
    if (!fs.existsSync(path.join(staging, WIN_EXE))) throw new Error(`${WIN_EXE} absent de l'archive`);
    installExeFiles(staging);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Compilation depuis les sources du dépôt (windows/build.ps1, SDK .NET). Impossible depuis un runtime installé.
async function buildExe() {
  const repoWin = path.resolve(__dirname, '..', 'windows');
  const script = path.join(repoWin, 'build.ps1');
  if (!fs.existsSync(script)) throw new Error('sources absentes (windows/build.ps1 hors du dépôt)');
  const dotnet = findBin('dotnet', [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'dotnet')]);
  if (!dotnet || !(await run(dotnet, ['--version'], { timeout: 30000, windowsHide: true })).ok) {
    throw new Error('SDK .NET introuvable');
  }
  const r = await run(powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    { cwd: repoWin, timeout: 900000, maxBuffer: 16 << 20, windowsHide: true });
  if (!r.ok) {
    const last = String(r.stderr || r.stdout).trim().split(/\r?\n/).pop();
    throw new Error(`build.ps1 a échoué${last ? ' : ' + last : ''}`);
  }
  const built = path.join(repoWin, 'bin');
  if (!fs.existsSync(path.join(built, WIN_EXE))) throw new Error(`${WIN_EXE} absent après compilation`);
  installExeFiles(built);
}

// ── Processus Dojo (Windows) ─────────────────────────────────────────────
// Arrêtés avant toute suppression ou réinstallation : agent (node agent-win.js), ses enfants collector.js et media.ps1,
// et DojoWallpaper.exe lancé depuis windows\bin. Visés seulement si la ligne de commande (ou le chemin de l'exe) est dans
// le dossier d'installation. Les enfants ne le sont que si leur parent est un agent visé : l'agent perso
// (~\.config\claude-dojo\agent.ps1, port 7777) a lui aussi un collector.js et un media.ps1 dans ce dossier, sans agent-win.js.
const DOJO_PROCS = [
  { kind: 'agent', name: /^node(\.exe)?$/i, file: 'agent-win.js' },
  { kind: 'collector', name: /^node(\.exe)?$/i, file: 'collector.js', child: true },
  { kind: 'media', name: /^(powershell|pwsh)(\.exe)?$/i, file: 'windows\\media.ps1', child: true },
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const errText = (e) => String((e && e.message) || e);
const taskkillExe = () => winSys(path.join('System32', 'taskkill.exe'));

// Fonction pure (testable partout). procs : [{ pid, ppid, name, commandLine, executablePath }]. Renvoie [{ pid, kind, name }].
// Le chemin du dossier doit être suivi d'un séparateur puis du nom du fichier, entre guillemets, espaces ou bords :
// « claude-dojo2\agent-win.js » ne compte pas.
function dojoProcessTargets(procs, { dojo, exeDir, self = process.pid }) {
  const norm = (s) => String(s || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const base = norm(dojo);
  const exeBase = norm(exeDir);
  const matchers = DOJO_PROCS.map((d) => ({
    ...d,
    re: new RegExp('(^|["\\s])' + escapeRe(base + '\\' + d.file.toLowerCase()) + '(["\\s]|$)'),
  }));
  const kindOf = (p, m) => m.name.test(p.name || '') && m.re.test(norm(p.commandLine));
  const candidates = procs.filter((p) => p && p.pid !== self);
  const agentPids = new Set(candidates.filter((p) => kindOf(p, matchers[0])).map((p) => p.pid));
  const out = [];
  for (const p of candidates) {
    if (agentPids.has(p.pid)) { out.push({ pid: p.pid, kind: 'agent', name: p.name }); continue; }
    const child = matchers.slice(1).find((m) => kindOf(p, m));
    if (child && agentPids.has(p.ppid)) { out.push({ pid: p.pid, kind: child.kind, name: p.name }); continue; }
    if (/^dojowallpaper\.exe$/i.test(p.name || '') && exeBase && norm(p.executablePath).startsWith(exeBase + '\\')) {
      out.push({ pid: p.pid, kind: 'wallpaper', name: p.name });
    }
  }
  return out;
}

// Processus Windows (lecture seule) via Get-CimInstance. Lève si PowerShell échoue.
async function listWinProcesses() {
  const script = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; '
    + 'Get-CimInstance -ClassName Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine, ExecutablePath '
    + '| ConvertTo-Json -Compress';
  const r = await run(powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 60000, maxBuffer: 32 << 20, windowsHide: true });
  if (!r.ok) fail(`liste des processus indisponible (${String(r.stderr || '').trim().split(/\r?\n/).pop() || 'PowerShell'})`);
  const text = r.stdout.trim();
  const list = text ? JSON.parse(text) : [];
  return (Array.isArray(list) ? list : [list]).map((p) => ({
    pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, commandLine: p.CommandLine, executablePath: p.ExecutablePath,
  }));
}

// Arrête les processus Dojo (taskkill /T /F, arguments en tableau, sans shell). Ne lève jamais : renvoie les cibles,
// celles arrêtées, celles encore actives après vérification, et des avertissements. dryRun : rien n'est arrêté.
async function stopDojoProcesses({ dryRun = false } = {}) {
  const where = { dojo: paths.dojo(), exeDir: paths.exeDir() };
  let procs;
  try { procs = await listWinProcesses(); } catch (e) {
    return { targets: [], stopped: [], remaining: [], warnings: [`processus Dojo non vérifiés (${errText(e)})`] };
  }
  const targets = dojoProcessTargets(procs, where).map(({ pid, kind, name }) => ({ pid, kind, name }));
  if (dryRun || targets.length === 0) return { targets, stopped: [], remaining: [], warnings: [] };
  for (const t of targets) await run(taskkillExe(), ['/PID', String(t.pid), '/T', '/F'], { timeout: 15000, windowsHide: true });
  const warnings = [];
  let remaining = targets;
  try {
    const again = dojoProcessTargets(await listWinProcesses(), where);
    remaining = again.filter((a) => targets.some((t) => t.pid === a.pid));
  } catch (e) {
    warnings.push(`arrêt des processus Dojo non vérifié (${errText(e)})`);
  }
  if (remaining.length) warnings.push(`processus Dojo encore actifs : ${remaining.map((r) => `${r.kind} (pid ${r.pid})`).join(', ')}`);
  const stopped = targets.filter((t) => !remaining.some((r) => r.pid === t.pid));
  return { targets, stopped, remaining, warnings };
}

// CLI « stop-processes » (install.ps1 l'appelle avant de remplacer les fichiers). macOS : rien.
async function stopProcesses() {
  if (!WIN) return { ok: true, skipped: 'non-windows', targets: [], stopped: [], remaining: [], warnings: [] };
  return { ok: true, ...(await stopDojoProcesses()) };
}

// Suppression qui ne doit pas interrompre la désinstallation : un échec devient un avertissement et un champ error.
function attempt(fn, dir, dryRun, warnings, what) {
  try { return fn(); } catch (e) {
    warnings.push(`${what} non supprimé (${errText(e)}) : ${dir}`);
    return { path: dir, existed: fs.existsSync(dir), removed: false, dryRun, error: errText(e) };
  }
}

// Désinstallation Windows, symétrique de l'installation. D'abord les processus Dojo (un fichier en cours d'exécution
// ne se supprime pas), puis valeurs Run et lanceur, exe, entrées de settings.json (sauvegarde avant), puis dossier
// d'installation. Chaque étape va au bout : un échec est remonté dans warnings. Sans --purge, config.json et
// backgrounds\ restent. Les options terminal (Ghostty, Terminal.app, zsh) n'existent pas sous Windows.
async function uninstallWin(opts) {
  const dryRun = opts.dryRun === true;
  const warnings = [];
  const processes = await stopDojoProcesses({ dryRun });
  warnings.push(...processes.warnings);
  let launchAgents;
  try {
    launchAgents = autostartUninstall({ dryRun, noLaunchd: opts.noLaunchd === true });
  } catch (e) {
    warnings.push(`démarrage automatique non retiré (${errText(e)})`);
    launchAgents = { ok: true, dryRun, skipped: false, removed: [], commands: [], warnings: [] };
  }
  const exeDir = paths.exeDir();
  const existed = fs.existsSync(exeDir);
  const app = { path: exeDir, existed, removed: existed, dryRun };
  const appRemoved = [];
  let appRemaining = null;
  if (existed && !dryRun) {
    try { fs.rmSync(exeDir, { recursive: true, force: true }); appRemoved.push(exeDir); } catch {
      // Exe verrouillé (en cours d'exécution) : rien d'arrêté, à relancer une fois l'app fermée.
      appRemaining = exeDir;
      app.removed = false;
    }
  }
  // settings.json avant le dossier d'installation : l'état (VITEST_MAX_WORKERS) y est lu.
  let settings;
  try { settings = unmergeSettings({ dryRun }); } catch (e) {
    settings = { changed: false, backup: null, diff: '', error: errText(e) };
  }
  const dojo = paths.dojo();
  const config = attempt(() => (opts.purge === true ? removeTree(dojo, true, dryRun) : removeInstallKeepConfig(dojo, dryRun)),
    dojo, dryRun, warnings, 'configuration');
  const stateDir = paths.stateDir();
  const states = attempt(() => removeTree(stateDir, opts.states === true, dryRun), stateDir, dryRun, warnings, 'états');
  return {
    ok: true,
    dryRun,
    processes,
    launchAgents,
    app,
    appRemoved,
    appRemaining,
    settings: { changed: settings.changed, backup: settings.backup, diff: settings.diff, error: settings.error || null },
    terminal: { skipped: 'win32' },
    config,
    states,
    warnings,
  };
}

// Sans --purge : supprime le contenu du dossier d'installation sauf config.json (réglages réutilisés à la réinstallation)
// et backgrounds/ (fonds personnels).
const KEEP_WIN_UNINSTALL = ['config.json', 'backgrounds'];
function removeInstallKeepConfig(dir, dryRun) {
  const existed = fs.existsSync(dir);
  const kept = KEEP_WIN_UNINSTALL.filter((n) => fs.existsSync(path.join(dir, n)));
  const removed = [];
  if (existed && !dryRun) {
    for (const n of fs.readdirSync(dir)) {
      if (KEEP_WIN_UNINSTALL.includes(n)) continue;
      try { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); removed.push(n); } catch { /* verrouillé : reste en place */ }
    }
  }
  return { path: dir, existed, removed: false, kept, removedEntries: removed, dryRun };
}

// ── uninstall : LaunchAgents, app, entrées dojo de settings.json, puis config/états si demandé ──
function removeTree(dir, doIt, dryRun) {
  const existed = fs.existsSync(dir);
  if (existed && doIt && !dryRun) fs.rmSync(dir, { recursive: true, force: true });
  return { path: dir, existed, removed: existed && doIt, dryRun };
}

const writable = (p) => {
  try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; }
};

// Retire les DojoWallpaper.app de appDirs(). Celui du premier dossier (~/Applications) l'est toujours, comme avant.
// Les autres (/Applications) ne le sont que s'ils sont inscriptibles : sinon le chemin est renvoyé dans appRemaining,
// à glisser dans la Corbeille à la main. appRemoved liste les bundles effectivement retirés.
function removeApps(dryRun) {
  const [main, ...others] = appDirs().map((d) => path.join(d, APP_NAME));
  const app = removeTree(main, true, dryRun);
  const appRemoved = app.removed ? [main] : [];
  let appRemaining = null;
  for (const target of others) {
    if (!fs.existsSync(target)) continue;
    if (!writable(path.dirname(target)) || !writable(target)) { appRemaining = appRemaining || target; continue; }
    if (dryRun) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true });
      appRemoved.push(target);
    } catch {
      appRemaining = appRemaining || target;
    }
  }
  return { app, appRemoved, appRemaining };
}

async function uninstall(opts = {}) {
  if (WIN) return uninstallWin(opts);
  const dryRun = opts.dryRun === true;
  const launchAgents = await launchAgentsUninstall({ dryRun, noLaunchd: opts.noLaunchd === true });
  const { app, appRemoved, appRemaining } = removeApps(dryRun);
  // settings.json illisible : signalé, laissé tel quel, le reste de la désinstallation continue.
  let settings;
  try { settings = unmergeSettings({ dryRun }); } catch (e) {
    settings = { changed: false, backup: null, diff: '', error: e.message || String(e) };
  }
  // Options terminal : lignes Dojo retirées de Ghostty et de ~/.zshrc, profil Terminal, dossier terminal/.
  let terminal;
  try {
    terminal = await terminalRemove({ ghostty: true, terminalApp: true, welcome: true }, { dryRun, dropDir: true });
  } catch (e) {
    terminal = { error: e.message || String(e) };
  }
  const config = removeTree(paths.dojo(), opts.purge === true, dryRun);
  const states = removeTree(paths.stateDir(), opts.states === true, dryRun);
  return {
    ok: true,
    dryRun,
    launchAgents,
    app,
    appRemoved,
    appRemaining,
    settings: { changed: settings.changed, backup: settings.backup, diff: settings.diff, error: settings.error || null },
    terminal,
    config,
    states,
  };
}

// ── status (lecture seule) ───────────────────────────────────────────────
function probeAgent() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: AGENT_PORT, path: '/stats', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function status() {
  const cfg = readConfig();
  const agentRunning = await probeAgent();
  if (WIN) {
    const autostart = autostartState();
    return {
      ok: true,
      configured: cfg !== null,
      agentRunning,
      launchAgentsLoaded: autostart.agent,
      launchAgents: autostart,
      installed: fs.existsSync(path.join(paths.dojo(), 'agent-win.js')),
      port: AGENT_PORT,
      terminal: { skipped: 'win32' },
    };
  }
  const agentLoaded = (await run('launchctl', ['print', `gui/${uid()}/${LABEL_AGENT}`])).ok;
  const wallLoaded = (await run('launchctl', ['print', `gui/${uid()}/${LABEL_WALL}`])).ok;
  return {
    ok: true,
    configured: cfg !== null,
    agentRunning,
    launchAgentsLoaded: agentLoaded && wallLoaded,
    launchAgents: { agent: agentLoaded, wallpaper: wallLoaded },
    installed: fs.existsSync(path.join(paths.dojo(), 'agent-mac.js')),
    port: AGENT_PORT,
    terminal: await terminalStatus(),
  };
}

// ── Thèmes et fonds d'écran ──────────────────────────────────────────────
// Un thème = un dossier themes/<id>/ avec un theme.json valide (id = nom du dossier). Les autres dossiers sont ignorés.
function listThemes() {
  const root = paths.themes();
  let names = [];
  try { names = fs.readdirSync(root).sort(); } catch { return []; }
  const themes = [];
  for (const id of names) {
    if (!THEME_ID_RE.test(id)) continue;
    const dir = path.join(root, id);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8')); } catch { continue; }
    if (!isObj(meta) || meta.id !== id || typeof meta.name !== 'string' || meta.name.trim() === '') continue;
    const thumb = path.join(dir, 'thumbnail.jpg');
    themes.push({
      id,
      name: meta.name,
      thumbnail: fs.existsSync(thumb) ? thumb : null,
      background: path.join(dir, 'background.jpg'),
    });
  }
  // Le thème par défaut d'abord, les autres dans l'ordre alphabétique.
  const i = themes.findIndex((t) => t.id === DEFAULT_THEME);
  if (i > 0) themes.unshift(...themes.splice(i, 1));
  return themes;
}

// Liste des thèmes, thème courant (défaut naruto), fond personnalisé (null = fond du thème) et autoDownload (bool).
function themesInfo() {
  const cfg = readConfig() || {};
  const theme = typeof cfg.theme === 'string' && THEME_ID_RE.test(cfg.theme) ? cfg.theme : DEFAULT_THEME;
  const background = typeof cfg.background === 'string' && cfg.background !== '' ? cfg.background : null;
  return { ok: true, themes: listThemes(), theme, background, autoDownload: autoDownloadOf(cfg) };
}

// Fond utilisable tel quel : chemin accepté par checkBackgroundPath et fichier régulier présent. La sentinelle « theme » n'est pas un fichier.
function usableBackground(p) {
  if (p === THEME_BG_ID) return false;
  try { checkBackgroundPath(p, 'backgroundByTheme'); } catch { return false; }
  return isRegularFile(p);
}

// Bascule de thème. Fond : 1) sentinelle « theme » mémorisée = fond du thème (null) ; 2) chemin mémorisé utilisable ;
// 3) aucune entrée mémorisée et défaut du thème déjà téléchargé : ce défaut (si fond null ou de galerie) ;
// 4) aucune entrée et fond de galerie : fond du thème (null). Un fond perso hors galerie reste inchangé.
// needsSync : le thème a encore des fonds curés non téléchargés (wallpapers sync).
async function setTheme(arg) {
  const id = String(arg ?? '');
  if (!THEME_ID_RE.test(id)) fail('identifiant de thème attendu (lettres minuscules, chiffres, tirets).');
  const known = listThemes().map((t) => t.id);
  if (!known.includes(id)) fail(`thème inconnu : ${id}. Thèmes disponibles : ${known.join(', ') || 'aucun'}.`);
  const before = readConfig() || {};
  const prev = typeof before.background === 'string' ? before.background : null;
  // Options terminal actives : les données du nouveau thème sont vérifiées, puis régénérées AVANT d'écrire config.theme.
  // Si la régénération échoue, config.json garde l'ancien thème.
  const opts = terminalOptions();
  const regenerated = TERM_KEYS.some((k) => opts[k]);
  if (regenerated) terminalSources(id, opts);
  const terminal = regenerated ? await terminalApply(null, id) : null;
  writeConfig({ theme: id });
  const remembered = isObj(before.backgroundByTheme) ? before.backgroundByTheme[id] : undefined;
  const absent = remembered === undefined || remembered === null;
  const owner = prev === null ? null : galleryOwner(prev);
  const dflt = defaultFileId(id);
  const dfltFile = dflt === null ? null : galleryFileFor(id, dflt);
  if (remembered === THEME_BG_ID) writeConfig({ background: null });
  else if (typeof remembered === 'string' && usableBackground(remembered)) writeConfig({ background: remembered });
  else if (absent && dfltFile !== null && replaceableBackground(prev)) applyGalleryFile(id, dfltFile.file);
  else if (owner !== null) writeConfig({ background: null });
  const after = readConfig() || {};
  const out = {
    ok: true,
    theme: id,
    background: typeof after.background === 'string' ? after.background : null,
    hasDownloads: galleryFiles(id).length > 0,
    needsSync: autoDownloadOf(after) && missingIds(id).length > 0,
  };
  if (regenerated) { out.regenerated = true; out.terminal = terminal; }
  return out;
}

// Supprime l'ancienne copie seulement si elle est directement dans backgrounds/ : un chemin choisi par l'utilisateur
// et les fonds de galerie (backgrounds/<theme>/) ne sont jamais touchés.
function dropOldBackground(prev, keep) {
  if (typeof prev !== 'string' || prev === keep) return null;
  if (path.dirname(path.resolve(prev)) !== paths.backgrounds()) return null;
  fs.rmSync(prev, { force: true });
  return prev;
}

const isRegularFile = (p) => { try { return fs.lstatSync(p).isFile(); } catch { return false; } };

// Signature (magic bytes) de chaque format accepté : le contenu doit correspondre à l'extension.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BG_KIND_OF_EXT = { '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.webp': 'webp', '.heic': 'heic' };
function bgKind(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp' && ['heic', 'heix', 'mif1', 'msf1'].includes(buf.toString('latin1', 8, 12))) return 'heic';
  return null;
}

// set-background <chemin|default> : l'image est copiée dans backgrounds/ (nom = sha1 court + extension).
function setBackground(arg) {
  const value = String(arg ?? '');
  if (value === '') fail('chemin de l\'image attendu, ou « default » pour revenir au fond du thème.');
  const prev = (readConfig() || {}).background;
  if (value === 'default') {
    writeConfig({ background: null });
    return { ok: true, background: null, removed: dropOldBackground(prev, null) };
  }
  const src = path.resolve(expandHome(value));
  const ext = path.extname(src).toLowerCase();
  if (!BG_EXT.includes(ext)) fail(`format refusé (${ext || 'sans extension'}) : jpg, jpeg, png, heic ou webp attendu.`);
  let st;
  try { st = fs.lstatSync(src); } catch { fail(`fichier introuvable : ${src}`); }
  if (st.isSymbolicLink()) fail(`lien symbolique refusé : ${src}. Indiquez le fichier réel.`);
  if (!st.isFile()) fail(`fichier attendu, pas un dossier : ${src}`);
  if (st.size > BG_MAX_BYTES) fail('image trop lourde : 50 Mo maximum.');
  const buf = fs.readFileSync(src);
  if (bgKind(buf) !== BG_KIND_OF_EXT[ext]) fail(`contenu incohérent avec l'extension ${ext} : ce fichier n'est pas une image ${BG_KIND_OF_EXT[ext].toUpperCase()} valide.`);
  const dir = paths.backgrounds();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const dest = path.join(dir, crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12) + ext);
  // écriture dans un fichier temporaire puis rename : un lien symbolique déjà présent à ce nom est remplacé, jamais suivi
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buf, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, dest);
  writeConfig({ background: dest });
  return { ok: true, background: dest, removed: dropOldBackground(prev, dest) };
}

// ── Galerie Wallhaven (SFW) ──────────────────────────────────────────────
// Fonds proposés par l'API publique Wallhaven, téléchargés dans backgrounds/<theme>/. Hôte et URL fixes (jamais surchargeables).
const WALLHAVEN_API = 'https://wallhaven.cc/api/v1';
const WALLHAVEN_IMG_HOST = 'w.wallhaven.cc';
const WALLHAVEN_ID_RE = /^[a-z0-9]{4,10}$/;
const GALLERY_FILE_RE = /^wallhaven-([a-z0-9]{4,10})\.(jpg|jpeg|png|webp)$/;
const GALLERY_KIND = { '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.webp': 'webp' };
const SEARCH_CATEGORIES = { 'stargate-sg1': '111' }; // défaut : 010 (anime)
const API_TIMEOUT_MS = 15000;
const IMG_TIMEOUT_MS = 60000;
const IMG_MAX_BYTES = 25 * 1024 * 1024;
// Identifiant réservé : le fond embarqué du thème (wallpapers use theme). Il sert aussi de sentinelle dans
// backgroundByTheme[<thème>] : « le fond du thème a été choisi explicitement », pour que set-theme et sync ne réappliquent pas le défaut.
const THEME_BG_ID = 'theme';
// Entrée « bundled » de wallpapers.ids : même fond embarqué, jamais téléchargée ; wallpapers use bundled = wallpapers use theme.
const BUNDLED_ID = 'bundled';
const PROGRESS_FRESH_MS = 90 * 1000; // progression « en cours » si mise à jour il y a moins de 90 s

const wallId = (v) => typeof v === 'string' && WALLHAVEN_ID_RE.test(v);
const strOrNull = (v) => (typeof v === 'string' ? v : null);
const httpsOrNull = (u) => {
  if (typeof u !== 'string') return null;
  try { return new URL(u).protocol === 'https:' ? u : null; } catch { return null; }
};
// Page source d'un fond (crédits) : https et hôte exactement wallhaven.cc ou www.wallhaven.cc, sinon null.
// Appliqué à l'index, aux réponses download, list, search et local (y compris pour un index.json ancien).
const WALLHAVEN_SOURCE_HOSTS = ['wallhaven.cc', 'www.wallhaven.cc'];
const sourceOrNull = (u) => {
  if (typeof u !== 'string') return null;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && WALLHAVEN_SOURCE_HOSTS.includes(url.hostname) ? u : null;
  } catch { return null; }
};
const galleryDir = (theme) => path.join(paths.backgrounds(), theme);
const indexFile = () => path.join(paths.backgrounds(), 'index.json');

// User-Agent exigé par Wallhaven (sinon 403) : version lue dans package.json à côté de ce fichier.
function userAgent() {
  try {
    return `claude-dojo/${JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version}`;
  } catch { return 'claude-dojo/inconnu'; }
}

// Erreur Wallhaven. fatal : la commande entière échoue (refus, limite de débit, réseau) ; sinon seul l'élément est sauté.
function apiFail(msg, fatal) {
  const e = new SetupError(msg);
  e.fatal = fatal;
  throw e;
}

// Délai minimal entre deux requêtes API : 1000 ms. DOJO_WALLHAVEN_MIN_INTERVAL_MS ne sert qu'aux tests.
function wallhavenGap() {
  const raw = process.env.DOJO_WALLHAVEN_MIN_INTERVAL_MS;
  return raw && /^\d+$/.test(raw) ? Number(raw) : 1000;
}

// Client HTTP : requêtes séquentielles espacées de wallhavenGap() ms (API et images), sans redirection suivie, avec délai maximal.
// deps (tests) : fetch, now, sleep.
function makeWallhaven(deps = {}) {
  const doFetch = deps.fetch || globalThis.fetch;
  const now = deps.now || Date.now;
  const pause = deps.sleep || sleep;
  const gap = wallhavenGap();
  const ua = userAgent();
  let last = null;
  async function spaced() {
    if (last !== null) {
      const left = last + gap - now();
      if (left > 0) await pause(left);
    }
    last = now();
  }
  async function request(url, timeoutMs) {
    try {
      return await doFetch(url, { headers: { 'User-Agent': ua }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) apiFail('délai dépassé en interrogeant Wallhaven.', true);
      apiFail('erreur réseau vers Wallhaven (connexion impossible ou redirection refusée).', true);
    }
  }
  function checkStatus(res) {
    if (res.ok) return;
    if (res.status === 403) apiFail('Wallhaven a refusé la requête.', true);
    if (res.status === 429) apiFail('trop de requêtes, réessayez plus tard.', true);
    if (res.status === 404) apiFail('fond introuvable sur Wallhaven (404).', false);
    apiFail(`réponse inattendue de Wallhaven (HTTP ${res.status}).`, false);
  }
  return {
    async json(url) {
      await spaced();
      const res = await request(url, API_TIMEOUT_MS);
      checkStatus(res);
      try { return await res.json(); } catch { return apiFail('réponse Wallhaven illisible.', false); }
    },
    async image(url) {
      await spaced();
      const res = await request(url, IMG_TIMEOUT_MS);
      checkStatus(res);
      return res;
    },
  };
}

// Corps de l'image plafonné à IMG_MAX_BYTES : Content-Length d'abord, puis comptage en streaming.
async function readCapped(res) {
  const tooBig = () => fail(`image trop lourde : ${IMG_MAX_BYTES / (1024 * 1024)} Mo maximum.`);
  const declared = res.headers.get('content-length');
  if (declared !== null && Number(declared) > IMG_MAX_BYTES) tooBig();
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > IMG_MAX_BYTES) tooBig();
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > IMG_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      tooBig();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

// URL de l'image : https, hôte exactement w.wallhaven.cc, sans identifiants ni port explicite.
function imageUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { fail('URL d\'image invalide.'); }
  if (u.protocol !== 'https:' || u.hostname !== WALLHAVEN_IMG_HOST || u.port !== '' || u.username !== '' || u.password !== '') {
    fail(`URL d'image refusée : seul https://${WALLHAVEN_IMG_HOST} est accepté.`);
  }
  return u;
}

// Écriture atomique en 0600 : temporaire créé en O_EXCL, puis rename (qui remplace un éventuel lien sans le suivre).
function writeSecret(dest, buf) {
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  try {
    fs.writeFileSync(tmp, buf, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// Dossier de galerie : créé en 0700, jamais un lien symbolique.
function ensureSafeDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory()) fail(`dossier refusé (lien symbolique ou fichier) : ${dir}`);
  fs.chmodSync(dir, 0o700);
}

// Vrai si le fichier a la signature de son format (lecture sans suivre les liens).
function magicMatches(file, kind) {
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return bgKind(buf.subarray(0, n)) === kind;
  } catch { return false; } finally { if (fd !== null) fs.closeSync(fd); }
}

// Fonds téléchargés d'un thème : backgrounds/<theme>/wallhaven-<id>.<ext>, fichiers réguliers au contenu valide, triés par nom.
function galleryFiles(theme) {
  const dir = galleryDir(theme);
  try { if (!fs.lstatSync(dir).isDirectory()) return []; } catch { return []; }
  let names = [];
  try { names = fs.readdirSync(dir).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = GALLERY_FILE_RE.exec(name);
    if (!m) continue;
    const file = path.join(dir, name);
    if (!isRegularFile(file) || !magicMatches(file, GALLERY_KIND[path.extname(name)])) continue;
    out.push({ id: m[1], file });
  }
  return out;
}

const galleryFileFor = (theme, id) => galleryFiles(theme).find((f) => f.id === id) || null;

// backgrounds/index.json : une entrée par (thème, id), pour les crédits (source, résolution). Lien ou contenu invalide = vide.
function readIndex() {
  if (!isRegularFile(indexFile())) return [];
  try {
    const v = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    return Array.isArray(v) ? v.filter(isObj) : [];
  } catch { return []; }
}

// Verrou d'écriture de index.json : index.json.lock, créé en wx (0600), contient le pid. Une écriture dure quelques ms :
// 20 essais espacés de 50 ms suffisent. Un verrou de plus de 10 s est repris (takeOverStale). Non obtenu = erreur,
// le fichier déjà téléchargé reste sans entrée d'index (un nouveau download la rajoute).
const indexLock = () => `${indexFile()}.lock`;
const INDEX_LOCK_TRIES = 20;
const INDEX_LOCK_WAIT_MS = 50;
const INDEX_LOCK_STALE_MS = 10 * 1000;

// Verrou d'index périmé : pas mis à jour depuis plus de INDEX_LOCK_STALE_MS (absent = périmé, l'appelant réessaie).
const indexLockIsStale = (file) => {
  try { return Date.now() - fs.lstatSync(file).mtimeMs > INDEX_LOCK_STALE_MS; } catch { return true; }
};

async function acquireIndexLock() {
  const lock = indexLock();
  for (let i = 0; i < INDEX_LOCK_TRIES; i += 1) {
    try {
      fs.writeFileSync(lock, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    if (indexLockIsStale(lock)) {
      takeOverStale(lock, indexLockIsStale);
      continue; // reprise (ou verrou déjà repris ailleurs) : nouvel essai sans attendre
    }
    await sleep(INDEX_LOCK_WAIT_MS);
  }
  fail('index des fonds occupé par un autre téléchargement : réessayez.');
}

// Libère seulement un verrou qui porte notre pid (un verrou repris entre-temps par un autre processus reste en place).
function releaseIndexLock() {
  const lock = indexLock();
  try {
    if (fs.readFileSync(lock, 'utf8').trim() === String(process.pid)) fs.rmSync(lock, { force: true });
  } catch { /* déjà libéré */ }
}

// Ajout d'une entrée : sous verrou, l'index est relu puis réécrit (atomiquement) : deux téléchargements concurrents ne se perdent pas.
async function recordDownload(entry) {
  ensureSafeDir(paths.backgrounds());
  await acquireIndexLock();
  try {
    const rest = readIndex().filter((e) => !(e.id === entry.id && e.theme === entry.theme));
    writeSecret(indexFile(), Buffer.from(JSON.stringify([...rest, entry], null, 2) + '\n'));
  } finally {
    releaseIndexLock();
  }
}

// Thème connu (listé par listThemes), ou erreur.
function knownTheme(arg) {
  const id = String(arg ?? '');
  if (!THEME_ID_RE.test(id)) fail('identifiant de thème attendu (lettres minuscules, chiffres, tirets).');
  if (!listThemes().some((t) => t.id === id)) fail(`thème inconnu : ${id}.`);
  return id;
}

const activeTheme = () => {
  const t = (readConfig() || {}).theme;
  return typeof t === 'string' && THEME_ID_RE.test(t) ? t : DEFAULT_THEME;
};

function themeJson(id) {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(paths.themes(), id, 'theme.json'), 'utf8'));
    return isObj(t) ? t : null;
  } catch { return null; }
}

// Galerie curée déclarée dans theme.json (champ wallpapers) : { ids, query, default }. ids peut contenir « bundled »
// (fond embarqué du thème, jamais téléchargé). default : id du fond à télécharger en premier, « bundled », ou null.
function curatedOf(theme) {
  const w = (themeJson(theme) || {}).wallpapers;
  const idOk = (v) => v === BUNDLED_ID || wallId(v);
  if (!isObj(w) || w.provider !== 'wallhaven' || !Array.isArray(w.ids) || !w.ids.every(idOk)
    || typeof w.query !== 'string' || w.query.trim() === '') {
    fail(`le thème ${theme} n'a pas de galerie Wallhaven valide (champ wallpapers de theme.json).`);
  }
  const def = w.default === undefined ? null : w.default;
  if (def !== null && !(idOk(def) && w.ids.includes(def))) {
    fail(`le thème ${theme} : wallpapers.default doit être un identifiant de ids (ou bundled).`);
  }
  return { ids: w.ids, query: w.query, default: def };
}

// Identifiants Wallhaven de la galerie : sans « bundled », sans doublon, dans l'ordre du pack.
const remoteIdsOf = (curated) => [...new Set(curated.ids.filter((id) => id !== BUNDLED_ID))];

// Id du fond par défaut à télécharger : null si le thème n'a pas de défaut, si le défaut est « bundled », ou sans galerie valide.
function defaultFileId(theme) {
  let def = null;
  try { def = curatedOf(theme).default; } catch { return null; }
  return def !== null && def !== BUNDLED_ID ? def : null;
}

// IDs curés du thème absents de la galerie (vide si le thème n'a pas de galerie valide).
function missingIds(theme) {
  let ids;
  try { ids = remoteIdsOf(curatedOf(theme)); } catch { return []; }
  const have = new Set(galleryFiles(theme).map((f) => f.id));
  return ids.filter((id) => !have.has(id));
}

// Fond courant remplaçable par le fond par défaut : aucun fond, ou un fichier de galerie (backgrounds/<theme>/).
// Un fond perso hors galerie n'est jamais remplacé.
const replaceableBackground = (bg) => typeof bg !== 'string' || bg === '' || galleryOwner(bg) !== null;

// Entrée commune aux réponses (list, search) : id, résolution, miniature, page source, téléchargement local.
function toEntry(d, locals) {
  const file = locals.get(d.id) || null;
  return {
    id: d.id,
    resolution: strOrNull(d.resolution),
    thumb: httpsOrNull(d.thumbs && d.thumbs.large),
    source: sourceOrNull(d.url),
    purity: strOrNull(d.purity),
    downloaded: file !== null,
    file,
  };
}

const localsOf = (theme) => new Map(galleryFiles(theme).map((f) => [f.id, f.file]));

async function wallpapersList(arg, api) {
  const theme = knownTheme(arg);
  const curated = curatedOf(theme);
  const ids = remoteIdsOf(curated);
  const locals = localsOf(theme);
  const wallpapers = [];
  const skipped = [];
  for (const id of ids) {
    let d;
    try {
      const body = await api.json(`${WALLHAVEN_API}/w/${id}`);
      d = body && isObj(body.data) ? body.data : apiFail('réponse Wallhaven inattendue.', false);
    } catch (e) {
      if (!(e instanceof SetupError) || e.fatal) throw e;
      skipped.push({ id, reason: e.message });
      continue;
    }
    if (d.id !== id) skipped.push({ id, reason: 'identifiant inattendu dans la réponse.' });
    else if (d.purity !== 'sfw') skipped.push({ id, reason: `contenu non SFW (${String(d.purity)}).` });
    else wallpapers.push(toEntry(d, locals));
  }
  return { ok: true, theme, query: curated.query, default: curated.default, wallpapers, skipped };
}

function parsePage(arg) {
  if (arg === undefined || arg === '') return 1;
  const n = Number(arg);
  if (!/^\d+$/.test(String(arg)) || n < 1 || n > 1000) fail('page attendue : entier entre 1 et 1000.');
  return n;
}

async function wallpapersSearch(themeArg, pageArg, api) {
  const theme = knownTheme(themeArg);
  const { query } = curatedOf(theme);
  const page = parsePage(pageArg);
  // purity=100 (SFW) forcé : aucun paramètre ne le change.
  const params = new URLSearchParams({
    q: query,
    purity: '100',
    categories: SEARCH_CATEGORIES[theme] || '010',
    atleast: '2560x1440',
    ratios: '16x10,16x9',
    sorting: 'favorites',
    page: String(page),
  });
  const body = await api.json(`${WALLHAVEN_API}/search?${params}`);
  if (!isObj(body) || !Array.isArray(body.data)) apiFail('réponse Wallhaven inattendue.', false);
  const meta = isObj(body.meta) ? body.meta : {};
  const lastPage = Number.isInteger(meta.last_page) && meta.last_page >= 1 ? meta.last_page : page;
  const locals = localsOf(theme);
  const wallpapers = body.data
    .filter((d) => isObj(d) && wallId(d.id) && d.purity === 'sfw')
    .map((d) => toEntry(d, locals));
  return { ok: true, theme, page, lastPage, wallpapers };
}

async function wallpapersDownload(idArg, themeArg, api) {
  const id = String(idArg ?? '');
  if (!WALLHAVEN_ID_RE.test(id)) fail('identifiant Wallhaven invalide (4 à 10 caractères : a-z et 0-9).');
  if (id === THEME_BG_ID || id === BUNDLED_ID) fail(`identifiant réservé : ${id} désigne le fond embarqué du thème.`);
  const theme = knownTheme(themeArg === undefined ? activeTheme() : themeArg);
  const body = await api.json(`${WALLHAVEN_API}/w/${id}`);
  const d = body && isObj(body.data) ? body.data : apiFail('réponse Wallhaven inattendue.', false);
  if (d.id !== id) fail('identifiant inattendu dans la réponse Wallhaven.');
  if (d.purity !== 'sfw') fail(`image refusée : contenu non SFW (${String(d.purity)}).`);
  const url = imageUrl(d.path);
  const ext = path.extname(url.pathname).toLowerCase();
  if (!GALLERY_KIND[ext]) fail(`format refusé (${ext || 'sans extension'}) : jpg, png ou webp attendu.`);
  const res = await api.image(url.href);
  const buf = await readCapped(res);
  if (bgKind(buf) !== GALLERY_KIND[ext]) {
    fail(`contenu incohérent avec l'extension ${ext} : ce fichier n'est pas une image ${GALLERY_KIND[ext].toUpperCase()} valide.`);
  }
  ensureSafeDir(paths.backgrounds());
  ensureSafeDir(galleryDir(theme));
  const file = path.join(galleryDir(theme), `wallhaven-${id}${ext}`);
  writeSecret(file, buf);
  const source = sourceOrNull(d.url);
  const resolution = strOrNull(d.resolution);
  await recordDownload({ id, theme, source, resolution, file, downloadedAt: new Date().toISOString() });
  return { ok: true, id, theme, file, source, resolution };
}

// Fond = fichier de galerie pour ce thème : config.background et config.backgroundByTheme[theme].
function applyGalleryFile(theme, file) {
  const cfg = readConfig() || {};
  const byTheme = isObj(cfg.backgroundByTheme) ? { ...cfg.backgroundByTheme } : {};
  byTheme[theme] = file;
  writeConfig({ background: file, backgroundByTheme: byTheme });
}

// Tous les fonds téléchargés d'un id, un par thème : backgrounds/<theme>/wallhaven-<id>.*, triés par nom de thème.
// Racine absente ou lien symbolique = aucun ; une galerie en lien ou un fichier invalide est ignoré (galleryFiles).
function downloadsOf(id) {
  try { if (!fs.lstatSync(paths.backgrounds()).isDirectory()) return []; } catch { return []; }
  let names = [];
  try { names = fs.readdirSync(paths.backgrounds()).sort(); } catch { return []; }
  const out = [];
  for (const theme of names) {
    if (!THEME_ID_RE.test(theme)) continue;
    const hit = galleryFileFor(theme, id);
    if (hit) out.push({ theme, file: hit.file });
  }
  return out;
}

// Fond téléchargé <id> : dans le thème donné ; sinon dans le thème actif ; sinon dans l'unique autre thème qui l'a.
// Présent dans plusieurs autres thèmes : erreur, il faut préciser le thème. config.theme n'est jamais modifié.
function downloadedFor(id, themeArg) {
  if (themeArg !== undefined) {
    const theme = knownTheme(themeArg);
    const hit = galleryFileFor(theme, id);
    if (!hit) fail(`fond ${id} non téléchargé pour le thème ${theme} (wallpapers download ${id} ${theme}).`);
    return { theme, file: hit.file };
  }
  const active = activeTheme();
  const found = downloadsOf(id);
  if (found.length === 0) fail(`fond ${id} non téléchargé (wallpapers download ${id} ${active}).`);
  const here = found.find((d) => d.theme === active);
  if (here) return here;
  if (found.length > 1) {
    fail(`fond ${id} téléchargé pour plusieurs thèmes (${found.map((d) => d.theme).join(', ')}) : précisez le thème, wallpapers use ${id} <theme>.`);
  }
  return found[0];
}

// use <id|fichier> [theme] : id = fond téléchargé (voir downloadedFor) ; fichier de galerie = pas de copie ;
// autre fichier = set-background. Le thème n'est accepté qu'avec un identifiant. theme et bundled : fond du thème (alias).
function wallpapersUse(arg, themeArg) {
  const value = String(arg ?? '');
  if (value === '') fail('identifiant ou chemin attendu : wallpapers use <id|fichier|theme|bundled> [theme].');
  if (value === THEME_BG_ID || value === BUNDLED_ID) {
    if (themeArg !== undefined) fail(`wallpapers use ${value} : pas de second argument, le thème actif est utilisé.`);
    return useThemeBackground();
  }
  if (WALLHAVEN_ID_RE.test(value)) {
    const hit = downloadedFor(value, themeArg);
    applyGalleryFile(hit.theme, hit.file);
    return { ok: true, background: hit.file, theme: hit.theme, id: value };
  }
  if (themeArg !== undefined) fail('thème accepté seulement avec un identifiant Wallhaven : wallpapers use <id> [theme].');
  const file = path.resolve(expandHome(value));
  const owner = galleryOwner(file);
  if (owner !== null) {
    if (!isRegularFile(file)) fail(`fichier introuvable dans la galerie : ${file}`);
    applyGalleryFile(owner, file);
    const m = GALLERY_FILE_RE.exec(path.basename(file));
    return { ok: true, background: file, theme: owner, id: m ? m[1] : null };
  }
  const set = setBackground(value);
  return { ok: true, background: set.background, theme: activeTheme(), id: null };
}

// Fond du thème (choix explicite) : config.background = null, et backgroundByTheme[thème actif] = sentinelle « theme » :
// set-theme et sync ne rétablissent plus le fond par défaut de ce thème. Même effet que
// set-background default : la copie directe éventuelle (backgrounds/<fichier>) est retirée, les galeries jamais.
function useThemeBackground() {
  const theme = activeTheme();
  const prev = (readConfig() || {}).background;
  writeConfig({ background: null, backgroundByTheme: { [theme]: THEME_BG_ID } });
  dropOldBackground(prev, null);
  return { ok: true, background: null, theme, id: THEME_BG_ID };
}

// Fond embarqué du thème (src/themes/<id>/background.jpg) : null si le fichier manque.
// current : config.background absent et thème actif.
function themeBuiltin(theme) {
  const file = path.join(paths.themes(), theme, 'background.jpg');
  if (!isRegularFile(file)) return null;
  const cfg = readConfig() || {};
  const bg = typeof cfg.background === 'string' && cfg.background !== '' ? cfg.background : null;
  return { id: THEME_BG_ID, file, source: null, resolution: null, current: bg === null && theme === activeTheme(), builtin: true };
}

// Liste des fonds d'un thème : fond du thème en tête pour naruto, en dernier pour les autres, puis les téléchargés.
function wallpapersLocal(arg) {
  const theme = knownTheme(arg);
  const current = (readConfig() || {}).background;
  const index = readIndex();
  const downloaded = galleryFiles(theme).map((f) => {
    const meta = index.find((e) => e.theme === theme && e.id === f.id) || {};
    return {
      id: f.id,
      file: f.file,
      source: sourceOrNull(meta.source),
      resolution: strOrNull(meta.resolution),
      current: f.file === current,
      builtin: false,
    };
  });
  const embedded = themeBuiltin(theme);
  let wallpapers = downloaded;
  if (embedded !== null) wallpapers = theme === DEFAULT_THEME ? [embedded, ...downloaded] : [...downloaded, embedded];
  return { ok: true, theme, count: downloaded.length, wallpapers };
}

// next : fond suivant dans la liste de local du thème actif (fond du thème compris), cyclique, depuis le fond courant.
function wallpapersNext() {
  const theme = activeTheme();
  const list = wallpapersLocal(theme).wallpapers;
  if (list.length === 0) fail(`aucun fond pour le thème ${theme} : ni fond du thème ni téléchargement (wallpapers download <id>).`);
  const at = list.findIndex((w) => w.current);
  const pick = list[(at + 1) % list.length];
  if (pick.builtin) {
    useThemeBackground();
    return { ok: true, background: null, theme, id: THEME_BG_ID, count: list.length };
  }
  applyGalleryFile(theme, pick.file);
  return { ok: true, background: pick.file, theme, id: pick.id, count: list.length };
}

// ── Synchronisation : wallpapers sync [theme], progression : wallpapers progress <theme> ─────────────
// Progression du thème : backgrounds/<theme>/.sync-progress.json = { pid, total, done, current }, 0600, écrite atomiquement.
// Le fichier sert aussi de verrou : pid vivant ET fichier mis à jour il y a moins de PROGRESS_FRESH_MS = sync en cours.
const progressFile = (theme) => path.join(galleryDir(theme), '.sync-progress.json');
const progressBytes = (state) => Buffer.from(JSON.stringify({ pid: process.pid, ...state }) + '\n');

// Contenu du fichier de progression (null si absent, illisible ou lien symbolique).
function readProgress(theme) {
  const file = progressFile(theme);
  if (!isRegularFile(file)) return null;
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return isObj(v) ? v : null; } catch { return null; }
}

// Vrai si le fichier de progression existe (fichier régulier) et a été mis à jour il y a moins de PROGRESS_FRESH_MS.
function progressFresh(theme) {
  try {
    const st = fs.lstatSync(progressFile(theme));
    return st.isFile() && Date.now() - st.mtimeMs < PROGRESS_FRESH_MS;
  } catch { return false; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Reprise d'un verrou périmé : rename vers « <verrou>.stale-<pid> ». Un seul processus gagne ce rename ; les autres
// reçoivent ENOENT (retour false) et l'appelant retente sa création. Le contrôle isStale porte sur le fichier
// effectivement renommé : s'il est redevenu vivant entre-temps (un autre processus l'a repris et recréé), il est remis
// en place sans écraser un verrou plus récent (retour false). Sinon il est supprimé (retour true).
function takeOverStale(lock, isStale) {
  const moved = `${lock}.stale-${process.pid}`;
  try {
    fs.renameSync(lock, moved);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  if (isStale(moved)) {
    fs.rmSync(moved, { force: true });
    return true;
  }
  try { fs.linkSync(moved, lock); } catch { /* un verrou plus récent existe déjà : il prime */ }
  fs.rmSync(moved, { force: true });
  return false;
}

// Verrou de sync vivant : fichier régulier mis à jour il y a moins de PROGRESS_FRESH_MS, pid vivant.
function progressIsLive(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || Date.now() - st.mtimeMs >= PROGRESS_FRESH_MS) return false;
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObj(v) && pidAlive(v.pid);
  } catch { return false; }
}

// Prend le verrou du thème : création exclusive (wx). Un verrou vivant bloque ; un verrou périmé (fichier ancien
// ou pid mort) est repris par takeOverStale, puis la création est retentée (3 tentatives au plus). Renvoie false si un autre sync tourne.
function acquireLock(theme, state) {
  const lock = progressFile(theme);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(lock, progressBytes(state), { mode: 0o600, flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    if (progressIsLive(lock)) return false;
    takeOverStale(lock, (f) => !progressIsLive(f));
  }
  return false;
}

// Fin de sync : retire la progression seulement si elle appartient à ce processus.
function releaseLock(theme) {
  const cur = readProgress(theme);
  if (cur && cur.pid === process.pid) fs.rmSync(progressFile(theme), { force: true });
}

// Fond par défaut appliqué à la fin de son téléchargement (sync), si le thème est le thème actif, qu'aucun choix n'est
// mémorisé pour lui (backgroundByTheme absent ou sentinelle absente) et que le fond courant est remplaçable (voir replaceableBackground).
function applyDefaultFile(theme, file) {
  if (theme !== activeTheme()) return false;
  const cfg = readConfig() || {};
  const remembered = isObj(cfg.backgroundByTheme) ? cfg.backgroundByTheme[theme] : undefined;
  if (remembered !== undefined && remembered !== null) return false;
  if (!replaceableBackground(cfg.background)) return false;
  applyGalleryFile(theme, file);
  return true;
}

// sync [theme] : télécharge les fonds curés (theme.json) pas encore présents, un par un, espacés (makeWallhaven).
// Le fond par défaut (wallpapers.default) passe en premier. « bundled » n'est jamais téléchargé.
// Erreur propre à un fond (404, non SFW, trop lourd, signature) : dans failed, on continue. Erreur bloquante
// (403, 429, réseau, délai) : le sync s'arrête proprement (stopped), ce qui est téléchargé reste.
// Le fond actif ne change qu'à la fin du téléchargement du défaut, si applyDefaultFile l'accepte (defaultApplied).
// Sans thème explicite et avec wallpapers.autoDownload à false : rien n'est fait. Un thème explicite reste une action manuelle.
async function wallpapersSync(themeArg, api) {
  if (themeArg === undefined && !autoDownloadOf(readConfig())) {
    return { ok: true, theme: activeTheme(), skipped: true, reason: 'autoDownload désactivé' };
  }
  const theme = knownTheme(themeArg === undefined ? activeTheme() : themeArg);
  const curated = curatedOf(theme);
  const defId = defaultFileId(theme);
  const ids = remoteIdsOf(curated);
  const order = defId === null ? ids : [defId, ...ids.filter((id) => id !== defId)];
  const have = new Set(galleryFiles(theme).map((f) => f.id));
  const skipped = order.filter((id) => have.has(id));
  const todo = order.filter((id) => !have.has(id));
  const total = order.length;
  const defaultId = curated.default;
  if (todo.length === 0) {
    return { ok: true, theme, defaultId, defaultApplied: false, total, downloaded: [], skipped, failed: [], stopped: null };
  }
  ensureSafeDir(paths.backgrounds());
  ensureSafeDir(galleryDir(theme));
  let done = skipped.length;
  if (!acquireLock(theme, { total, done, current: null })) return { ok: true, theme, alreadyRunning: true };
  const downloaded = [];
  const failed = [];
  let stopped = null;
  let defaultApplied = false;
  try {
    for (const id of todo) {
      writeSecret(progressFile(theme), progressBytes({ total, done, current: id }));
      try {
        const got = await wallpapersDownload(id, theme, api);
        downloaded.push(id);
        if (id === defId && applyDefaultFile(theme, got.file)) defaultApplied = true;
      } catch (e) {
        if (!(e instanceof SetupError) || e.fatal) {
          stopped = e && e.message ? e.message : String(e);
          break;
        }
        failed.push({ id, reason: e.message });
      }
      done += 1;
    }
  } finally {
    releaseLock(theme);
  }
  return { ok: true, theme, defaultId, defaultApplied, total, downloaded, skipped, failed, stopped };
}

// progress <theme> : running = progression mise à jour il y a moins de 90 s ; total et done du dernier sync.
function wallpapersProgress(arg) {
  const theme = knownTheme(arg);
  const p = readProgress(theme) || {};
  const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  return { ok: true, theme, running: progressFresh(theme), total: count(p.total), done: count(p.done) };
}

// Sous-commandes : wallpapers list|search|download|sync|progress|use|next|local. deps (fetch, now, sleep) : injectés par les tests.
async function wallpapers(args = [], deps = {}) {
  const [sub, a2, a3] = args;
  switch (sub) {
    case 'list': return wallpapersList(a2, makeWallhaven(deps));
    case 'search': return wallpapersSearch(a2, a3, makeWallhaven(deps));
    case 'download': return wallpapersDownload(a2, a3, makeWallhaven(deps));
    case 'sync': return wallpapersSync(a2, makeWallhaven(deps));
    case 'progress': return wallpapersProgress(a2);
    case 'use': return wallpapersUse(a2, a3);
    case 'next': return wallpapersNext();
    case 'local': return wallpapersLocal(a2);
    default: return fail('wallpapers attend list, search, download, sync, progress, use, next ou local.');
  }
}

// ── Terminal : Ghostty, Terminal.app et zsh (options indépendantes, toutes réversibles) ──
// Options : config.json, clé terminal {ghostty, terminalApp, welcome}. Fichiers générés dans ~/.config/claude-dojo/terminal/ :
// theme/ (copie de themes/<id>/terminal/), ghostty.conf, welcome.zsh. Dans les fichiers de l'utilisateur, Dojo ne gère
// qu'un bloc : une ligne marqueur + une ligne, ajoutées en fin de fichier (fin de ligne dominante du fichier). Le retrait
// supprime le marqueur et la ligne qui le suit seulement si celle-ci est une ligne gérée : le fichier retrouve ses octets
// d'origine, y compris sans retour ligne final.
const MARK_GHOSTTY = '# claude-dojo terminal theme (managed)';
const MARK_WELCOME = '# claude-dojo welcome (managed)';
const EMPTY_PLIST = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict/></plist>\n';
// Exécutables externes : injectables pour les tests (defaults ne doit jamais toucher le vrai domaine en test).
const termBin = {
  defaults: () => process.env.DOJO_DEFAULTS_BIN || 'defaults',
  pgrep: () => process.env.DOJO_PGREP_BIN || 'pgrep',
  plutil: () => process.env.DOJO_PLUTIL_BIN || 'plutil',
};
const termPaths = () => {
  const dir = paths.terminal();
  return { dir, theme: path.join(dir, 'theme'), ghosttyConf: path.join(dir, 'ghostty.conf'), welcome: path.join(dir, 'welcome.zsh') };
};
const prefsFile = () => path.join(home(), 'Library', 'Preferences', 'com.apple.Terminal.plist');
const isDirAt = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFileAt = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const readText = (file) => { try { return fs.readFileSync(realFile(file), 'utf8'); } catch { return ''; } };
// Ligne gérée par Dojo après un marqueur : seule celle-ci part avec lui au retrait (jamais une ligne utilisateur).
const MANAGED_LINE_RE = /^(?:source |\[\[ -r |config-file = \?)/;
// Ligne sans fin de ligne (\r\n, \n ou rien) : marqueurs et lignes se comparent ainsi, CRLF compris.
const bare = (s) => s.replace(/\r?\n?$/, '');
// Fin de ligne dominante d'un fichier (CRLF si la majorité de ses retours l'est) : celle des lignes ajoutées.
const dominantEol = (text) => {
  const all = (text.match(/\n/g) || []).length;
  const crlf = (text.match(/\r\n/g) || []).length;
  return crlf > all - crlf ? '\r\n' : '\n';
};
// Bloc en place : marqueur suivi d'une ligne gérée (sous n'importe quelle version de la ligne).
function hasBlock(text, marker) {
  const lines = text.split('\n');
  return lines.some((l, i) => bare(l) === marker && i + 1 < lines.length && MANAGED_LINE_RE.test(bare(lines[i + 1])));
}
const fileHash = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
// Application présente : dossiers d'applications (DOJO_APPS_DIRS en tests) ; /System/Applications sinon.
const appPresent = (name) => {
  const extra = process.env.DOJO_APPS_DIRS ? [] : ['/System/Applications', '/System/Applications/Utilities'];
  return [...appDirs(), ...extra].some((d) => fs.existsSync(path.join(d, name)));
};

// Ghostty : ~/.config/ghostty/config si présent, sinon config.ghostty d'Application Support si présent, sinon le premier (créé).
const ghosttyCandidates = () => [
  path.join(home(), '.config', 'ghostty', 'config'),
  path.join(home(), 'Library', 'Application Support', 'com.mitchellh.ghostty', 'config.ghostty'),
];
function ghosttyConfigFile() {
  const [a, b] = ghosttyCandidates();
  if (fs.existsSync(a)) return a;
  if (fs.existsSync(b)) return b;
  return a;
}
// Valeur Ghostty : brute si elle est sûre, sinon entre guillemets doubles (espaces, guillemets, antislash).
const ghosttyVal = (p) => (/[\s"\\]/.test(p) ? '"' + p.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' : p);

// ZDOTDIR tel que zsh le lit : variable d'environnement, sinon affectation dans ~/.zshenv (lu par zsh avant .zshrc).
// Lecture simple : dernière affectation ZDOTDIR=… (export facultatif, guillemets simples ou doubles), ~ et $HOME seuls
// sont développés. Une valeur plus complexe n'est pas devinée : dir vaut null.
function zdotdirInfo() {
  const fromEnv = (process.env.ZDOTDIR || '').trim();
  if (fromEnv) return { dir: expandHome(fromEnv), raw: fromEnv };
  const zshenv = path.join(home(), '.zshenv');
  const decls = readText(zshenv).split('\n').map(bare)
    .filter((l) => !/^\s*#/.test(l) && /(^|[\s;])ZDOTDIR=/.test(l));
  if (decls.length === 0) return { dir: home(), raw: null };
  const raw = decls[decls.length - 1].match(/ZDOTDIR=(.*)$/)[1].trim();
  const single = /^'([^']*)'$/.exec(raw);
  const double = /^"([^"]*)"$/.exec(raw);
  let v = single ? single[1] : double ? double[1] : raw.replace(/\s+#.*$/, '').trim();
  // Guillemets simples : aucune expansion. Guillemets doubles : pas d'expansion de ~ (comme zsh).
  if (!single) {
    v = v.replace(/\$\{HOME\}|\$HOME(?!\w)/g, home());
    if (!double) v = v.replace(/^~(?=\/|$)/, home());
  }
  if (v === '') return { dir: home(), raw };
  if (!path.isAbsolute(v) || /[$`]/.test(v)) return { dir: null, raw };
  return { dir: v, raw };
}
// Fichier .zshrc que zsh lira, et s'il est bien celui que Dojo modifie (effective) ; warning : texte si ça diverge.
function zshrcInfo() {
  const z = zdotdirInfo();
  if (z.dir === null) {
    return {
      file: path.join(home(), '.zshrc'),
      effective: false,
      warning: `ZDOTDIR est défini dans ~/.zshenv (${z.raw}) sans que Dojo puisse le lire : le bloc est écrit dans ~/.zshrc, que zsh ne lira peut-être pas. Vérifie la valeur avec « zsh -c 'echo $ZDOTDIR' ».`,
    };
  }
  return { file: path.join(z.dir, '.zshrc'), effective: true, warning: null };
}
const zshrcFile = () => zshrcInfo().file;
const zshrcCandidates = () => [...new Set([zshrcFile(), path.join(home(), '.zshrc')])];

// Retire chaque marqueur (toutes les occurrences). La ligne gérée qui le suit part avec lui ; une ligne utilisateur reste.
// Bloc en fin de fichier sans fin de ligne : le retour ajouté avant le marqueur part aussi (retrait octet pour octet).
// Sans marqueur, le texte est renvoyé à l'identique.
function stripBlock(text, marker) {
  if (text === '') return text;
  const parts = text.split(/(?<=\n)/);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (bare(parts[i]) !== marker) { out.push(parts[i]); continue; }
    const next = parts[i + 1];
    if (next === undefined || !MANAGED_LINE_RE.test(bare(next))) continue;
    i++;
    if (!next.endsWith('\n') && out.length) out[out.length - 1] = out[out.length - 1].replace(/\r?\n$/, '');
  }
  return out.join('');
}
// Ajoute ou remet à jour le bloc en fin de fichier. Bloc unique et déjà à jour : texte inchangé.
function setBlock(text, marker, line) {
  const lines = text.split('\n');
  const at = lines.flatMap((l, i) => (bare(l) === marker ? [i] : []));
  if (at.length === 1 && at[0] + 1 < lines.length && bare(lines[at[0] + 1]) === line) return text;
  const eol = dominantEol(text);
  const base = stripBlock(text, marker);
  const block = marker + eol + line;
  if (base === '') return block + eol;
  return base.endsWith('\n') ? base + block + eol : base + eol + block;
}

// Sauvegarde horodatée, jamais écrasée (deux sauvegardes dans la même seconde : suffixe -2, -3...).
function backupFile(real) {
  const base = `${real}.bak-${stampNow()}`;
  for (let n = 1; ; n++) {
    const dest = n === 1 ? base : `${base}-${n}`;
    try { fs.copyFileSync(real, dest, fs.constants.COPYFILE_EXCL); return dest; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}
// Modifie un fichier de config : sauvegarde puis écriture atomique. Rien si le texte ne change ; rien en dryRun.
function editConfigFile(file, transform, dryRun = false) {
  const real = realFile(file);
  const exists = fs.existsSync(real);
  const before = exists ? fs.readFileSync(real, 'utf8') : '';
  const after = transform(before);
  if (after === before) return { changed: false, backup: null };
  let backup = null;
  if (!dryRun) {
    if (exists) backup = backupFile(real);
    writeAtomic(file, after);
  }
  return { changed: true, backup };
}
// Retire le bloc de chaque fichier candidat qui le contient.
function removeBlocks(files, marker, dryRun) {
  let changed = false;
  let backup = null;
  for (const f of files) {
    const r = editConfigFile(f, (t) => stripBlock(t, marker), dryRun);
    if (r.changed) { changed = true; backup = backup || r.backup; }
  }
  return { changed, backup };
}
// Bloc géré : ajout ou mise à jour dans file, retrait de tous les autres candidats. action : added, updated, unchanged, removed, none.
function wireBlock(on, { file, candidates, marker, line }, dryRun = false) {
  if (!on) {
    const r = removeBlocks(candidates, marker, dryRun);
    return { file, action: r.changed ? 'removed' : 'none', changed: r.changed, backup: r.backup };
  }
  const existed = hasBlock(readText(file), marker);
  const others = removeBlocks(candidates.filter((f) => f !== file), marker, dryRun);
  const r = editConfigFile(file, (t) => setBlock(t, marker, line), dryRun);
  const changed = others.changed || r.changed;
  return { file, action: !changed ? 'unchanged' : existed ? 'updated' : 'added', changed, backup: r.backup || others.backup };
}
const ghosttyWire = (T) => ({ file: ghosttyConfigFile(), candidates: ghosttyCandidates(), marker: MARK_GHOSTTY, line: `config-file = ?${ghosttyVal(T.ghosttyConf)}` });
// Ligne gardée : zsh ignore la ligne (sans message) tant que welcome.zsh n'existe pas.
const welcomeLine = (file) => `[[ -r ${q(file)} ]] && source ${q(file)}`;
const welcomeWire = (T) => ({ file: zshrcFile(), candidates: zshrcCandidates(), marker: MARK_WELCOME, line: welcomeLine(T.welcome) });
const wireResult = (r, key) => ({ [key]: r.file, action: r.action, changed: r.changed, backup: r.backup });

// Shaders du thème installé (theme/shaders/*.glsl), triés. Ghostty : une ligne custom-shader par fichier.
// Un lien vers un .glsl compte (isFileAt suit le lien) : Dirent.isFile() serait faux pour lui.
function shaderFiles(theme) {
  const dir = path.join(theme, 'shaders');
  try {
    return fs.readdirSync(dir)
      .filter((n) => n.endsWith('.glsl') && isFileAt(path.join(dir, n)))
      .sort();
  } catch { return []; }
}
function ghosttyConfText(T) {
  return [
    `theme = ${ghosttyVal(path.join(T.theme, 'ghostty.theme'))}`,
    ...shaderFiles(T.theme).map((f) => `custom-shader = ${ghosttyVal(path.join(T.theme, 'shaders', f))}`),
    // true (valeur par défaut) : la boucle d'animation tourne quand la fenêtre a le focus ; « always » la ferait tourner aussi hors focus.
    'custom-shader-animation = true',
    'background-opacity = 0.88',
    'background-blur = 20',
    'window-colorspace = display-p3',
    'minimum-contrast = 1.1',
  ].join('\n') + '\n';
}

// Options : config.json (booléens manquants = false).
function terminalOptions() {
  const t = (readConfig() || {}).terminal;
  const o = isObj(t) ? t : {};
  return Object.fromEntries(TERM_KEYS.map((k) => [k, o[k] === true]));
}
// Profil Terminal importé par Dojo (state.json, managed.terminalApp), ou null.
function managedTerminal() {
  const m = readState().managed;
  return isObj(m) && isObj(m.terminalApp) ? m.terminalApp : null;
}
// Terminal.app lancé ? (pgrep -x : jamais de kill)
const terminalRunning = async () => (await run(termBin.pgrep(), ['-x', 'Terminal'], { timeout: 5000 })).ok;
// Un config.json existant mais illisible bloque tout : on ne touche à rien avant.
function checkConfigReadable() {
  if (fs.existsSync(path.join(paths.dojo(), 'config.json')) && readConfig() === null) {
    fail('config.json existant illisible : corrige-le ou déplace-le.');
  }
}

// Données nécessaires aux options demandées (vérifiées avant toute écriture).
function terminalSources(theme, want) {
  const out = { themeSrc: null, welcomeSrc: null, profile: null };
  if (want.ghostty || want.terminalApp) {
    const dir = path.join(paths.themes(), theme, 'terminal');
    if (!isDirAt(dir)) fail(`thème ${theme} : dossier terminal/ absent (${dir}).`);
    out.themeSrc = fs.realpathSync(dir);
    assertLinksInside(out.themeSrc, out.themeSrc);
    if (want.ghostty && !isFileAt(path.join(out.themeSrc, 'ghostty.theme'))) fail(`thème ${theme} : ghostty.theme absent.`);
    if (want.terminalApp && !isFileAt(path.join(out.themeSrc, 'Terminal.terminal'))) fail(`thème ${theme} : Terminal.terminal absent.`);
  }
  if (want.terminalApp) {
    const meta = listThemes().find((t) => t.id === theme);
    // Les points sont retirés : ils sépareraient les niveaux d'une clé plist.
    out.profile = ('Dojo ' + (meta ? meta.name : theme)).replace(/\./g, '');
  }
  if (want.welcome) {
    const w = path.join(paths.terminalSrc(), 'welcome.zsh');
    if (!isFileAt(w)) fail(`welcome.zsh introuvable : ${w}`);
    out.welcomeSrc = w;
  }
  return out;
}

// Préférences Terminal dans un fichier temporaire. Absentes : modèle vide. Renvoie true si elles existaient.
async function loadPrefs(plist) {
  if (!fs.existsSync(prefsFile())) { fs.writeFileSync(plist, EMPTY_PLIST); return false; }
  const r = await run(termBin.defaults(), ['export', 'com.apple.Terminal', plist]);
  if (!r.ok) fail(`defaults export com.apple.Terminal a échoué : ${r.stderr.trim() || 'erreur inconnue'}`);
  return true;
}
async function importPrefs(plist) {
  const r = await run(termBin.defaults(), ['import', 'com.apple.Terminal', plist]);
  if (!r.ok) fail(`defaults import com.apple.Terminal a échoué : ${r.stderr.trim() || 'erreur inconnue'}`);
}
async function withPrefsTmp(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-terminal-'));
  try { return await fn(path.join(tmp, 'prefs.plist')); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
// Sauvegarde des préférences exportées dans ~/.config/claude-dojo/backup/. Jamais écrasée : suffixe -2, -3...
function saveBackup(exported) {
  const dir = path.join(paths.dojo(), 'backup');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const data = fs.readFileSync(exported);
  const base = `com.apple.Terminal.${stampNow()}`;
  for (let n = 1; ; n++) {
    const dest = path.join(dir, `${base}${n === 1 ? '' : '-' + n}.plist`);
    try { fs.writeFileSync(dest, data, { mode: 0o600, flag: 'wx' }); return dest; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}
const plutil = (args) => run(termBin.plutil(), args, { timeout: 20000, maxBuffer: 16 << 20 });
// Valeur brute d'une clé de plist, ou null si absente.
async function plistRaw(file, key) {
  const r = await plutil(['-extract', key, 'raw', '-o', '-', file]);
  return r.ok ? r.stdout.replace(/\n$/, '') : null;
}
const keyExists = async (file, key) => (await plistRaw(file, key)) !== null;
// plutil qui doit réussir : erreur claire sinon (avant tout import).
async function plutilOk(args, what) {
  const r = await plutil(args);
  if (!r.ok) fail(`${what} : écriture impossible (${r.stderr.trim() || 'plutil'}).`);
}
// Après un échec à partir de l'import : préférences réimportées depuis la sauvegarde, puis erreur relancée (toujours).
async function restorePrefs(backup, err) {
  const r = await run(termBin.defaults(), ['import', 'com.apple.Terminal', backup]);
  if (!r.ok) fail(`${err.message} ; restauration impossible depuis ${backup} : ${r.stderr.trim() || 'defaults'}.`);
  fail(`${err.message} (préférences Terminal restaurées depuis ${backup}).`);
}
// Dictionnaire racine d'un fichier .terminal (plist XML), nom du profil remplacé.
function profileFragment(file, profile) {
  const m = fs.readFileSync(file, 'utf8').match(/<plist[^>]*>\s*(<dict>[\s\S]*<\/dict>)\s*<\/plist>/);
  if (!m) fail(`${file} : profil Terminal illisible (plist XML attendu).`);
  return m[1].replace(/(<key>name<\/key>\s*<string>)[^<]*(<\/string>)/, (_, a, b) => a + xmlEsc(profile) + b);
}

// Importe le profil dans Window Settings et le règle en fenêtre par défaut et au démarrage. Terminal lancé : rien n'est écrit,
// le fichier .terminal est renvoyé pour un double-clic (Terminal réécrit ses préférences à la fermeture).
// Les préférences exportées sont sauvegardées AVANT tout import (chemin dans state.managed.terminalApp.backup). Une erreur
// à partir de l'import (ou de l'écriture de l'état qui le suit) réimporte la sauvegarde puis relance l'erreur. Une erreur de
// plutil avant l'import ne touche pas au domaine : rien n'est importé.
async function terminalImport(file, profile) {
  const rec = managedTerminal();
  const hash = fileHash(file);
  const running = await terminalRunning();
  const out = (action, extra = {}) => ({ action, profile, file: null, running, changed: false, backup: null, ...extra });
  if (rec && rec.profile === profile && rec.hash === hash) return out('unchanged');
  if (running) return out('open-file', { file });
  return withPrefsTmp(async (plist) => {
    await loadPrefs(plist);
    const backup = saveBackup(plist);
    // Réimport : les défauts d'avant le premier import restent la référence, pour le retrait.
    const prevDefault = rec ? (rec.previousDefault ?? null) : await plistRaw(plist, 'Default Window Settings');
    const prevStartup = rec ? (rec.previousStartup ?? null) : await plistRaw(plist, 'Startup Window Settings');
    let touched = false;
    try {
      // -remove et -insert échouent (code 1) si la clé manque, resp. existe déjà : on ne les lance que s'ils sont utiles.
      if (rec && rec.profile !== profile && await keyExists(plist, `Window Settings.${rec.profile}`)) {
        await plutilOk(['-remove', `Window Settings.${rec.profile}`, plist], `profil Terminal « ${rec.profile} » (retrait)`);
      }
      if (!(await keyExists(plist, 'Window Settings'))) {
        await plutilOk(['-insert', 'Window Settings', '-dictionary', plist], 'Window Settings');
      }
      const rep = await plutil(['-replace', `Window Settings.${profile}`, '-xml', profileFragment(file, profile), plist]);
      if (!rep.ok) fail(`profil Terminal « ${profile} » : écriture impossible (${rep.stderr.trim() || 'plutil'}).`);
      for (const key of ['Default Window Settings', 'Startup Window Settings']) {
        const r = await plutil(['-replace', key, '-string', profile, plist]);
        if (!r.ok) fail(`${key} : écriture impossible (${r.stderr.trim() || 'plutil'}).`);
      }
      touched = true;
      await importPrefs(plist);
      setManaged('terminalApp', { profile, hash, previousDefault: prevDefault, previousStartup: prevStartup, backup });
    } catch (e) {
      if (touched) await restorePrefs(backup, e);
      throw e;
    }
    return out('imported', { changed: true });
  });
}

// Retire le profil importé et remet les défauts d'avant, seulement s'ils pointent encore vers lui.
async function terminalRemoveProfile(rec, dryRun) {
  const running = await terminalRunning();
  const out = (action, changed = false) => ({ action, profile: rec ? rec.profile : null, file: null, running, changed, backup: null });
  if (!rec) return out('none');
  if (running) return out('skipped');
  if (dryRun) return out('removed', true);
  return withPrefsTmp(async (plist) => {
    const existed = await loadPrefs(plist);
    if (existed) {
      // -remove échoue si la clé manque : on ne le lance que pour une clé présente. Un échec est une erreur (rien n'est importé).
      if (await keyExists(plist, `Window Settings.${rec.profile}`)) {
        await plutilOk(['-remove', `Window Settings.${rec.profile}`, plist], `profil Terminal « ${rec.profile} » (retrait)`);
      }
      const defaults = [
        ['Default Window Settings', rec.previousDefault ?? null],
        ['Startup Window Settings', rec.previousStartup ?? null],
      ];
      for (const [key, prev] of defaults) {
        if ((await plistRaw(plist, key)) !== rec.profile) continue; // changé par l'utilisateur : intouché
        if (prev === null) await plutilOk(['-remove', key, plist], `${key} (retrait)`);
        else {
          const r = await plutil(['-replace', key, '-string', prev, plist]);
          if (!r.ok) fail(`${key} : restauration impossible (${r.stderr.trim() || 'plutil'}).`);
        }
      }
      await importPrefs(plist);
    }
    setManaged('terminalApp', null);
    return out('removed', existed);
  });
}

// theme/ remplacé par une copie complète : copie dans theme.tmp-<pid>, puis renameSync. Une erreur pendant la copie laisse
// l'ancien theme/ en place : il n'est jamais à moitié copié.
function replaceThemeDir(src, dest) {
  const tmp = `${dest}.tmp-${process.pid}`;
  const old = `${dest}.old-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    fs.cpSync(src, tmp, { recursive: true, dereference: false, verbatimSymlinks: true });
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  const had = fs.existsSync(dest);
  if (had) fs.renameSync(dest, old);
  try {
    fs.renameSync(tmp, dest);
  } catch (e) {
    if (had) fs.renameSync(old, dest);
    throw e;
  }
  fs.rmSync(old, { recursive: true, force: true });
}

// Régénère tout ce qui est installé pour les options demandées, puis enregistre ces options. Options manquantes = celles enregistrées.
// theme : thème à appliquer (set-theme, avant d'écrire config.theme) ; sans lui, celui de config.json.
async function terminalApply(arg, theme = null) {
  checkConfigReadable();
  const recorded = terminalOptions();
  const want = arg === null ? recorded : { ...recorded, ...arg };
  const id = theme ?? themesInfo().theme;
  const src = terminalSources(id, want);
  const T = termPaths();
  const anyOn = TERM_KEYS.some((k) => want[k]);
  if (anyOn) {
    fs.mkdirSync(T.dir, { recursive: true, mode: 0o700 });
    if (want.ghostty || want.terminalApp) replaceThemeDir(src.themeSrc, T.theme);
    else fs.rmSync(T.theme, { recursive: true, force: true });
    if (want.ghostty) writeAtomic(T.ghosttyConf, ghosttyConfText(T));
    else fs.rmSync(T.ghosttyConf, { force: true });
    if (want.welcome) writeAtomic(T.welcome, fs.readFileSync(src.welcomeSrc));
    else fs.rmSync(T.welcome, { force: true });
  }
  const ghostty = wireResult(wireBlock(want.ghostty, ghosttyWire(T)), 'configPath');
  const z = zshrcInfo();
  // warning : seulement quand l'option zsh est active (sinon rien n'est écrit dans zsh).
  const welcome = {
    ...wireResult(wireBlock(want.welcome, welcomeWire(T)), 'zshrc'),
    effective: z.effective,
    warning: want.welcome ? z.warning : null,
  };
  if (!anyOn) fs.rmSync(T.dir, { recursive: true, force: true });
  // Options écrites avant l'import Terminal : si celui-ci échoue, config.json dit ce qui est déjà posé (Ghostty, zsh).
  writeConfig({ terminal: want });
  const terminalApp = want.terminalApp
    ? await terminalImport(path.join(T.theme, 'Terminal.terminal'), src.profile)
    : await terminalRemoveProfile(managedTerminal(), false);
  return { ok: true, theme: id, options: want, dir: T.dir, ghostty, terminalApp, welcome };
}

// Retire les composants sélectionnés (sel) : lignes, profil, fichiers. dropDir : retire aussi le dossier terminal/ (uninstall).
// Le dossier reste tant qu'une option reste active. Les options retirées sont marquées false dans config.json.
async function terminalRemove(sel, opts = {}) {
  const dryRun = opts.dryRun === true;
  const T = termPaths();
  const ghostty = sel.ghostty ? wireResult(wireBlock(false, ghosttyWire(T), dryRun), 'configPath') : null;
  const welcome = sel.welcome ? wireResult(wireBlock(false, welcomeWire(T), dryRun), 'zshrc') : null;
  const terminalApp = sel.terminalApp ? await terminalRemoveProfile(managedTerminal(), dryRun) : null;
  const was = terminalOptions();
  const left = { ...was };
  for (const k of TERM_KEYS) if (sel[k]) left[k] = false;
  if (!dryRun) {
    if (sel.ghostty) fs.rmSync(T.ghosttyConf, { force: true });
    if (sel.welcome) fs.rmSync(T.welcome, { force: true });
    if (!left.ghostty && !left.terminalApp) fs.rmSync(T.theme, { recursive: true, force: true });
    // Seules les options réellement actives passent à false : un retrait sans rien d'installé ne touche pas config.json.
    const patch = {};
    for (const k of TERM_KEYS) if (sel[k] && was[k]) patch[k] = false;
    if (Object.keys(patch).length && readConfig() !== null) writeConfig({ terminal: patch });
  }
  const dropDir = opts.dropDir === true || TERM_KEYS.every((k) => !left[k]);
  const dir = removeTree(T.dir, dropDir, dryRun);
  return { ok: true, dryRun, ghostty, terminalApp, welcome, dir, options: left };
}
async function terminalRemoveCli(raw) {
  const o = terminalArg(raw);
  const sel = {};
  for (const k of TERM_KEYS) sel[k] = o === null ? true : o[k] === true;
  return terminalRemove(sel);
}

// Argument terminal : objet {ghostty?, terminalApp?, welcome?} de booléens. Vide ou absent = null.
function terminalArg(raw) {
  const text = readArg(raw);
  if (text.trim() === '') return null;
  let o;
  try { o = JSON.parse(text); } catch (e) { fail(`JSON invalide en argument : ${e.message}`); }
  if (!isObj(o)) fail('options terminal : un objet JSON est attendu.');
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (!TERM_KEYS.includes(k)) fail(`option terminal inconnue : ${k} (attendu ghostty, terminalApp ou welcome).`);
    if (typeof v !== 'boolean') fail(`terminal.${k} doit être un booléen.`);
    out[k] = v;
  }
  return out;
}

// Lecture seule : options, état réel des fichiers et de Terminal.app.
async function terminalStatus() {
  const rec = managedTerminal();
  const z = zshrcInfo();
  return {
    ok: true,
    theme: themesInfo().theme,
    options: terminalOptions(),
    ghostty: {
      configPath: ghosttyConfigFile(),
      applied: ghosttyCandidates().some((f) => hasBlock(readText(f), MARK_GHOSTTY)),
      available: appPresent('Ghostty.app'),
    },
    terminalApp: { applied: rec !== null, running: await terminalRunning(), available: appPresent('Terminal.app') },
    welcome: {
      zshrc: z.file,
      applied: zshrcCandidates().some((f) => hasBlock(readText(f), MARK_WELCOME)),
      effective: z.effective,
      warning: z.warning,
    },
  };
}

// ── Dispatch CLI ─────────────────────────────────────────────────────────
const USAGE = [
  'node setup.js detect',
  'node setup.js write-config <json|->',
  'node setup.js themes',
  'node setup.js set-theme <id>',
  'node setup.js window-zone',
  'node setup.js set-background <chemin|default>',
  'node setup.js wallpapers list <theme>',
  'node setup.js wallpapers search <theme> [page]',
  'node setup.js wallpapers download <id> [theme]',
  'node setup.js wallpapers sync [theme]   (sans thème : rien si wallpapers.autoDownload vaut false)',
  'node setup.js wallpapers progress <theme>',
  'node setup.js wallpapers use <id|fichier> [theme]',
  'node setup.js wallpapers use theme|bundled',
  'node setup.js wallpapers next',
  'node setup.js wallpapers local <theme>',
  'node setup.js terminal status',
  'node setup.js terminal apply [{ghostty,terminalApp,welcome}|-]   (sans argument : options enregistrées)',
  'node setup.js terminal remove [{ghostty,terminalApp,welcome}|-]  (sans argument : tout)',
  'node setup.js geocode <ville>',
  'node setup.js install-files <srcdir>',
  'node setup.js upgrade-runtime <srcdir> [{appPath,noLaunchd}|-]   (runtime plus récent que l\'installé : copie + redémarrage de l\'agent)',
  'node setup.js npm-install [node]',
  'node setup.js merge-settings <json|->',
  'node setup.js unmerge-settings [json|->]',
  'node setup.js launchagents install|uninstall [json|->]   (Windows : valeurs HKCU\\...\\Run et lanceur start-agent.vbs)',
  'node setup.js ensure-wallpaper-exe   (Windows : DojoWallpaper.exe de la release (sha256 requis) ou compilé, remplace l\'existant ; DOJO_SKIP_EXE=1 : rien)',
  'node setup.js stop-processes   (Windows : arrête agent, collector, media.ps1 et DojoWallpaper.exe du dossier d\'installation)',
  'node setup.js uninstall [json|->]   (Windows : arrête les processus Dojo ; sans purge, config.json et backgrounds\\ restent)',
  'node setup.js status',
];

async function main(argv, deps = {}) {
  const [cmd, a1, a2] = argv;
  switch (cmd) {
    case undefined: case '-h': case '--help':
      return { ok: true, usage: USAGE };
    case 'detect': return detect();
    case 'write-config': return writeConfig(parseJsonArg(a1));
    case 'themes': return themesInfo();
    case 'set-theme': return setTheme(a1);
    case 'window-zone': return windowZoneInfo();
    case 'set-background': return setBackground(a1);
    case 'wallpapers': return wallpapers(argv.slice(1), deps);
    case 'terminal': {
      if (a1 === 'status') return terminalStatus();
      if (a1 === 'apply') return terminalApply(terminalArg(a2));
      if (a1 === 'remove') return terminalRemoveCli(a2);
      fail('terminal attend status, apply ou remove.');
      break;
    }
    case 'geocode': return geocode(readArg(a1));
    case 'install-files': return installFiles(readArg(a1));
    case 'upgrade-runtime': return upgradeRuntime(readArg(a1), parseJsonArg(a2));
    case 'npm-install': return npmInstall(a1 || null);
    case 'merge-settings': return mergeSettings(parseJsonArg(a1));
    case 'unmerge-settings': return unmergeSettings(parseJsonArg(a1));
    case 'launchagents': {
      const opts = parseJsonArg(a2);
      if (a1 === 'install') return WIN ? autostartInstall(opts) : launchAgentsInstall(opts);
      if (a1 === 'uninstall') return WIN ? autostartUninstall(opts) : launchAgentsUninstall(opts);
      fail('launchagents attend install ou uninstall.');
      break;
    }
    case 'ensure-wallpaper-exe': return ensureWallpaperExe();
    case 'stop-processes': return stopProcesses();
    case 'uninstall': return uninstall(parseJsonArg(a1));
    case 'status': return status();
    default: fail(`commande inconnue : ${cmd}`);
  }
  return null;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((out) => { process.stdout.write(JSON.stringify(out) + '\n'); })
    .catch((e) => {
      const msg = e instanceof SetupError ? e.message : (e && e.message) || String(e);
      process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
      process.exitCode = 1;
    });
}

module.exports = {
  main, detect, mergeSettings, unmergeSettings, writeConfig, installFiles,
  launchAgentsInstall, launchAgentsUninstall, uninstall, lineDiff, deepMerge, validateConfig,
  wallpapers, setTheme,
  terminalStatus, terminalApply, terminalRemove,
  // Windows (fonctions pures testables sur toute plateforme, voir test/setup-win.test.js).
  mergeTransform, unmergeTransform, cmdArg, scriptPath, vbsStr, launcherVbs, regArgs,
  autostartInstall, autostartUninstall, ensureWallpaperExe, dojoProcessTargets, RUN_KEY, RUN_AGENT, RUN_WALL,
};
