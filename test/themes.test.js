// Tests des thèmes (node:test) : commandes themes / set-theme / set-background, copie par install-files,
// validation de chaque src/themes/<id>/ (theme.json, fond, miniature, contraste).
// Chaque test travaille dans un HOME temporaire ; aucun launchctl (uninstall uniquement avec noLaunchd).
// THEMES_STRICT=1 : la miniature thumbnail.jpg devient obligatoire.
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
const THEMES_SRC = path.join(REPO, 'src', 'themes');
const STRICT = process.env.THEMES_STRICT === '1';

// ── Helpers ──────────────────────────────────────────────────────────────
const CREATED = [];
function tmpDir(prefix = 'dojo-theme-test-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  CREATED.push(d);
  return d;
}
after(() => { for (const d of CREATED) fs.rmSync(d, { recursive: true, force: true }); });

// Dossiers d'applications simulés dans le HOME temporaire : jamais le vrai /Applications.
const appDirsOf = (home) => [path.join(home, 'Applications'), path.join(home, 'SysApplications')].join(path.delimiter);

// Lance setup.js (ou une copie installée via script) avec HOME temporaire.
// DOJO_THEMES_DIR n'est transmis que si env le fournit : sinon les thèmes réels de src/ sont lus.
function cli(home, args, { input, env = {}, script = SETUP } = {}) {
  const childEnv = { ...process.env, HOME: home, DOJO_DETECT_NO_GH_AUTH: '1', DOJO_APPS_DIRS: appDirsOf(home), ...env };
  if (!('DOJO_THEMES_DIR' in env)) delete childEnv.DOJO_THEMES_DIR;
  const r = spawnSync(process.execPath, [script, ...args], { env: childEnv, input, encoding: 'utf8', timeout: 60000 });
  const raw = r.stdout.trim();
  let out = null;
  try { out = JSON.parse(raw); } catch { out = null; }
  return { code: r.status, out, raw, stderr: r.stderr };
}

const writeFile = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
};
const writeJson = (file, obj) => writeFile(file, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const configFile = (home) => path.join(home, '.config', 'claude-dojo', 'config.json');
const backgroundsOf = (home) => path.join(home, '.config', 'claude-dojo', 'backgrounds');

// Début de fichier JPEG (signature FF D8 FF) suivi d'un contenu identifiable.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const jpegFile = (dir, name, tag = 'x') => writeFile(path.join(dir, name), Buffer.concat([JPEG, Buffer.from(tag)]));

// Image dont les premiers octets correspondent à l'extension (jpg/jpeg, png, webp, heic).
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP_HEAD = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
const HEIC_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic')]);
function imageFile(dir, name, tag = 'x') {
  const head = { '.png': PNG_HEAD, '.webp': WEBP_HEAD, '.heic': HEIC_HEAD }[path.extname(name).toLowerCase()] || JPEG;
  return writeFile(path.join(dir, name), Buffer.concat([head, Buffer.from(tag)]));
}

// Dossier de thèmes factice (valeur de DOJO_THEMES_DIR). entries : { id, name?, dir?, raw?, files? }.
function fixtureThemes(entries = [
  { id: 'naruto', name: 'Naruto', files: ['thumbnail.jpg'] },
  { id: 'alpha', name: 'Alpha' },
  { id: 'broken', raw: '{pas du json' },
  { id: 'mismatch', dir: 'mismatch', raw: JSON.stringify({ id: 'autre', name: 'Autre' }) },
]) {
  const base = tmpDir();
  for (const e of entries) {
    const dir = path.join(base, 'themes', e.dir ?? e.id);
    writeFile(path.join(dir, 'theme.json'), e.raw ?? JSON.stringify({ id: e.id, name: e.name }));
    for (const f of e.files ?? []) writeFile(path.join(dir, f), Buffer.concat([JPEG, Buffer.from('thumb')]));
  }
  return { DOJO_THEMES_DIR: base };
}

// ── Commande themes ──────────────────────────────────────────────────────
test('themes : dossiers valides listés, défaut en tête, dossiers invalides ignorés, défaut naruto sans config', () => {
  const home = tmpDir();
  const env = fixtureThemes();
  const r = cli(home, ['themes'], { env });
  assert.equal(r.code, 0, r.raw);
  assert.equal(r.out.ok, true);
  assert.deepEqual(r.out.themes.map((t) => t.id), ['naruto', 'alpha'], 'broken et mismatch écartés');
  assert.equal(r.out.theme, 'naruto', 'thème courant par défaut');
  assert.equal(r.out.background, null);
  const base = env.DOJO_THEMES_DIR;
  const naruto = r.out.themes[0];
  assert.equal(naruto.name, 'Naruto');
  assert.equal(naruto.thumbnail, path.join(base, 'themes', 'naruto', 'thumbnail.jpg'));
  assert.equal(naruto.background, path.join(base, 'themes', 'naruto', 'background.jpg'), 'chemin absolu même si le fichier manque');
  assert.equal(r.out.themes[1].thumbnail, null, 'pas de miniature : null');
});

test('themes : la liste réelle contient naruto en tête, avec chemins absolus', (t) => {
  if (!fs.existsSync(path.join(THEMES_SRC, 'naruto', 'theme.json'))) { t.skip('thème naruto pas encore créé'); return; }
  const r = cli(tmpDir(), ['themes']);
  assert.equal(r.code, 0, r.raw);
  assert.equal(r.out.theme, 'naruto');
  assert.equal(r.out.themes[0].id, 'naruto', 'défaut en tête');
  for (const th of r.out.themes) {
    assert.ok(path.isAbsolute(th.background), `background absolu : ${th.id}`);
    if (th.thumbnail !== null) assert.ok(path.isAbsolute(th.thumbnail), `thumbnail absolu : ${th.id}`);
  }
});

test('themes : reflète config.theme et config.background', () => {
  const home = tmpDir();
  writeJson(configFile(home), { theme: 'alpha', background: '/abs/fond.jpg' });
  const r = cli(home, ['themes'], { env: fixtureThemes() });
  assert.equal(r.code, 0, r.raw);
  assert.equal(r.out.theme, 'alpha');
  assert.equal(r.out.background, '/abs/fond.jpg');
});

// ── set-theme ────────────────────────────────────────────────────────────
test('set-theme : écrit config.theme pour un thème connu, garde le reste de la config', () => {
  const home = tmpDir();
  const env = fixtureThemes();
  writeJson(configFile(home), { weather: { name: 'Lyon', lat: 45.76, lon: 4.83 } });
  const r = cli(home, ['set-theme', 'alpha'], { env });
  assert.equal(r.code, 0, r.raw);
  assert.deepEqual(r.out, { ok: true, theme: 'alpha', background: null, hasDownloads: false, needsSync: false });
  const cfg = readJson(configFile(home));
  assert.equal(cfg.theme, 'alpha');
  assert.equal(cfg.weather.name, 'Lyon', 'clés existantes conservées');
  assert.equal(cli(home, ['themes'], { env }).out.theme, 'alpha');
});

test('set-theme : id inconnu, mal formé ou absent -> erreur, rien écrit', () => {
  const env = fixtureThemes();
  const home = tmpDir();
  const unknown = cli(home, ['set-theme', 'zzz'], { env });
  assert.equal(unknown.code, 1, unknown.raw);
  assert.equal(unknown.out.ok, false);
  assert.match(unknown.out.error, /inconnu/);
  assert.ok(unknown.out.error.includes('alpha'), 'liste les thèmes disponibles');
  for (const bad of [['../alpha'], ['Alpha'], [''], []]) {
    const r = cli(home, ['set-theme', ...bad], { env });
    assert.equal(r.code, 1, `refusé : ${JSON.stringify(bad)}`);
    assert.equal(r.out.ok, false);
  }
  assert.equal(fs.existsSync(configFile(home)), false, 'rien écrit en cas d erreur');
});

// ── set-background ───────────────────────────────────────────────────────
test('set-background : jpg copié dans backgrounds/ (dossier 0700, fichier 0600), référencé dans config', () => {
  const home = tmpDir();
  const env = fixtureThemes();
  const src = jpegFile(tmpDir(), 'Mon Fond.JPG', 'un');
  const r = cli(home, ['set-background', src], { env });
  assert.equal(r.code, 0, r.raw);
  assert.equal(r.out.ok, true);
  assert.equal(r.out.removed, null, 'pas d ancienne copie');
  const dest = r.out.background;
  assert.ok(path.isAbsolute(dest), 'chemin absolu');
  assert.equal(path.dirname(dest), backgroundsOf(home));
  assert.match(path.basename(dest), /^[0-9a-f]{12}\.jpg$/, 'sha1 court + extension en minuscules');
  assert.deepEqual(fs.readFileSync(dest), fs.readFileSync(src), 'contenu copié à l identique');
  assert.equal(fs.statSync(dest).mode & 0o777, 0o600);
  assert.equal(fs.statSync(backgroundsOf(home)).mode & 0o777, 0o700);
  assert.equal(readJson(configFile(home)).background, dest);
  assert.equal(cli(home, ['themes'], { env }).out.background, dest);

  const again = cli(home, ['set-background', src], { env });
  assert.equal(again.out.background, dest, 'même contenu : même nom');
  assert.equal(again.out.removed, null, 'la copie en cours n est jamais supprimée');
  assert.ok(fs.existsSync(dest));
});

test('set-background : extension .txt refusée, rien copié ni référencé', () => {
  const home = tmpDir();
  const src = writeFile(path.join(tmpDir(), 'notes.txt'), 'pas une image');
  const r = cli(home, ['set-background', src]);
  assert.equal(r.code, 1, r.raw);
  assert.equal(r.out.ok, false);
  assert.match(r.out.error, /format refusé/);
  assert.equal(fs.existsSync(backgroundsOf(home)), false, 'aucune copie');
  assert.equal(fs.existsSync(configFile(home)), false, 'config intacte');
});

test('set-background : jpeg, png, heic, webp (casse indifférente) acceptés ; gif et sans extension refusés', () => {
  const home = tmpDir();
  const dir = tmpDir();
  for (const name of ['a.jpeg', 'b.PNG', 'c.heic', 'd.WebP', 'e.Jpg']) {
    const r = cli(home, ['set-background', imageFile(dir, name, name)]);
    assert.equal(r.code, 0, `${name} : ${r.raw}`);
    assert.match(path.basename(r.out.background), /\.(jpeg|png|heic|webp|jpg)$/, 'extension en minuscules');
  }
  for (const name of ['f.gif', 'sansext']) {
    const r = cli(home, ['set-background', jpegFile(dir, name)]);
    assert.equal(r.code, 1, `${name} refusé`);
    assert.equal(r.out.ok, false);
  }
});

test('set-background : fichier absent, dossier nommé .jpg, argument manquant -> erreur', () => {
  const home = tmpDir();
  const absent = cli(home, ['set-background', path.join(tmpDir(), 'absent.jpg')]);
  assert.equal(absent.code, 1, absent.raw);
  assert.match(absent.out.error, /introuvable/);

  const dirAsImage = path.join(tmpDir(), 'photo.jpg');
  fs.mkdirSync(dirAsImage);
  const dir = cli(home, ['set-background', dirAsImage]);
  assert.equal(dir.code, 1, dir.raw);
  assert.match(dir.out.error, /pas un dossier/);

  const none = cli(home, ['set-background']);
  assert.equal(none.code, 1, none.raw);
  assert.equal(none.out.ok, false);
  assert.equal(fs.existsSync(backgroundsOf(home)), false, 'aucune copie après une erreur');
});

test('set-background : plus de 50 Mo refusé ; exactement 50 Mo accepté', () => {
  const MAX = 50 * 1024 * 1024;
  const dir = tmpDir();
  const home = tmpDir();
  const big = writeFile(path.join(dir, 'trop.jpg'), '');
  fs.truncateSync(big, MAX + 1);
  const refused = cli(home, ['set-background', big]);
  assert.equal(refused.code, 1, refused.raw);
  assert.match(refused.out.error, /50 Mo/);
  assert.equal(fs.existsSync(backgroundsOf(home)), false);

  const limit = jpegFile(dir, 'limite.jpg', '');
  fs.truncateSync(limit, MAX);
  const accepted = cli(home, ['set-background', limit]);
  assert.equal(accepted.code, 0, accepted.raw);
});

test('set-background default : background remis à null, copie supprimée ; fichier choisi hors backgrounds/ jamais touché', () => {
  const home = tmpDir();
  const env = fixtureThemes();
  const dest = cli(home, ['set-background', jpegFile(tmpDir(), 'fond.jpg')]).out.background;
  assert.ok(fs.existsSync(dest));

  const r = cli(home, ['set-background', 'default'], { env });
  assert.equal(r.code, 0, r.raw);
  assert.equal(r.out.background, null);
  assert.equal(r.out.removed, dest, 'ancienne copie signalée');
  assert.equal(fs.existsSync(dest), false, 'copie supprimée');
  assert.equal(readJson(configFile(home)).background ?? null, null, 'plus de fond personnalisé');
  assert.equal(cli(home, ['themes'], { env }).out.background, null);

  const own = jpegFile(tmpDir(), 'mon-fond.jpg', 'perso');
  writeJson(configFile(home), { ...readJson(configFile(home)), background: own });
  const kept = cli(home, ['set-background', 'default'], { env });
  assert.equal(kept.code, 0, kept.raw);
  assert.equal(kept.out.removed, null, 'chemin hors backgrounds/ : rien supprimé');
  assert.ok(fs.existsSync(own), 'fichier de l utilisateur intact');
});

test('set-background : remplacer le fond supprime l ancienne copie et garde la nouvelle', () => {
  const home = tmpDir();
  const dir = tmpDir();
  const first = cli(home, ['set-background', jpegFile(dir, 'a.jpg', 'AAA')]);
  const second = cli(home, ['set-background', jpegFile(dir, 'b.jpg', 'BBB')]);
  assert.equal(second.code, 0, second.raw);
  assert.equal(second.out.removed, first.out.background);
  assert.equal(fs.existsSync(first.out.background), false, 'ancienne copie retirée');
  assert.ok(fs.existsSync(second.out.background), 'nouvelle copie gardée');
  assert.deepEqual(fs.readdirSync(backgroundsOf(home)), [path.basename(second.out.background)]);
});

test('set-background : faux .jpg (texte, ou PNG nommé .jpg) refusé, rien copié ni référencé', () => {
  const home = tmpDir();
  const dir = tmpDir();
  const text = writeFile(path.join(dir, 'faux.jpg'), '<html>pas une image</html>');
  const r = cli(home, ['set-background', text]);
  assert.equal(r.code, 1, r.raw);
  assert.equal(r.out.ok, false);
  assert.match(r.out.error, /incohérent avec l'extension \.jpg/);

  const pngAsJpg = writeFile(path.join(dir, 'png-deguise.jpg'), Buffer.concat([PNG_HEAD, Buffer.from('x')]));
  assert.equal(cli(home, ['set-background', pngAsJpg]).code, 1, 'signature PNG dans un .jpg refusée');
  assert.equal(fs.existsSync(backgroundsOf(home)), false, 'aucune copie');
  assert.equal(fs.existsSync(configFile(home)), false, 'config intacte');
});

test('set-background : lien symbolique refusé, même vers une vraie image', () => {
  const home = tmpDir();
  const real = jpegFile(tmpDir(), 'reel.jpg', 'reel');
  const link = path.join(tmpDir(), 'lien.jpg');
  fs.symlinkSync(real, link);
  const r = cli(home, ['set-background', link]);
  assert.equal(r.code, 1, r.raw);
  assert.match(r.out.error, /lien symbolique refusé/);
  assert.equal(fs.existsSync(backgroundsOf(home)), false, 'aucune copie');
  assert.equal(fs.existsSync(configFile(home)), false, 'config intacte');
});

test('set-background : .svg refusé même avec un contenu d image', () => {
  const home = tmpDir();
  const svg = writeFile(path.join(tmpDir(), 'fond.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const r = cli(home, ['set-background', svg]);
  assert.equal(r.code, 1, r.raw);
  assert.match(r.out.error, /format refusé \(\.svg\)/);
  assert.equal(fs.existsSync(backgroundsOf(home)), false, 'aucune copie');
});

test('write-config : background hors backgrounds/, symlink dans backgrounds/ ou .svg refusés', () => {
  const home = tmpDir();
  const bg = backgroundsOf(home);
  fs.mkdirSync(bg, { recursive: true });
  const outside = jpegFile(tmpDir(), 'dehors.jpg');
  fs.symlinkSync(outside, path.join(bg, 'lien.jpg'));
  const svg = writeFile(path.join(bg, 'fond.svg'), '<svg/>');
  for (const p of [outside, path.join(bg, '..', 'x.jpg'), path.join(bg, 'lien.jpg'), svg]) {
    const r = cli(home, ['write-config', JSON.stringify({ background: p })]);
    assert.equal(r.code, 1, `${p} refusé : ${r.raw}`);
  }
  assert.equal(fs.existsSync(configFile(home)), false, 'rien écrit');
});

// ── write-config : theme et background ───────────────────────────────────
test('write-config : theme et background validés, null efface la clé, ~ développé', () => {
  const home = tmpDir();
  let r = cli(home, ['write-config', JSON.stringify({ theme: 'Naruto!' })]);
  assert.equal(r.code, 1, 'theme mal formé refusé');
  r = cli(home, ['write-config', JSON.stringify({ background: 'relatif.jpg' })]);
  assert.equal(r.code, 1, 'background relatif refusé');
  assert.equal(fs.existsSync(configFile(home)), false, 'rien écrit en cas d erreur');

  // ~ est développé, mais le fond doit être une image de backgrounds/ (comme set-background)
  r = cli(home, ['write-config', JSON.stringify({ theme: 'frieren', background: '~/fond.jpg' })]);
  assert.equal(r.code, 1, 'fichier hors backgrounds/ refusé');
  r = cli(home, ['write-config', JSON.stringify({ theme: 'frieren', background: '~/.config/claude-dojo/backgrounds/fond.jpg' })]);
  assert.equal(r.code, 0, r.raw);
  let cfg = readJson(configFile(home));
  assert.equal(cfg.theme, 'frieren');
  assert.equal(cfg.background, path.join(home, '.config', 'claude-dojo', 'backgrounds', 'fond.jpg'));

  r = cli(home, ['write-config', JSON.stringify({ background: null, theme: null })]);
  assert.equal(r.code, 0, r.raw);
  cfg = readJson(configFile(home));
  assert.equal(cfg.background, undefined, 'null efface background');
  assert.equal(cfg.theme, undefined, 'null efface theme');
});

test('config.example.json : theme naruto, background null, accepté par write-config', () => {
  const example = fs.readFileSync(path.join(REPO, 'src', 'config.example.json'), 'utf8');
  const parsed = JSON.parse(example);
  assert.equal(parsed.theme, 'naruto');
  assert.equal(parsed.background, null);
  const r = cli(tmpDir(), ['write-config', '-'], { input: example });
  assert.equal(r.code, 0, r.raw);
});

// ── install-files et désinstallation ─────────────────────────────────────
test('install-files copie themes/ dans le HOME temporaire ; la copie installée liste les thèmes', () => {
  const home = tmpDir();
  const src = path.join(tmpDir(), 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.copyFileSync(SETUP, path.join(src, 'setup.js'));
  writeJson(path.join(src, 'themes', 'alpha', 'theme.json'), { id: 'alpha', name: 'Alpha' });
  writeFile(path.join(src, 'themes', 'alpha', 'background.jpg'), JPEG);

  const r = cli(home, ['install-files', src]);
  assert.equal(r.code, 0, r.raw);
  assert.ok(r.out.copied.includes('themes/'), 'themes/ copié');
  const installed = path.join(home, '.config', 'claude-dojo');
  assert.ok(fs.existsSync(path.join(installed, 'themes', 'alpha', 'theme.json')));
  assert.ok(fs.existsSync(path.join(installed, 'themes', 'alpha', 'background.jpg')));

  const listed = cli(home, ['themes'], { script: path.join(installed, 'setup.js') });
  assert.equal(listed.code, 0, listed.raw);
  assert.deepEqual(listed.out.themes.map((t) => t.id), ['alpha']);

  // Réinstallation : themes/ est remplacé (un thème retiré du source disparaît de la copie)
  fs.rmSync(path.join(src, 'themes', 'alpha'), { recursive: true });
  writeJson(path.join(src, 'themes', 'beta', 'theme.json'), { id: 'beta', name: 'Beta' });
  assert.equal(cli(home, ['install-files', src]).code, 0);
  assert.equal(fs.existsSync(path.join(installed, 'themes', 'alpha')), false);
  assert.ok(fs.existsSync(path.join(installed, 'themes', 'beta', 'theme.json')));
});

// Empreintes de tous les fichiers d'un dossier, sous-dossiers compris (terminal/frames, terminal/shaders).
// Un lien est comparé à sa cible écrite, jamais suivi.
function treeHashes(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p);
      if (e.isSymbolicLink()) out[rel] = 'lien:' + fs.readlinkSync(p);
      else if (e.isDirectory()) walk(p);
      else out[rel] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}

test('install-files : terminal/ d un thème copié récursivement (frames/, shaders/) ; lien interne gardé, lien sortant refusé', () => {
  const home = tmpDir();
  const base = tmpDir();
  const src = path.join(base, 'src');
  const term = path.join(src, 'themes', 'alpha', 'terminal');
  writeJson(path.join(src, 'themes', 'alpha', 'theme.json'), { id: 'alpha', name: 'Alpha' });
  writeFile(path.join(term, 'frames', 'frame_01.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFile(path.join(term, 'shaders', 'a.glsl'), 'void mainImage(){}');
  fs.symlinkSync('a.glsl', path.join(term, 'shaders', 'link.glsl'));
  const r = cli(home, ['install-files', src]);
  assert.equal(r.code, 0, r.raw);
  const copy = path.join(home, '.config', 'claude-dojo', 'themes', 'alpha', 'terminal');
  assert.ok(fs.existsSync(path.join(copy, 'frames', 'frame_01.png')), 'frames/ copié');
  assert.ok(fs.existsSync(path.join(copy, 'shaders', 'a.glsl')), 'shaders/ copié');
  assert.ok(fs.lstatSync(path.join(copy, 'shaders', 'link.glsl')).isSymbolicLink(), 'lien interne conservé comme lien');
  assert.equal(fs.readlinkSync(path.join(copy, 'shaders', 'link.glsl')), 'a.glsl');

  // lien qui sort du dossier source : refusé avant toute copie
  // depuis terminal/shaders/ : cinq « .. » mènent hors de src/ (base/outside.glsl)
  fs.symlinkSync('../../../../../outside.glsl', path.join(term, 'shaders', 'out.glsl'));
  writeFile(path.join(base, 'outside.glsl'), 'secret');
  const home2 = tmpDir();
  const bad = cli(home2, ['install-files', src]);
  assert.equal(bad.code, 1, bad.raw);
  assert.match(bad.out.error, /lien symbolique refusé/);
  assert.equal(fs.existsSync(path.join(home2, '.config', 'claude-dojo', 'themes')), false, 'rien copié');
});

test('install-files : les thèmes réels de src/themes sont copiés à l identique (terminal/ compris)', (t) => {
  if (!fs.existsSync(THEMES_SRC)) { t.skip('src/themes absent'); return; }
  const home = tmpDir();
  const r = cli(home, ['install-files', path.join(REPO, 'src')]);
  assert.equal(r.code, 0, r.raw);
  const installed = path.join(home, '.config', 'claude-dojo', 'themes');
  for (const id of THEME_IDS) {
    assert.deepEqual(treeHashes(path.join(installed, id)), treeHashes(path.join(THEMES_SRC, id)), id);
  }
});

test('uninstall (même HOME) : sans purge, backgrounds/ et config restent ; avec purge, tout part', () => {
  const home = tmpDir();
  const dest = cli(home, ['set-background', jpegFile(tmpDir(), 'fond.jpg')]).out.background;
  assert.ok(fs.existsSync(dest));

  let r = cli(home, ['uninstall', JSON.stringify({ noLaunchd: true })]);
  assert.equal(r.code, 0, r.raw);
  assert.equal(r.out.config.removed, false, 'config conservée sans purge');
  assert.ok(fs.existsSync(dest), 'backgrounds/ conservé sans purge');

  r = cli(home, ['uninstall', JSON.stringify({ noLaunchd: true, purge: true })]);
  assert.equal(r.code, 0, r.raw);
  assert.equal(r.out.config.removed, true);
  assert.equal(fs.existsSync(dest), false, 'backgrounds/ supprimé avec purge');
});

// ── Validation des thèmes réels (src/themes/<id>/) ───────────────────────
const isDirName = (root, n) => { try { return fs.statSync(path.join(root, n)).isDirectory(); } catch { return false; } };
const THEME_IDS = fs.existsSync(THEMES_SRC) ? fs.readdirSync(THEMES_SRC).filter((n) => isDirName(THEMES_SRC, n)).sort() : [];
// Les 8 thèmes livrés : la liste de src/themes doit correspondre exactement (ni manquant, ni en trop).
const EXPECTED_THEME_IDS = ['naruto', 'stargate-sg1', 'demon-slayer', 'frieren', 'one-piece',
  'my-hero-academia', 'jujutsu-kaisen', 'mushoku-tensei'].sort();
// Termes personnels interdits dans le dépôt (scan CI, insensible à la casse).
// Fragments concaténés : le littéral complet n'apparaît jamais dans ce fichier.
const FORBIDDEN_RE = new RegExp([
  'gt' + 'ko', 'gre' + 'go', 'mus' + '-inn', 'min' + 'zac', 'cascade' + 'projects',
  'dot' + 'world', 'mediamod' + 'ifier', 'her' + 'mes',
].join('|'), 'i');
// Plafond de background.jpg : 900 Ko par défaut. naruto garde son fond tiers historique (~1,1 Mo, 3840x2400),
// conservé tel quel : plafond relevé à 1,3 Mo pour ce seul thème.
const BG_MAX_DEFAULT = 900 * 1024;
const BG_MAX = { naruto: 1.3 * 1024 * 1024 };
const bgMax = (id) => BG_MAX[id] ?? BG_MAX_DEFAULT;

const ID_RE = /^[a-z0-9-]+$/;
const PALETTE_KEYS = ['bg', 'line', 'fg', 'muted', 'dim', 'purple', 'pink', 'orange', 'yellow'];
const VOCAB_KEYS = ['title', 'empty', 'labelWorking', 'labelWaiting', 'labelIdle', 'summaryWorking', 'summaryWaiting', 'summaryIdle'];
const PROPS = ['post', 'dhd', 'log', 'grimoire', 'barrel', 'robot', 'doll', 'staff'];
const HAIR_STYLES = ['spiky', 'long', 'duck', 'bob', 'kakashi', 'bowl', 'gaara', 'itachi', 'mane',
  'short', 'messy', 'bald', 'twintail', 'curly', 'blast', 'split', 'antenna', 'flame', 'spikyUp', 'longStraight', 'pigtailOne'];
const HATS = ['straw', 'pink', 'witch', 'priest'];
const EARS = ['elf'];
const SCAR_FACES = ['forehead', 'cheek', 'eye'];
const BACK_ITEMS = ['staff', 'swords', 'katana', 'spear', 'sheath'];
const CHAR_REQUIRED_COLORS = ['hair', 'top', 'pants', 'iris'];
// body est optionnel : le moteur prend top par défaut. Validé comme couleur quand il est présent.
const CHAR_COLORS = ['body', 'hair2', 'topD', 'pantsD', 'skin', 'skinD', 'shoe', 'belt', 'hatBand', 'blindfold',
  'earrings', 'scarf', 'cape', 'gem'];
const CHAR_FLAGS = ['noPupil', 'noBrow', 'brows', 'eyeRings', 'mask', 'gourd', 'tear', 'scratch', 'clouds', 'ponytail',
  'paint', 'sennin', 'whiskers', 'bare', 'eyeHidden', 'boarMask', 'gag', 'horn', 'antlers', 'cigarette', 'freckles', 'flameCoat'];

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_RE = /^rgba?\(\s*\d+(\.\d+)?\s*,\s*\d+(\.\d+)?\s*,\s*\d+(\.\d+)?\s*(,\s*\d*\.?\d+%?\s*)?\)$/i;
const isColor = (v) => typeof v === 'string' && (HEX_RE.test(v.trim()) || RGB_RE.test(v.trim()));
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Couleur -> { r, g, b, a } (a dans 0..1). Ne traite que les formes validées par isColor.
function parseColor(s) {
  const v = s.trim();
  const hex = HEX_RE.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const parts = /^rgba?\((.*)\)$/i.exec(v)[1].split(',').map((p) => p.trim());
  const alpha = parts[3];
  const a = alpha === undefined ? 1 : (alpha.endsWith('%') ? parseFloat(alpha) / 100 : parseFloat(alpha));
  return { r: +parts[0], g: +parts[1], b: +parts[2], a };
}
// Couleur translucide posée sur un fond opaque.
const over = (top, base) => ({
  r: top.r * top.a + base.r * (1 - top.a),
  g: top.g * top.a + base.g * (1 - top.a),
  b: top.b * top.a + base.b * (1 - top.a),
  a: 1,
});
// Luminance relative WCAG.
function luminance({ r, g, b }) {
  const lin = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(c1, c2) {
  const [hi, lo] = [luminance(c1), luminance(c2)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function readTheme(id) {
  return JSON.parse(fs.readFileSync(path.join(THEMES_SRC, id, 'theme.json'), 'utf8'));
}

// Liste des erreurs de theme.json (vide = valide). Ne lève pas : chaque défaut est une ligne.
function themeErrors(id) {
  const errs = [];
  const need = (ok, msg) => { if (!ok) errs.push(msg); };
  let t;
  try { t = readTheme(id); } catch (e) { return [`theme.json illisible : ${e.message}`]; }
  if (!isObj(t)) return ['theme.json : un objet JSON est attendu'];

  need(ID_RE.test(id), `nom de dossier invalide : ${id}`);
  need(t.id === id, `id « ${t.id} » différent du nom du dossier « ${id} »`);
  need(isStr(t.name), 'name : chaîne non vide requise');
  need(isStr(t.credit), 'credit : chaîne non vide requise');
  need(t.accentFont === null || isStr(t.accentFont), 'accentFont : chaîne ou null');

  if (!isObj(t.palette)) {
    errs.push('palette : objet requis');
  } else {
    for (const k of PALETTE_KEYS) need(isColor(t.palette[k]), `palette.${k} : couleur CSS valide requise`);
    if (isColor(t.palette.bg)) {
      const a = parseColor(t.palette.bg).a;
      need(a >= 0.45 && a <= 0.6, `palette.bg : fond translucide, alpha entre .45 et .6 (reçu ${a})`);
    }
  }

  if (!isObj(t.vocab)) errs.push('vocab : objet requis');
  else for (const k of VOCAB_KEYS) need(isStr(t.vocab[k]), `vocab.${k} : texte non vide requis`);

  need(PROPS.includes(t.prop), `prop : ${PROPS.join(' | ')} attendu (reçu ${JSON.stringify(t.prop)})`);
  if (t.propColors !== undefined) {
    need(Array.isArray(t.propColors) && t.propColors.length === 2 && t.propColors.every(isColor), 'propColors : deux couleurs');
  }

  if (!Array.isArray(t.chars) || t.chars.length < 5) {
    errs.push(`chars : au moins 5 personnages (reçu ${Array.isArray(t.chars) ? t.chars.length : 'aucun'})`);
  } else {
    const seen = new Set();
    t.chars.forEach((c, i) => {
      const at = `chars[${i}]`;
      if (!isObj(c)) { errs.push(`${at} : objet attendu`); return; }
      need(typeof c.id === 'string' && ID_RE.test(c.id), `${at}.id : [a-z0-9-]+ requis`);
      need(!seen.has(c.id), `${at}.id « ${c.id} » en double dans le thème`);
      seen.add(c.id);
      need(isStr(c.name), `${at}.name : texte non vide requis`);
      for (const k of CHAR_REQUIRED_COLORS) need(isColor(c[k]), `${at}.${k} : couleur requise`);
      for (const k of CHAR_COLORS) if (c[k] !== undefined) need(isColor(c[k]), `${at}.${k} : couleur attendue`);
      if (c.band !== undefined && c.band !== null) need(isColor(c.band), `${at}.band : couleur ou null`);
      if (c.wrap !== undefined && c.wrap !== false) need(isColor(c.wrap), `${at}.wrap : couleur ou false`);
      if (c.glasses !== undefined && c.glasses !== true) need(isColor(c.glasses), `${at}.glasses : couleur ou true`);
      if (c.checker !== undefined) need(Array.isArray(c.checker) && c.checker.length === 2 && c.checker.every(isColor), `${at}.checker : deux couleurs`);
      for (const k of CHAR_FLAGS) if (c[k] !== undefined) need(typeof c[k] === 'boolean', `${at}.${k} : booléen attendu`);
      if (c.hairStyle !== undefined) need(HAIR_STYLES.includes(c.hairStyle), `${at}.hairStyle hors liste : ${c.hairStyle}`);
      if (c.hat !== undefined) need(HATS.includes(c.hat), `${at}.hat hors liste : ${c.hat}`);
      if (c.ears !== undefined) need(EARS.includes(c.ears), `${at}.ears hors liste : ${c.ears}`);
      if (c.scarFace !== undefined) need(SCAR_FACES.includes(c.scarFace), `${at}.scarFace hors liste : ${c.scarFace}`);
      if (c.backItem !== undefined) need(BACK_ITEMS.includes(c.backItem), `${at}.backItem hors liste : ${c.backItem}`);
      if (c.kanji !== undefined) need(typeof c.kanji === 'string', `${at}.kanji : chaîne attendue`);
      if (c.tag !== undefined) need(typeof c.tag === 'string', `${at}.tag : chaîne attendue`);
    });
  }
  return errs;
}

const isJpeg = (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;

test('thèmes : exactement les 8 ids attendus dans src/themes', () => {
  assert.deepEqual(THEME_IDS, EXPECTED_THEME_IDS);
});

for (const id of THEME_IDS) {
  test(`thème ${id} : theme.json valide`, () => {
    const errs = themeErrors(id);
    assert.equal(errs.length, 0, errs.join(' | '));
  });

  test(`thème ${id} : au moins 5 personnages`, () => {
    const chars = readTheme(id).chars;
    assert.ok(Array.isArray(chars) && chars.length >= 5, `${Array.isArray(chars) ? chars.length : 0} personnage(s), 5 minimum`);
  });

  test(`thème ${id} : credit non vide`, () => {
    assert.ok(isStr(readTheme(id).credit), 'credit absent ou vide');
  });

  test(`thème ${id} : vocab complet`, () => {
    const vocab = readTheme(id).vocab;
    const missing = VOCAB_KEYS.filter((k) => !isObj(vocab) || !isStr(vocab[k]));
    assert.equal(missing.length, 0, `vocab incomplet : ${missing.join(', ')}`);
  });

  test(`thème ${id} : aucun terme perso dans theme.json`, () => {
    const found = FORBIDDEN_RE.exec(fs.readFileSync(path.join(THEMES_SRC, id, 'theme.json'), 'utf8'));
    assert.equal(found, null, `terme interdit : ${found && found[0]}`);
  });

  test(`thème ${id} : background.jpg (JPEG, ${Math.round(bgMax(id) / 1024)} Ko max)`, () => {
    const file = path.join(THEMES_SRC, id, 'background.jpg');
    assert.ok(fs.existsSync(file), 'background.jpg absent');
    const buf = fs.readFileSync(file);
    assert.ok(buf.length <= bgMax(id), `background.jpg trop lourd : ${buf.length} octets (max ${bgMax(id)})`);
    assert.ok(isJpeg(buf), 'signature JPEG absente');
  });

  test(`thème ${id} : contraste (fg >= 4.5, muted >= 3 sur bg composé sur #101018)`, () => {
    let t;
    try { t = readTheme(id); } catch (e) { assert.fail(`theme.json illisible : ${e.message}`); }
    assert.ok(isObj(t.palette) && isColor(t.palette.bg) && isColor(t.palette.fg) && isColor(t.palette.muted),
      'palette bg/fg/muted invalide (voir le test theme.json valide)');
    const base = { r: 0x10, g: 0x10, b: 0x18, a: 1 };
    const panel = over(parseColor(t.palette.bg), base);
    const fg = contrast(over(parseColor(t.palette.fg), panel), panel);
    const muted = contrast(over(parseColor(t.palette.muted), panel), panel);
    assert.ok(fg >= 4.5, `contraste fg ${fg.toFixed(2)} < 4.5`);
    assert.ok(muted >= 3, `contraste muted ${muted.toFixed(2)} < 3`);
  });

  test(`thème ${id} : thumbnail.jpg (obligatoire si THEMES_STRICT=1)`, (t) => {
    const file = path.join(THEMES_SRC, id, 'thumbnail.jpg');
    if (!fs.existsSync(file)) {
      if (!STRICT) { t.skip('thumbnail.jpg absent (THEMES_STRICT=1 pour l exiger)'); return; }
      assert.fail('thumbnail.jpg absent');
    }
    assert.ok(isJpeg(fs.readFileSync(file)), 'signature JPEG absente');
  });
}
