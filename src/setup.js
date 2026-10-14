#!/usr/bin/env node
// Claude Dojo : logique d'installation et de désinstallation (le gros de install.sh et uninstall.sh).
// Usage : node setup.js <commande> [argument]
//   argument : JSON en ligne de commande, ou « - » pour lire le JSON sur stdin.
// Sortie : une ligne JSON sur stdout. Succès : exit 0 {"ok":true,...}. Erreur : exit 1 {"ok":false,"error":"..."}.
// Node >= 18, aucune dépendance. Le HOME est relu à chaque appel (process.env.HOME, sinon os.homedir()).
// Tous les processus externes sont lancés avec execFile et un tableau d'arguments (jamais de shell).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile, execFileSync } = require('child_process');

const LABEL_AGENT = 'io.github.claude-dojo.agent';
const LABEL_WALL = 'io.github.claude-dojo.wallpaper';
const LEGACY_RE = /^com\.[^.]+\.claude-dojo\.(agent|wallpaper)$/;
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd'];
const RE = {
  hook: /claude-dojo\/hook\.js/,
  heavy: /claude-dojo\/heavy-gate\.js/,
  statusline: /claude-dojo\/statusline\.js/,
};
const RE_ANY_HEAVY = /heavy-gate\.js/;
const AGENT_PORT = 7777;

class SetupError extends Error {}
const fail = (msg) => { throw new SetupError(msg); };

// ── Chemins (HOME relu à chaque appel) ───────────────────────────────────
const home = () => process.env.HOME || os.homedir();
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
};

// ── Utilitaires ──────────────────────────────────────────────────────────
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cmdOf = (h) => [h.command, ...(Array.isArray(h.args) ? h.args : [])].join(' ');
const isDojo = (h, re) => isObj(h) && re.test(cmdOf(h));
// Argument pour un shell POSIX (Claude Code lance les commandes de hooks via sh -c) : guillemets doubles,
// avec \ " $ ` échappés. Pour un chemin ordinaire, le texte produit est celui d'avant (réglages déjà installés inchangés).
const q = (p) => '"' + String(p).replace(/["\\$`]/g, '\\$&') + '"';
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
function searchDirs(extra = []) {
  return [...new Set([...pathDirs(), ...extra, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
    path.join(home(), '.local', 'bin')])];
}
function findBin(name, extra = []) {
  for (const d of searchDirs(extra)) {
    const p = path.join(d, name);
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
function versionedBins(base, rel) {
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
    .map(({ n }) => path.join(base, n, rel, 'node'));
}

function nodeCandidates() {
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

async function detect() {
  const node = findNode();
  const gh = findBin('gh');
  let authed = false;
  // DOJO_DETECT_NO_GH_AUTH=1 : pas de sondage (tests, trousseau). Le jeton n'est jamais renvoyé.
  if (gh && process.env.DOJO_DETECT_NO_GH_AUTH !== '1') authed = (await run(gh, ['auth', 'token'], { timeout: 5000 })).ok;
  const dojo = paths.dojo();
  const labels = listLaunchAgentLabels(paths.launchAgents());
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
      installed: fs.existsSync(path.join(dojo, 'agent-mac.js')) || labels.length > 0,
      configDir: dojo,
      configExists: fs.existsSync(path.join(dojo, 'config.json')),
      launchAgents: labels,
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
const hasDojoIn = (list, re) => Array.isArray(list) && list.some((g) => isObj(g) && Array.isArray(g.hooks) && g.hooks.some((h) => isDojo(h, re)));

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
function mergeTransform(s, o) {
  const { node, dojo } = o;
  const wantHooks = o.hooks !== false;
  const wantHeavy = o.heavyGate === true;
  if (wantHooks || wantHeavy) { if (!isObj(s.hooks)) s.hooks = {}; }

  if (wantHooks) {
    for (const ev of HOOK_EVENTS) {
      const list = Array.isArray(s.hooks[ev]) ? s.hooks[ev] : [];
      s.hooks[ev] = setDojoGroup(list, RE.hook, {
        hooks: [{ type: 'command', command: q(node) + ' ' + q(dojo + '/hook.js'), async: true }],
      });
    }
  } else if (isObj(s.hooks)) {
    for (const ev of Object.keys(s.hooks)) {
      if (Array.isArray(s.hooks[ev])) s.hooks[ev] = setDojoGroup(s.hooks[ev], RE.hook, null);
    }
  }

  const vw = o.vitestWorkers !== undefined ? o.vitestWorkers : (wantHeavy ? true : undefined);
  const vwValue = vw === true ? '2' : (typeof vw === 'number' && vw > 0 ? String(Math.floor(vw)) : null);
  const dojoVitestValues = new Set(['2']);
  if (vwValue) dojoVitestValues.add(vwValue);

  if (wantHeavy) {
    s.hooks.PreToolUse = setDojoGroup(Array.isArray(s.hooks.PreToolUse) ? s.hooks.PreToolUse : [], RE.heavy, {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: q(node) + ' ' + q(dojo + '/heavy-gate.js'), timeout: 10 }],
    });
  } else if (o.heavyGate === false && isObj(s.hooks)) {
    const had = hasDojoIn(s.hooks.PreToolUse, RE.heavy);
    if (Array.isArray(s.hooks.PreToolUse)) s.hooks.PreToolUse = setDojoGroup(s.hooks.PreToolUse, RE.heavy, null);
    if (had && isObj(s.env) && dojoVitestValues.has(s.env.VITEST_MAX_WORKERS)) {
      delete s.env.VITEST_MAX_WORKERS;
      if (Object.keys(s.env).length === 0) delete s.env;
    }
  }

  if (vwValue) {
    if (!isObj(s.env)) s.env = {};
    if (s.env.VITEST_MAX_WORKERS === undefined) s.env.VITEST_MAX_WORKERS = vwValue;
  }

  const statusLine = { type: 'command', command: q(node) + ' ' + q(dojo + '/statusline.js'), refreshInterval: 30 };
  if (o.statusLine === 'replace') s.statusLine = statusLine;
  else if (o.statusLine === 'keep' && (!s.statusLine || isDojo(s.statusLine, RE.statusline))) s.statusLine = statusLine;
  // 'none' : statusLine jamais touchée
  return s;
}

// Retire uniquement ce que dojo a ajouté (même logique que uninstall.sh). Renvoie true si modifié.
function unmergeTransform(s) {
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
  if (heavyRemoved && isObj(s.env) && s.env.VITEST_MAX_WORKERS === '2') {
    delete s.env.VITEST_MAX_WORKERS;
    touched = true;
    if (Object.keys(s.env).length === 0) delete s.env;
  }
  return touched;
}

// Écriture commune : sauvegarde horodatée si le fichier existait, puis écriture (sauf dryRun).
function commitSettings(file, before, after, dryRun) {
  let backup = null;
  if (!dryRun) {
    if (before !== null) {
      backup = file + '.bak-' + stampNow();
      fs.copyFileSync(file, backup);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, after);
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
    if (!found) fail('Node.js 18 ou plus est introuvable (PATH, Homebrew, /usr/local, volta, nvm, fnm).');
    node = found.path;
  }
  const o = {
    node: canonical(node),
    dojo: paths.dojo(),
    hooks: opts.hooks !== false,
    statusLine: opts.statusLine || 'keep',
    heavyGate: typeof opts.heavyGate === 'boolean' ? opts.heavyGate : undefined,
    vitestWorkers: opts.vitestWorkers,
  };
  if (!['replace', 'keep', 'none'].includes(o.statusLine)) fail("statusLine doit valoir replace, keep ou none.");
  const { before, norm, obj } = readSettingsFile(file);
  mergeTransform(obj, o);
  const after = JSON.stringify(obj, null, 2) + '\n';
  const changed = norm === null || after !== norm;
  const backup = changed ? commitSettings(file, before, after, dryRun) : null;
  return settingsResult(file, norm, after, changed, dryRun, backup, {
    heavyGateThresholds: o.heavyGate === true ? heavyThresholds() : null,
  });
}

function unmergeSettings(opts = {}) {
  const file = paths.settings();
  const dryRun = opts.dryRun === true;
  const { before, norm, obj } = readSettingsFile(file);
  if (before === null) return { ok: true, changed: false, dryRun, file, backup: null, before: null, after: null, diff: '' };
  const touched = unmergeTransform(obj);
  const after = JSON.stringify(obj, null, 2) + '\n';
  const changed = touched && after !== norm;
  const backup = changed ? commitSettings(file, before, after, dryRun) : null;
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
}

// Écrit config.json (0600, dossier 0700). Ne renvoie jamais les valeurs (le jeton Sentry en fait partie).
function writeConfig(input) {
  const patch = normalizePatch(input);
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
  validateConfig(merged);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return { ok: true, path: file, mode: '0600', keys: Object.keys(merged) };
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
const RUNTIME_DIRS = new Set(['wallpaper', 'node_modules']);

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
    if (st.isDirectory() && RUNTIME_DIRS.has(name)) {
      if (lst.isDirectory()) assertLinksInside(from, real);
      items.push({ name, from, dir: true });
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
    if (dir) fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true });
    copied.push(dir ? name + '/' : name);
  }
  return { ok: true, copied, dest };
}

// npm install --omit=dev dans ~/.config/claude-dojo (node-ical), avec le npm du node détecté.
async function npmInstall(nodePath) {
  const dest = paths.dojo();
  if (!fs.existsSync(path.join(dest, 'package.json'))) fail(`package.json absent de ${dest} : lance d'abord install-files.`);
  const nodeBin = nodePath || (findNode() || {}).path || null;
  let npm = nodeBin ? path.join(path.dirname(nodeBin), 'npm') : null;
  if (!npm || !isExec(npm)) npm = findBin('npm');
  if (!npm) fail('npm introuvable (il vient normalement avec node).');
  const env = {
    ...process.env,
    PATH: [nodeBin ? path.dirname(nodeBin) : null, process.env.PATH].filter(Boolean).join(path.delimiter),
  };
  const r = await run(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent'],
    { cwd: dest, env, timeout: 600000, maxBuffer: 16 << 20 });
  if (!r.ok) fail(`npm install a échoué dans ${dest} (réseau ?). Relance l'installation une fois la connexion rétablie.`);
  return { ok: true, dest, nodeModules: fs.existsSync(path.join(dest, 'node_modules')) };
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
  const dryRun = opts.dryRun === true;
  const launchAgents = await launchAgentsUninstall({ dryRun, noLaunchd: opts.noLaunchd === true });
  const { app, appRemoved, appRemaining } = removeApps(dryRun);
  // settings.json illisible : signalé, laissé tel quel, le reste de la désinstallation continue.
  let settings;
  try { settings = unmergeSettings({ dryRun }); } catch (e) {
    settings = { changed: false, backup: null, diff: '', error: e.message || String(e) };
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
  };
}

// ── Dispatch CLI ─────────────────────────────────────────────────────────
const USAGE = [
  'node setup.js detect',
  'node setup.js write-config <json|->',
  'node setup.js geocode <ville>',
  'node setup.js install-files <srcdir>',
  'node setup.js npm-install [node]',
  'node setup.js merge-settings <json|->',
  'node setup.js unmerge-settings [json|->]',
  'node setup.js launchagents install|uninstall [json|->]',
  'node setup.js uninstall [json|->]',
  'node setup.js status',
];

async function main(argv) {
  const [cmd, a1, a2] = argv;
  switch (cmd) {
    case undefined: case '-h': case '--help':
      return { ok: true, usage: USAGE };
    case 'detect': return detect();
    case 'write-config': return writeConfig(parseJsonArg(a1));
    case 'geocode': return geocode(readArg(a1));
    case 'install-files': return installFiles(readArg(a1));
    case 'npm-install': return npmInstall(a1 || null);
    case 'merge-settings': return mergeSettings(parseJsonArg(a1));
    case 'unmerge-settings': return unmergeSettings(parseJsonArg(a1));
    case 'launchagents': {
      const opts = parseJsonArg(a2);
      if (a1 === 'install') return launchAgentsInstall(opts);
      if (a1 === 'uninstall') return launchAgentsUninstall(opts);
      fail('launchagents attend install ou uninstall.');
      break;
    }
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
};
