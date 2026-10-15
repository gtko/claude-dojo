// Tests du support Windows de src/setup.js (node:test).
// Les fonctions pures (commandes de hooks, merge-settings, lanceur VBScript, arguments reg.exe) tournent sur toute
// plateforme, en forçant win:true. Le reste (CLI, fichiers, registre) ne tourne que sous Windows, dans un profil
// temporaire (USERPROFILE et HOME) avec DOJO_SKIP_REGISTRY=1 et DOJO_SKIP_EXE=1 : rien n'est écrit hors de ce dossier.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SETUP = path.join(REPO, 'src', 'setup.js');
const setup = require(SETUP);
const WIN = process.platform === 'win32';
const winOnly = WIN ? {} : { skip: 'Windows uniquement' };

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const DOJO = 'C:\\Users\\Ana\\.config\\claude-dojo';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd'];
const HOOK_CMD = `"${NODE}" "${DOJO}\\hook.js"`;
const HEAVY_CMD = `"${NODE}" "${DOJO}\\heavy-gate.js"`;
const STATUS_CMD = `"${NODE}" "${DOJO}\\statusline.js"`;

// Réglages utilisateur (hooks tiers, permissions, env, statusLine tierce) : doivent survivre au merge et à l'unmerge.
function userSettings() {
  return {
    model: 'opus',
    permissions: { allow: ['Bash(git status)'] },
    env: { FOO: 'bar' },
    hooks: {
      PreToolUse: [
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'C:\\tools\\guard.cmd' }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node C:\\perso\\heavy-gate.js' }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'C:\\tools\\notify.cmd' }] }],
    },
  };
}

const winMerge = (s, extra = {}) => setup.mergeTransform(s, {
  node: NODE, dojo: DOJO, hooks: true, statusLine: 'keep', win: true, ...extra,
});
const dojoCommands = (s) => {
  const out = [];
  for (const ev of Object.keys(s.hooks || {})) {
    for (const g of s.hooks[ev]) for (const h of g.hooks) if (/claude-dojo/.test(h.command)) out.push(h.command);
  }
  return out;
};

// ── Fonctions pures (toute plateforme) ───────────────────────────────────

test('hooks Windows : node.exe et hook.js entre guillemets, antislashes intacts, mêmes événements que macOS', () => {
  const s = {};
  winMerge(s, { heavyGate: true, statusLine: 'replace' });
  assert.deepEqual(Object.keys(s.hooks).sort(), [...EVENTS].sort());
  for (const ev of EVENTS) {
    const hookGroups = s.hooks[ev].filter((g) => g.hooks.some((h) => h.command === HOOK_CMD));
    assert.equal(hookGroups.length, 1, `${ev} : un seul groupe hook.js`);
    assert.equal(hookGroups[0].hooks[0].async, true, ev);
  }
});

test('heavy-gate Windows : matcher Bash|PowerShell, timeout 10, commande entre guillemets', () => {
  const s = {};
  winMerge(s, { heavyGate: true });
  const heavy = s.hooks.PreToolUse.filter((g) => g.hooks.some((h) => h.command === HEAVY_CMD));
  assert.equal(heavy.length, 1);
  assert.equal(heavy[0].matcher, 'Bash|PowerShell');
  assert.equal(heavy[0].hooks[0].timeout, 10);
});

test('statusLine Windows : commande entre guillemets, refreshInterval 30', () => {
  const s = {};
  winMerge(s, { statusLine: 'replace' });
  assert.deepEqual(s.statusLine, { type: 'command', command: STATUS_CMD, refreshInterval: 30 });
});

test('merge-settings Windows idempotent : deux passes = même objet, pas de doublon', () => {
  const s = userSettings();
  winMerge(s, { heavyGate: true });
  const once = JSON.stringify(s);
  winMerge(s, { heavyGate: true });
  assert.equal(JSON.stringify(s), once);
  assert.equal(dojoCommands(s).length, EVENTS.length + 1); // hooks (6) + heavy-gate (statusLine hors de s.hooks)
  assert.equal(s.statusLine.command, STATUS_CMD);
});

test('merge-settings Windows préserve les réglages utilisateur et les hooks tiers', () => {
  const s = userSettings();
  winMerge(s, { heavyGate: true });
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.permissions, { allow: ['Bash(git status)'] });
  assert.equal(s.env.FOO, 'bar');
  assert.ok(s.hooks.PreToolUse.some((g) => g.matcher === 'Edit'));
  assert.ok(s.hooks.PreToolUse.some((g) => g.hooks.some((h) => h.command === 'node C:\\perso\\heavy-gate.js')));
  assert.ok(s.hooks.Stop.some((g) => g.hooks.some((h) => h.command === 'C:\\tools\\notify.cmd')));
});

test('merge-settings Windows remplace une entrée dojo au format macOS (matcher Bash) sans la dupliquer', () => {
  const s = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '"/usr/local/bin/node" "/x/claude-dojo/heavy-gate.js"', timeout: 10 }] }],
    },
  };
  winMerge(s, { heavyGate: true });
  const heavy = s.hooks.PreToolUse.filter((g) => g.hooks.some((h) => /heavy-gate\.js/.test(h.command)));
  assert.equal(heavy.length, 1);
  assert.equal(heavy[0].matcher, 'Bash|PowerShell');
  assert.equal(heavy[0].hooks[0].command, HEAVY_CMD);
});

test('unmerge Windows : retire exactement ce que dojo a ajouté (aller-retour = réglages d origine)', () => {
  const original = userSettings();
  const s = JSON.parse(JSON.stringify(original));
  winMerge(s, { heavyGate: true, statusLine: 'replace' });
  const touched = setup.unmergeTransform(s, '2'); // VITEST_MAX_WORKERS posé par le merge heavy-gate
  assert.equal(touched, true);
  assert.deepEqual(s, original);
});

test('unmerge Windows : statusLine tierce conservée, statusLine dojo retirée', () => {
  const s = { statusLine: { type: 'command', command: STATUS_CMD, refreshInterval: 30 } };
  setup.unmergeTransform(s, null);
  assert.equal(s.statusLine, undefined);
  const other = { statusLine: { type: 'command', command: 'C:\\tools\\sl.cmd' } };
  setup.unmergeTransform(other, null);
  assert.deepEqual(other.statusLine, { type: 'command', command: 'C:\\tools\\sl.cmd' });
});

test('cmdArg Windows : guillemets doubles sans doubler les antislashes ; caractères ambigus refusés', () => {
  assert.equal(setup.cmdArg('C:\\a b\\node.exe', true), '"C:\\a b\\node.exe"');
  for (const bad of ['C:\\x"y', 'C:\\$x', 'C:\\`x', 'C:\\100%']) {
    assert.throws(() => setup.cmdArg(bad, true), /chemin refusé/, bad);
  }
});

test('cmdArg hors Windows : sh-compatible, antislashes et $ échappés comme avant', () => {
  assert.equal(setup.cmdArg('/usr/local/bin/node', false), '"/usr/local/bin/node"');
  assert.equal(setup.cmdArg('/a$b', false), '"/a\\$b"');
});

test('scriptPath : séparateur de la plateforme, dossier POSIX inchangé', () => {
  assert.equal(setup.scriptPath(DOJO, 'hook.js', true), DOJO + '\\hook.js');
  assert.equal(setup.scriptPath('/home/x/.config/claude-dojo', 'hook.js', false), '/home/x/.config/claude-dojo/hook.js');
});

test('vbsStr : ASCII entre guillemets, guillemets doublés, caractères accentués en ChrW', () => {
  assert.equal(setup.vbsStr('a"b'), '"a""b"');
  assert.equal(setup.vbsStr(''), '""');
  assert.equal(setup.vbsStr('é'), 'ChrW(233)');
  assert.equal(setup.vbsStr('é"'), 'ChrW(233) & """"');
});

test('launcherVbs : fenêtre masquée, asynchrone, fichier ASCII pur, node puis agent-win.js', () => {
  const vbs = setup.launcherVbs(NODE, 'C:\\Users\\Zoë\\.config\\claude-dojo');
  assert.match(vbs, /CreateObject\("WScript\.Shell"\)/);
  assert.match(vbs, /, 0, False\r?$/m);
  assert.doesNotMatch(vbs, /[^\x00-\x7f]/, 'pas de caractère hors ASCII (wscript lit en ANSI)');
  assert.ok(vbs.includes('ChrW(235)'), 'le ë du chemin passe par ChrW (U+00EB = 235)');
  assert.ok(vbs.includes('sh.Run """C:\\Program Files\\nodejs\\node.exe"" ""'), 'node.exe entre guillemets VBS');
  assert.ok(vbs.includes('agent-win.js'), 'lance agent-win.js');
});

test('arguments reg.exe : clé Run HKCU, REG_SZ, /f ; suppression sans /d', () => {
  assert.equal(setup.RUN_KEY, 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
  assert.deepEqual(setup.regArgs.add('ClaudeDojoAgent', 'X'), ['add', setup.RUN_KEY, '/v', 'ClaudeDojoAgent', '/t', 'REG_SZ', '/d', 'X', '/f']);
  assert.deepEqual(setup.regArgs.del('ClaudeDojoWallpaper'), ['delete', setup.RUN_KEY, '/v', 'ClaudeDojoWallpaper', '/f']);
});

test('autostartInstall en dryRun : rien n écrit, valeurs prévues (agent seul sans exe)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-dry-'));
  const env = { USERPROFILE: home, HOME: home, DOJO_SKIP_REGISTRY: '1' };
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const out = setup.autostartInstall({ node: process.execPath, dryRun: true });
    assert.equal(out.dryRun, true);
    assert.deepEqual(out.values.map((v) => v.name), ['ClaudeDojoAgent']);
    assert.equal(fs.existsSync(path.join(home, '.config', 'claude-dojo', 'start-agent.vbs')), false);
  } finally {
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── CLI et fichiers (Windows seulement, profil temporaire) ───────────────

function winHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-win-'));
}

// Lance le CLI avec un profil temporaire. Renvoie { code, out (JSON), stderr }.
function cli(home, args, { input, env = {} } = {}) {
  const r = spawnSync(process.execPath, [SETUP, ...args], {
    env: {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      DOJO_SKIP_REGISTRY: '1',
      DOJO_SKIP_EXE: '1',
      DOJO_DETECT_NO_GH_AUTH: '1',
      ...env,
    },
    input,
    encoding: 'utf8',
    timeout: 120000,
  });
  let out = null;
  try { out = JSON.parse(r.stdout.trim()); } catch { out = null; }
  return { code: r.status, out, stderr: r.stderr };
}

const settingsFile = (home) => path.join(home, '.claude', 'settings.json');
const dojoDir = (home) => path.join(home, '.config', 'claude-dojo');
const backups = (file) => fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(path.basename(file) + '.bak-'));

// Dossier source factice : fichiers du runtime Windows (agent-win.js, win-media.js, windows/media.ps1, thèmes).
function fakeSrc(home) {
  const src = path.join(home, 'src');
  fs.mkdirSync(path.join(src, 'windows'), { recursive: true });
  fs.mkdirSync(path.join(src, 'themes', 'naruto'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'claude-dojo', version: '0.2.1' }));
  fs.writeFileSync(path.join(src, 'agent-win.js'), '// agent v1\n');
  fs.writeFileSync(path.join(src, 'win-media.js'), '// media\n');
  fs.writeFileSync(path.join(src, 'hook.js'), '// hook\n');
  fs.writeFileSync(path.join(src, 'windows', 'media.ps1'), '# media\n');
  fs.writeFileSync(path.join(src, 'themes', 'naruto', 'theme.json'), '{}\n');
  return src;
}

test('install-files Windows : runtime copié (agent-win, win-media, windows/media.ps1), config.json et windows\\bin conservés', winOnly, () => {
  const home = winHome();
  try {
    const src = fakeSrc(home);
    let out = cli(home, ['install-files', src]);
    assert.equal(out.code, 0, out.stderr);
    const dest = dojoDir(home);
    for (const f of ['agent-win.js', 'win-media.js', 'hook.js', 'package.json', path.join('windows', 'media.ps1')]) {
      assert.ok(fs.existsSync(path.join(dest, f)), f);
    }
    assert.ok(fs.existsSync(path.join(dest, 'themes', 'naruto', 'theme.json')));
    // Réinstallation : config et exe de windows\bin gardés, runtime mis à jour.
    fs.writeFileSync(path.join(dest, 'config.json'), '{"theme":"naruto"}\n');
    fs.mkdirSync(path.join(dest, 'windows', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'windows', 'bin', 'DojoWallpaper.exe'), 'fake');
    fs.writeFileSync(path.join(src, 'agent-win.js'), '// agent v2\n');
    out = cli(home, ['install-files', src]);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(fs.readFileSync(path.join(dest, 'config.json'), 'utf8'), '{"theme":"naruto"}\n');
    assert.equal(fs.readFileSync(path.join(dest, 'windows', 'bin', 'DojoWallpaper.exe'), 'utf8'), 'fake');
    assert.equal(fs.readFileSync(path.join(dest, 'agent-win.js'), 'utf8'), '// agent v2\n');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('write-config Windows : écrit config.json, mode POSIX non applicable (null), sans erreur', winOnly, () => {
  const home = winHome();
  try {
    const out = cli(home, ['write-config', '{"theme":"naruto","terminal":{"welcome":false}}']);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.out.mode, null);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dojoDir(home), 'config.json'), 'utf8')).theme, 'naruto');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('merge-settings Windows : crée/complète settings.json avec sauvegarde, idempotent, clés utilisateur gardées', winOnly, () => {
  const home = winHome();
  try {
    const file = settingsFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(userSettings(), null, 2));
    let out = cli(home, ['merge-settings', '{"heavyGate":true,"statusLine":"keep"}']);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.out.changed, true);
    assert.equal(backups(file).length, 1, 'une sauvegarde avant modification');
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(s.model, 'opus');
    assert.equal(s.env.FOO, 'bar');
    assert.ok(s.hooks.Stop.some((g) => g.hooks.some((h) => h.command === 'C:\\tools\\notify.cmd')));
    const heavy = s.hooks.PreToolUse.find((g) => g.hooks.some((h) => /claude-dojo\\heavy-gate\.js"$/.test(h.command)));
    assert.equal(heavy.matcher, 'Bash|PowerShell');
    assert.match(s.hooks.Stop.find((g) => /claude-dojo/.test(JSON.stringify(g))).hooks[0].command, /^".+node(\.exe)?" ".+claude-dojo\\hook\.js"$/);
    assert.equal(s.statusLine.command.includes('claude-dojo\\statusline.js'), true);
    // Deuxième passe : rien à changer, pas de nouvelle sauvegarde.
    out = cli(home, ['merge-settings', '{"heavyGate":true,"statusLine":"keep"}']);
    assert.equal(out.out.changed, false);
    assert.equal(backups(file).length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall Windows sans purge : entrées dojo retirées (sauvegarde), clés utilisateur gardées, config.json seul reste', winOnly, () => {
  const home = winHome();
  try {
    const file = settingsFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(userSettings(), null, 2));
    assert.equal(cli(home, ['install-files', fakeSrc(home)]).code, 0);
    assert.equal(cli(home, ['merge-settings', '{"heavyGate":true,"statusLine":"replace"}']).code, 0);
    const dest = dojoDir(home);
    fs.writeFileSync(path.join(dest, 'config.json'), '{"theme":"naruto"}\n');
    fs.mkdirSync(path.join(dest, 'windows', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'windows', 'bin', 'DojoWallpaper.exe'), 'fake');
    fs.writeFileSync(path.join(dest, 'start-agent.vbs'), "' lanceur\r\n");

    const out = cli(home, ['uninstall', '{}']);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.out.settings.changed, true);
    assert.ok(out.out.settings.backup, 'sauvegarde signalée');
    assert.deepEqual(out.out.appRemoved, [path.join(dest, 'windows', 'bin')]);
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(s, userSettings(), 'settings identiques à l original');
    assert.equal(fs.existsSync(path.join(dest, 'windows', 'bin')), false, 'exe retiré');
    assert.equal(fs.existsSync(path.join(dest, 'start-agent.vbs')), false, 'lanceur retiré');
    assert.equal(fs.existsSync(path.join(dest, 'config.json')), true, 'config conservée sans --purge');
    assert.equal(fs.existsSync(path.join(dest, 'package.json')), false, 'runtime retiré sans --purge');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall Windows avec purge : dossier d installation entièrement supprimé', winOnly, () => {
  const home = winHome();
  try {
    const dest = dojoDir(home);
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'config.json'), '{}\n');
    const out = cli(home, ['uninstall', '{"purge":true}']);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(fs.existsSync(dest), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('launchagents install/uninstall Windows : lanceur écrit, registre sauté et signalé (DOJO_SKIP_REGISTRY=1)', winOnly, () => {
  const home = winHome();
  try {
    const dest = dojoDir(home);
    fs.mkdirSync(dest, { recursive: true });
    let out = cli(home, ['launchagents', 'install', '{}']);
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(out.out.loaded, []);
    assert.ok(out.out.warnings.some((w) => w.includes('DOJO_SKIP_REGISTRY')));
    const vbs = path.join(dest, 'start-agent.vbs');
    const content = fs.readFileSync(vbs, 'utf8');
    assert.match(content, /, 0, False/);
    assert.doesNotMatch(content, /[^\x00-\x7f]/);
    out = cli(home, ['launchagents', 'uninstall', '{}']);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(fs.existsSync(vbs), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ensure-wallpaper-exe Windows : DOJO_SKIP_EXE=1 ne fait rien', winOnly, () => {
  const home = winHome();
  try {
    const out = cli(home, ['ensure-wallpaper-exe'], { env: { DOJO_SKIP_EXE: '1' } });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.out.installed, false);
    assert.equal(out.out.skipped, 'DOJO_SKIP_EXE=1');
    assert.equal(fs.existsSync(path.join(dojoDir(home), 'windows')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('detect Windows : install.autostart renseigné, chemins Windows', winOnly, () => {
  const home = winHome();
  try {
    const out = cli(home, ['detect']);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.out.platform, 'win32');
    assert.equal(typeof out.out.install.autostart.agent, 'boolean');
    assert.equal(out.out.home, home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
