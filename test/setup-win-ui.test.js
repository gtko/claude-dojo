// Interface Windows (windows/ui) copiée par install-files dans windows\ui de l'installation : sans tests/, remplacement
// propre à chaque installation, source absente tolérée, retirée à la désinstallation.
// La plateforme est simulée (DOJO_FORCE_PLATFORM) : ces tests tournent sur toute plateforme. Chaque test travaille dans
// un dossier temporaire (USERPROFILE et HOME) : rien n'est écrit hors de ce dossier.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SETUP = path.join(REPO, 'src', 'setup.js');
const WIN = process.platform === 'win32';
const winOnly = WIN ? {} : { skip: 'Windows uniquement' };

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-ui-'));
}

// setup.js sur un profil temporaire. platform : plateforme simulée (win32 par défaut).
function cli(home, args, platform = 'win32') {
  const r = spawnSync(process.execPath, [SETUP, ...args], {
    env: {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      DOJO_DOCUMENTS_DIR: path.join(home, 'Documents'), // profils PowerShell : jamais le vrai Documents (registre)
      DOJO_FORCE_PLATFORM: platform,
      DOJO_SKIP_REGISTRY: '1',
      DOJO_SKIP_EXE: '1',
      DOJO_DETECT_NO_GH_AUTH: '1',
    },
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });
  let out = null;
  try { out = JSON.parse(r.stdout.trim()); } catch { out = null; }
  return { code: r.status, out, stderr: r.stderr };
}

const dojoDir = (home) => path.join(home, '.config', 'claude-dojo');

// Dépôt factice : <repo>/src (runtime) et <repo>/windows/ui (interface, avec un dossier tests/ de développement).
function fakeRepo(home, { ui = true } = {}) {
  const repo = path.join(home, 'repo');
  const src = path.join(repo, 'src');
  fs.mkdirSync(path.join(src, 'windows'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'claude-dojo', version: '0.2.1' }));
  fs.writeFileSync(path.join(src, 'agent-win.js'), '// agent\n');
  fs.writeFileSync(path.join(src, 'windows', 'media.ps1'), '# media\n');
  if (ui) {
    const dir = path.join(repo, 'windows', 'ui');
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'common.css'), 'body {}\n');
    fs.writeFileSync(path.join(dir, 'wizard.html'), '<!doctype html>\n');
    fs.writeFileSync(path.join(dir, 'wizard.js'), '// assistant\n');
    fs.writeFileSync(path.join(dir, 'tests', 'dev.test.js'), '// test de développement\n');
  }
  return { src, ui: path.join(repo, 'windows', 'ui') };
}

// Liste récursive des fichiers d'un dossier, en chemins relatifs triés.
function listFiles(root, rel = '') {
  const out = [];
  for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = path.join(rel, ent.name);
    if (ent.isDirectory()) out.push(...listFiles(root, p));
    else out.push(p);
  }
  return out.sort();
}

test('install-files Windows : windows/ui copié dans windows\\ui, sans tests/', () => {
  const home = tmpHome();
  try {
    const { src } = fakeRepo(home);
    const out = cli(home, ['install-files', src]);
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(out.out.warnings, []);
    assert.ok(out.out.copied.includes('windows/ui/'), 'windows/ui/ signalé comme copié');
    const ui = path.join(dojoDir(home), 'windows', 'ui');
    assert.deepEqual(listFiles(ui), ['common.css', 'wizard.html', 'wizard.js']);
    assert.ok(fs.existsSync(path.join(dojoDir(home), 'windows', 'media.ps1')), 'src/windows toujours copié');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install-files Windows : réinstallation idempotente, fichiers obsolètes de ui retirés, config et exe gardés', () => {
  const home = tmpHome();
  try {
    const { src, ui } = fakeRepo(home);
    assert.equal(cli(home, ['install-files', src]).code, 0);
    const dest = dojoDir(home);
    const first = listFiles(path.join(dest, 'windows', 'ui'));
    fs.writeFileSync(path.join(dest, 'config.json'), '{"theme":"naruto"}\n');
    fs.mkdirSync(path.join(dest, 'windows', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'windows', 'bin', 'DojoWallpaper.exe'), 'fake');
    fs.writeFileSync(path.join(dest, 'windows', 'ui', 'ancien.js'), '// obsolète\n');

    // Deuxième passe sans changement de source : même liste, ancien fichier retiré.
    const again = cli(home, ['install-files', src]);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(listFiles(path.join(dest, 'windows', 'ui')), first);
    assert.equal(fs.existsSync(path.join(dest, 'windows', 'ui', 'ancien.js')), false, 'fichier obsolète retiré');

    // Fichier supprimé du dépôt : il disparaît de l'installation au passage suivant.
    fs.rmSync(path.join(ui, 'wizard.js'));
    assert.equal(cli(home, ['install-files', src]).code, 0);
    assert.deepEqual(listFiles(path.join(dest, 'windows', 'ui')), ['common.css', 'wizard.html']);

    assert.equal(fs.readFileSync(path.join(dest, 'config.json'), 'utf8'), '{"theme":"naruto"}\n');
    assert.equal(fs.readFileSync(path.join(dest, 'windows', 'bin', 'DojoWallpaper.exe'), 'utf8'), 'fake');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install-files Windows : dossier windows/ui absent du dépôt = avertissement, pas d échec, installation gardée', () => {
  const home = tmpHome();
  try {
    const { src, ui } = fakeRepo(home);
    assert.equal(cli(home, ['install-files', src]).code, 0);
    const installed = path.join(dojoDir(home), 'windows', 'ui');
    const before = listFiles(installed);

    fs.rmSync(ui, { recursive: true, force: true }); // clone supprimé après l'installation
    const out = cli(home, ['install-files', src]);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.out.warnings.length, 1);
    assert.match(out.out.warnings[0], /interface Windows introuvable/);
    assert.ok(!out.out.copied.includes('windows/ui/'));
    assert.deepEqual(listFiles(installed), before, 'windows\\ui de l installation gardé tel quel');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install-files Windows : windows/ui absent au premier passage = avertissement, rien créé', () => {
  const home = tmpHome();
  try {
    const { src } = fakeRepo(home, { ui: false });
    const out = cli(home, ['install-files', src]);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.out.warnings.length, 1);
    assert.equal(fs.existsSync(path.join(dojoDir(home), 'windows', 'ui')), false);
    assert.ok(fs.existsSync(path.join(dojoDir(home), 'windows', 'media.ps1')), 'le reste du runtime est copié');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install-files Windows : lien qui sort de windows/ui refusé avant toute écriture', (t) => {
  const home = tmpHome();
  try {
    const { src, ui } = fakeRepo(home);
    const secret = path.join(home, 'secret.txt');
    fs.writeFileSync(secret, 'hors dépôt\n');
    try {
      fs.symlinkSync(secret, path.join(ui, 'fuite.txt'));
    } catch {
      t.skip('lien symbolique indisponible sur cette machine');
      return;
    }
    const out = cli(home, ['install-files', src]);
    assert.notEqual(out.code, 0, 'installation refusée');
    assert.equal(fs.existsSync(path.join(dojoDir(home), 'windows', 'ui')), false, 'rien copié dans windows\\ui');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install-files hors Windows : windows/ui non copié', () => {
  const home = tmpHome();
  try {
    const { src } = fakeRepo(home);
    const out = cli(home, ['install-files', src], 'darwin');
    assert.equal(out.code, 0, out.stderr);
    assert.equal(fs.existsSync(path.join(dojoDir(home), 'windows')), false);
    assert.ok(!out.out.copied.includes('windows/ui/'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall Windows : windows\\ui retiré avec le runtime, config.json gardé', winOnly, () => {
  const home = tmpHome();
  try {
    const { src } = fakeRepo(home);
    assert.equal(cli(home, ['install-files', src]).code, 0);
    const dest = dojoDir(home);
    fs.writeFileSync(path.join(dest, 'config.json'), '{"theme":"naruto"}\n');
    assert.ok(fs.existsSync(path.join(dest, 'windows', 'ui', 'wizard.html')));

    const out = cli(home, ['uninstall', '{}']);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(fs.existsSync(path.join(dest, 'windows', 'ui')), false, 'windows\\ui retiré');
    assert.equal(fs.existsSync(path.join(dest, 'config.json')), true, 'config.json gardé sans --purge');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
