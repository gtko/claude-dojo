// Tests des options terminal de src/setup.js (Ghostty, Terminal.app, zsh/welcome, set-theme, uninstall) et
// cohérence des bundles terminal/ de chaque thème (src/themes/<id>/terminal/). node:test.
// Chaque test travaille dans un HOME temporaire sous os.tmpdir(). defaults et pgrep sont remplacés par des faux
// (DOJO_DEFAULTS_BIN, DOJO_PGREP_BIN) : le vrai defaults n'est jamais appelé. L'environnement des processus est
// reconstruit à partir de zéro (ni ZDOTDIR ni variable DOJO_* de la machine ne fuient dans les tests).
'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SETUP = path.join(REPO, 'src', 'setup.js');
const THEMES_SRC = path.join(REPO, 'src', 'themes');
const HAS_PLUTIL = spawnSync('/bin/sh', ['-c', 'command -v plutil'], { encoding: 'utf8' }).status === 0;
const NEEDS_PLUTIL = HAS_PLUTIL ? false : 'plutil absent (macOS requis)';

// ── Helpers ──────────────────────────────────────────────────────────────
const CREATED = [];
after(() => { for (const d of CREATED) fs.rmSync(d, { recursive: true, force: true }); });

const XML_TERMINAL = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>name</key>
	<string>Src name</string>
	<key>type</key>
	<string>Window Settings</string>
	<key>BackgroundAlpha</key>
	<real>0.88</real>
</dict>
</plist>
`;
const XML_STORE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
	<key>Default Window Settings</key><string>Basic</string>
	<key>Startup Window Settings</key><string>Basic</string>
	<key>Window Settings</key><dict><key>Basic</key><dict><key>name</key><string>Basic</string></dict></dict>
</dict></plist>
`;
// Faux defaults : export copie le magasin dans le fichier demandé, import le remplace. Journal dans FAKE_LOG.
const FAKE_DEFAULTS = `#!/bin/sh
echo "defaults $*" >> "$FAKE_LOG"
case "$1" in
  export) cp "$FAKE_STORE" "$3" || exit 1 ;;
  import) cp "$3" "$FAKE_STORE" || exit 1; mkdir -p "$(dirname "$FAKE_PREFS")"; : > "$FAKE_PREFS" ;;
  *) exit 2 ;;
esac
`;
// Faux pgrep : Terminal « lancé » tant que le fichier FAKE_RUNNING existe. Jamais de kill.
const FAKE_PGREP = `#!/bin/sh
echo "pgrep $*" >> "$FAKE_LOG"
[ -f "$FAKE_RUNNING" ] && exit 0
exit 1
`;

// Environnement isolé : HOME avec espace, thèmes factices (alpha, beta, gamma sans terminal/), faux binaires.
function makeEnv({ prefs = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-term-test-'));
  CREATED.push(root);
  const home = path.join(root, 'home dir');
  fs.mkdirSync(home, { recursive: true });
  const mk = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
  const themes = path.join(root, 'themes');
  mk(path.join(themes, 'alpha', 'theme.json'), JSON.stringify({ id: 'alpha', name: 'Alpha' }));
  mk(path.join(themes, 'alpha', 'terminal', 'ghostty.theme'), 'palette = 0=#000000\n');
  mk(path.join(themes, 'alpha', 'terminal', 'Terminal.terminal'), XML_TERMINAL);
  mk(path.join(themes, 'alpha', 'terminal', 'shaders', 'b.glsl'), '// b\n');
  mk(path.join(themes, 'alpha', 'terminal', 'shaders', 'a.glsl'), '// a\n');
  mk(path.join(themes, 'alpha', 'terminal', 'shaders', 'notes.txt'), 'pas un shader');
  mk(path.join(themes, 'beta', 'theme.json'), JSON.stringify({ id: 'beta', name: 'Beta.Theme' }));
  mk(path.join(themes, 'beta', 'terminal', 'ghostty.theme'), 'palette = 1=#111111\n');
  mk(path.join(themes, 'beta', 'terminal', 'Terminal.terminal'), XML_TERMINAL);
  mk(path.join(themes, 'gamma', 'theme.json'), JSON.stringify({ id: 'gamma', name: 'Gamma' }));
  mk(path.join(root, 'src-terminal', 'welcome.zsh'), '# welcome\necho hello\n');
  mk(path.join(root, 'store.plist'), prefs ? XML_STORE : '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict/></plist>\n');
  mk(path.join(root, 'bin', 'defaults'), FAKE_DEFAULTS);
  mk(path.join(root, 'bin', 'pgrep'), FAKE_PGREP);
  fs.chmodSync(path.join(root, 'bin', 'defaults'), 0o755);
  fs.chmodSync(path.join(root, 'bin', 'pgrep'), 0o755);
  mk(path.join(home, '.config', 'claude-dojo', 'config.json'), JSON.stringify({ theme: 'alpha' }));
  if (prefs) mk(path.join(home, 'Library', 'Preferences', 'com.apple.Terminal.plist'), 'placeholder');
  const env = {
    PATH: path.join(root, 'bin') + path.delimiter + (process.env.PATH || '/usr/bin:/bin'),
    HOME: home,
    DOJO_DETECT_NO_GH_AUTH: '1',
    DOJO_APPS_DIRS: [path.join(home, 'Applications'), path.join(home, 'SysApplications')].join(path.delimiter),
    DOJO_THEMES_DIR: root,
    DOJO_TERMINAL_DIR: path.join(root, 'src-terminal'),
    DOJO_DEFAULTS_BIN: path.join(root, 'bin', 'defaults'),
    DOJO_PGREP_BIN: path.join(root, 'bin', 'pgrep'),
    FAKE_STORE: path.join(root, 'store.plist'),
    FAKE_PREFS: path.join(home, 'Library', 'Preferences', 'com.apple.Terminal.plist'),
    FAKE_LOG: path.join(root, 'calls.log'),
    FAKE_RUNNING: path.join(root, 'running'),
  };
  fs.writeFileSync(env.FAKE_LOG, '');
  return { root, home, env, store: env.FAKE_STORE, log: env.FAKE_LOG };
}

// Terminal.app « lancé » ou non (fichier drapeau lu par le faux pgrep).
const setRunning = (E, on) => {
  if (on) fs.writeFileSync(E.env.FAKE_RUNNING, '');
  else fs.rmSync(E.env.FAKE_RUNNING, { force: true });
};

// Lance setup.js avec l'environnement de E (+ extraEnv). Refuse de tourner sans faux defaults/pgrep.
function cli(E, args, { input, extraEnv = {}, script = SETUP } = {}) {
  const env = { ...E.env, ...extraEnv };
  assert.ok(env.DOJO_DEFAULTS_BIN.startsWith(E.root) && env.DOJO_PGREP_BIN.startsWith(E.root), 'faux defaults et pgrep obligatoires');
  const r = spawnSync(process.execPath, [script, ...args], { env, input, encoding: 'utf8', timeout: 120000 });
  let out = null;
  try { out = JSON.parse(r.stdout.trim()); } catch { out = null; }
  return { code: r.status, out, raw: r.stdout.trim(), stderr: r.stderr };
}
const ok = (r) => { assert.equal(r.code, 0, r.raw + ' ' + r.stderr); assert.equal(r.out.ok, true, r.raw); return r.out; };
const fails = (r, re) => { assert.equal(r.code, 1, r.raw); assert.equal(r.out.ok, false, r.raw); assert.match(r.out.error, re); return r.out.error; };

const ghosttyFile = (E) => path.join(E.home, '.config', 'ghostty', 'config');
const appSupportGhostty = (E) => path.join(E.home, 'Library', 'Application Support', 'com.mitchellh.ghostty', 'config.ghostty');
const zshrc = (E) => path.join(E.home, '.zshrc');
const generated = (E) => path.join(E.home, '.config', 'claude-dojo', 'terminal');
const cfgFile = (E) => path.join(E.home, '.config', 'claude-dojo', 'config.json');
const stateFile = (E) => path.join(E.home, '.config', 'claude-dojo', 'state.json');
const cfgTerminal = (E) => JSON.parse(fs.readFileSync(cfgFile(E), 'utf8')).terminal;
const bakFiles = (f) => fs.existsSync(path.dirname(f)) ? fs.readdirSync(path.dirname(f)).filter((n) => n.startsWith(path.basename(f) + '.bak-')) : [];
const calls = (E, prefix) => fs.readFileSync(E.log, 'utf8').split('\n').filter((l) => l && (!prefix || l.startsWith(prefix)));
const readBytes = (f) => fs.readFileSync(f);
const readText = (f) => fs.readFileSync(f, 'utf8');
// Empreintes de tout le HOME (fichiers, liens, sauvegardes comprises) : deux relevés égaux = aucun changement.
function snapshot(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (e.isSymbolicLink()) out[rel] = 'lien:' + fs.readlinkSync(p);
      else if (e.isDirectory()) walk(p);
      else out[rel] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}
// Valeur d'une clé d'un plist (copie temporaire : plutil ne touche jamais au magasin de test).
function plistGet(E, key, file = E.store) {
  const copy = path.join(E.root, `chk-${crypto.randomBytes(4).toString('hex')}.plist`);
  fs.copyFileSync(file, copy);
  return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', copy], { encoding: 'utf8' }).trim();
}
const plistHas = (E, key) => {
  const copy = path.join(E.root, `has-${crypto.randomBytes(4).toString('hex')}.plist`);
  fs.copyFileSync(E.store, copy);
  return spawnSync('plutil', ['-extract', key, 'raw', '-o', '-', copy], { encoding: 'utf8' }).status === 0;
};

// Contenus « riches » : commentaires, lignes vides, sans retour final, CRLF.
const RICH_GHOSTTY = '# my ghostty config\n\nfont-family = "JetBrains Mono"\n\n# keybinds\nkeybind = ctrl+t=new_tab\n\n   \n# last line, no newline';
const RICH_ZSH = 'export FOO=1\n\n# aliases\nalias ll=\'ls -la\'\n\n# trailing blank\n\nexport BAR="x y"';
const RICH_CASES = {
  'commentaires, lignes vides, sans retour final': RICH_GHOSTTY,
  'se termine par un retour à la ligne': '# c\n\nfont-size = 12\n',
  'se termine par deux retours (ligne vide finale)': 'a = 1\n\n',
  'CRLF avec retour final': 'font-size = 12\r\n# c\r\n\r\nkeybind = a=b\r\n',
  'CRLF sans retour final': 'a = 1\r\nb = 2',
  'uniquement des lignes vides': '\n\n',
  'fichier vide existant': '',
};

test('apply ghostty+welcome : fichiers générés, lignes exactes, sauvegardes, retrait octet pour octet', () => {
  const E = makeEnv();
  fs.mkdirSync(path.dirname(ghosttyFile(E)), { recursive: true });
  fs.writeFileSync(ghosttyFile(E), RICH_GHOSTTY);
  fs.writeFileSync(zshrc(E), RICH_ZSH);
  const a = ok(cli(E, ['terminal', 'apply', '{"ghostty":true,"welcome":true}']));
  assert.equal(a.ghostty.action, 'added');
  assert.equal(a.welcome.action, 'added');
  assert.equal(a.terminalApp.action, 'none');
  assert.equal(a.ghostty.configPath, ghosttyFile(E));
  assert.equal(bakFiles(ghosttyFile(E)).length, 1, 'une sauvegarde pour ghostty');
  assert.equal(bakFiles(zshrc(E)).length, 1, 'une sauvegarde pour zshrc');
  assert.equal(readBytes(path.join(path.dirname(ghosttyFile(E)), bakFiles(ghosttyFile(E))[0])).equals(Buffer.from(RICH_GHOSTTY)), true, 'sauvegarde = original');
  // bloc ajouté en fin, après le texte d'origine ; le retour manquant n'est pas inventé à la fin du fichier
  const gh = readText(ghosttyFile(E));
  assert.ok(gh.startsWith(RICH_GHOSTTY + '\n# claude-dojo terminal theme (managed)\nconfig-file = ?"'));
  assert.ok(gh.endsWith('ghostty.conf"'));
  const zs = readText(zshrc(E));
  assert.ok(zs.startsWith(RICH_ZSH + '\n# claude-dojo welcome (managed)\nsource "'));
  assert.ok(zs.endsWith('welcome.zsh"'));
  assert.equal(readText(path.join(generated(E), 'welcome.zsh')), '# welcome\necho hello\n');
  assert.equal(fs.existsSync(path.join(generated(E), 'theme', 'Terminal.terminal')), true, 'theme/ copié');
  assert.deepEqual(cfgTerminal(E), { ghostty: true, terminalApp: false, welcome: true });
  const r = ok(cli(E, ['terminal', 'remove']));
  assert.equal(r.ghostty.action, 'removed');
  assert.equal(r.welcome.action, 'removed');
  assert.equal(readText(ghosttyFile(E)), RICH_GHOSTTY, 'ghostty : octets d origine');
  assert.equal(readText(zshrc(E)), RICH_ZSH, 'zshrc : octets d origine');
  assert.equal(fs.existsSync(generated(E)), false, 'dossier terminal/ supprimé');
  assert.deepEqual(cfgTerminal(E), { ghostty: false, terminalApp: false, welcome: false });
});

test('idempotence : apply x2 = aucun octet modifié dans le HOME, aucune nouvelle sauvegarde, aucun appel defaults', () => {
  const E = makeEnv();
  fs.mkdirSync(path.dirname(ghosttyFile(E)), { recursive: true });
  fs.writeFileSync(ghosttyFile(E), RICH_GHOSTTY);
  fs.writeFileSync(zshrc(E), RICH_ZSH);
  ok(cli(E, ['terminal', 'apply', '{"ghostty":true,"welcome":true}']));
  const before = snapshot(E.home);
  const second = ok(cli(E, ['terminal', 'apply', '{"ghostty":true,"welcome":true}']));
  assert.equal(second.ghostty.action, 'unchanged');
  assert.equal(second.welcome.action, 'unchanged');
  assert.equal(second.ghostty.changed, false);
  assert.equal(second.welcome.changed, false);
  assert.equal(second.ghostty.backup, null);
  assert.deepEqual(snapshot(E.home), before, 'HOME identique après le 2e apply');
  assert.equal(bakFiles(ghosttyFile(E)).length, 1);
  assert.equal(bakFiles(zshrc(E)).length, 1);
  // apply sans argument : options enregistrées reprises, même résultat
  ok(cli(E, ['terminal', 'apply']));
  assert.deepEqual(snapshot(E.home), before, 'apply sans argument : rien ne change');
  assert.equal(calls(E, 'defaults').length, 0);
});

test('idempotence Terminal.app : 2e apply sans nouvel import', { skip: NEEDS_PLUTIL }, () => {
  const E = makeEnv();
  assert.equal(ok(cli(E, ['terminal', 'apply', '{"terminalApp":true}'])).terminalApp.action, 'imported');
  const n = calls(E, 'defaults').length;
  const before = snapshot(E.home);
  const again = ok(cli(E, ['terminal', 'apply']));
  assert.equal(again.terminalApp.action, 'unchanged');
  assert.equal(calls(E, 'defaults').length, n, 'aucun defaults au 2e apply');
  assert.deepEqual(snapshot(E.home), before, 'HOME identique');
});

for (const [label, content] of Object.entries(RICH_CASES)) {
  test(`retrait octet pour octet, ghostty et zshrc (${label})`, () => {
    const E = makeEnv();
    const gh = ghosttyFile(E);
    const zs = zshrc(E);
    if (content !== null) {
      fs.mkdirSync(path.dirname(gh), { recursive: true });
      fs.writeFileSync(gh, Buffer.from(content, 'utf8'));
      fs.writeFileSync(zs, Buffer.from(content, 'utf8'));
    }
    ok(cli(E, ['terminal', 'apply', '{"ghostty":true,"welcome":true}']));
    assert.ok(readText(gh).includes('# claude-dojo terminal theme (managed)'));
    assert.ok(readText(zs).includes('# claude-dojo welcome (managed)'));
    ok(cli(E, ['terminal', 'remove']));
    assert.ok(readBytes(gh).equals(Buffer.from(content, 'utf8')), 'ghostty : octets identiques à l origine');
    assert.ok(readBytes(zs).equals(Buffer.from(content, 'utf8')), 'zshrc : octets identiques à l origine');
    // la sauvegarde horodatée reste l'original exact
    const [b] = bakFiles(gh);
    assert.ok(readBytes(path.join(path.dirname(gh), b)).equals(Buffer.from(content, 'utf8')), 'sauvegarde = original');
  });
}

test('retrait sans bloc : fichier laissé strictement intact (aucune sauvegarde, aucune écriture)', () => {
  const E = makeEnv();
  fs.writeFileSync(zshrc(E), 'a=1\n# commentaire\n');
  const before = snapshot(E.home);
  const r = ok(cli(E, ['terminal', 'remove']));
  assert.equal(r.welcome.action, 'none');
  assert.equal(r.welcome.changed, false);
  assert.deepEqual(snapshot(E.home), before);
});

test('fichier créé à l apply (zshrc absent) : vidé au retrait, sans sauvegarde', () => {
  const E = makeEnv();
  ok(cli(E, ['terminal', 'apply', '{"welcome":true}']));
  assert.ok(fs.existsSync(zshrc(E)));
  assert.equal(bakFiles(zshrc(E)).length, 0, 'pas de sauvegarde d un fichier inexistant');
  ok(cli(E, ['terminal', 'remove', '{"welcome":true}']));
  assert.equal(readText(zshrc(E)), '');
});

test('ghostty : création de ~/.config/ghostty/config si absent, une seule ligne config-file après 2 apply', () => {
  const E = makeEnv();
  assert.equal(fs.existsSync(ghosttyFile(E)), false);
  const r = ok(cli(E, ['terminal', 'apply', '{"ghostty":true}']));
  assert.equal(r.ghostty.configPath, ghosttyFile(E));
  assert.equal(r.ghostty.action, 'added');
  ok(cli(E, ['terminal', 'apply', '{"ghostty":true}']));
  const gh = readText(ghosttyFile(E));
  assert.equal(gh.split('\n').filter((l) => l.startsWith('config-file')).length, 1, 'une seule ligne config-file');
  assert.equal(gh.split('\n').filter((l) => l === '# claude-dojo terminal theme (managed)').length, 1, 'un seul marqueur');
  assert.match(gh, /^config-file = \?"[^"\n]+\/ghostty\.conf"$/m);
  assert.equal(bakFiles(ghosttyFile(E)).length, 0, 'fichier créé : pas de sauvegarde');
  assert.equal(fs.existsSync(appSupportGhostty(E)), false, 'Application Support non créé');
});

test('ghostty : ~/.config/ghostty/config prioritaire ; Application Support seul utilisé si c est le seul', () => {
  const E = makeEnv();
  fs.mkdirSync(path.dirname(appSupportGhostty(E)), { recursive: true });
  fs.writeFileSync(appSupportGhostty(E), 'x = 1');
  const r = ok(cli(E, ['terminal', 'apply', '{"ghostty":true}']));
  assert.equal(r.ghostty.configPath, appSupportGhostty(E));
  assert.equal(readText(appSupportGhostty(E)), 'x = 1\n# claude-dojo terminal theme (managed)\nconfig-file = ?"' + path.join(generated(E), 'ghostty.conf') + '"');
  assert.equal(fs.existsSync(ghosttyFile(E)), false, '~/.config/ghostty non créé quand Application Support existe');
  // les deux existent : ~/.config prioritaire, Application Support intouché et débarrassé du bloc
  fs.mkdirSync(path.dirname(ghosttyFile(E)), { recursive: true });
  fs.writeFileSync(ghosttyFile(E), 'font = 1');
  const r2 = ok(cli(E, ['terminal', 'apply', '{"ghostty":true}']));
  assert.equal(r2.ghostty.configPath, ghosttyFile(E));
  assert.ok(readText(ghosttyFile(E)).includes('config-file = ?'));
  assert.equal(readText(appSupportGhostty(E)), 'x = 1', 'Application Support : bloc retiré, texte d origine');
  assert.equal(readText(appSupportGhostty(E)).includes('claude-dojo'), false);
});

test('ZDOTDIR : .zshrc lu dans ZDOTDIR (dossier avec espace), ~/.zshrc non créé', () => {
  const E = makeEnv();
  const zdot = path.join(E.home, 'zdot dir');
  fs.mkdirSync(zdot);
  const r = ok(cli(E, ['terminal', 'apply', '{"welcome":true}'], { extraEnv: { ZDOTDIR: zdot } }));
  assert.equal(r.welcome.zshrc, path.join(zdot, '.zshrc'));
  assert.ok(readText(path.join(zdot, '.zshrc')).includes('# claude-dojo welcome (managed)'));
  assert.equal(fs.existsSync(zshrc(E)), false, 'pas de ~/.zshrc quand ZDOTDIR est défini');
  ok(cli(E, ['terminal', 'remove', '{"welcome":true}'], { extraEnv: { ZDOTDIR: zdot } }));
  assert.equal(readText(path.join(zdot, '.zshrc')), '');
});

test('chemins avec espaces : valeurs quotées dans ghostty.conf, theme et source zsh', () => {
  const E = makeEnv();
  ok(cli(E, ['terminal', 'apply', '{"ghostty":true,"welcome":true}']));
  const conf = readText(path.join(generated(E), 'ghostty.conf'));
  assert.match(conf, /^theme = "[^"\n]*\/theme\/ghostty\.theme"$/m, 'theme quoté (espace dans le HOME)');
  assert.match(conf, /^custom-shader = "[^"\n]*\/theme\/shaders\/a\.glsl"$/m);
  assert.ok(readText(zshrc(E)).includes('source "' + path.join(generated(E), 'welcome.zsh') + '"'));
});

test('ghostty.conf : une ligne custom-shader par .glsl, triées, lien symbolique inclus, notes.txt exclu', () => {
  const E = makeEnv();
  // lien relatif dans le thème source (autorisé : il reste dans terminal/)
  fs.symlinkSync('b.glsl', path.join(E.root, 'themes', 'alpha', 'terminal', 'shaders', 'z-link.glsl'));
  ok(cli(E, ['terminal', 'apply', '{"ghostty":true}']));
  const conf = readText(path.join(generated(E), 'ghostty.conf'));
  const shaders = conf.split('\n').filter((l) => l.startsWith('custom-shader'));
  assert.equal(shaders.length, 3, shaders.join(' | '));
  assert.ok(shaders[0].includes('/a.glsl') && shaders[1].includes('/b.glsl') && shaders[2].includes('/z-link.glsl'), 'ordre trié');
  assert.equal(conf.includes('notes.txt'), false);
});

test('ghostty.conf ne contient jamais background-image (ni fond d image), options fixes présentes', () => {
  const E = makeEnv();
  ok(cli(E, ['terminal', 'apply', '{"ghostty":true}']));
  const conf = readText(path.join(generated(E), 'ghostty.conf'));
  assert.equal(/background-image/.test(conf), false);
  assert.match(conf, /background-opacity = 0\.88\nbackground-blur = 20\nwindow-colorspace = display-p3\nminimum-contrast = 1\.1\n$/);
});

test('zshrc : bloc périmé (ancien chemin) remplacé par un seul bloc à jour, texte de l utilisateur gardé', () => {
  const E = makeEnv();
  const stale = 'before=1\n# claude-dojo welcome (managed)\nsource "/old/place/welcome.zsh"\nafter=2\n';
  fs.writeFileSync(zshrc(E), stale);
  ok(cli(E, ['terminal', 'apply', '{"welcome":true}']));
  const zs = readText(zshrc(E));
  assert.equal(zs.split('\n').filter((l) => l === '# claude-dojo welcome (managed)').length, 1);
  assert.equal(zs.includes('/old/place'), false, 'ancien chemin retiré');
  assert.ok(zs.startsWith('before=1\nafter=2\n# claude-dojo welcome (managed)\nsource "'), zs);
  ok(cli(E, ['terminal', 'remove', '{"welcome":true}']));
  assert.equal(readText(zshrc(E)), 'before=1\nafter=2\n');
});

test('bloc ajouté deux fois à la main : un seul bloc après apply, retrait complet', () => {
  const E = makeEnv();
  const line = `source "${path.join(generated(E), 'welcome.zsh')}"`;
  const dup = `keep=1\n# claude-dojo welcome (managed)\n${line}\n# claude-dojo welcome (managed)\n${line}\n`;
  fs.writeFileSync(zshrc(E), dup);
  ok(cli(E, ['terminal', 'apply', '{"welcome":true}']));
  assert.equal(readText(zshrc(E)).split('\n').filter((l) => l === '# claude-dojo welcome (managed)').length, 1, 'un seul marqueur après apply');
  ok(cli(E, ['terminal', 'remove', '{"welcome":true}']));
  assert.equal(readText(zshrc(E)), 'keep=1\n', 'aucun résidu du bloc dupliqué');
});

test('apply sans option ni enregistrement : aucun fichier créé, aucun appel defaults', () => {
  const E = makeEnv();
  const r = ok(cli(E, ['terminal', 'apply', '{}']));
  assert.equal(r.ghostty.action, 'none');
  assert.equal(r.welcome.action, 'none');
  assert.equal(r.terminalApp.action, 'none');
  assert.equal(fs.existsSync(ghosttyFile(E)), false);
  assert.equal(fs.existsSync(appSupportGhostty(E)), false);
  assert.equal(fs.existsSync(zshrc(E)), false);
  assert.equal(fs.existsSync(generated(E)), false);
  assert.equal(calls(E, 'defaults').length, 0);
});

test('apply partiel : options non citées conservées ; tout à false retire le dossier terminal/', () => {
  const E = makeEnv();
  ok(cli(E, ['terminal', 'apply', '{"welcome":true}']));
  ok(cli(E, ['terminal', 'apply', '{"ghostty":true}']));
  assert.deepEqual(cfgTerminal(E), { ghostty: true, terminalApp: false, welcome: true });
  assert.ok(fs.existsSync(path.join(generated(E), 'welcome.zsh')));
  ok(cli(E, ['terminal', 'apply', '{"ghostty":false,"welcome":false}']));
  assert.equal(fs.existsSync(generated(E)), false);
  assert.equal(readText(zshrc(E)), '', 'zshrc vidé du bloc');
  assert.equal(fs.existsSync(ghosttyFile(E)) && readText(ghosttyFile(E)).includes('claude-dojo'), false);
});

test('remove partiel (welcome seul) : ghostty reste, le dossier reste, options à jour', () => {
  const E = makeEnv();
  fs.mkdirSync(path.dirname(ghosttyFile(E)), { recursive: true });
  fs.writeFileSync(ghosttyFile(E), 'a = 1');
  ok(cli(E, ['terminal', 'apply', '{"ghostty":true,"welcome":true}']));
  const r = ok(cli(E, ['terminal', 'remove', '{"welcome":true}']));
  assert.equal(r.welcome.action, 'removed');
  assert.equal(r.ghostty, null);
  assert.equal(r.dir.removed, false);
  assert.equal(fs.existsSync(path.join(generated(E), 'theme', 'ghostty.theme')), true);
  assert.equal(fs.existsSync(path.join(generated(E), 'welcome.zsh')), false);
  assert.deepEqual(cfgTerminal(E), { ghostty: true, terminalApp: false, welcome: false });
  assert.ok(readText(ghosttyFile(E)).includes('# claude-dojo terminal theme (managed)'));
});

test('set-theme sans option terminal active : aucun fichier terminal touché', () => {
  const E = makeEnv();
  const before = snapshot(E.home);
  const r = ok(cli(E, ['set-theme', 'beta']));
  assert.equal(r.regenerated, undefined);
  assert.equal(fs.existsSync(generated(E)), false);
  assert.equal(fs.existsSync(ghosttyFile(E)), false);
  assert.equal(fs.existsSync(zshrc(E)), false);
  assert.equal(calls(E, 'defaults').length, 0);
  // seul config.json a changé (thème)
  const after = snapshot(E.home);
  const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
  assert.deepEqual(changed, [path.join('.config', 'claude-dojo', 'config.json')]);
});

test('set-theme régénère theme/ quand une option est active ; shaders absents chez beta', () => {
  const E = makeEnv();
  ok(cli(E, ['terminal', 'apply', '{"ghostty":true}']));
  const r = ok(cli(E, ['set-theme', 'beta']));
  assert.equal(r.regenerated, true);
  const dir = generated(E);
  assert.match(readText(path.join(dir, 'ghostty.conf')), /theme\/ghostty\.theme/);
  assert.equal(readText(path.join(dir, 'theme', 'ghostty.theme')), 'palette = 1=#111111\n', 'theme/ remplacé par beta');
  assert.equal(fs.existsSync(path.join(dir, 'theme', 'shaders')), false, 'pas de shaders chez beta');
  assert.equal(JSON.parse(readText(cfgFile(E))).theme, 'beta');
});

test('set-theme vers un thème sans terminal/ : refusé, config et fichiers inchangés', () => {
  const E = makeEnv();
  ok(cli(E, ['terminal', 'apply', '{"ghostty":true}']));
  const before = snapshot(E.home);
  const err = fails(cli(E, ['set-theme', 'gamma']), /gamma : dossier terminal\/ absent/);
  assert.match(err, /gamma/);
  assert.deepEqual(snapshot(E.home), before, 'rien n a bougé');
  assert.equal(JSON.parse(readText(cfgFile(E))).theme, 'alpha');
});

test('thème sans terminal/ : apply ghostty refusé sans rien écrire ; welcome seul reste possible', () => {
  const E = makeEnv();
  fs.writeFileSync(cfgFile(E), JSON.stringify({ theme: 'gamma' }));
  fs.writeFileSync(zshrc(E), 'keep');
  const before = snapshot(E.home);
  fails(cli(E, ['terminal', 'apply', '{"ghostty":true}']), /gamma : dossier terminal\/ absent/);
  assert.deepEqual(snapshot(E.home), before, 'rien n a bougé après refus');
  const r = ok(cli(E, ['terminal', 'apply', '{"welcome":true}']));
  assert.equal(r.welcome.action, 'added', 'welcome n utilise pas le bundle du thème');
});

test('welcome.zsh manquant : erreur claire, rien écrit', () => {
  const E = makeEnv();
  fs.unlinkSync(path.join(E.root, 'src-terminal', 'welcome.zsh'));
  fs.writeFileSync(zshrc(E), 'keep');
  fails(cli(E, ['terminal', 'apply', '{"welcome":true}']), /welcome\.zsh introuvable/);
  assert.equal(readText(zshrc(E)), 'keep');
  assert.equal(cfgTerminal(E), undefined, 'config : aucune clé terminal écrite');
});

test('validation : options non booléennes ou inconnues refusées, config inchangée', () => {
  const E = makeEnv();
  fails(cli(E, ['terminal', 'apply', '{"ghostty":"yes"}']), /booléen/);
  fails(cli(E, ['terminal', 'apply', '{"welcome":1}']), /booléen/);
  fails(cli(E, ['terminal', 'remove', '{"zsh":true}']), /inconnue/);
  fails(cli(E, ['terminal', 'apply', '[true]']), /objet JSON/);
  fails(cli(E, ['terminal', 'apply', '{nope']), /JSON invalide/);
  fails(cli(E, ['write-config', '{"terminal":{"welcome":1}}']), /terminal\.welcome doit être un booléen/);
  assert.equal(cfgTerminal(E), undefined, 'aucune clé terminal écrite');
  assert.equal(ok(cli(E, ['write-config', '{"terminal":{"welcome":true}}'])).ok, true);
  assert.equal(cli(E, ['terminal', 'nope']).code, 1);
});

test('apply via stdin (-) : seules les options fournies sont appliquées', () => {
  const E = makeEnv();
  const r = ok(cli(E, ['terminal', 'apply', '-'], { input: '{"welcome":true}' }));
  assert.equal(r.welcome.action, 'added');
  assert.equal(r.ghostty.action, 'none');
  assert.equal(r.terminalApp.action, 'none');
});

test('status : forme JSON exacte, lecture seule', () => {
  const E = makeEnv();
  const before = snapshot(E.home);
  const st = ok(cli(E, ['terminal', 'status']));
  assert.deepEqual(Object.keys(st), ['ok', 'theme', 'options', 'ghostty', 'terminalApp', 'welcome']);
  assert.deepEqual(Object.keys(st.ghostty), ['configPath', 'applied', 'available']);
  assert.deepEqual(Object.keys(st.terminalApp), ['applied', 'running', 'available']);
  assert.deepEqual(Object.keys(st.welcome), ['zshrc', 'applied']);
  assert.deepEqual(st.options, { ghostty: false, terminalApp: false, welcome: false });
  assert.equal(st.theme, 'alpha');
  assert.equal(st.ghostty.available, false, 'Ghostty.app absent des dossiers de test');
  assert.equal(st.terminalApp.running, false);
  assert.deepEqual(snapshot(E.home), before, 'status n écrit rien');
});

test('Terminal.app lancé : open-file, aucun appel defaults, prefs intactes', () => {
  const E = makeEnv();
  const storeBefore = readBytes(E.store);
  setRunning(E, true);
  const r = ok(cli(E, ['terminal', 'apply', '{"terminalApp":true}']));
  assert.equal(r.terminalApp.action, 'open-file');
  assert.equal(r.terminalApp.running, true);
  assert.equal(r.terminalApp.file, path.join(generated(E), 'theme', 'Terminal.terminal'));
  assert.equal(calls(E, 'defaults').length, 0, 'aucun appel defaults');
  assert.ok(readBytes(E.store).equals(storeBefore), 'prefs intactes');
  const st = ok(cli(E, ['terminal', 'status']));
  assert.equal(st.terminalApp.running, true);
  assert.equal(st.terminalApp.applied, false);
});

test('Terminal.app lancé pendant le retrait : skipped, aucun appel defaults, retrait possible ensuite', { skip: NEEDS_PLUTIL }, () => {
  const E = makeEnv();
  ok(cli(E, ['terminal', 'apply', '{"terminalApp":true}']));
  const n = calls(E, 'defaults').length;
  setRunning(E, true);
  const sk = ok(cli(E, ['terminal', 'remove', '{"terminalApp":true}']));
  assert.equal(sk.terminalApp.action, 'skipped');
  assert.equal(calls(E, 'defaults').length, n, 'aucun appel defaults quand Terminal tourne');
  assert.equal(plistHas(E, 'Window Settings.Dojo Alpha'), true, 'profil toujours là');
  setRunning(E, false);
  const late = ok(cli(E, ['terminal', 'remove', '{"terminalApp":true}']));
  assert.equal(late.terminalApp.action, 'removed', 'retrait possible une fois Terminal fermé');
  assert.equal(plistHas(E, 'Window Settings.Dojo Alpha'), false);
});

test('Terminal.app non lancé : import (defaults import), profil par défaut et au démarrage, idempotent', { skip: NEEDS_PLUTIL }, () => {
  const E = makeEnv();
  const r = ok(cli(E, ['terminal', 'apply', '{"terminalApp":true}']));
  assert.equal(r.terminalApp.action, 'imported');
  assert.equal(r.terminalApp.profile, 'Dojo Alpha');
  assert.equal(r.terminalApp.running, false);
  assert.equal(plistGet(E, 'Default Window Settings'), 'Dojo Alpha');
  assert.equal(plistGet(E, 'Startup Window Settings'), 'Dojo Alpha');
  assert.equal(plistGet(E, 'Window Settings.Dojo Alpha.name'), 'Dojo Alpha', 'name réécrit');
  assert.equal(plistGet(E, 'Window Settings.Basic.name'), 'Basic', 'profil existant conservé');
  assert.equal(calls(E, 'defaults import com.apple.Terminal').length, 1);
  assert.equal(r.terminalApp.file, null);
});

test('Terminal.app : retrait restaure les défauts d origine et supprime le profil', { skip: NEEDS_PLUTIL }, () => {
  const E = makeEnv();
  ok(cli(E, ['terminal', 'apply', '{"terminalApp":true}']));
  const rm = ok(cli(E, ['terminal', 'remove', '{"terminalApp":true}']));
  assert.equal(rm.terminalApp.action, 'removed');
  assert.equal(plistGet(E, 'Default Window Settings'), 'Basic', 'défaut restauré');
  assert.equal(plistGet(E, 'Startup Window Settings'), 'Basic', 'démarrage restauré');
  assert.equal(plistHas(E, 'Window Settings.Dojo Alpha'), false, 'profil retiré');
  assert.equal(plistGet(E, 'Window Settings.Basic.name'), 'Basic');
  assert.equal(calls(E, 'defaults import com.apple.Terminal').length, 2);
});

test('Terminal.app : changement de thème -> ancien profil retiré, défauts d origine gardés', { skip: NEEDS_PLUTIL }, () => {
  const E = makeEnv();
  ok(cli(E, ['terminal', 'apply', '{"terminalApp":true}']));
  const r = ok(cli(E, ['set-theme', 'beta']));
  assert.equal(r.regenerated, true);
  assert.equal(r.terminal.terminalApp.profile, 'Dojo BetaTheme', 'points retirés du nom');
  assert.equal(r.terminal.terminalApp.action, 'imported');
  assert.equal(plistGet(E, 'Default Window Settings'), 'Dojo BetaTheme');
  assert.equal(plistHas(E, 'Window Settings.Dojo Alpha'), false, 'ancien profil retiré');
  ok(cli(E, ['terminal', 'remove', '{"terminalApp":true}']));
  assert.equal(plistGet(E, 'Default Window Settings'), 'Basic', 'défaut d origine');
  assert.equal(plistHas(E, 'Window Settings.Dojo BetaTheme'), false);
});

test('Terminal.app : prefs absentes -> import crée le domaine, retrait le laisse sans défaut ni profil', { skip: NEEDS_PLUTIL }, () => {
  const E = makeEnv({ prefs: false });
  ok(cli(E, ['terminal', 'apply', '{"terminalApp":true}']));
  assert.ok(calls(E, 'defaults').every((l) => l.startsWith('defaults import')), 'pas d export sans prefs');
  ok(cli(E, ['terminal', 'remove', '{"terminalApp":true}']));
  assert.equal(plistHas(E, 'Default Window Settings'), false);
  assert.equal(plistHas(E, 'Window Settings.Dojo Alpha'), false);
});

test('uninstall : retire lignes, profil et dossier ; dryRun ne touche à rien', { skip: NEEDS_PLUTIL }, () => {
  const E = makeEnv();
  fs.mkdirSync(path.dirname(ghosttyFile(E)), { recursive: true });
  fs.writeFileSync(ghosttyFile(E), RICH_GHOSTTY);
  fs.writeFileSync(zshrc(E), RICH_ZSH);
  ok(cli(E, ['terminal', 'apply', '{"ghostty":true,"terminalApp":true,"welcome":true}']));
  const before = snapshot(E.home);
  const nDefaults = calls(E, 'defaults').length;
  const dry = ok(cli(E, ['uninstall', '{"noLaunchd":true,"dryRun":true}']));
  assert.equal(dry.terminal.ghostty.changed, true, 'dryRun : ce qui serait fait est annoncé');
  assert.equal(dry.terminal.welcome.changed, true);
  assert.equal(dry.terminal.terminalApp.action, 'removed');
  assert.deepEqual(snapshot(E.home), before, 'dryRun : HOME identique');
  assert.equal(calls(E, 'defaults').length, nDefaults, 'dryRun : aucun appel defaults');
  const u = ok(cli(E, ['uninstall', '{"noLaunchd":true}']));
  assert.equal(u.terminal.ghostty.action, 'removed');
  assert.equal(u.terminal.welcome.action, 'removed');
  assert.equal(u.terminal.terminalApp.action, 'removed');
  assert.equal(u.terminal.dir.removed, true);
  assert.equal(readText(ghosttyFile(E)), RICH_GHOSTTY);
  assert.equal(readText(zshrc(E)), RICH_ZSH);
  assert.equal(plistHas(E, 'Window Settings.Dojo Alpha'), false);
  assert.equal(fs.existsSync(generated(E)), false);
  assert.equal(fs.existsSync(stateFile(E)), false, 'état Terminal.app effacé');
});

test('uninstall avec Terminal.app lancé : profil laissé, signalé skipped, fichiers Dojo retirés', { skip: NEEDS_PLUTIL }, () => {
  const E = makeEnv();
  ok(cli(E, ['terminal', 'apply', '{"terminalApp":true,"welcome":true}']));
  const n = calls(E, 'defaults').length;
  setRunning(E, true);
  const u = ok(cli(E, ['uninstall', '{"noLaunchd":true}']));
  assert.equal(u.terminal.terminalApp.action, 'skipped');
  assert.equal(u.terminal.welcome.action, 'removed');
  assert.equal(fs.existsSync(generated(E)), false);
  assert.equal(calls(E, 'defaults').length, n, 'aucun appel defaults pendant l uninstall');
  assert.equal(plistHas(E, 'Window Settings.Dojo Alpha'), true, 'profil à retirer après fermeture de Terminal');
});

test('runtime installé (install-files) : terminal apply depuis ~/.config/claude-dojo trouve welcome.zsh', () => {
  const E = makeEnv();
  // install-files copie le vrai src/ dans le HOME temporaire ; la copie installée utilise ses propres thèmes.
  const inst = cli(E, ['install-files', path.join(REPO, 'src')], { extraEnv: { DOJO_TERMINAL_DIR: '', DOJO_THEMES_DIR: '' } });
  ok(inst);
  assert.ok(inst.out.copied.includes('terminal-src/'), 'terminal-src/ copié');
  const dest = path.join(E.home, '.config', 'claude-dojo');
  assert.equal(readText(path.join(dest, 'terminal-src', 'welcome.zsh')), readText(path.join(REPO, 'src', 'terminal', 'welcome.zsh')));
  assert.equal(fs.existsSync(path.join(dest, 'terminal')), false, 'terminal/ (généré) absent après install-files');
  // thème par défaut (naruto) : son bundle réel est dans la copie installée
  fs.writeFileSync(cfgFile(E), JSON.stringify({ theme: 'naruto' }));
  const script = path.join(dest, 'setup.js');
  const r = ok(cli(E, ['terminal', 'apply', '{"welcome":true,"ghostty":true}'], { script, extraEnv: { DOJO_TERMINAL_DIR: '', DOJO_THEMES_DIR: '' } }));
  assert.equal(r.welcome.action, 'added');
  assert.equal(r.ghostty.action, 'added');
  assert.equal(readText(path.join(generated(E), 'welcome.zsh')), readText(path.join(REPO, 'src', 'terminal', 'welcome.zsh')));
  assert.ok(fs.existsSync(path.join(generated(E), 'theme', 'ghostty.theme')));
});

test('runtime installé : welcome.zsh de terminal-src n est jamais remplacé par la copie générée', () => {
  const E = makeEnv();
  // terminal/welcome.zsh généré (ancien) ne doit pas servir de source
  ok(cli(E, ['install-files', path.join(REPO, 'src')], { extraEnv: { DOJO_TERMINAL_DIR: '', DOJO_THEMES_DIR: '' } }));
  const dest = path.join(E.home, '.config', 'claude-dojo');
  fs.mkdirSync(path.join(dest, 'terminal'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'terminal', 'welcome.zsh'), '# obsolète\n');
  fs.writeFileSync(cfgFile(E), JSON.stringify({ theme: 'naruto' }));
  ok(cli(E, ['terminal', 'apply', '{"welcome":true}'], { script: path.join(dest, 'setup.js'), extraEnv: { DOJO_TERMINAL_DIR: '', DOJO_THEMES_DIR: '' } }));
  assert.equal(readText(path.join(generated(E), 'welcome.zsh')), readText(path.join(REPO, 'src', 'terminal', 'welcome.zsh')));
});

// ── Cohérence des bundles terminal/ de chaque thème (src/themes/<id>/terminal/) ─────────────────
// Un bundle absent ou incomplet fait échouer ses tests (attendu tant que tous les thèmes ne sont pas générés).
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const listNames = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const THEME_IDS = fs.existsSync(THEMES_SRC)
  ? fs.readdirSync(THEMES_SRC).filter((n) => isDir(path.join(THEMES_SRC, n))).sort()
  : [];
const bundleOf = (id) => path.join(THEMES_SRC, id, 'terminal');
// Fichiers réguliers du bundle, sous-dossiers compris (un lien interne est suivi pour sa taille et son contenu).
function bundleFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (isFile(p)) out.push(p);
    }
  };
  if (isDir(dir)) walk(dir);
  return out;
}
const REQUIRED_BUNDLE = ['ghostty.theme', 'Terminal.terminal', 'fastfetch.jsonc', 'fastfetch-text.jsonc', 'logo.png', 'logo.txt', 'lists.txt'];
const LIST_KEYS = ['key1', 'key2', 'accent', 'value', 'cols', 'rows'];
const MIN_FRAMES = 8;
const MIN_SHADERS = 3;
const MIN_LIST_ITEMS = 10;
const BUNDLE_MAX_BYTES = 6 * 1024 * 1024;
const DYNAMIC_LINE = '// @DYNAMIC@';
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const relLum = ([r, g, b]) => {
  const lin = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrastOf = (a, b) => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
// Termes interdits : fragments concaténés, le littéral complet n'apparaît pas dans ce fichier (comme themes.test.js).
const FORBIDDEN_RE = new RegExp([
  'gt' + 'ko', 'gre' + 'go', 'mus' + '-inn', 'min' + 'zac', 'cascade' + 'projects',
  'dot' + 'world', 'mediamod' + 'ifier', 'her' + 'mes',
].join('|'), 'i');
const ABS_PATH_RE = new RegExp('/' + 'Users/|/' + 'private/');

for (const id of THEME_IDS) {
  const dir = bundleOf(id);
  const present = () => assert.ok(isDir(dir), `terminal/ absent dans src/themes/${id}`);

  test(`thème ${id} : terminal/ complet (fichiers requis, >= ${MIN_FRAMES} frames, >= ${MIN_SHADERS} shaders)`, () => {
    present();
    const missing = REQUIRED_BUNDLE.filter((f) => !isFile(path.join(dir, f)));
    assert.deepEqual(missing, [], 'fichiers manquants');
    const frames = listNames(path.join(dir, 'frames')).filter((n) => /^frame_.+\.png$/.test(n));
    assert.ok(frames.length >= MIN_FRAMES, `frames : ${frames.length} (minimum ${MIN_FRAMES})`);
    const shaders = listNames(path.join(dir, 'shaders')).filter((n) => n.endsWith('.glsl'));
    assert.ok(shaders.length >= MIN_SHADERS, `shaders : ${shaders.length} (minimum ${MIN_SHADERS})`);
  });

  test(`thème ${id} : fastfetch.jsonc et fastfetch-text.jsonc : exactement une ligne ${DYNAMIC_LINE}`, () => {
    present();
    for (const f of ['fastfetch.jsonc', 'fastfetch-text.jsonc']) {
      const text = readText(path.join(dir, f));
      const lines = text.split(/\r?\n/).filter((l) => l.trim() === DYNAMIC_LINE).length;
      const anywhere = text.split(DYNAMIC_LINE).length - 1;
      assert.equal(lines, 1, `${f} : ${lines} ligne(s) ${DYNAMIC_LINE}`);
      assert.equal(anywhere, 1, `${f} : marqueur présent ${anywhere} fois`);
    }
  });

  test(`thème ${id} : lists.txt : clés requises, R;G;B valides, cols/rows entiers, >= ${MIN_LIST_ITEMS} l1 et l2`, () => {
    present();
    const kv = new Map();
    const l1 = [];
    const l2 = [];
    const bad = [];
    for (const raw of readText(path.join(dir, 'lists.txt')).split(/\r?\n/)) {
      if (raw.trim() === '') continue;
      const i = raw.indexOf('|');
      if (i <= 0) { bad.push(raw); continue; }
      const k = raw.slice(0, i);
      const v = raw.slice(i + 1).trim();
      if (k === 'l1') l1.push(v);
      else if (k === 'l2') l2.push(v);
      else kv.set(k, v);
    }
    assert.deepEqual(bad, [], 'lignes sans « clé|valeur »');
    assert.deepEqual(LIST_KEYS.filter((k) => !kv.get(k)), [], 'clés manquantes ou vides');
    for (const k of ['accent', 'value']) {
      const v = kv.get(k) || '';
      assert.match(v, /^\d{1,3};\d{1,3};\d{1,3}$/, `${k} : R;G;B attendu (reçu « ${v} »)`);
      assert.ok(v.split(';').every((n) => Number(n) <= 255), `${k} : composantes au plus 255`);
    }
    for (const k of ['cols', 'rows']) assert.match(kv.get(k) || '', /^[1-9]\d*$/, `${k} : entier positif attendu`);
    assert.ok(l1.length >= MIN_LIST_ITEMS, `l1 : ${l1.length} (minimum ${MIN_LIST_ITEMS})`);
    assert.ok(l2.length >= MIN_LIST_ITEMS, `l2 : ${l2.length} (minimum ${MIN_LIST_ITEMS})`);
  });

  test(`thème ${id} : ghostty.theme : 16 lignes palette (index 0 à 15), pas de background-image`, () => {
    present();
    const text = readText(path.join(dir, 'ghostty.theme'));
    const palette = text.split('\n').filter((l) => /^\s*palette\s*=/.test(l));
    assert.equal(palette.length, 16, `${palette.length} ligne(s) palette`);
    const idx = palette.map((l) => Number((/^\s*palette\s*=\s*(\d+)=#[0-9a-fA-F]{6}\s*$/.exec(l) || [])[1]));
    assert.deepEqual(idx.slice().sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i), 'index 0 à 15 attendus, en hexadécimal #rrggbb');
    assert.equal(/^\s*background-image\s*=/m.test(text), false, 'background-image interdit');
  });

  test(`thème ${id} : ghostty.theme : contraste foreground/background >= 7`, () => {
    present();
    const text = readText(path.join(dir, 'ghostty.theme'));
    const bg = /^\s*background\s*=\s*(#[0-9a-fA-F]{6})\s*$/m.exec(text);
    const fg = /^\s*foreground\s*=\s*(#[0-9a-fA-F]{6})\s*$/m.exec(text);
    assert.ok(bg && fg, 'background ou foreground absent (#rrggbb attendu)');
    const ratio = contrastOf(hexRgb(fg[1]), hexRgb(bg[1]));
    assert.ok(ratio >= 7, `contraste ${ratio.toFixed(2)} < 7`);
  });

  test(`thème ${id} : terminal/ sans terme perso ni chemin absolu d utilisateur ou de session`, () => {
    present();
    for (const f of bundleFiles(dir)) {
      if (/\.png$/i.test(f)) continue;
      const text = readText(f);
      const term = FORBIDDEN_RE.exec(text);
      assert.equal(term, null, `${path.relative(REPO, f)} : terme interdit`);
      assert.equal(ABS_PATH_RE.test(text), false, `${path.relative(REPO, f)} : chemin absolu`);
    }
  });

  test(`thème ${id} : Terminal.terminal valide (plutil -lint)`, { skip: NEEDS_PLUTIL }, () => {
    present();
    const r = spawnSync('plutil', ['-lint', path.join(dir, 'Terminal.terminal')], { encoding: 'utf8' });
    assert.equal(r.status, 0, (r.stdout + r.stderr).trim());
  });

  test(`thème ${id} : chaque shader .glsl contient mainImage`, () => {
    present();
    const shaders = listNames(path.join(dir, 'shaders')).filter((n) => n.endsWith('.glsl'));
    assert.ok(shaders.length > 0, 'aucun shader .glsl');
    const bad = shaders.filter((n) => !readText(path.join(dir, 'shaders', n)).includes('mainImage'));
    assert.deepEqual(bad, [], 'shaders sans mainImage');
  });

  test(`thème ${id} : bundle terminal/ de moins de 6 Mo`, () => {
    present();
    const total = bundleFiles(dir).reduce((s, f) => s + fs.statSync(f).size, 0);
    assert.ok(total < BUNDLE_MAX_BYTES, `${(total / 1048576).toFixed(2)} Mo (maximum 6 Mo)`);
  });
}
