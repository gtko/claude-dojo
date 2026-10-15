// Tests du terminal Windows de src/setup.js : fragment Windows Terminal, blocs des profils PowerShell, accueil welcome.ps1,
// terminal status|apply|remove, set-theme et write-config. node:test.
// Simulé sur toute plateforme (DOJO_FORCE_PLATFORM=win32). Chaque test travaille dans un dossier temporaire : USERPROFILE
// et HOME (profil), LOCALAPPDATA (Windows Terminal) et DOJO_THEMES_DIR (thèmes factices) sont redéfinis. Les faux
// defaults, pgrep et plutil sont des chemins absents : un appel à l'un d'eux échouerait au lieu de toucher la machine.
// Le welcome.ps1 copié est celui de src/terminal/ (lecture seule).
'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SETUP = path.join(REPO, 'src', 'setup.js');
const TERM_SRC = path.join(REPO, 'src', 'terminal');
const IS_WIN = process.platform === 'win32';
const GUID = '{8f3e5a2c-6d1b-4e97-b0a4-3c9d7f15e264}';
const SCHEME_KEYS = ['background', 'foreground', 'cursorColor', 'selectionBackground', 'black', 'red', 'green', 'yellow', 'blue',
  'purple', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightPurple', 'brightCyan', 'brightWhite'];
const CREATED = [];
after(() => { for (const d of CREATED) fs.rmSync(d, { recursive: true, force: true }); });

// ── Helpers ──────────────────────────────────────────────────────────────
const write = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
const hex = (n) => '#' + n.toString(16).padStart(2, '0').repeat(3);
// ghostty.theme factice : 16 couleurs dérivées de base, plus fond, texte, curseur et sélection (comme les vrais thèmes).
const ghosttyTheme = (base, { skip15 = false } = {}) => [
  ...Array.from({ length: 16 }, (_, i) => i).filter((i) => !(skip15 && i === 15)).map((i) => `palette = ${i}=${hex(base + i)}`),
  `background = ${hex(base)}`,
  `foreground = ${hex(base + 0x80)}`,
  `cursor-color = ${hex(base + 0x20)}`,
  `selection-background = ${hex(base + 0x40)}`,
].join('\n') + '\n';
// Schéma attendu pour un thème de base donnée (même dérivation que ghosttyTheme).
function expectedScheme(name, base) {
  const ansi = Array.from({ length: 16 }, (_, i) => hex(base + i));
  const names = ['black', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white'];
  const scheme = { name, background: hex(base), foreground: hex(base + 0x80), cursorColor: hex(base + 0x20), selectionBackground: hex(base + 0x40) };
  names.forEach((n, i) => { scheme[n] = ansi[i]; });
  names.forEach((n, i) => { scheme['bright' + n[0].toUpperCase() + n.slice(1)] = ansi[8 + i]; });
  return scheme;
}
// Empreintes de tous les fichiers d'un dossier (sans dossiers vides) : deux relevés égaux = aucun changement.
function tree(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}
const without = (t, ...names) => Object.fromEntries(Object.entries(t).filter(([k]) => !names.includes(path.basename(k))));

// Environnement isolé : profil avec espace, LOCALAPPDATA, thèmes alpha et beta (complets), gamma (sans terminal/),
// delta (palette incomplète), et config.json sur alpha.
function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-termwin-'));
  CREATED.push(root);
  const home = path.join(root, 'profil utilisateur');
  const local = path.join(root, 'AppData Local');
  const themes = path.join(root, 'themes');
  for (const [id, name, base] of [['alpha', 'Alpha', 0x10], ['beta', 'Beta Theme', 0x60]]) {
    write(path.join(themes, id, 'theme.json'), JSON.stringify({ id, name }));
    write(path.join(themes, id, 'terminal', 'ghostty.theme'), ghosttyTheme(base));
    write(path.join(themes, id, 'terminal', 'logo.txt'), `LOGO-${id.toUpperCase()}\r\n`);
    write(path.join(themes, id, 'terminal', 'lists.txt'), `key1|mission\nkey2|jutsu\nl1|Tache ${id}\nl2|Sort ${id}\n`);
    write(path.join(themes, id, 'terminal', 'frames', 'frame_01.png'), 'image non copiée');
    write(path.join(themes, id, 'background.jpg'), `JPEG-${id}`);
  }
  write(path.join(themes, 'gamma', 'theme.json'), JSON.stringify({ id: 'gamma', name: 'Gamma' }));
  write(path.join(themes, 'delta', 'theme.json'), JSON.stringify({ id: 'delta', name: 'Delta' }));
  write(path.join(themes, 'delta', 'terminal', 'ghostty.theme'), ghosttyTheme(0x30, { skip15: true }));
  write(path.join(home, '.config', 'claude-dojo', 'config.json'), JSON.stringify({ theme: 'alpha' }) + '\n');
  fs.mkdirSync(local, { recursive: true });
  // PATH et Program Files contrôlés : pwsh.exe fictif dans bin (PowerShell 7 « installé »), rien sous Program Files.
  const bin = path.join(root, 'bin');
  write(path.join(bin, 'pwsh.exe'), '');
  const env = {
    PATH: [bin, path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(path.delimiter),
    SystemRoot: process.env.SystemRoot || '',
    TEMP: root,
    TMP: root,
    DOJO_FORCE_PLATFORM: 'win32',
    USERPROFILE: home,
    HOME: home,
    LOCALAPPDATA: local,
    ProgramW6432: path.join(root, 'Program Files'),
    ProgramFiles: path.join(root, 'Program Files'),
    DOJO_DOCUMENTS_DIR: path.join(home, 'Documents'), // jamais le vrai dossier Documents (registre)
    DOJO_THEMES_DIR: root, // setup.js lit <DOJO_THEMES_DIR>/themes/

    DOJO_TERMINAL_DIR: TERM_SRC,
    DOJO_DETECT_NO_GH_AUTH: '1',
    DOJO_APPS_DIRS: path.join(root, 'Applications'),
    DOJO_DEFAULTS_BIN: path.join(root, 'absent', 'defaults'),
    DOJO_PGREP_BIN: path.join(root, 'absent', 'pgrep'),
    DOJO_PLUTIL_BIN: path.join(root, 'absent', 'plutil'),
  };
  return {
    root, home, local, themes, env,
    fragment: path.join(local, 'Microsoft', 'Windows Terminal', 'Fragments', 'claude-dojo', 'claude-dojo.json'),
    fragmentsDir: path.join(local, 'Microsoft', 'Windows Terminal', 'Fragments', 'claude-dojo'),
    wtSettings: path.join(local, 'Microsoft', 'Windows Terminal', 'settings.json'),
    gen: path.join(home, '.config', 'claude-dojo', 'terminal'),
    ps7: path.join(home, 'Documents', 'PowerShell', 'profile.ps1'),
    ps5: path.join(home, 'Documents', 'WindowsPowerShell', 'profile.ps1'),
    cfg: path.join(home, '.config', 'claude-dojo', 'config.json'),
  };
}

// Lance setup.js avec l'environnement de E (+ extraEnv). Renvoie { code, out (JSON), raw, stderr }.
function cli(E, args, { input, extraEnv = {} } = {}) {
  const r = spawnSync(process.execPath, [SETUP, ...args], { env: { ...E.env, ...extraEnv }, input, encoding: 'utf8', timeout: 120000 });
  let out = null;
  try { out = JSON.parse(r.stdout.trim()); } catch { out = null; }
  return { code: r.status, out, raw: r.stdout.trim(), stderr: r.stderr };
}
const ok = (r) => { assert.equal(r.code, 0, r.raw + ' ' + r.stderr); assert.equal(r.out.ok, true, r.raw); return r.out; };
const fails = (r, re) => { assert.equal(r.code, 1, r.raw); assert.equal(r.out.ok, false, r.raw); assert.match(r.out.error, re); };
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const apply = (E, opts) => cli(E, ['terminal', 'apply', JSON.stringify(opts)]);
const BLOCK_RE = /# >>> claude-dojo >>>\r?\n[\s\S]*?\r?\n# <<< claude-dojo <<</g;

// ── Statut, sans rien installer ───────────────────────────────────────────

test('terminal status Windows : forme win32, rien d\'installé, ghostty et terminalApp ignorées, aucun fichier créé', () => {
  const E = makeEnv();
  const before = { home: tree(E.home), local: tree(E.local) };
  const s = ok(cli(E, ['terminal', 'status']));
  assert.equal(s.platform, 'win32');
  assert.equal(s.theme, 'alpha');
  assert.deepEqual(s.options, { windowsTerminal: false, welcome: false });
  assert.deepEqual(s.windowsTerminal, { installed: false, fragmentsDir: E.fragmentsDir, applied: false });
  assert.deepEqual(s.powershell, { profilePath: E.ps7, windowsPowerShellPath: E.ps5, welcome: false });
  assert.deepEqual(s.ghostty, { installed: false, applied: false, skipped: 'win32' });
  assert.deepEqual(s.terminalApp, { installed: false, applied: false, skipped: 'win32' });
  assert.deepEqual({ home: tree(E.home), local: tree(E.local) }, before, 'status ne écrit rien');
});

test('Windows Terminal installé : paquet Microsoft.WindowsTerminal (ou Preview) détecté, autre paquet ignoré', () => {
  const E = makeEnv();
  fs.mkdirSync(path.join(E.local, 'Packages', 'Microsoft.Autre_8wekyb3d8bbwe'), { recursive: true });
  assert.equal(ok(cli(E, ['terminal', 'status'])).windowsTerminal.installed, false);
  fs.mkdirSync(path.join(E.local, 'Packages', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe'), { recursive: true });
  assert.equal(ok(cli(E, ['terminal', 'status'])).windowsTerminal.installed, true);
});

// ── apply : fragment, profil, welcome ─────────────────────────────────────

test('apply Windows Terminal + welcome : fragment valide (schéma, GUID, palette du thème), profil Claude Dojo, fond du thème', () => {
  const E = makeEnv();
  const wtSettings = '{\n  // réglages de l\'utilisateur\n  "defaultProfile": "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}"\n}\n';
  write(E.wtSettings, wtSettings);
  const settingsBefore = fs.readFileSync(E.wtSettings);
  const out = ok(apply(E, { windowsTerminal: true, welcome: true }));
  assert.deepEqual(out.options, { windowsTerminal: true, welcome: true });
  assert.equal(out.windowsTerminal.action, 'added');
  assert.equal(out.windowsTerminal.path, E.fragment);
  assert.equal(out.ghostty.skipped, 'win32');
  assert.equal(out.terminalApp.skipped, 'win32');

  const frag = readJson(E.fragment);
  assert.deepEqual(Object.keys(frag).sort(), ['profiles', 'schemes']);
  assert.equal(frag.schemes.length, 1);
  assert.deepEqual(frag.schemes[0], expectedScheme('Claude Dojo Alpha', 0x10), 'schéma = palette de ghostty.theme (16 couleurs + fond, texte, curseur, sélection)');
  for (const k of SCHEME_KEYS) assert.match(frag.schemes[0][k], /^#[0-9a-f]{6}$/, k);
  assert.equal(frag.profiles.length, 1);
  assert.deepEqual(frag.profiles[0], {
    guid: GUID,
    name: 'Claude Dojo',
    commandline: 'powershell.exe -NoLogo',
    colorScheme: 'Claude Dojo Alpha',
    backgroundImage: path.join(E.themes, 'alpha', 'background.jpg'),
    backgroundImageOpacity: 0.25,
    backgroundImageStretchMode: 'uniformToFill',
  });
  // Le réglage de l'utilisateur n'est jamais touché.
  assert.ok(fs.readFileSync(E.wtSettings).equals(settingsBefore), 'settings.json de Windows Terminal intact, octet pour octet');
  // Accueil : welcome.ps1 et les seuls fichiers lus (logo, lists), pas de welcome.zsh ni de frames.
  assert.ok(fs.readFileSync(path.join(E.gen, 'welcome.ps1')).equals(fs.readFileSync(path.join(TERM_SRC, 'welcome.ps1'))));
  assert.deepEqual(fs.readdirSync(path.join(E.gen, 'theme')).sort(), ['lists.txt', 'logo.txt']);
  assert.equal(fs.existsSync(path.join(E.gen, 'welcome.zsh')), false);
  assert.equal(fs.readFileSync(path.join(E.gen, 'theme', 'logo.txt'), 'utf8'), 'LOGO-ALPHA\r\n');
  // Profils PowerShell : bloc unique dans chacun, créés (absents avant).
  for (const f of [E.ps7, E.ps5]) {
    const text = fs.readFileSync(f, 'utf8');
    assert.equal((text.match(BLOCK_RE) || []).length, 1, f);
    assert.match(text, /Join-Path \$env:USERPROFILE '\.config\\claude-dojo\\terminal\\welcome\.ps1'/);
  }
  assert.deepEqual(out.powershell.profiles.map((p) => p.action), ['created', 'created']);
  assert.deepEqual(readJson(E.cfg).terminal, { windowsTerminal: true, welcome: true });
  // Statut cohérent.
  const s = ok(cli(E, ['terminal', 'status']));
  assert.equal(s.windowsTerminal.applied, true);
  assert.equal(s.powershell.welcome, true);
});

test('apply deux fois : même résultat, fichiers inchangés, action unchanged, aucune sauvegarde', () => {
  const E = makeEnv();
  ok(apply(E, { windowsTerminal: true, welcome: true }));
  const first = { home: tree(E.home), local: tree(E.local) };
  const out = ok(apply(E, { windowsTerminal: true, welcome: true }));
  assert.equal(out.windowsTerminal.action, 'unchanged');
  assert.deepEqual(out.powershell.profiles.map((p) => p.action), ['unchanged', 'unchanged']);
  assert.deepEqual({ home: tree(E.home), local: tree(E.local) }, first);
  assert.equal(fs.readdirSync(path.dirname(E.ps7)).filter((n) => n.includes('.bak-')).length, 0);
});

test('apply sans fenêtre Windows Terminal : seul welcome est posé, fragment absent', () => {
  const E = makeEnv();
  const out = ok(apply(E, { welcome: true }));
  assert.equal(out.windowsTerminal.action, 'none');
  assert.equal(fs.existsSync(E.fragment), false);
  assert.equal(fs.existsSync(E.fragmentsDir), false);
  assert.equal(ok(cli(E, ['terminal', 'status'])).powershell.welcome, true);
});

test('ghostty et terminalApp demandées sous Windows : ignorées (skipped), aucune config Ghostty ni profil Terminal écrit', () => {
  const E = makeEnv();
  const out = ok(apply(E, { ghostty: true, terminalApp: true, windowsTerminal: true }));
  assert.deepEqual(out.ghostty, { installed: false, applied: false, skipped: 'win32' });
  assert.deepEqual(out.terminalApp, { installed: false, applied: false, skipped: 'win32' });
  assert.deepEqual(out.options, { windowsTerminal: true, welcome: false });
  assert.deepEqual(readJson(E.cfg).terminal, { windowsTerminal: true, welcome: false });
  assert.equal(fs.existsSync(path.join(E.home, '.config', 'ghostty')), false);
  assert.equal(fs.existsSync(path.join(E.home, 'Library')), false);
  assert.equal(fs.existsSync(path.join(E.gen, 'theme', 'ghostty.theme')), false, 'pas de copie de thème Ghostty');
});

// ── Préservation des profils PowerShell existants ─────────────────────────

test('profil PowerShell existant (BOM, CRLF, sans retour final) : octets d\'origine préservés, sauvegarde faite, retrait exact', () => {
  const E = makeEnv();
  const original = Buffer.from('\uFEFFSet-Alias ll Get-ChildItem\r\nfunction Get-Eau { "été" }', 'utf8');
  fs.mkdirSync(path.dirname(E.ps5), { recursive: true });
  fs.writeFileSync(E.ps5, original);
  fs.mkdirSync(path.dirname(E.ps7), { recursive: true });
  fs.writeFileSync(E.ps7, original);
  ok(apply(E, { welcome: true }));
  for (const f of [E.ps5, E.ps7]) {
    const now = fs.readFileSync(f);
    assert.ok(now.subarray(0, original.length).equals(original), 'contenu d\'origine en tête, octet pour octet');
    assert.equal(now[0], 0xEF, 'BOM conservée');
    assert.equal(now.toString('utf8').match(BLOCK_RE).length, 1);
  }
  const backups = fs.readdirSync(path.dirname(E.ps5)).filter((n) => n.startsWith('profile.ps1.bak-'));
  assert.equal(backups.length, 1, 'une sauvegarde du profil existant');
  assert.ok(fs.readFileSync(path.join(path.dirname(E.ps5), backups[0])).equals(original), 'sauvegarde = contenu d\'origine');
  ok(cli(E, ['terminal', 'remove']));
  assert.ok(fs.readFileSync(E.ps5).equals(original), 'retrait : profil identique à l\'origine');
  assert.ok(fs.readFileSync(E.ps7).equals(original), 'retrait : profil identique à l\'origine');
});

test('profil PowerShell existant avec retour final CRLF : retrait restitue les octets exacts', () => {
  const E = makeEnv();
  const original = Buffer.from('# mon profil\r\n$x = 1\r\n', 'utf8');
  fs.mkdirSync(path.dirname(E.ps7), { recursive: true });
  fs.writeFileSync(E.ps7, original);
  ok(apply(E, { welcome: true }));
  assert.equal(fs.readFileSync(E.ps7, 'utf8').match(BLOCK_RE).length, 1);
  ok(apply(E, { welcome: false }));
  assert.ok(fs.readFileSync(E.ps7).equals(original));
  assert.equal(hasBlockOf(E.ps7), false);
});
function hasBlockOf(f) { return fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('# >>> claude-dojo >>>'); }

// ── Profils non UTF-8 : jamais réécrits, avertissement ───────────────────

test('profil cp1252 (« é » en 0xE9) : skipped à l\'apply et au retrait, fichier octet pour octet identique, pas de sauvegarde', () => {
  const E = makeEnv();
  const original = Buffer.from('# été\r\n$x = 1\r\n', 'latin1'); // 0xE9 seul : pas de l'UTF-8 valide
  fs.mkdirSync(path.dirname(E.ps5), { recursive: true });
  fs.writeFileSync(E.ps5, original);
  fs.mkdirSync(path.dirname(E.ps7), { recursive: true });
  fs.writeFileSync(E.ps7, original);
  const out = ok(apply(E, { welcome: true }));
  assert.deepEqual(out.powershell.profiles.map((p) => p.action), ['skipped', 'skipped']);
  for (const p of out.powershell.profiles) {
    assert.match(p.warning, /^profil non UTF-8 \(non UTF-8\), ajoutez manuellement dans /);
    assert.match(p.warning, /# >>> claude-dojo >>>/, 'le bloc à ajouter à la main figure dans l\'avertissement');
  }
  assert.ok(fs.readFileSync(E.ps5).equals(original), 'profil Windows PowerShell identique, octet pour octet');
  assert.ok(fs.readFileSync(E.ps7).equals(original), 'profil PowerShell 7 identique, octet pour octet');
  assert.deepEqual(fs.readdirSync(path.dirname(E.ps5)).filter((n) => n.includes('.bak-')), [], 'aucune sauvegarde');
  assert.equal(ok(cli(E, ['terminal', 'status'])).powershell.welcome, false, 'accueil non posé');
  const rm = ok(cli(E, ['terminal', 'remove']));
  assert.deepEqual(rm.powershell.profiles.map((p) => p.action), ['skipped', 'skipped']);
  assert.ok(fs.readFileSync(E.ps5).equals(original), 'retrait : profil identique');
  assert.ok(fs.readFileSync(E.ps7).equals(original), 'retrait : profil identique');
});

test('profil UTF-16LE (BOM FF FE) et UTF-16 sans BOM (octets nuls) : skipped, fichiers identiques, retrait aussi skipped', () => {
  const E = makeEnv();
  const utf16 = Buffer.from('﻿# profil\r\n$x = 1\r\n', 'utf16le');
  const noBom = Buffer.from('# profil\r\n', 'utf16le');
  fs.mkdirSync(path.dirname(E.ps5), { recursive: true });
  fs.writeFileSync(E.ps5, utf16);
  fs.mkdirSync(path.dirname(E.ps7), { recursive: true });
  fs.writeFileSync(E.ps7, noBom);
  const out = ok(apply(E, { welcome: true }));
  const byPath = Object.fromEntries(out.powershell.profiles.map((p) => [p.path, p]));
  assert.equal(byPath[E.ps5].action, 'skipped');
  assert.match(byPath[E.ps5].warning, /^profil non UTF-8 \(UTF-16\)/);
  assert.equal(byPath[E.ps7].action, 'skipped');
  assert.match(byPath[E.ps7].warning, /^profil non UTF-8 \(octets nuls\)/);
  assert.ok(fs.readFileSync(E.ps5).equals(utf16), 'UTF-16 avec BOM : identique');
  assert.ok(fs.readFileSync(E.ps7).equals(noBom), 'UTF-16 sans BOM : identique');
  const rm = ok(cli(E, ['terminal', 'remove']));
  assert.deepEqual(rm.powershell.profiles.map((p) => p.action), ['skipped', 'skipped']);
  assert.ok(fs.readFileSync(E.ps5).equals(utf16) && fs.readFileSync(E.ps7).equals(noBom), 'retrait : fichiers identiques');
});

test('profil UTF-8 avec BOM et CRLF : bloc ajouté puis retiré, BOM et octets d\'origine restitués, aucun avertissement', () => {
  const E = makeEnv();
  const original = Buffer.from('﻿# été\r\n$x = 1\r\n', 'utf8');
  fs.mkdirSync(path.dirname(E.ps5), { recursive: true });
  fs.writeFileSync(E.ps5, original);
  const out = ok(apply(E, { welcome: true }));
  const p5 = out.powershell.profiles.find((p) => p.path === E.ps5);
  assert.equal(p5.action, 'added', 'bloc ajouté dans le profil existant');
  assert.equal(p5.warning, undefined);
  const now = fs.readFileSync(E.ps5);
  assert.equal(now[0], 0xEF, 'BOM conservée');
  assert.ok(now.subarray(0, original.length).equals(original), 'contenu d\'origine en tête');
  ok(cli(E, ['terminal', 'remove']));
  assert.ok(fs.readFileSync(E.ps5).equals(original), 'retrait : octets d\'origine restitués');
});

// ── PowerShell 7 : posé seulement si installé ou si son profil existe ─────

test('pwsh absent (ni dans PATH ni sous Program Files\\PowerShell\\7) : profil PowerShell 7 non créé, Windows PowerShell 5.1 seul', () => {
  const E = makeEnv();
  E.env.PATH = path.join(E.root, 'vide');
  const out = ok(apply(E, { welcome: true }));
  assert.deepEqual(out.powershell.profiles.map((p) => [p.path, p.action]), [[E.ps5, 'created']]);
  assert.equal(fs.existsSync(E.ps7), false, 'PowerShell\\profile.ps1 non créé');
  assert.equal(ok(cli(E, ['terminal', 'status'])).powershell.welcome, true, 'statut : accueil posé dans WindowsPowerShell');
  ok(cli(E, ['terminal', 'remove']));
  assert.equal(fs.existsSync(E.ps5), false, 'profil créé par Dojo supprimé au retrait');
});

test('pwsh seulement sous Program Files\\PowerShell\\7 : profil PowerShell 7 créé', () => {
  const E = makeEnv();
  E.env.PATH = path.join(E.root, 'vide');
  fs.mkdirSync(path.join(E.env.ProgramW6432, 'PowerShell', '7'), { recursive: true });
  const out = ok(apply(E, { welcome: true }));
  assert.deepEqual(out.powershell.profiles.map((p) => p.action), ['created', 'created']);
  assert.equal(fs.existsSync(E.ps7), true);
});

test('profil PowerShell 7 déjà présent sans pwsh installé : bloc posé dedans', () => {
  const E = makeEnv();
  E.env.PATH = path.join(E.root, 'vide');
  fs.mkdirSync(path.dirname(E.ps7), { recursive: true });
  fs.writeFileSync(E.ps7, '# mon profil 7\r\n');
  const out = ok(apply(E, { welcome: true }));
  assert.deepEqual(out.powershell.profiles.map((p) => p.action), ['added', 'created']);
  assert.equal(hasBlockOf(E.ps7), true);
});

// ── Dossier Documents : DOJO_DOCUMENTS_DIR ────────────────────────────────

test('DOJO_DOCUMENTS_DIR : profils posés dans ce dossier, rien sous Documents du profil', () => {
  const E = makeEnv();
  const docs = path.join(E.root, 'OneDrive', 'Documents');
  E.env.DOJO_DOCUMENTS_DIR = docs;
  ok(apply(E, { welcome: true }));
  const ps5 = path.join(docs, 'WindowsPowerShell', 'profile.ps1');
  const ps7 = path.join(docs, 'PowerShell', 'profile.ps1');
  assert.equal(hasBlockOf(ps5), true);
  assert.equal(hasBlockOf(ps7), true);
  assert.equal(fs.existsSync(path.join(E.home, 'Documents')), false, 'Documents du profil non créé');
  assert.equal(ok(cli(E, ['terminal', 'status'])).powershell.profilePath, ps7);
  ok(cli(E, ['terminal', 'remove']));
  assert.equal(fs.existsSync(ps5), false);
  assert.equal(fs.existsSync(ps7), false);
});

// ── remove ────────────────────────────────────────────────────────────────

test('remove après apply : fragment et dossier claude-dojo retirés, profils créés supprimés, terminal\\ retiré, retour à l\'état initial', () => {
  const E = makeEnv();
  const initial = { home: without(tree(E.home), 'config.json'), local: tree(E.local) };
  ok(apply(E, { windowsTerminal: true, welcome: true }));
  const out = ok(cli(E, ['terminal', 'remove']));
  assert.equal(out.windowsTerminal.action, 'removed');
  assert.equal(out.windowsTerminal.dirRemoved, true);
  assert.deepEqual(out.powershell.profiles.map((p) => p.deleted), [true, true], 'profils créés par Dojo et vides : supprimés');
  assert.equal(fs.existsSync(E.fragmentsDir), false);
  assert.equal(fs.existsSync(E.gen), false);
  assert.deepEqual(readJson(E.cfg).terminal, { windowsTerminal: false, welcome: false });
  assert.deepEqual({ home: without(tree(E.home), 'config.json'), local: tree(E.local) }, initial);
  const s = ok(cli(E, ['terminal', 'status']));
  assert.equal(s.windowsTerminal.applied, false);
  assert.equal(s.powershell.welcome, false);
});

test('remove sans apply : ok:true, aucun changement, config.json intact', () => {
  const E = makeEnv();
  const before = { home: tree(E.home), local: tree(E.local) };
  const out = ok(cli(E, ['terminal', 'remove']));
  assert.equal(out.windowsTerminal.action, 'none');
  assert.deepEqual(out.powershell.profiles.map((p) => p.action), ['none', 'none']);
  assert.deepEqual({ home: tree(E.home), local: tree(E.local) }, before);
});

test('remove ne touche pas au settings.json de Windows Terminal ni au reste du dossier Windows Terminal', () => {
  const E = makeEnv();
  write(E.wtSettings, '{"actions":[]}\n');
  write(path.join(path.dirname(E.wtSettings), 'state.json'), '{"x":1}\n');
  const wt = tree(path.dirname(E.wtSettings));
  ok(apply(E, { windowsTerminal: true }));
  ok(cli(E, ['terminal', 'remove', '{"windowsTerminal":true}']));
  assert.deepEqual(tree(path.dirname(E.wtSettings)), wt, 'dossier Windows Terminal identique à l\'origine');
  assert.equal(fs.readdirSync(path.dirname(E.wtSettings)).filter((n) => n.includes('.bak')).length, 0, 'aucune sauvegarde dans le dossier Windows Terminal');
});

test('remove ciblé : seule l\'option demandée est retirée, l\'autre reste posée', () => {
  const E = makeEnv();
  ok(apply(E, { windowsTerminal: true, welcome: true }));
  const out = ok(cli(E, ['terminal', 'remove', '{"welcome":true}']));
  assert.equal(out.powershell.profiles[0].action, 'removed');
  assert.equal(fs.existsSync(E.fragment), true, 'fragment toujours là');
  assert.equal(fs.existsSync(path.join(E.gen, 'welcome.ps1')), false);
  assert.deepEqual(readJson(E.cfg).terminal, { windowsTerminal: true, welcome: false });
  assert.equal(hasBlockOf(E.ps7), false);
});

// ── set-theme, write-config, erreurs ──────────────────────────────────────

test('set-theme avec options Windows actives : fragment et accueil régénérés pour le nouveau thème', () => {
  const E = makeEnv();
  ok(apply(E, { windowsTerminal: true, welcome: true }));
  const out = ok(cli(E, ['set-theme', 'beta']));
  assert.equal(out.regenerated, true);
  assert.equal(out.terminal.theme, 'beta');
  const frag = readJson(E.fragment);
  assert.equal(frag.schemes[0].name, 'Claude Dojo Beta Theme');
  assert.deepEqual(frag.schemes[0], expectedScheme('Claude Dojo Beta Theme', 0x60));
  assert.equal(frag.profiles[0].colorScheme, 'Claude Dojo Beta Theme');
  assert.equal(frag.profiles[0].backgroundImage, path.join(E.themes, 'beta', 'background.jpg'));
  assert.equal(fs.readFileSync(path.join(E.gen, 'theme', 'logo.txt'), 'utf8'), 'LOGO-BETA\r\n');
  assert.equal(readJson(E.cfg).theme, 'beta');
});

test('set-theme vers un thème sans terminal/ : erreur, config.json et fragment inchangés', () => {
  const E = makeEnv();
  ok(apply(E, { windowsTerminal: true }));
  const fragBefore = fs.readFileSync(E.fragment);
  const cfgBefore = fs.readFileSync(E.cfg);
  fails(cli(E, ['set-theme', 'gamma']), /thème gamma : dossier terminal\/ absent/);
  assert.ok(fs.readFileSync(E.fragment).equals(fragBefore));
  assert.ok(fs.readFileSync(E.cfg).equals(cfgBefore));
});

test('palette incomplète (couleur 15 absente de ghostty.theme) : set-theme refusé, config.json et fragment inchangés', () => {
  const E = makeEnv();
  ok(apply(E, { windowsTerminal: true }));
  const fragBefore = fs.readFileSync(E.fragment);
  const cfgBefore = fs.readFileSync(E.cfg);
  fails(cli(E, ['set-theme', 'delta']), /thème delta : couleur 15 absente de ghostty\.theme/);
  assert.ok(fs.readFileSync(E.fragment).equals(fragBefore));
  assert.ok(fs.readFileSync(E.cfg).equals(cfgBefore));
});

test('write-config accepte windowsTerminal (booléen) et refuse une autre valeur', () => {
  const E = makeEnv();
  ok(cli(E, ['write-config', '{"terminal":{"windowsTerminal":true}}']));
  assert.equal(readJson(E.cfg).terminal.windowsTerminal, true);
  fails(cli(E, ['write-config', '{"terminal":{"windowsTerminal":"oui"}}']), /terminal\.windowsTerminal doit être un booléen\./);
});

test('arguments terminal : option inconnue et valeur non booléenne refusées, rien écrit', () => {
  const E = makeEnv();
  const cfgBefore = fs.readFileSync(E.cfg);
  fails(apply(E, { welcome: 'oui' }), /terminal\.welcome doit être un booléen\./);
  fails(apply(E, { foo: true }), /option terminal inconnue : foo/);
  assert.ok(fs.readFileSync(E.cfg).equals(cfgBefore));
  assert.equal(fs.existsSync(E.gen), false);
});

test('plateforme darwin simulée : status sans windowsTerminal, apply windowsTerminal refusé (comportement macOS inchangé)', () => {
  const E = makeEnv();
  const extra = { DOJO_FORCE_PLATFORM: 'darwin' };
  const s = ok(cli(E, ['terminal', 'status'], { extraEnv: extra }));
  assert.deepEqual(Object.keys(s.options).sort(), ['ghostty', 'terminalApp', 'welcome']);
  fails(cli(E, ['terminal', 'apply', '{"windowsTerminal":true}'], { extraEnv: extra }), /option terminal inconnue : windowsTerminal \(attendu ghostty, terminalApp ou welcome\)/);
  assert.equal(fs.existsSync(E.fragment), false);
});

// ── welcome.ps1 et profils : syntaxe et rendu (Windows PowerShell 5.1) ────

test('fichiers ASCII seul : welcome.ps1 et bloc du profil (Windows PowerShell 5.1 lit un .ps1 sans BOM en ANSI)', () => {
  const welcome = fs.readFileSync(path.join(TERM_SRC, 'welcome.ps1'));
  assert.ok([...welcome].every((b) => b < 0x80), 'welcome.ps1 ASCII');
  const E = makeEnv();
  ok(apply(E, { welcome: true }));
  assert.ok([...fs.readFileSync(E.ps7)].every((b) => b < 0x80), 'profil PowerShell 7 ASCII (bloc seul)');
});

// Windows PowerShell 5.1 (présent sur Windows 10 et 11) : analyse et rendu réels.
const PS_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
test('syntaxe PowerShell : welcome.ps1 et profils avec bloc analysés sans erreur', { skip: IS_WIN ? false : 'Windows PowerShell uniquement' }, () => {
  const E = makeEnv();
  ok(apply(E, { windowsTerminal: true, welcome: true }));
  const files = [path.join(E.gen, 'welcome.ps1'), E.ps7, E.ps5];
  // Analyse seulement (ParseFile) : rien n'est exécuté, donc aucun profil ni accueil ne s'affiche.
  const script = '$bad = 0; foreach ($f in (ConvertFrom-Json $env:DOJO_PS_FILES)) { $e = $null; '
    + '[void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$e); if ($e) { $bad += $e.Count } }; exit $bad';
  const r = spawnSync(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: { ...E.env, DOJO_PS_FILES: JSON.stringify(files) }, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('welcome.ps1 : titre, logo et deux lignes du thème ; DOJO_WELCOME=off : rien', { skip: IS_WIN ? false : 'Windows PowerShell uniquement' }, () => {
  const E = makeEnv();
  ok(apply(E, { welcome: true }));
  const run = (extra) => spawnSync(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(E.gen, 'welcome.ps1')],
    { env: { ...E.env, ...extra }, encoding: 'utf8', timeout: 120000 });
  const r = run({});
  assert.equal(r.status, 0, r.stderr);
  const text = r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(text, /LOGO-ALPHA/);
  assert.match(text, /✦ claude-dojo · alpha/, 'titre (UTF-8)');
  assert.match(text, /✦ mission\s+Tache alpha/);
  assert.match(text, /✦ jutsu\s+Sort alpha/);
  const off = run({ DOJO_WELCOME: 'off' });
  assert.equal(off.stdout, '');
});

test('welcome.ps1 sans theme/ : titre seul, sans logo ni erreur, code 0 (le shell n\'est jamais bloqué)', { skip: IS_WIN ? false : 'Windows PowerShell uniquement' }, () => {
  const E = makeEnv();
  ok(apply(E, { welcome: true }));
  fs.rmSync(path.join(E.gen, 'theme'), { recursive: true, force: true });
  const r = spawnSync(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(E.gen, 'welcome.ps1')],
    { env: { ...E.env }, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.doesNotMatch(r.stdout, /LOGO-ALPHA/);
  assert.match(r.stdout.replace(/\x1b\[[0-9;]*m/g, ''), /✦ claude-dojo · alpha/);
});

test('bloc du profil : accueil ignoré pour -Command, -c, -File, -f, -EncodedCommand, -NonInteractive ; gardé sinon', { skip: IS_WIN ? false : 'Windows PowerShell uniquement' }, () => {
  const E = makeEnv();
  ok(apply(E, { welcome: true }));
  // Ligne lue dans le profil écrit : le test évalue la logique réellement posée, pas une copie.
  const line = fs.readFileSync(E.ps5, 'utf8').split(/\r?\n/).find((l) => l.startsWith('$dojoBatch = '));
  assert.ok(line, 'ligne $dojoBatch présente dans le bloc');
  const cases = [
    [['powershell.exe', '-NoLogo'], false],
    [['powershell.exe'], false],
    [['pwsh.exe', '-NoExit', '-ExecutionPolicy', 'Bypass'], false],
    [['pwsh.exe', '-NoProfile', '-NoLogo'], false],
    [['powershell.exe', '-Command', 'ls'], true],
    [['powershell.exe', '-c', 'ls'], true],
    [['powershell.exe', '-com', 'ls'], true],
    [['powershell.exe', '-File', 'x.ps1'], true],
    [['powershell.exe', '-f', 'x.ps1'], true],
    [['pwsh.exe', '-EncodedCommand', 'AAAA'], true],
    [['pwsh.exe', '-e', 'AAAA'], true],
    [['pwsh.exe', '-ec', 'AAAA'], true],
    [['powershell.exe', '-NonInteractive'], true],
    [['powershell.exe', '-noninteractive', '-NoLogo'], true],
  ];
  // Premier élément = l'exécutable, comme [Environment]::GetCommandLineArgs().
  const script = '$res = @(foreach ($c in (ConvertFrom-Json $env:DOJO_CASES)) { $dojoArgs = @($c | Select-Object -Skip 1); '
    + `${line}; [pscustomobject]@{ batch = $dojoBatch } }); ConvertTo-Json -InputObject $res -Compress`;
  const r = spawnSync(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: { ...E.env, DOJO_CASES: JSON.stringify(cases.map(([args]) => args)) }, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([].concat(JSON.parse(r.stdout)).map((x) => x.batch), cases.map(([, want]) => want));
});
