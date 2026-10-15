// Tests de src/setup.js (node:test). Chaque test travaille dans un HOME temporaire.
// Aucun launchctl réel : launchagents uniquement en dryRun, uninstall uniquement avec noLaunchd.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SETUP = path.join(REPO, 'src', 'setup.js');
const IS_WIN = process.platform === 'win32';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-test-'));
}

// Dossiers d'applications simulés dans le HOME temporaire : jamais le vrai /Applications.
const appDirsOf = (home) => [path.join(home, 'Applications'), path.join(home, 'SysApplications')].join(path.delimiter);

// Lance le CLI avec HOME temporaire. Renvoie { code, out (JSON parsé), raw }.
// USERPROFILE suit HOME : sous Windows, os.homedir() ne lit que USERPROFILE.
function cli(home, args, { input, env = {} } = {}) {
  const r = spawnSync(process.execPath, [SETUP, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), DOJO_DOCUMENTS_DIR: path.join(home, 'Documents'), DOJO_DETECT_NO_GH_AUTH: '1', DOJO_APPS_DIRS: appDirsOf(home), ...env },
    input,
    encoding: 'utf8',
    timeout: 60000,
  });
  const raw = r.stdout.trim();
  let out = null;
  try { out = JSON.parse(raw); } catch { out = null; }
  return { code: r.status, out, raw, stderr: r.stderr };
}

const settingsFile = (home) => path.join(home, '.claude', 'settings.json');
const configFile = (home) => path.join(home, '.config', 'claude-dojo', 'config.json');
const stateFile = (home) => path.join(home, '.config', 'claude-dojo', 'state.json');
const writeJson = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const backups = (file) => fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(path.basename(file) + '.bak-'));

// Réglages « riches » : model, effort, plugins, permissions, env, statusLine tierce, hooks tiers.
function richSettings() {
  return {
    model: 'opus',
    effort: 'high',
    plugins: { enabled: ['some-plugin@market'] },
    permissions: { allow: ['Bash(git status)'], deny: ['Bash(rm -rf *)'] },
    env: { FOO: 'bar' },
    statusLine: { type: 'command', command: '/usr/bin/other-statusline --compact' },
    hooks: {
      PreToolUse: [
        { matcher: 'Edit', hooks: [{ type: 'command', command: '/tools/guard.sh' }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /perso/heavy-gate.js' }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: '/tools/notify.sh' }] }],
    },
  };
}

const dojoCommands = (settings) => {
  const out = [];
  for (const groups of Object.values(settings.hooks || {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of g.hooks || []) if (typeof h.command === 'string' && h.command.includes('claude-dojo')) out.push(h.command);
    }
  }
  return out;
};

test('merge-settings garde les clés utilisateur et ajoute les hooks dojo', () => {
  const home = tmpHome();
  writeJson(settingsFile(home), richSettings());
  const r = cli(home, ['merge-settings', JSON.stringify({ heavyGate: true, statusLine: 'keep' })]);
  assert.equal(r.code, 0, r.raw);
  assert.equal(r.out.ok, true);
  assert.equal(r.out.changed, true);
  assert.ok(r.out.backup && fs.existsSync(r.out.backup), 'sauvegarde horodatée créée');

  const s = readJson(settingsFile(home));
  assert.equal(s.model, 'opus');
  assert.equal(s.effort, 'high');
  assert.deepEqual(s.plugins, { enabled: ['some-plugin@market'] });
  assert.deepEqual(s.permissions, { allow: ['Bash(git status)'], deny: ['Bash(rm -rf *)'] });
  assert.equal(s.env.FOO, 'bar');
  assert.equal(s.env.VITEST_MAX_WORKERS, '2');
  assert.equal(s.statusLine.command, '/usr/bin/other-statusline --compact', 'statusLine tierce conservée en keep');
  assert.ok(s.hooks.Stop[0].hooks[0].command === '/tools/notify.sh', 'hook tiers conservé');
  assert.ok(s.hooks.PreToolUse.some((g) => g.hooks.some((h) => h.command === '/tools/guard.sh')));
  assert.ok(s.hooks.PreToolUse.some((g) => g.hooks.some((h) => h.command === 'node /perso/heavy-gate.js')), 'heavy-gate perso intact');
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd']) {
    assert.ok(s.hooks[ev].some((g) => g.hooks.some((h) => h.command.includes(path.join('claude-dojo', 'hook.js')))), `hook dojo sous ${ev}`);
  }
  // path.join : sous Windows, les commandes portent des antislashes (séparateur natif).
  assert.ok(s.hooks.PreToolUse.some((g) => g.hooks.some((h) => h.command.includes(path.join('claude-dojo', 'heavy-gate.js')))));
  assert.equal(s.statusLine.command, '/usr/bin/other-statusline --compact');
});

test('merge-settings est idempotent : deux passes = même fichier, pas de doublon ni de 2e sauvegarde', () => {
  const home = tmpHome();
  writeJson(settingsFile(home), richSettings());
  const args = ['merge-settings', JSON.stringify({ heavyGate: true, statusLine: 'replace' })];
  assert.equal(cli(home, args).out.ok, true);
  const first = fs.readFileSync(settingsFile(home), 'utf8');
  const again = cli(home, args);
  assert.equal(again.out.ok, true);
  assert.equal(again.out.changed, false);
  assert.equal(again.out.backup, null);
  assert.equal(fs.readFileSync(settingsFile(home), 'utf8'), first);
  assert.equal(backups(settingsFile(home)).length, 1, 'une seule sauvegarde');
  // Même contrôle que le CI : pas de doublon de commande dojo sous un même événement.
  const s = readJson(settingsFile(home));
  for (const [ev, groups] of Object.entries(s.hooks)) {
    const cmds = [];
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of g.hooks || []) if (String(h.command).includes('claude-dojo')) cmds.push(h.command);
    }
    assert.equal(new Set(cmds).size, cmds.length, `doublon dojo sous ${ev}`);
  }
});

test('chemin ordinaire : commandes identiques à celles d avant le correctif, settings déjà installé inchangé', { skip: IS_WIN && 'commandes au format POSIX (chemins avec /, échappement sh) : format Windows différent' }, () => {
  const home = tmpHome();
  const node = path.join(fs.realpathSync(path.dirname(process.execPath)), path.basename(process.execPath));
  const dojo = path.join(home, '.config', 'claude-dojo');
  const group = (command) => [{ hooks: [{ type: 'command', command, async: true }] }];
  const hooks = Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd']
    .map((ev) => [ev, group(`"${node}" "${dojo}/hook.js"`)]));
  writeJson(settingsFile(home), { hooks, statusLine: { type: 'command', command: `"${node}" "${dojo}/statusline.js"`, refreshInterval: 30 } });
  const r = cli(home, ['merge-settings', JSON.stringify({ node: process.execPath, statusLine: 'keep' })]);
  assert.equal(r.out.ok, true, r.raw);
  assert.equal(r.out.changed, false, 'aucune réécriture pour un chemin ordinaire');
  assert.equal(r.out.backup, null);
});

test('commandes dojo évaluées par sh -c : HOME avec espace, guillemets, $ et apostrophe, arguments reçus intacts', { skip: IS_WIN && 'sh -c et shebang POSIX ; le guillemet est interdit dans un nom de dossier Windows' }, () => {
  const base = tmpHome();
  const home = path.join(base, `mon "dossier" $HOME 'perso'`);
  fs.mkdirSync(home, { recursive: true });
  // Faux node : écrit chacun de ses arguments sur une ligne dans le fichier désigné par DOJO_TEST_OUT.
  const fakeDir = path.join(base, 'bin "x" $y');
  fs.mkdirSync(fakeDir, { recursive: true });
  const fakeNode = path.join(fakeDir, 'fake node');
  fs.writeFileSync(fakeNode, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done > "$DOJO_TEST_OUT"\n', { mode: 0o755 });
  const out = path.join(base, 'args.txt');
  const r = cli(home, ['merge-settings', JSON.stringify({ node: fakeNode, heavyGate: true, statusLine: 'replace' })]);
  assert.equal(r.code, 0, r.raw);

  const s = readJson(settingsFile(home));
  const commands = [...dojoCommands(s), s.statusLine.command];
  assert.equal(commands.length, 8, '6 hooks + heavy-gate + statusLine');
  const dojo = path.join(home, '.config', 'claude-dojo');
  const received = new Set();
  for (const cmd of commands) {
    const ev = spawnSync('/bin/sh', ['-c', cmd], { env: { ...process.env, DOJO_TEST_OUT: out }, encoding: 'utf8' });
    assert.equal(ev.status, 0, `${cmd} : ${ev.stderr}`);
    const args = fs.readFileSync(out, 'utf8').split('\n').filter((l) => l !== '');
    assert.equal(args.length, 1, `un seul argument attendu pour : ${cmd}`);
    received.add(args[0]);
  }
  assert.deepEqual([...received].sort(), [`${dojo}/hook.js`, `${dojo}/heavy-gate.js`, `${dojo}/statusline.js`].sort());
});

test('unmerge-settings restaure l organisation d origine et conserve les hooks tiers', () => {
  const home = tmpHome();
  const original = richSettings();
  writeJson(settingsFile(home), original);
  assert.equal(cli(home, ['merge-settings', JSON.stringify({ heavyGate: true, statusLine: 'replace' })]).out.ok, true);
  const r = cli(home, ['unmerge-settings', '{}']);
  assert.equal(r.code, 0, r.raw);
  assert.equal(r.out.changed, true);
  // statusLine était tierce avant : « replace » l'a écrasée, donc elle ne revient pas. On la remet pour comparer.
  const restored = readJson(settingsFile(home));
  assert.deepEqual(restored.hooks.Stop, original.hooks.Stop);
  assert.deepEqual(restored.hooks.PreToolUse, original.hooks.PreToolUse);
  assert.equal(restored.env.VITEST_MAX_WORKERS, undefined);
  assert.deepEqual(dojoCommands(restored), []);
  assert.equal(restored.model, 'opus');
  assert.deepEqual(restored.plugins, original.plugins);
});

test('unmerge après merge en keep restaure exactement l original', () => {
  const home = tmpHome();
  const original = richSettings();
  writeJson(settingsFile(home), original);
  assert.equal(cli(home, ['merge-settings', JSON.stringify({ heavyGate: true, statusLine: 'keep' })]).out.ok, true);
  assert.equal(cli(home, ['unmerge-settings']).out.ok, true);
  assert.deepEqual(readJson(settingsFile(home)), original);
});

test('dryRun ne modifie rien ni ne sauvegarde', () => {
  const home = tmpHome();
  writeJson(settingsFile(home), richSettings());
  const before = fs.readFileSync(settingsFile(home), 'utf8');
  const m = cli(home, ['merge-settings', JSON.stringify({ dryRun: true, heavyGate: true, statusLine: 'replace' })]);
  assert.equal(m.out.ok, true);
  assert.equal(m.out.dryRun, true);
  assert.equal(m.out.changed, true);
  assert.ok(m.out.diff.includes('+ '), 'le diff montre les ajouts');
  assert.ok(m.out.heavyGateThresholds && m.out.heavyGateThresholds.HEAVY_GATE_MAX >= 2);
  const u = cli(home, ['unmerge-settings', '{"dryRun":true}']);
  assert.equal(u.out.ok, true);
  assert.equal(fs.readFileSync(settingsFile(home), 'utf8'), before);
  assert.equal(backups(settingsFile(home)).length, 0);
});

test('merge-settings crée le fichier s il est absent, unmerge sans fichier ne fait rien', () => {
  const home = tmpHome();
  const r = cli(home, ['merge-settings', '{"statusLine":"keep"}']);
  assert.equal(r.out.ok, true);
  assert.equal(r.out.changed, true);
  assert.equal(r.out.backup, null);
  assert.ok(readJson(settingsFile(home)).hooks.Stop);
  const home2 = tmpHome();
  const u = cli(home2, ['unmerge-settings']);
  assert.equal(u.out.ok, true);
  assert.equal(u.out.changed, false);
});

test('merge-settings refuse un settings.json invalide sans le modifier', () => {
  const home = tmpHome();
  writeJson(settingsFile(home), '{ pas du json');
  const r = cli(home, ['merge-settings', '{}']);
  assert.equal(r.code, 1);
  assert.equal(r.out.ok, false);
  assert.match(r.out.error, /JSON invalide/);
  assert.equal(fs.readFileSync(settingsFile(home), 'utf8'), '{ pas du json');
});

test('write-config : mode 0600 (dossier 0700), fusion profonde, clés inconnues conservées, null retire', () => {
  const home = tmpHome();
  const first = cli(home, ['write-config', JSON.stringify({
    weather: { name: 'Paris', lat: '48.8566', lon: 2.3522, timezone: 'Europe/Paris' },
    calendars: ['webcal://example.org/cal.ics'],
    github: { owners: ['alice'] },
    projects: { roots: ['~/Projects'], onlyOwners: false },
    sentry: { token: 'tok-123', org: 'acme' },
  })]);
  assert.equal(first.code, 0, first.raw);
  if (!IS_WIN) assert.equal(first.out.mode, '0600'); // sous Windows, src/setup.js rend mode: null (pas de bits POSIX)
  assert.ok(!first.raw.includes('tok-123'), 'le jeton n est jamais renvoyé');
  const file = configFile(home);
  if (!IS_WIN) { // Windows n'a pas de bits POSIX : fs.statSync rend toujours 0666/0777
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  }
  let cfg = readJson(file);
  assert.equal(cfg.weather.lat, 48.8566, 'lat convertie en nombre');
  // path.normalize : sous Windows, ~ est remplacé par concaténation (séparateurs mélangés), même dossier.
  assert.equal(path.normalize(cfg.projects.roots[0]), path.join(home, 'Projects'), '~ développé');

  // Clé inconnue ajoutée à la main : doit survivre à write-config
  cfg.custom = { keep: true };
  writeJson(file, cfg);
  const second = cli(home, ['write-config', JSON.stringify({ sentry: { org: 'other' }, calendars: null })]);
  assert.equal(second.code, 0, second.raw);
  cfg = readJson(file);
  assert.deepEqual(cfg.custom, { keep: true });
  assert.equal(cfg.sentry.org, 'other');
  assert.equal(cfg.sentry.token, 'tok-123', 'fusion profonde : token conservé');
  assert.equal(cfg.calendars, undefined, 'null retire la section');
  if (!IS_WIN) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('write-config : weather remplacée en entier (pas de fuseau d une ancienne ville), null la retire', () => {
  const home = tmpHome();
  let r = cli(home, ['write-config', JSON.stringify({ weather: { name: 'Paris', lat: 48.8566, lon: 2.3522, timezone: 'Europe/Paris' } })]);
  assert.equal(r.code, 0, r.raw);
  r = cli(home, ['write-config', JSON.stringify({ weather: { name: 'Lyon', lat: 45.764, lon: 4.8357 } })]);
  assert.equal(r.code, 0, r.raw);
  assert.deepEqual(readJson(configFile(home)).weather, { name: 'Lyon', lat: 45.764, lon: 4.8357 });
  r = cli(home, ['write-config', JSON.stringify({ weather: null })]);
  assert.equal(r.code, 0, r.raw);
  assert.equal(readJson(configFile(home)).weather, undefined, 'météo désactivée : section retirée');
});

test('write-config valide lat/lon et les URL d agenda', () => {
  const home = tmpHome();
  const badLat = cli(home, ['write-config', JSON.stringify({ weather: { name: 'X', lat: 'abc', lon: 1 } })]);
  assert.equal(badLat.code, 1);
  assert.equal(badLat.out.ok, false);
  const badRange = cli(home, ['write-config', JSON.stringify({ weather: { name: 'X', lat: 120, lon: 1 } })]);
  assert.equal(badRange.code, 1);
  const badCal = cli(home, ['write-config', JSON.stringify({ calendars: ['ftp://example.org/x'] })]);
  assert.equal(badCal.code, 1);
  assert.ok(!badCal.raw.includes('ftp://'), "l'URL n'est pas renvoyée dans l'erreur");
  assert.equal(fs.existsSync(configFile(home)), false, 'rien écrit en cas d erreur');
});

test('write-config lit le JSON sur stdin avec -', () => {
  const home = tmpHome();
  const r = cli(home, ['write-config', '-'], { input: JSON.stringify({ github: { owners: ['bob'] } }) });
  assert.equal(r.code, 0, r.raw);
  assert.deepEqual(readJson(configFile(home)).github, { owners: ['bob'] });
});

test('launchagents --dry-run : plists corrects, chemin node, XML échappé, aucun fichier écrit', { skip: IS_WIN && 'launchd : macOS uniquement' }, () => {
  const home = tmpHome();
  const node = '/opt/a&b/<node>/bin/node';
  const r = cli(home, ['launchagents', 'install', JSON.stringify({ dryRun: true, node })]);
  assert.equal(r.code, 0, r.raw);
  assert.equal(r.out.dryRun, true);
  const labels = r.out.plists.map((p) => p.label);
  assert.deepEqual(labels, ['io.github.claude-dojo.agent', 'io.github.claude-dojo.wallpaper']);
  const agent = r.out.plists[0].content;
  assert.ok(agent.includes('<string>/opt/a&amp;b/&lt;node&gt;/bin/node</string>'), 'chemin node échappé');
  assert.ok(!agent.includes('a&b'), 'pas de & brut');
  assert.ok(agent.includes('<key>RunAtLoad</key><true/>'));
  assert.ok(agent.includes(path.join(home, '.config', 'claude-dojo', 'agent-mac.js')));
  assert.ok(r.out.plists[1].content.includes('Contents/MacOS/DojoWallpaper'));
  assert.ok(Array.isArray(r.out.commands) && r.out.commands.every((c) => typeof c === 'string'));
  assert.equal(fs.existsSync(path.join(home, 'Library')), false, 'aucun LaunchAgent écrit en dryRun');
});

test('launchagents install refuse une commande inconnue', () => {
  const home = tmpHome();
  const r = cli(home, ['launchagents', 'frobnicate', '{"dryRun":true}']);
  assert.equal(r.code, 1);
  assert.equal(r.out.ok, false);
});

test('launchagents --dry-run : migrated liste les anciens labels qui seraient retirés, sans rien supprimer', { skip: IS_WIN && 'launchd : macOS uniquement' }, () => {
  const home = tmpHome();
  const dir = path.join(home, 'Library', 'LaunchAgents');
  const old = ['com.old.claude-dojo.agent', 'com.old.claude-dojo.wallpaper'];
  for (const l of old) writeJson(path.join(dir, l + '.plist'), '<plist/>');
  const r = cli(home, ['launchagents', 'install', JSON.stringify({ dryRun: true, node: process.execPath })]);
  assert.equal(r.code, 0, r.raw);
  assert.deepEqual(r.out.migrated, old);
  assert.ok(r.out.commands.includes(`rm ${path.join(dir, old[0] + '.plist')}`), 'la suppression figure dans commands');
  for (const l of old) assert.ok(fs.existsSync(path.join(dir, l + '.plist')), `${l} toujours présent en dryRun`);

  // Avec --no-launchd : rien n'est retiré, migrated est vide et les anciens plists restent.
  const r2 = cli(home, ['launchagents', 'install', JSON.stringify({ noLaunchd: true, node: process.execPath })]);
  assert.equal(r2.code, 0, r2.raw);
  assert.deepEqual(r2.out.migrated, []);
  for (const l of old) assert.ok(fs.existsSync(path.join(dir, l + '.plist')), `${l} laissé en place (--no-launchd)`);
});

test('detect renvoie un JSON complet et valide', () => {
  const home = tmpHome();
  writeJson(settingsFile(home), richSettings());
  const r = cli(home, ['detect']);
  assert.equal(r.code, 0, r.stderr);
  const d = r.out;
  assert.equal(d.ok, true);
  assert.equal(typeof d.node.ok, 'boolean');
  assert.ok('path' in d.node && 'version' in d.node);
  for (const k of ['brew', 'macmon', 'mediaControl', 'claude']) assert.ok(d[k] === null || typeof d[k].path === 'string', k);
  assert.equal(typeof d.gh.authed, 'boolean');
  assert.equal(d.settings.exists, true);
  assert.equal(d.settings.hooksDojo, false);
  assert.equal(d.settings.heavyGatePerso, true, 'heavy-gate perso détecté');
  assert.equal(d.settings.heavyGateDojo, false);
  assert.equal(d.settings.statusLine.command, '/usr/bin/other-statusline --compact');
  assert.equal(d.install.installed, false);
  assert.equal(d.install.configExists, false);
  assert.deepEqual(d.install.launchAgents, []);
  assert.equal(d.config, null);
  assert.equal(d.home, home);
  assert.ok(['arm64', 'x86_64'].includes(d.arch));
});

test('install-files copie le runtime sans écraser config.json, refuse un dossier absent', () => {
  const home = tmpHome();
  const src = path.join(REPO, 'src');
  const r = cli(home, ['install-files', src]);
  assert.equal(r.code, 0, r.raw);
  const dest = path.join(home, '.config', 'claude-dojo');
  for (const f of ['hook.js', 'agent-mac.js', 'statusline.js', 'heavy-gate.js', 'package.json', 'config.example.json']) {
    assert.ok(fs.existsSync(path.join(dest, f)), `copié : ${f}`);
  }
  assert.ok(fs.existsSync(path.join(dest, 'wallpaper', 'index.html')), 'wallpaper/ copié');
  assert.ok(fs.existsSync(path.join(dest, 'cache')), 'cache/ créé');
  assert.ok(!r.out.copied.includes('config.json'));
  // src/terminal : copié sous terminal-src/ (welcome.zsh), jamais sous terminal/ (fichiers générés)
  assert.ok(r.out.copied.includes('terminal-src/'), 'terminal-src/ copié');
  assert.ok(fs.existsSync(path.join(dest, 'terminal-src', 'welcome.zsh')), 'welcome.zsh installé');
  assert.ok(!fs.existsSync(path.join(dest, 'terminal')), 'terminal/ (généré) non créé par install-files');

  // config.json existant : jamais écrasé
  writeJson(path.join(dest, 'config.json'), { weather: { name: 'Lyon', lat: 45.76, lon: 4.83, timezone: 'Europe/Paris' } });
  assert.equal(cli(home, ['install-files', src]).code, 0);
  assert.equal(readJson(path.join(dest, 'config.json')).weather.name, 'Lyon');

  const missing = cli(home, ['install-files', path.join(home, 'absent')]);
  assert.equal(missing.code, 1);
  assert.equal(missing.out.ok, false);
});

// Source de test : runtime minimal, plus un fichier « dehors » hors du dossier source.
function fakeSource() {
  const base = tmpHome();
  const src = path.join(base, 'src');
  const outside = path.join(base, 'outside', 'secret.js');
  writeJson(outside, 'secret');
  writeJson(path.join(src, 'hook.js'), '// hook');
  writeJson(path.join(src, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;');
  writeJson(path.join(src, 'wallpaper', 'index.html'), '<!doctype html>');
  const link = (rel, target) => {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.symlinkSync(target, path.join(src, rel));
  };
  return { src, outside, link };
}

test('install-files refuse un lien qui sort du dossier source (node_modules compris) avant toute copie', () => {
  const cases = [
    (f) => f.link('node_modules/pkg/leak.js', f.outside), // absolu, dans node_modules
    (f) => f.link('wallpaper/up.js', '../../outside/secret.js'), // relatif, remonte hors de la source
    (f) => f.link('statusline.js', f.outside), // lien de premier niveau copié par son nom
  ];
  for (const plant of cases) {
    const home = tmpHome();
    const f = fakeSource();
    plant(f);
    const r = cli(home, ['install-files', f.src]);
    assert.equal(r.code, 1, r.raw);
    assert.equal(r.out.ok, false);
    assert.match(r.out.error, /lien symbolique refusé/);
    assert.equal(fs.existsSync(path.join(home, '.config', 'claude-dojo', 'hook.js')), false, 'rien copié en cas de refus');
  }
});

test('install-files ne suit pas les liens internes : recopiés comme liens, cible résolue dans la copie', () => {
  const home = tmpHome();
  const f = fakeSource();
  f.link('node_modules/.bin/tool', '../pkg/index.js');
  const r = cli(home, ['install-files', f.src]);
  assert.equal(r.code, 0, r.raw);
  const copy = path.join(home, '.config', 'claude-dojo', 'node_modules', '.bin', 'tool');
  assert.ok(fs.lstatSync(copy).isSymbolicLink(), 'lien conservé tel quel');
  // path.normalize : Windows rend la cible avec des antislashes (même lien, séparateur natif).
  assert.equal(path.normalize(fs.readlinkSync(copy)), path.normalize('../pkg/index.js'));
  assert.equal(fs.readFileSync(copy, 'utf8'), 'module.exports = 1;');
});

test('uninstall avec noLaunchd et purge : settings nettoyé, config supprimée, aucun launchctl', () => {
  const home = tmpHome();
  writeJson(settingsFile(home), richSettings());
  assert.equal(cli(home, ['install-files', path.join(REPO, 'src')]).code, 0);
  assert.equal(cli(home, ['merge-settings', JSON.stringify({ heavyGate: true, statusLine: 'replace' })]).code, 0);
  const r = cli(home, ['uninstall', JSON.stringify({ noLaunchd: true, purge: true })]);
  assert.equal(r.code, 0, r.raw);
  assert.equal(r.out.launchAgents.skipped, true);
  assert.equal(fs.existsSync(path.join(home, '.config', 'claude-dojo')), false, 'config supprimée avec purge');
  const s = readJson(settingsFile(home));
  assert.deepEqual(dojoCommands(s), []);
  assert.equal(s.model, 'opus');
  assert.equal(s.statusLine, undefined, 'statusLine dojo retirée');
});

// Bundle DojoWallpaper.app factice dans un dossier d'applications (HOME temporaire uniquement).
function fakeApp(dir) {
  const bundle = path.join(dir, 'DojoWallpaper.app');
  fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Contents', 'MacOS', 'DojoWallpaper'), '#!/bin/sh\n');
  return bundle;
}

test('uninstall retire aussi le bundle du dossier système quand il est inscriptible', { skip: IS_WIN && 'bundles .app macOS : uninstall Windows supprime le dossier de l exe' }, () => {
  const home = tmpHome();
  const mainApp = fakeApp(path.join(home, 'Applications'));
  const sysApp = fakeApp(path.join(home, 'SysApplications'));
  const r = cli(home, ['uninstall', JSON.stringify({ noLaunchd: true })]);
  assert.equal(r.code, 0, r.raw);
  assert.deepEqual(r.out.appRemoved, [mainApp, sysApp]);
  assert.equal(r.out.appRemaining, null);
  assert.equal(fs.existsSync(mainApp), false);
  assert.equal(fs.existsSync(sysApp), false);
});

test('uninstall : bundle dans un dossier non inscriptible laissé en place, signalé dans appRemaining', { skip: IS_WIN && 'chmod 0555 sans effet sous Windows : dossier toujours inscriptible' }, (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root peut écrire partout');
  const home = tmpHome();
  const sys = path.join(home, 'SysApplications');
  const sysApp = fakeApp(sys);
  fs.chmodSync(sys, 0o555);
  try {
    const r = cli(home, ['uninstall', JSON.stringify({ noLaunchd: true })]);
    assert.equal(r.code, 0, r.raw);
    assert.equal(r.out.appRemaining, sysApp);
    assert.deepEqual(r.out.appRemoved, []);
    assert.equal(fs.existsSync(sysApp), true, 'bundle non touché');
  } finally {
    fs.chmodSync(sys, 0o755);
  }
});

test('uninstall en dryRun ne retire aucun bundle', () => {
  const home = tmpHome();
  const sysApp = fakeApp(path.join(home, 'SysApplications'));
  const r = cli(home, ['uninstall', JSON.stringify({ noLaunchd: true, dryRun: true })]);
  assert.equal(r.code, 0, r.raw);
  assert.deepEqual(r.out.appRemoved, []);
  assert.equal(fs.existsSync(sysApp), true);
});

test('uninstall sans aucun bundle : appRemoved vide, appRemaining null', () => {
  const home = tmpHome();
  const r = cli(home, ['uninstall', JSON.stringify({ noLaunchd: true })]);
  assert.equal(r.code, 0, r.raw);
  assert.deepEqual(r.out.appRemoved, []);
  assert.equal(r.out.appRemaining, null);
});

test('commande inconnue et sans argument : erreur propre en JSON', () => {
  const home = tmpHome();
  const bad = cli(home, ['nope']);
  assert.equal(bad.code, 1);
  assert.deepEqual(bad.out, { ok: false, error: 'commande inconnue : nope' });
  const noArg = cli(home, []);
  assert.equal(noArg.code, 0);
  assert.equal(noArg.out.ok, true);
  assert.ok(Array.isArray(noArg.out.usage));
});

test('setup.js n utilise que des modules natifs (zéro dépendance)', () => {
  const src = fs.readFileSync(SETUP, 'utf8');
  const allowed = new Set(['fs', 'os', 'path', 'http', 'https', 'child_process', 'crypto']);
  const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  for (const r of requires) assert.ok(allowed.has(r), `module inattendu : ${r}`);
  assert.ok(!/exec\(\s*['"`]/.test(src), 'jamais exec avec une chaîne (shell)');
});

test('écriture atomique : aucun fichier tmp résiduel, mode d origine conservé', () => {
  const home = tmpHome();
  writeJson(settingsFile(home), richSettings());
  fs.chmodSync(settingsFile(home), 0o600);
  const inode = fs.statSync(settingsFile(home)).ino;
  const r = cli(home, ['merge-settings', JSON.stringify({ heavyGate: true, statusLine: 'replace' })]);
  assert.equal(r.code, 0, r.raw);
  assert.equal(r.out.changed, true);
  assert.notEqual(fs.statSync(settingsFile(home)).ino, inode, 'remplacé par renommage (nouvel inode), pas écrit en place');
  if (!IS_WIN) assert.equal(fs.statSync(settingsFile(home)).mode & 0o777, 0o600, 'mode conservé');
  assert.deepEqual(fs.readdirSync(path.dirname(settingsFile(home))).filter((n) => n.includes('.tmp-')), []);
  assert.equal(backups(settingsFile(home)).length, 1, 'sauvegarde horodatée toujours créée');
});

test('settings.json lien symbolique (dotfiles) : le lien est conservé, la cible reçoit les hooks', () => {
  const home = tmpHome();
  const dotfiles = path.join(home, 'dotfiles', 'claude');
  const target = path.join(dotfiles, 'settings.json');
  writeJson(target, richSettings());
  fs.mkdirSync(path.dirname(settingsFile(home)), { recursive: true });
  fs.symlinkSync(target, settingsFile(home));
  const r = cli(home, ['merge-settings', JSON.stringify({ heavyGate: true, statusLine: 'keep' })]);
  assert.equal(r.code, 0, r.raw);
  assert.equal(r.out.changed, true);
  assert.ok(fs.lstatSync(settingsFile(home)).isSymbolicLink(), 'le lien n est pas remplacé par un fichier');
  assert.equal(fs.readlinkSync(settingsFile(home)), target);
  assert.ok(dojoCommands(readJson(target)).length > 0, 'la cible reçoit les hooks dojo');
  assert.deepEqual(fs.readdirSync(dotfiles).filter((n) => n.includes('.tmp-')), []);
});

test('settings.json lien cassé : la cible est créée, le lien conservé', () => {
  const home = tmpHome();
  const target = path.join(home, 'dotfiles', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile(home)), { recursive: true });
  fs.symlinkSync(target, settingsFile(home));
  const r = cli(home, ['merge-settings', '{"statusLine":"keep"}']);
  assert.equal(r.code, 0, r.raw);
  assert.ok(fs.lstatSync(settingsFile(home)).isSymbolicLink(), 'lien conservé');
  assert.ok(readJson(target).hooks.Stop, 'cible créée avec les hooks');
});

test('launchagents install refuse un bundle sur un volume monté, en AppTranslocation ou hors des dossiers d application', { skip: IS_WIN && 'launchd : macOS uniquement' }, () => {
  const home = tmpHome();
  const msg = 'Déplace DojoWallpaper.app dans /Applications puis relance-la.';
  const bad = [
    '/Volumes/ClaudeDojo/DojoWallpaper.app',
    '/private/var/folders/xx/AppTranslocation/ABC123/d/DojoWallpaper.app',
    path.join(home, 'Downloads', 'DojoWallpaper.app'),
  ];
  for (const app of bad) {
    const r = cli(home, ['launchagents', 'install', JSON.stringify({ dryRun: true, node: process.execPath, app })]);
    assert.equal(r.code, 1, `${app} : ${r.raw}`);
    assert.equal(r.out.ok, false);
    assert.equal(r.out.error, msg);
  }
  // Refus sans dryRun : rien n'est écrit (LaunchAgents absents).
  const real = cli(home, ['launchagents', 'install', JSON.stringify({ noLaunchd: true, node: process.execPath, app: bad[0] })]);
  assert.equal(real.code, 1, real.raw);
  assert.equal(fs.existsSync(path.join(home, 'Library')), false, 'aucun LaunchAgent écrit après un refus');

  // Dossiers d'applications de test (appDirsOf) : acceptés, y compris le cas install.sh (~/Applications).
  for (const app of [path.join(home, 'Applications', 'DojoWallpaper.app'), path.join(home, 'SysApplications', 'DojoWallpaper.app')]) {
    const ok = cli(home, ['launchagents', 'install', JSON.stringify({ dryRun: true, node: process.execPath, app })]);
    assert.equal(ok.code, 0, `${app} : ${ok.raw}`);
    assert.equal(ok.out.ok, true);
  }
});

test('VITEST_MAX_WORKERS posé par l utilisateur : conservé au merge heavy-gate, à sa désactivation et à l unmerge', () => {
  const home = tmpHome();
  writeJson(settingsFile(home), { ...richSettings(), env: { FOO: 'bar', VITEST_MAX_WORKERS: '2' } });
  assert.equal(cli(home, ['merge-settings', JSON.stringify({ heavyGate: true, statusLine: 'keep' })]).out.ok, true);
  assert.equal(cli(home, ['merge-settings', JSON.stringify({ heavyGate: false, statusLine: 'keep' })]).out.ok, true);
  assert.equal(readJson(settingsFile(home)).env.VITEST_MAX_WORKERS, '2', 'merge heavy-gate désactivé : valeur utilisateur gardée');
  assert.equal(cli(home, ['unmerge-settings']).out.ok, true);
  const restored = readJson(settingsFile(home));
  assert.equal(restored.env.VITEST_MAX_WORKERS, '2', 'unmerge : valeur utilisateur gardée');
  assert.equal(restored.env.FOO, 'bar');
  assert.equal(fs.existsSync(stateFile(home)), false, 'rien de mémorisé pour une valeur non posée par Dojo');
});

test('VITEST_MAX_WORKERS posé par Dojo : mémorisé, retiré à l unmerge', () => {
  const home = tmpHome();
  writeJson(settingsFile(home), { env: { FOO: 'bar' } });
  assert.equal(cli(home, ['merge-settings', JSON.stringify({ heavyGate: true, statusLine: 'keep' })]).out.ok, true);
  assert.equal(readJson(settingsFile(home)).env.VITEST_MAX_WORKERS, '2');
  assert.equal(readJson(stateFile(home)).managed.vitestMaxWorkers, '2', 'propriété mémorisée');
  assert.equal(cli(home, ['unmerge-settings']).out.ok, true);
  assert.deepEqual(readJson(settingsFile(home)), { env: { FOO: 'bar' } }, 'env d origine restauré');
  assert.equal(fs.existsSync(stateFile(home)), false, 'propriété oubliée après unmerge');
});

test('VITEST_MAX_WORKERS posé par Dojo : retiré au merge heavy-gate désactivé', () => {
  const home = tmpHome();
  writeJson(settingsFile(home), { env: { FOO: 'bar' } });
  assert.equal(cli(home, ['merge-settings', JSON.stringify({ heavyGate: true, statusLine: 'keep' })]).out.ok, true);
  assert.equal(cli(home, ['merge-settings', JSON.stringify({ heavyGate: false, statusLine: 'keep' })]).out.ok, true);
  assert.equal(readJson(settingsFile(home)).env.VITEST_MAX_WORKERS, undefined, 'retiré avec heavy-gate');
  assert.equal(readJson(settingsFile(home)).env.FOO, 'bar');
  assert.equal(fs.existsSync(stateFile(home)), false);
});

test('VITEST_MAX_WORKERS changé à la main après un merge Dojo : gardé à l unmerge, propriété oubliée', () => {
  const home = tmpHome();
  writeJson(settingsFile(home), { env: { FOO: 'bar' } });
  assert.equal(cli(home, ['merge-settings', JSON.stringify({ heavyGate: true, statusLine: 'keep' })]).out.ok, true);
  writeJson(settingsFile(home), { ...readJson(settingsFile(home)), env: { FOO: 'bar', VITEST_MAX_WORKERS: '5' } });
  assert.equal(cli(home, ['unmerge-settings']).out.ok, true);
  assert.equal(readJson(settingsFile(home)).env.VITEST_MAX_WORKERS, '5', 'valeur modifiée par l utilisateur gardée');
  assert.equal(fs.existsSync(stateFile(home)), false);
});

// ── Zone de travail (windowZone) ─────────────────────────────────────────

test('window-zone : désactivée par défaut, sans config.json', () => {
  const home = tmpHome();
  const r = cli(home, ['window-zone']);
  assert.equal(r.code, 0, r.raw);
  assert.deepEqual(r.out.windowZone, { enabled: false, margin: 8, reserveTop: true, exclude: [] });
});

test('write-config windowZone : écrite, fusion profonde, relue avec les défauts', () => {
  const home = tmpHome();
  let r = cli(home, ['write-config', JSON.stringify({ windowZone: { enabled: true, exclude: ['com.apple.Safari', 'com.apple.Safari', 'org.mozilla.firefox'] } })]);
  assert.equal(r.code, 0, r.raw);
  r = cli(home, ['write-config', JSON.stringify({ windowZone: { margin: 16 } })]);
  assert.equal(r.code, 0, r.raw);
  const cfg = readJson(configFile(home));
  assert.equal(cfg.windowZone.enabled, true, 'enabled conservé par la fusion');
  assert.equal(cfg.windowZone.margin, 16);
  const z = cli(home, ['window-zone']).out.windowZone;
  assert.deepEqual(z, { enabled: true, margin: 16, reserveTop: true, exclude: ['com.apple.Safari', 'org.mozilla.firefox'] });
  // Une liste remplace l'ancienne (pas de fusion), null retire la section
  r = cli(home, ['write-config', JSON.stringify({ windowZone: { exclude: [] } })]);
  assert.deepEqual(cli(home, ['window-zone']).out.windowZone.exclude, []);
  r = cli(home, ['write-config', JSON.stringify({ windowZone: null })]);
  assert.equal(readJson(configFile(home)).windowZone, undefined);
  assert.equal(cli(home, ['window-zone']).out.windowZone.enabled, false);
});

test('write-config windowZone : marge 0 et 64 acceptées, mêmes bornes que l app', () => {
  const home = tmpHome();
  for (const margin of [0, 64]) {
    const r = cli(home, ['write-config', JSON.stringify({ windowZone: { margin } })]);
    assert.equal(r.code, 0, r.raw);
    assert.equal(cli(home, ['window-zone']).out.windowZone.margin, margin);
  }
});

test('write-config windowZone : valeurs invalides refusées, config.json inchangé', () => {
  const home = tmpHome();
  cli(home, ['write-config', JSON.stringify({ windowZone: { enabled: true } })]);
  const before = fs.readFileSync(configFile(home), 'utf8');
  const bad = [
    { windowZone: 'oui' },
    { windowZone: [] },
    { windowZone: { enabled: 'true' } },
    { windowZone: { reserveTop: 1 } },
    { windowZone: { margin: -1 } },
    { windowZone: { margin: 65 } },
    { windowZone: { margin: 'abc' } },
    { windowZone: { exclude: 'com.apple.Safari' } },
    { windowZone: { exclude: [42] } },
    { windowZone: { exclude: ['pas un bundle id'] } },
    { windowZone: { exclude: ['../etc'] } },
    { windowZone: { exclude: Array.from({ length: 201 }, (_, i) => `com.example.app${i}`) } },
  ];
  for (const patch of bad) {
    const r = cli(home, ['write-config', JSON.stringify(patch)]);
    assert.notEqual(r.code, 0, JSON.stringify(patch).slice(0, 80));
    assert.match(r.out.error, /windowZone/);
  }
  assert.equal(fs.readFileSync(configFile(home), 'utf8'), before);
});

test('window-zone : config.json corrompu à la main, retombée sur les défauts', () => {
  const home = tmpHome();
  writeJson(configFile(home), { windowZone: { enabled: true, margin: 'x' } });
  const r = cli(home, ['window-zone']);
  assert.equal(r.code, 0, r.raw);
  assert.deepEqual(r.out.windowZone, { enabled: false, margin: 8, reserveTop: true, exclude: [] });
});

// ── upgrade-runtime : runtime embarqué plus récent que l'installé (app remplacée) ──
// Source embarquée factice dans le HOME temporaire. launchctl factice en tête de PATH : aucun launchctl réel.
function mkRuntime(dir, version, marker) {
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'package.json'), { name: 'claude-dojo', version });
  fs.writeFileSync(path.join(dir, 'agent-mac.js'), `// ${marker}\n`);
  return dir;
}
const dojoDirOf = (home) => path.join(home, '.config', 'claude-dojo');
const mkInstalled = (home, version, marker = 'old') => {
  writeJson(configFile(home), { theme: 'naruto' });
  return mkRuntime(dojoDirOf(home), version, marker);
};
const upgradeRuntimeCli = (home, src, opts = {}, env = {}) => cli(home, ['upgrade-runtime', src, JSON.stringify(opts)], { env });
const agentOf = (home) => fs.readFileSync(path.join(dojoDirOf(home), 'agent-mac.js'), 'utf8');
function fakeLaunchctl(root) {
  const bin = path.join(root, 'fake-bin');
  const log = path.join(root, 'launchctl.log');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/sh\necho "$@" >> "${log}"\n`, { mode: 0o755 });
  return { env: { PATH: bin + path.delimiter + process.env.PATH }, log };
}

test('upgrade-runtime : dojo non configuré (pas de config.json) → rien', () => {
  const home = tmpHome();
  const src = mkRuntime(path.join(home, 'embedded'), '0.2.1', 'new');
  mkRuntime(dojoDirOf(home), '0.2.0', 'old');
  const r = upgradeRuntimeCli(home, src);
  assert.equal(r.code, 0, r.raw);
  assert.deepEqual(r.out, { ok: true, upgraded: false, from: '0.2.0', to: '0.2.1', restarted: false, reason: 'not-configured' });
  assert.equal(agentOf(home), '// old\n');
});

test('upgrade-runtime : même version → rien', () => {
  const home = tmpHome();
  const src = mkRuntime(path.join(home, 'embedded'), '0.2.1', 'new');
  mkInstalled(home, '0.2.1');
  const r = upgradeRuntimeCli(home, src);
  assert.equal(r.code, 0, r.raw);
  assert.equal(r.out.upgraded, false);
  assert.equal(r.out.reason, 'up-to-date');
  assert.equal(agentOf(home), '// old\n');
});

test('upgrade-runtime : installée plus récente → rien, jamais de rétrogradation (comparaison numérique)', () => {
  const home = tmpHome();
  const src = mkRuntime(path.join(home, 'embedded'), '0.9.9', 'new');
  mkInstalled(home, '0.10.0');
  const r = upgradeRuntimeCli(home, src);
  assert.equal(r.code, 0, r.raw);
  assert.deepEqual(r.out, { ok: true, upgraded: false, from: '0.10.0', to: '0.9.9', restarted: false, reason: 'downgrade' });
  assert.equal(agentOf(home), '// old\n');
  const pkg = readJson(path.join(dojoDirOf(home), 'package.json'));
  assert.equal(pkg.version, '0.10.0');
});

test('upgrade-runtime : plus récente → fichiers copiés, version installée mise à jour, config.json intact, idempotent', () => {
  const home = tmpHome();
  const src = mkRuntime(path.join(home, 'embedded'), '0.10.0', 'new');
  mkInstalled(home, '0.9.0');
  const r = upgradeRuntimeCli(home, src);
  assert.equal(r.code, 0, r.raw);
  assert.deepEqual(r.out, { ok: true, upgraded: true, from: '0.9.0', to: '0.10.0', restarted: false, reason: 'done' });
  assert.equal(agentOf(home), '// new\n');
  assert.equal(readJson(path.join(dojoDirOf(home), 'package.json')).version, '0.10.0');
  assert.deepEqual(readJson(configFile(home)), { theme: 'naruto' });
  const again = upgradeRuntimeCli(home, src);
  assert.equal(again.out.reason, 'up-to-date');
  assert.equal(again.out.upgraded, false);
});

test('upgrade-runtime : version invalide (embarquée ou installée) → pas d\'upgrade, pas de crash', () => {
  const cases = [
    ['embarquée 0.2', 'embedded', '0.2', '0.2.0'],
    ['embarquée bêta', 'embedded', '0.2.1-beta.1', '0.2.0'],
    ['embarquée absente', 'embedded', undefined, '0.2.0'],
    ['installée invalide', 'installed', '0.2.1', 'abc'],
  ];
  for (const [label, which, embedded, installed] of cases) {
    const home = tmpHome();
    const src = path.join(home, 'embedded');
    if (which === 'embedded') {
      mkRuntime(src, embedded ?? '0.0.0', 'new');
      if (embedded === undefined) writeJson(path.join(src, 'package.json'), { name: 'claude-dojo' });
    } else {
      mkRuntime(src, '0.2.1', 'new');
    }
    mkInstalled(home, installed);
    const r = upgradeRuntimeCli(home, src);
    assert.equal(r.code, 0, `${label} : ${r.raw}`);
    assert.equal(r.out.upgraded, false, label);
    assert.equal(r.out.reason, 'invalid-version', label);
    assert.equal(agentOf(home), '// old\n', label);
  }
  const home = tmpHome();
  const src = path.join(home, 'embedded');
  mkRuntime(src, '0.2.1', 'new');
  fs.writeFileSync(path.join(src, 'package.json'), '{ pas du json');
  mkInstalled(home, '0.2.0');
  const broken = upgradeRuntimeCli(home, src);
  assert.equal(broken.out.reason, 'invalid-version');
  assert.equal(agentOf(home), '// old\n');
});

test('upgrade-runtime : app lancée depuis /Volumes ou AppTranslocation → refus (volume)', { skip: IS_WIN && 'chemins macOS (/Volumes, AppTranslocation)' }, () => {
  for (const appPath of [
    '/Volumes/DojoWallpaper/DojoWallpaper.app',
    '/private/var/folders/xx/AppTranslocation/ABC/d/DojoWallpaper.app',
  ]) {
    const home = tmpHome();
    const src = mkRuntime(path.join(home, 'embedded'), '0.2.1', 'new');
    mkInstalled(home, '0.2.0');
    const r = upgradeRuntimeCli(home, src, { appPath });
    assert.equal(r.code, 0, r.raw);
    assert.deepEqual(r.out, { ok: true, upgraded: false, from: '0.2.0', to: '0.2.1', restarted: false, reason: 'volume' }, appPath);
    assert.equal(agentOf(home), '// old\n', appPath);
  }
  const home = tmpHome();
  const src = mkRuntime(path.join(home, 'embedded'), '0.2.1', 'new');
  mkInstalled(home, '0.2.0');
  const ok = upgradeRuntimeCli(home, src, { appPath: '/Applications/DojoWallpaper.app' });
  assert.equal(ok.out.reason, 'done', 'app dans /Applications : mise à jour faite');
});

test('upgrade-runtime : relance l\'agent par launchctl kickstart seulement si son LaunchAgent existe, jamais avec noLaunchd', { skip: IS_WIN && 'launchctl : macOS uniquement' }, () => {
  const home = tmpHome();
  const fake = fakeLaunchctl(home);
  const src = mkRuntime(path.join(home, 'embedded'), '0.2.1', 'new');
  mkInstalled(home, '0.2.0');
  const plist = path.join(home, 'Library', 'LaunchAgents', 'io.github.claude-dojo.agent.plist');
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, '<plist/>');

  const off = upgradeRuntimeCli(home, src, { noLaunchd: true }, fake.env);
  assert.equal(off.out.upgraded, true, off.raw);
  assert.equal(off.out.restarted, false);
  assert.ok(!fs.existsSync(fake.log), 'noLaunchd : aucun launchctl');

  writeJson(path.join(dojoDirOf(home), 'package.json'), { name: 'claude-dojo', version: '0.2.0' });
  const on = upgradeRuntimeCli(home, src, {}, fake.env);
  assert.equal(on.out.upgraded, true, on.raw);
  assert.equal(on.out.restarted, true);
  assert.match(fs.readFileSync(fake.log, 'utf8'), new RegExp(`^kickstart -k gui/${process.getuid()}/io\\.github\\.claude-dojo\\.agent$`, 'm'));
});

test('upgrade-runtime : argument absent ou JSON non objet → erreur propre ou comportement par défaut, sans crash', () => {
  const home = tmpHome();
  const none = cli(home, ['upgrade-runtime']);
  assert.equal(none.code, 1);
  assert.equal(none.out.ok, false);
  const src = mkRuntime(path.join(home, 'embedded'), '0.2.1', 'new');
  mkInstalled(home, '0.2.0');
  const nul = cli(home, ['upgrade-runtime', src, 'null']);
  assert.equal(nul.code, 0, nul.raw);
  assert.equal(nul.out.reason, 'done');
});
