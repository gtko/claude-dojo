// Tests de la galerie Wallhaven (src/setup.js : commande wallpapers, set-theme, backgroundByTheme).
// Aucun appel réseau réel : fetch injecté, et globalThis.fetch remplacé par un refus. Chaque test travaille dans un HOME temporaire.
// Sauf DOJO_NET_TESTS=1 : un test d'intégration réel (list frieren, download d'un ID curé), toujours en HOME temporaire.
'use strict';
const test = require('node:test');
const { beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SETUP = path.join(REPO, 'src', 'setup.js');
const setup = require(SETUP);
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'src', 'package.json'), 'utf8')).version;
const API = 'https://wallhaven.cc/api/v1';
const REAL_FETCH = globalThis.fetch;
const MB = 1024 * 1024;

// ── Fixtures ─────────────────────────────────────────────────────────────
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(120, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 8)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(120, 9)]);

let homeDir = null;
let savedHome;
let savedGap;
const outsideDirs = [];
const noNetwork = async () => { throw new Error('appel réseau réel interdit dans les tests'); };

beforeEach(() => {
  savedHome = process.env.HOME;
  savedGap = process.env.DOJO_WALLHAVEN_MIN_INTERVAL_MS;
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-wall-test-'));
  process.env.HOME = homeDir;
  process.env.DOJO_WALLHAVEN_MIN_INTERVAL_MS = '0';
  globalThis.fetch = noNetwork;
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedGap === undefined) delete process.env.DOJO_WALLHAVEN_MIN_INTERVAL_MS; else process.env.DOJO_WALLHAVEN_MIN_INTERVAL_MS = savedGap;
  fs.rmSync(homeDir, { recursive: true, force: true });
  for (const d of outsideDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────
const dojoDir = () => path.join(process.env.HOME, '.config', 'claude-dojo');
const bgRoot = () => path.join(dojoDir(), 'backgrounds');
const bgDir = (theme) => path.join(bgRoot(), theme);
const configFile = () => path.join(dojoDir(), 'config.json');
const readConfig = () => JSON.parse(fs.readFileSync(configFile(), 'utf8'));
const writeRawConfig = (obj) => {
  fs.mkdirSync(dojoDir(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(obj));
};
const modeOf = (p) => fs.statSync(p).mode & 0o777;
// Windows n'a pas de bits POSIX : fs.statSync y rend toujours 0666/0777, les modes ne sont comparés que hors Windows.
const POSIX_MODES = process.platform !== 'win32';
const assertMode = (p, mode) => { if (POSIX_MODES) assert.equal(modeOf(p), mode); };
const wp = (args, deps = {}) => setup.main(['wallpapers', ...args], deps);
const noSleep = async () => {};

function outsideDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-wall-out-'));
  outsideDirs.push(d);
  return d;
}

const apiData = (id, over = {}) => ({
  data: {
    id,
    url: `https://wallhaven.cc/w/${id}`,
    purity: 'sfw',
    resolution: '2560x1440',
    path: `https://w.wallhaven.cc/full/ab/wallhaven-${id}.jpg`,
    thumbs: { large: `https://th.wallhaven.cc/lg/ab/${id}.jpg` },
    ...over,
  },
});
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const imgRes = (body, headers = {}) => new Response(body, { status: 200, headers });

// fetch factice : enregistre chaque appel ; mesure le nombre de requêtes simultanées.
function fakeFetch(handler) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try { return await handler(String(url), opts); } finally { inFlight -= 1; }
  };
  return { fetch, calls, maxInFlight: () => maxInFlight };
}

// Galerie naruto : aaaa (jpg), bbbb (png), cccc (webp), plus trois éléments à ignorer (contenu invalide, texte, lien).
function seedGallery() {
  const dir = bgDir('naruto');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'wallhaven-aaaa.jpg'), JPEG, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'wallhaven-bbbb.png'), PNG, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'wallhaven-cccc.webp'), WEBP, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'wallhaven-dddd.jpg'), 'pas une image', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'texte', { mode: 0o600 });
  const secretDir = outsideDir();
  fs.writeFileSync(path.join(secretDir, 'secret.jpg'), JPEG);
  fs.symlinkSync(path.join(secretDir, 'secret.jpg'), path.join(dir, 'wallhaven-eeee.jpg'));
  fs.writeFileSync(path.join(bgRoot(), 'index.json'), JSON.stringify([{
    id: 'aaaa', theme: 'naruto', source: 'https://wallhaven.cc/w/aaaa', resolution: '1920x1080',
    file: path.join(dir, 'wallhaven-aaaa.jpg'), downloadedAt: '2026-10-01T00:00:00.000Z',
  }]), { mode: 0o600 });
  return { aaaa: path.join(dir, 'wallhaven-aaaa.jpg'), bbbb: path.join(dir, 'wallhaven-bbbb.png'), cccc: path.join(dir, 'wallhaven-cccc.webp') };
}

// ── list ─────────────────────────────────────────────────────────────────
test('list : sfw gardé, sketchy et 404 sautés avec raison, requêtes séquentielles avec User-Agent', async () => {
  const ids = curatedIds('frieren');
  const f = fakeFetch(async (url) => {
    const id = url.split('/w/')[1];
    if (id === '2y6vy6') return jsonRes(apiData(id, { purity: 'sketchy' }));
    if (id === '9ozlpk') return jsonRes({ error: 'Not found' }, 404);
    return jsonRes(apiData(id));
  });
  const r = await wp(['list', 'frieren'], { fetch: f.fetch, sleep: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.theme, 'frieren');
  assert.equal(r.query, 'Sousou no Frieren');
  assert.equal(r.default, '9ozlpk');
  assert.deepEqual(r.wallpapers.map((w) => w.id), ids.filter((i) => i !== '2y6vy6' && i !== '9ozlpk'));
  assert.deepEqual(r.skipped.map((s) => s.id), ['2y6vy6', '9ozlpk']);
  assert.match(r.skipped[0].reason, /non SFW/);
  assert.match(r.skipped[1].reason, /introuvable/);
  assert.deepEqual(f.calls.map((c) => c.url), ids.map((i) => `${API}/w/${i}`));
  for (const c of f.calls) {
    assert.equal(c.opts.headers['User-Agent'], `claude-dojo/${PKG_VERSION}`);
    assert.equal(c.opts.redirect, 'error');
    assert.ok(c.opts.signal, 'délai maximal présent');
  }
  assert.equal(f.maxInFlight(), 1, 'une requête à la fois');
  const w = r.wallpapers[0];
  assert.deepEqual(Object.keys(w).sort(), ['downloaded', 'file', 'id', 'purity', 'resolution', 'source', 'thumb']);
  assert.equal(w.downloaded, false);
  assert.equal(w.file, null);
  assert.equal(w.source, 'https://wallhaven.cc/w/gw5ypd');
  assert.equal(w.thumb, 'https://th.wallhaven.cc/lg/ab/gw5ypd.jpg');
  assert.equal(w.purity, 'sfw');
});

test('list : un fond déjà téléchargé est marqué downloaded avec son fichier', async () => {
  const dir = bgDir('frieren');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'wallhaven-gw5ypd.jpg'), JPEG);
  const f = fakeFetch(async (url) => jsonRes(apiData(url.split('/w/')[1])));
  const r = await wp(['list', 'frieren'], { fetch: f.fetch, sleep: noSleep });
  const hit = r.wallpapers.find((w) => w.id === 'gw5ypd');
  assert.equal(hit.downloaded, true);
  assert.equal(hit.file, path.join(dir, 'wallhaven-gw5ypd.jpg'));
  assert.equal(r.wallpapers.filter((w) => w.downloaded).length, 1);
});

test('list : thème inconnu ou sans galerie refusé, sans appel réseau', async () => {
  const f = fakeFetch(async () => jsonRes({}));
  await assert.rejects(wp(['list', 'zzz'], { fetch: f.fetch }), /thème inconnu/);
  await assert.rejects(wp(['list', '../naruto'], { fetch: f.fetch }), /identifiant de thème/);
  assert.equal(f.calls.length, 0);
});

// ── search ───────────────────────────────────────────────────────────────
test('search : paramètres figés (purity=100, categories, atleast, ratios, sorting), refiltre sfw, lastPage', async () => {
  const body = {
    data: [apiData('abc123').data, { ...apiData('zzz999').data, purity: 'sketchy' }, { ...apiData('BAD!').data, id: 'BAD!' }],
    meta: { last_page: 7, current_page: 2 },
  };
  const f = fakeFetch(async () => jsonRes(body));
  const r = await wp(['search', 'naruto', '2'], { fetch: f.fetch, sleep: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.theme, 'naruto');
  assert.equal(r.page, 2);
  assert.equal(r.lastPage, 7);
  assert.deepEqual(r.wallpapers.map((w) => w.id), ['abc123']);
  const u = new URL(f.calls[0].url);
  assert.equal(u.origin + u.pathname, `${API}/search`);
  assert.equal(u.searchParams.get('q'), 'Naruto Shippuuden');
  assert.equal(u.searchParams.get('purity'), '100');
  assert.equal(u.searchParams.get('categories'), '010');
  assert.equal(u.searchParams.get('atleast'), '2560x1440');
  assert.equal(u.searchParams.get('ratios'), '16x10,16x9');
  assert.equal(u.searchParams.get('sorting'), 'favorites');
  assert.equal(u.searchParams.get('page'), '2');
  assert.equal(f.calls[0].opts.headers['User-Agent'], `claude-dojo/${PKG_VERSION}`);
});

test('search : stargate-sg1 utilise categories=111, page par défaut 1, lastPage absent -> page', async () => {
  const f = fakeFetch(async () => jsonRes({ data: [] }));
  const r = await wp(['search', 'stargate-sg1'], { fetch: f.fetch });
  assert.equal(new URL(f.calls[0].url).searchParams.get('categories'), '111');
  assert.equal(new URL(f.calls[0].url).searchParams.get('page'), '1');
  assert.deepEqual(r, { ok: true, theme: 'stargate-sg1', page: 1, lastPage: 1, wallpapers: [] });
});

test('search : page invalide refusée sans appel réseau', async () => {
  const f = fakeFetch(async () => jsonRes({ data: [] }));
  for (const bad of ['0', 'abc', '1001', '-1', '1.5']) {
    await assert.rejects(wp(['search', 'naruto', bad], { fetch: f.fetch }), /page attendue/, bad);
  }
  assert.equal(f.calls.length, 0);
});

// ── download ─────────────────────────────────────────────────────────────
test('download : jpeg et png nominaux, modes 0600/0700, index.json, retour JSON', async () => {
  const plan = { '8o99v2': 'jpg', mlq73y: 'png' };
  const f = fakeFetch(async (url) => {
    if (url.startsWith(`${API}/w/`)) {
      const id = url.split('/w/')[1];
      return jsonRes(apiData(id, { path: `https://w.wallhaven.cc/full/ab/wallhaven-${id}.${plan[id]}` }));
    }
    return imgRes(url.endsWith('.png') ? PNG : JPEG, { 'content-length': '120' });
  });
  const a = await wp(['download', '8o99v2', 'naruto'], { fetch: f.fetch });
  assert.deepEqual(a, {
    ok: true,
    id: '8o99v2',
    theme: 'naruto',
    file: path.join(bgDir('naruto'), 'wallhaven-8o99v2.jpg'),
    source: 'https://wallhaven.cc/w/8o99v2',
    resolution: '2560x1440',
  });
  const b = await wp(['download', 'mlq73y'], { fetch: f.fetch });
  assert.equal(b.theme, 'naruto', 'thème par défaut : naruto');
  assert.equal(b.file, path.join(bgDir('naruto'), 'wallhaven-mlq73y.png'));
  assert.deepEqual(fs.readFileSync(a.file), JPEG);
  assert.deepEqual(fs.readFileSync(b.file), PNG);
  assertMode(a.file, 0o600);
  assertMode(b.file, 0o600);
  assertMode(bgRoot(), 0o700);
  assertMode(bgDir('naruto'), 0o700);
  const index = JSON.parse(fs.readFileSync(path.join(bgRoot(), 'index.json'), 'utf8'));
  assert.deepEqual(index.map((e) => e.id).sort(), ['8o99v2', 'mlq73y']);
  assert.deepEqual(Object.keys(index[0]).sort(), ['downloadedAt', 'file', 'id', 'resolution', 'source', 'theme']);
  assertMode(path.join(bgRoot(), 'index.json'), 0o600);
  // Requêtes image : sans redirection suivie, User-Agent présent, délai maximal.
  const imgCall = f.calls.find((c) => c.url.includes('w.wallhaven.cc'));
  assert.equal(imgCall.opts.redirect, 'error');
  assert.equal(imgCall.opts.headers['User-Agent'], `claude-dojo/${PKG_VERSION}`);
  assert.ok(imgCall.opts.signal);
});

test('download : thème par défaut = thème actif de config.json', async () => {
  writeRawConfig({ theme: 'frieren' });
  const f = fakeFetch(async (url) => (url.startsWith(`${API}/w/`)
    ? jsonRes(apiData('gw5ypd'))
    : imgRes(JPEG)));
  const r = await wp(['download', 'gw5ypd'], { fetch: f.fetch });
  assert.equal(r.theme, 'frieren');
  assert.ok(fs.existsSync(path.join(bgDir('frieren'), 'wallhaven-gw5ypd.jpg')));
});

test('download : hôte, schéma, identifiants et port refusés, une seule requête (API) et aucune image', async () => {
  const bads = [
    'https://evil.example.com/full/x/wallhaven-abc123.jpg',
    'http://w.wallhaven.cc/full/x/wallhaven-abc123.jpg',
    'https://w.wallhaven.cc.evil.example/full/x/wallhaven-abc123.jpg',
    'https://user@w.wallhaven.cc/full/x/wallhaven-abc123.jpg',
    'https://w.wallhaven.cc:8443/full/x/wallhaven-abc123.jpg',
    'https://th.wallhaven.cc/full/x/wallhaven-abc123.jpg',
    'ftp://w.wallhaven.cc/full/x/wallhaven-abc123.jpg',
  ];
  for (const bad of bads) {
    const f = fakeFetch(async () => jsonRes(apiData('abc123', { path: bad })));
    await assert.rejects(wp(['download', 'abc123', 'naruto'], { fetch: f.fetch }), /URL d'image refusée/, bad);
    assert.equal(f.calls.length, 1, `aucune requête image pour ${bad}`);
  }
});

test('download : contenu non SFW refusé, rien écrit', async () => {
  const f = fakeFetch(async () => jsonRes(apiData('abc123', { purity: 'nsfw' })));
  await assert.rejects(wp(['download', 'abc123', 'naruto'], { fetch: f.fetch }), /non SFW/);
  assert.equal(f.calls.length, 1);
  assert.equal(fs.existsSync(bgDir('naruto')), false);
});

test('download : signature incohérente avec l’extension ou format refusé, rien écrit', async () => {
  const cases = [
    ['png', JPEG, /contenu incohérent/],
    ['webp', PNG, /contenu incohérent/],
    ['jpg', Buffer.from('pas une image du tout'), /contenu incohérent/],
    ['gif', JPEG, /format refusé/],
  ];
  for (const [ext, body, re] of cases) {
    const f = fakeFetch(async (url) => (url.startsWith(`${API}/w/`)
      ? jsonRes(apiData('abc123', { path: `https://w.wallhaven.cc/full/ab/wallhaven-abc123.${ext}` }))
      : imgRes(body)));
    await assert.rejects(wp(['download', 'abc123', 'naruto'], { fetch: f.fetch }), re, ext);
    assert.equal(fs.existsSync(path.join(bgDir('naruto'), `wallhaven-abc123.${ext}`)), false);
  }
});

test('download : image au-delà de 25 Mo refusée (Content-Length, puis comptage en streaming)', async () => {
  const declared = fakeFetch(async (url) => (url.startsWith(`${API}/w/`)
    ? jsonRes(apiData('abc123'))
    : imgRes(JPEG, { 'content-length': String(26 * MB) })));
  await assert.rejects(wp(['download', 'abc123', 'naruto'], { fetch: declared.fetch }), /trop lourde/);

  let cancelled = false;
  const streamed = fakeFetch(async (url) => {
    if (url.startsWith(`${API}/w/`)) return jsonRes(apiData('abc123'));
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(JPEG));
        for (let i = 0; i < 26; i += 1) c.enqueue(new Uint8Array(MB));
        c.close();
      },
      cancel() { cancelled = true; },
    });
    return imgRes(stream);
  });
  await assert.rejects(wp(['download', 'abc123', 'naruto'], { fetch: streamed.fetch }), /trop lourde/);
  assert.equal(cancelled, true, 'lecture interrompue');
  assert.equal(fs.existsSync(path.join(bgDir('naruto'), 'wallhaven-abc123.jpg')), false);
});

test('download : identifiant invalide refusé avant tout appel réseau', async () => {
  const f = fakeFetch(async () => jsonRes(apiData('abc123')));
  for (const bad of ['AB', 'abc', '../etc', 'ABCDEF', 'abc-123', 'abcdefghijk', '']) {
    await assert.rejects(wp(['download', bad, 'naruto'], { fetch: f.fetch }), /identifiant Wallhaven invalide/, bad);
  }
  assert.equal(f.calls.length, 0);
});

test('download : thème inconnu -> erreur claire, sans appel réseau', async () => {
  const f = fakeFetch(async () => jsonRes(apiData('abc123')));
  await assert.rejects(wp(['download', 'abc123', 'zzz'], { fetch: f.fetch }), /thème inconnu : zzz/);
  assert.equal(f.calls.length, 0);
});

test('download : aucun suivi de lien symbolique (dossier de galerie, fichier cible)', async () => {
  // Dossier de galerie = lien vers un dossier extérieur : refusé, rien n'y est écrit.
  const outside1 = outsideDir();
  fs.mkdirSync(bgRoot(), { recursive: true, mode: 0o700 });
  fs.symlinkSync(outside1, bgDir('naruto'));
  const f1 = fakeFetch(async (url) => (url.startsWith(`${API}/w/`) ? jsonRes(apiData('abc123')) : imgRes(JPEG)));
  await assert.rejects(wp(['download', 'abc123', 'naruto'], { fetch: f1.fetch }), /lien symbolique/);
  assert.deepEqual(fs.readdirSync(outside1), []);

  // Fichier cible déjà présent sous forme de lien : le lien est remplacé, la cible extérieure reste intacte.
  fs.rmSync(bgDir('naruto'));
  fs.mkdirSync(bgDir('naruto'), { mode: 0o700 });
  const outside2 = outsideDir();
  fs.writeFileSync(path.join(outside2, 'cible.jpg'), 'SECRET');
  fs.symlinkSync(path.join(outside2, 'cible.jpg'), path.join(bgDir('naruto'), 'wallhaven-abc123.jpg'));
  const f2 = fakeFetch(async (url) => (url.startsWith(`${API}/w/`) ? jsonRes(apiData('abc123')) : imgRes(JPEG)));
  const r = await wp(['download', 'abc123', 'naruto'], { fetch: f2.fetch });
  assert.equal(fs.readFileSync(path.join(outside2, 'cible.jpg'), 'utf8'), 'SECRET');
  assert.equal(fs.lstatSync(r.file).isSymbolicLink(), false);
  assert.deepEqual(fs.readFileSync(r.file), JPEG);
});

// ── Erreurs réseau ───────────────────────────────────────────────────────
test('erreurs Wallhaven : 403, 429, réseau et délai dépassé donnent des messages clairs', async () => {
  const cases = [
    [async () => jsonRes({}, 403), /Wallhaven a refusé la requête/],
    [async () => jsonRes({}, 429), /trop de requêtes, réessayez plus tard/],
    [async () => { throw new TypeError('fetch failed'); }, /erreur réseau vers Wallhaven/],
    [async () => { const e = new Error('délai'); e.name = 'TimeoutError'; throw e; }, /délai dépassé/],
  ];
  for (const [handler, re] of cases) {
    const f = fakeFetch(handler);
    await assert.rejects(wp(['list', 'frieren'], { fetch: f.fetch, sleep: noSleep }), re);
    assert.equal(f.calls.length, 1, 'arrêt à la première erreur bloquante');
  }
});

test('rate limit : au moins 1000 ms entre deux requêtes API (horloge injectée, pas de requêtes simultanées)', async () => {
  delete process.env.DOJO_WALLHAVEN_MIN_INTERVAL_MS;
  const sleeps = [];
  const f = fakeFetch(async (url) => jsonRes(apiData(url.split('/w/')[1])));
  await wp(['list', 'frieren'], { fetch: f.fetch, now: () => 0, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(f.calls.length, curatedIds('frieren').length);
  assert.deepEqual(sleeps, Array(curatedIds('frieren').length - 1).fill(1000));
  assert.equal(f.maxInFlight(), 1);
});

// ── local / use / next ───────────────────────────────────────────────────
test('local : fond du thème en tête pour naruto, seuls les fichiers au contenu valide (pas de lien, pas de texte), source et résolution depuis index.json', async () => {
  const files = seedGallery();
  writeRawConfig({ background: files.bbbb });
  const r = await wp(['local', 'naruto']);
  assert.equal(r.ok, true);
  assert.equal(r.theme, 'naruto');
  assert.equal(r.count, 3, 'téléchargés seulement : le fond du thème ne compte pas');
  assert.deepEqual(r.wallpapers.map((w) => w.id), ['theme', 'aaaa', 'bbbb', 'cccc']);
  assert.deepEqual(r.wallpapers.map((w) => w.builtin), [true, false, false, false]);
  assert.deepEqual(r.wallpapers.map((w) => w.current), [false, false, true, false]);
  assert.equal(r.wallpapers[0].file, path.join(REPO, 'src', 'themes', 'naruto', 'background.jpg'));
  assert.equal(r.wallpapers[0].source, null);
  assert.equal(r.wallpapers[1].source, 'https://wallhaven.cc/w/aaaa');
  assert.equal(r.wallpapers[1].resolution, '1920x1080');
  assert.equal(r.wallpapers[2].source, null);
  assert.equal(r.wallpapers[2].resolution, null);
  assert.equal(r.wallpapers[2].file, files.bbbb);
});

test('use <id> puis next : cyclique sur local (fond du thème compris), backgroundByTheme mis à jour, aucune copie', async () => {
  const files = seedGallery();
  const u = await wp(['use', 'bbbb']);
  assert.deepEqual(u, { ok: true, background: files.bbbb, theme: 'naruto', id: 'bbbb' });
  assert.equal(readConfig().background, files.bbbb);
  assert.equal(readConfig().backgroundByTheme.naruto, files.bbbb);
  const seen = [];
  for (let i = 0; i < 4; i += 1) seen.push((await wp(['next'])).id);
  assert.deepEqual(seen, ['cccc', 'theme', 'aaaa', 'bbbb'], 'ordre de local : fond du thème en tête pour naruto');
  const n = await wp(['next']);
  assert.equal(n.count, 4);
  assert.deepEqual(fs.readdirSync(bgRoot()).sort(), ['index.json', 'naruto'], 'rien de copié à la racine');
});

test('next : depuis un fond hors galerie, commence au premier fond du thème', async () => {
  const files = seedGallery();
  writeRawConfig({ background: null });
  const r = await wp(['next']);
  assert.equal(r.background, files.aaaa);
});

test('use <fichier de galerie> : pas de copie, backgroundByTheme[dossier du thème]', async () => {
  const files = seedGallery();
  const r = await wp(['use', files.cccc]);
  assert.deepEqual(r, { ok: true, background: files.cccc, theme: 'naruto', id: 'cccc' });
  assert.equal(readConfig().background, files.cccc);
  assert.equal(readConfig().backgroundByTheme.naruto, files.cccc);
  assert.deepEqual(fs.readdirSync(bgDir('naruto')).filter((n) => n.startsWith('wallhaven-')).sort(),
    ['wallhaven-aaaa.jpg', 'wallhaven-bbbb.png', 'wallhaven-cccc.webp', 'wallhaven-dddd.jpg', 'wallhaven-eeee.jpg']);
});

test('use <autre fichier> : comportement set-background (copie, ancien fond direct supprimé, galerie intacte)', async () => {
  const files = seedGallery();
  await wp(['use', files.aaaa]);
  const src1 = outsideDir();
  fs.writeFileSync(path.join(src1, 'perso1.jpg'), JPEG);
  const first = await wp(['use', path.join(src1, 'perso1.jpg')]);
  assert.equal(path.dirname(first.background), bgRoot(), 'copie directement dans backgrounds/');
  assert.equal(first.id, null);
  assert.equal(first.theme, 'naruto');
  assert.equal(readConfig().background, first.background);
  const src2 = outsideDir();
  fs.writeFileSync(path.join(src2, 'perso2.png'), PNG);
  const second = await wp(['use', path.join(src2, 'perso2.png')]);
  assert.equal(fs.existsSync(first.background), false, 'ancienne copie directe supprimée');
  assert.equal(fs.existsSync(files.aaaa), true, 'fond de galerie jamais supprimé');
  assert.equal(readConfig().background, second.background);
});

test('use : identifiant non téléchargé ou fichier de galerie introuvable -> erreur, rien changé', async () => {
  seedGallery();
  await assert.rejects(wp(['use', 'zzzz']), /non téléchargé/);
  await assert.rejects(wp(['use', path.join(bgDir('naruto'), 'wallhaven-ffff.jpg')]), /introuvable/);
  assert.equal(fs.existsSync(configFile()), false);
});

// Fond téléchargé pour un thème donné (galerie backgrounds/<theme>/), sans toucher à la config.
function seedOtherTheme(theme, id, buf = JPEG, ext = '.jpg') {
  fs.mkdirSync(bgDir(theme), { recursive: true, mode: 0o700 });
  const file = path.join(bgDir(theme), `wallhaven-${id}${ext}`);
  fs.writeFileSync(file, buf, { mode: 0o600 });
  return file;
}

test('use <id> : fond d un autre thème retrouvé, config.theme inchangé, backgroundByTheme de ce thème mis à jour', async () => {
  const files = seedGallery();
  writeRawConfig({ theme: 'frieren' });
  const r = await wp(['use', 'bbbb']);
  assert.deepEqual(r, { ok: true, background: files.bbbb, theme: 'naruto', id: 'bbbb' });
  const cfg = readConfig();
  assert.equal(cfg.theme, 'frieren', 'thème actif inchangé');
  assert.equal(cfg.background, files.bbbb);
  assert.equal(cfg.backgroundByTheme.naruto, files.bbbb);
  assert.equal(cfg.backgroundByTheme.frieren, undefined);
});

test('use <id> : le thème actif est pris quand l id existe aussi dans un autre thème', async () => {
  const files = seedGallery();
  seedOtherTheme('frieren', 'aaaa');
  writeRawConfig({ theme: 'naruto' });
  const r = await wp(['use', 'aaaa']);
  assert.deepEqual(r, { ok: true, background: files.aaaa, theme: 'naruto', id: 'aaaa' });
  assert.equal(readConfig().backgroundByTheme.frieren, undefined);
});

test('use <id> : présent dans deux autres thèmes sans thème actif -> erreur demandant le thème, rien changé', async () => {
  seedOtherTheme('frieren', 'ffff');
  seedOtherTheme('one-piece', 'ffff', PNG, '.png');
  writeRawConfig({ theme: 'jujutsu-kaisen' });
  await assert.rejects(wp(['use', 'ffff']), /plusieurs thèmes \(frieren, one-piece\)/);
  assert.equal(readConfig().background, undefined);
  const r = await wp(['use', 'ffff', 'one-piece']);
  assert.deepEqual(r, { ok: true, background: path.join(bgDir('one-piece'), 'wallhaven-ffff.png'), theme: 'one-piece', id: 'ffff' });
});

test('use <id> <theme> : thème explicite prime ; id absent de ce thème ou thème inconnu -> erreur claire, rien changé', async () => {
  const files = seedGallery();
  const frierenFile = seedOtherTheme('frieren', 'aaaa');
  writeRawConfig({ theme: 'naruto' });
  const r = await wp(['use', 'aaaa', 'frieren']);
  assert.deepEqual(r, { ok: true, background: frierenFile, theme: 'frieren', id: 'aaaa' });
  assert.equal(readConfig().theme, 'naruto', 'config.theme non modifié');
  assert.equal(readConfig().backgroundByTheme.naruto, undefined, 'autre thème non touché');
  await assert.rejects(wp(['use', 'cccc', 'frieren']), /non téléchargé pour le thème frieren \(wallpapers download cccc frieren\)/);
  await assert.rejects(wp(['use', 'aaaa', 'inconnu']), /thème inconnu : inconnu/);
  await assert.rejects(wp(['use', 'aaaa', '../naruto']), /identifiant de thème attendu/);
  assert.equal(readConfig().background, frierenFile, 'échecs sans effet');
  assert.equal(fs.existsSync(files.aaaa), true);
});

test('use <id> inconnu partout -> erreur claire, rien changé', async () => {
  seedGallery();
  await assert.rejects(wp(['use', 'gggg']), /fond gggg non téléchargé \(wallpapers download gggg naruto\)/);
  assert.equal(fs.existsSync(configFile()), false);
});

test('use <fichier> <theme> : thème refusé hors identifiant Wallhaven', async () => {
  const files = seedGallery();
  await assert.rejects(wp(['use', files.aaaa, 'frieren']), /accepté seulement avec un identifiant/);
  assert.equal(fs.existsSync(configFile()), false);
});

test('use <id> : galerie d un autre thème en lien symbolique jamais suivie', async () => {
  const outside = outsideDir();
  fs.writeFileSync(path.join(outside, 'wallhaven-gggg.jpg'), JPEG);
  fs.mkdirSync(bgRoot(), { recursive: true, mode: 0o700 });
  fs.symlinkSync(outside, bgDir('frieren'));
  await assert.rejects(wp(['use', 'gggg']), /non téléchargé/);
  assert.equal(fs.existsSync(configFile()), false);
});

test('next : sans téléchargé, le fond du thème (count 1) ; liste vide -> erreur claire', async () => {
  writeRawConfig({ theme: 'frieren' });
  const r = await wp(['next']);
  assert.deepEqual(r, { ok: true, background: null, theme: 'frieren', id: 'theme', count: 1 });
  assert.equal(readConfig().background, undefined);
  assert.equal(readConfig().backgroundByTheme.frieren, 'theme', 'choix explicite du fond du thème (next)');

  // Thème sans fond embarqué ni téléchargement : rien à cycler, erreur claire.
  const base = outsideDir(); // DOJO_THEMES_DIR désigne le parent du dossier themes/
  fs.mkdirSync(path.join(base, 'themes', 'bare'), { recursive: true });
  fs.writeFileSync(path.join(base, 'themes', 'bare', 'theme.json'), JSON.stringify({ id: 'bare', name: 'Bare' }));
  const prev = process.env.DOJO_THEMES_DIR;
  process.env.DOJO_THEMES_DIR = base;
  try {
    writeRawConfig({ theme: 'bare' });
    await assert.rejects(wp(['next']), /aucun fond pour le thème bare/);
    assert.deepEqual(await wp(['local', 'bare']), { ok: true, theme: 'bare', count: 0, wallpapers: [] });
  } finally {
    if (prev === undefined) delete process.env.DOJO_THEMES_DIR; else process.env.DOJO_THEMES_DIR = prev;
  }
});

// ── set-theme ────────────────────────────────────────────────────────────
test('set-theme : fond mémorisé restauré, retour au thème si fond de galerie d’un autre thème, fond perso inchangé', async () => {
  const files = seedGallery();
  await wp(['use', files.aaaa]);
  const off = await setup.main(['set-theme', 'frieren']);
  assert.deepEqual(off, { ok: true, theme: 'frieren', background: null, hasDownloads: false, needsSync: true });
  const back = await setup.main(['set-theme', 'naruto']);
  assert.deepEqual(back, { ok: true, theme: 'naruto', background: files.aaaa, hasDownloads: true, needsSync: true });

  const src = outsideDir();
  fs.writeFileSync(path.join(src, 'perso.jpg'), JPEG);
  const perso = await setup.main(['set-background', path.join(src, 'perso.jpg')]);
  const keep = await setup.main(['set-theme', 'frieren']);
  assert.equal(keep.background, perso.background, 'fond perso hors galerie conservé');
  assert.equal(keep.hasDownloads, false);

  // Fond de galerie de naruto, fichier supprimé ensuite : passer à frieren retire le fond (galerie d'un autre thème),
  // et revenir à naruto ne restaure pas un fichier absent.
  await setup.main(['set-theme', 'naruto']);
  await wp(['use', files.bbbb]);
  fs.rmSync(files.bbbb);
  const gone = await setup.main(['set-theme', 'frieren']);
  assert.equal(gone.background, null, 'fond de galerie d’un autre thème retiré');
  const again = await setup.main(['set-theme', 'naruto']);
  assert.equal(again.background, null, 'fond mémorisé absent : rien restauré');
});

test('set-theme : hasDownloads vrai seulement si un fond valide est téléchargé pour le thème', async () => {
  seedGallery();
  const r = await setup.main(['set-theme', 'naruto']);
  assert.equal(r.hasDownloads, true);
  const s = await setup.main(['set-theme', 'stargate-sg1']);
  assert.equal(s.hasDownloads, false);
});

// ── config.json : backgroundByTheme ──────────────────────────────────────
test('write-config : backgroundByTheme accepte un fond de galerie, refuse hors dossier, extension, chemin relatif ; null supprime', async () => {
  const files = seedGallery();
  await setup.main(['write-config', JSON.stringify({ backgroundByTheme: { naruto: files.aaaa } })]);
  assert.equal(readConfig().backgroundByTheme.naruto, files.aaaa);
  const bads = [
    { naruto: '/etc/passwd' },
    { naruto: path.join(os.tmpdir(), 'x.jpg') },
    { naruto: path.join(bgDir('naruto'), 'a', 'b.jpg') },
    { naruto: path.join(bgDir('naruto'), 'wallhaven-aaaa.txt') },
    { naruto: 'relatif.jpg' },
    { 'Bad Theme': files.aaaa },
  ];
  for (const bad of bads) {
    await assert.rejects(setup.main(['write-config', JSON.stringify({ backgroundByTheme: bad })]), /backgroundByTheme/, JSON.stringify(bad));
  }
  assert.equal(readConfig().backgroundByTheme.naruto, files.aaaa, 'config inchangée après refus');
  await setup.main(['write-config', JSON.stringify({ backgroundByTheme: { naruto: null } })]);
  assert.equal('naruto' in readConfig().backgroundByTheme, false);
});

test('background : sous-dossier de galerie accepté, lien symbolique refusé', async () => {
  const files = seedGallery();
  await setup.main(['write-config', JSON.stringify({ background: files.bbbb })]);
  assert.equal(readConfig().background, files.bbbb);
  const link = path.join(bgDir('naruto'), 'wallhaven-linked.jpg');
  fs.symlinkSync(path.join(outsideDir(), 'x.jpg'), link);
  await assert.rejects(setup.main(['write-config', JSON.stringify({ background: link })]), /lien symbolique/);
});

// ── CLI : sortie JSON sur stdout ─────────────────────────────────────────
test('CLI : sortie JSON sur stdout ; erreur en {ok:false,error} avec code 1', () => {
  const env = { ...process.env, HOME: process.env.HOME, DOJO_DETECT_NO_GH_AUTH: '1' };
  const ok = spawnSync(process.execPath, [SETUP, 'wallpapers', 'local', 'naruto'], { env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), {
    ok: true,
    theme: 'naruto',
    count: 0,
    wallpapers: [{
      id: 'theme', file: path.join(REPO, 'src', 'themes', 'naruto', 'background.jpg'),
      source: null, resolution: null, current: true, builtin: true,
    }],
  });
  const ko = spawnSync(process.execPath, [SETUP, 'wallpapers', 'progress'], { env, encoding: 'utf8' });
  assert.equal(ko.status, 1);
  const out = JSON.parse(ko.stdout);
  assert.equal(out.ok, false);
  assert.match(out.error, /identifiant de thème attendu/);
});

// ── Fond du thème (use theme / bundled), local, next, set-theme, sync : fond par défaut ──────────────
const curatedFile = (theme) => JSON.parse(fs.readFileSync(path.join(REPO, 'src', 'themes', theme, 'theme.json'), 'utf8')).wallpapers;
// IDs Wallhaven d'un thème (sans « bundled »), dans l'ordre du pack.
const curatedIds = (theme) => curatedFile(theme).ids.filter((id) => id !== 'bundled');
// Ordre de requête de sync : le défaut d'abord, puis les autres dans l'ordre du pack.
const syncOrder = (theme) => {
  const def = curatedFile(theme).default;
  const ids = curatedIds(theme);
  return def !== 'bundled' && ids.includes(def) ? [def, ...ids.filter((id) => id !== def)] : ids;
};
const img = (id) => `https://w.wallhaven.cc/full/ab/wallhaven-${id}.jpg`;
const progressOf = (theme) => path.join(bgDir(theme), '.sync-progress.json');

// Fonds valides pour les IDs donnés, sans appel réseau.
function seedFiles(theme, ids) {
  for (const id of ids) seedOtherTheme(theme, id);
}

// fetch de sync : API SFW (chemin .jpg) et image JPEG par défaut. api[id] : réponse ou exception propre à cet ID.
function wallFetch(api = {}) {
  return fakeFetch(async (url) => {
    if (!url.startsWith(`${API}/w/`)) return imgRes(JPEG);
    const id = url.split('/w/')[1];
    return api[id] ? api[id](url) : jsonRes(apiData(id));
  });
}

test('use theme : fond du thème, config.background retiré, sentinelle « theme » mémorisée pour le thème actif, autres thèmes et galerie intacts', async () => {
  const files = seedGallery();
  const frierenFile = seedOtherTheme('frieren', 'gggg');
  writeRawConfig({ theme: 'naruto', background: files.aaaa, backgroundByTheme: { naruto: files.aaaa, frieren: frierenFile } });
  const r = await wp(['use', 'theme']);
  assert.deepEqual(r, { ok: true, background: null, theme: 'naruto', id: 'theme' });
  const cfg = readConfig();
  assert.equal(cfg.background, undefined);
  assert.equal(cfg.backgroundByTheme.naruto, 'theme', 'choix explicite du fond du thème');
  assert.equal(cfg.backgroundByTheme.frieren, frierenFile);
  assert.equal(cfg.theme, 'naruto');
  assert.equal(fs.existsSync(files.aaaa), true, 'fond de galerie jamais supprimé');
});

test('use theme : copie perso directe retirée comme set-background default ; fichier hors backgrounds/ jamais touché ; thème en argument refusé', async () => {
  const src = outsideDir();
  fs.writeFileSync(path.join(src, 'perso.jpg'), JPEG);
  const copy = await setup.main(['set-background', path.join(src, 'perso.jpg')]);
  assert.equal(fs.existsSync(copy.background), true);
  await wp(['use', 'theme']);
  assert.equal(fs.existsSync(copy.background), false, 'copie directe retirée');

  const own = path.join(src, 'hors.jpg');
  fs.writeFileSync(own, JPEG);
  writeRawConfig({ theme: 'naruto', background: own });
  await wp(['use', 'theme']);
  assert.equal(fs.existsSync(own), true, 'fichier choisi hors backgrounds/ jamais touché');

  await assert.rejects(wp(['use', 'theme', 'frieren']), /pas de second argument/);
  assert.equal(readConfig().theme, 'naruto');
});

test('use bundled : alias de use theme (même retour, sentinelle mémorisée), thème en argument refusé', async () => {
  const files = seedGallery();
  writeRawConfig({ theme: 'naruto', background: files.aaaa, backgroundByTheme: { naruto: files.aaaa } });
  const r = await wp(['use', 'bundled']);
  assert.deepEqual(r, { ok: true, background: null, theme: 'naruto', id: 'theme' });
  assert.equal(readConfig().background, undefined);
  assert.equal(readConfig().backgroundByTheme.naruto, 'theme');
  await assert.rejects(wp(['use', 'bundled', 'frieren']), /pas de second argument/);
  assert.equal(readConfig().theme, 'naruto');
});

test('download : identifiants réservés theme et bundled refusés sans appel réseau', async () => {
  const f = fakeFetch(async () => jsonRes(apiData('abc123')));
  for (const reserved of ['theme', 'bundled']) {
    await assert.rejects(wp(['download', reserved, 'naruto'], { fetch: f.fetch }), /identifiant réservé/, reserved);
  }
  assert.equal(f.calls.length, 0);
});

test('local : fond du thème en dernier pour un autre thème ; current seulement si fond nul et thème actif', async () => {
  seedOtherTheme('frieren', 'gw5ypd');
  writeRawConfig({ theme: 'frieren' });
  const r = await wp(['local', 'frieren']);
  assert.deepEqual(r.wallpapers.map((w) => w.id), ['gw5ypd', 'theme']);
  assert.deepEqual(r.wallpapers.map((w) => w.builtin), [false, true]);
  assert.deepEqual(r.wallpapers.map((w) => w.current), [false, true]);
  assert.equal(r.count, 1);
  const other = await wp(['local', 'naruto']);
  assert.equal(other.wallpapers[0].builtin, true, 'naruto : fond du thème en tête');
  assert.equal(other.wallpapers[0].current, false, 'thème non actif : pas de fond courant');
});

test('set-theme : sans fond mémorisé, un fond de galerie revient au fond du thème ; fond perso inchangé ; needsSync selon les fonds curés', async () => {
  const files = seedGallery();
  writeRawConfig({ theme: 'frieren', background: files.aaaa });
  const r = await setup.main(['set-theme', 'naruto']);
  assert.equal(r.background, null, 'fond de galerie sans entrée mémorisée : fond du thème');

  const own = path.join(outsideDir(), 'perso.jpg');
  fs.writeFileSync(own, JPEG);
  writeRawConfig({ theme: 'naruto', background: own });
  const kept = await setup.main(['set-theme', 'frieren']);
  assert.equal(kept.background, own, 'fond perso hors galerie inchangé');
  assert.equal(kept.needsSync, true);

  seedFiles('frieren', curatedIds('frieren'));
  assert.equal((await setup.main(['set-theme', 'frieren'])).needsSync, false, 'tous les fonds curés présents');
  assert.equal((await setup.main(['set-theme', 'naruto'])).needsSync, true);
  assert.equal((await setup.main(['set-theme', 'stargate-sg1'])).needsSync, true);
});

test('set-theme : sans entrée mémorisée, défaut déjà téléchargé -> ce fichier (+ backgroundByTheme) si fond null ou de galerie ; fond perso inchangé', async () => {
  seedFiles('frieren', ['9ozlpk']);
  const dflt = path.join(bgDir('frieren'), 'wallhaven-9ozlpk.jpg');
  writeRawConfig({ theme: 'naruto' });
  const r = await setup.main(['set-theme', 'frieren']);
  assert.deepEqual(r, { ok: true, theme: 'frieren', background: dflt, hasDownloads: true, needsSync: true });
  assert.equal(readConfig().backgroundByTheme.frieren, dflt);

  const files = seedGallery();
  writeRawConfig({ theme: 'naruto', background: files.aaaa });
  assert.equal((await setup.main(['set-theme', 'frieren'])).background, dflt, 'fond de galerie remplacé par le défaut');

  const own = path.join(outsideDir(), 'perso.jpg');
  fs.writeFileSync(own, JPEG);
  writeRawConfig({ theme: 'naruto', background: own });
  assert.equal((await setup.main(['set-theme', 'frieren'])).background, own, 'fond perso hors galerie conservé');
  assert.equal(readConfig().backgroundByTheme, undefined);
});

test('set-theme : sentinelle « theme » mémorisée -> fond du thème (null), même si le défaut est téléchargé', async () => {
  const files = seedGallery();
  seedFiles('frieren', ['9ozlpk']);
  writeRawConfig({ theme: 'naruto', background: files.aaaa, backgroundByTheme: { frieren: 'theme' } });
  const r = await setup.main(['set-theme', 'frieren']);
  assert.equal(r.background, null);
  assert.equal(r.hasDownloads, true);
  assert.equal(readConfig().backgroundByTheme.frieren, 'theme');
  assert.equal(readConfig().background, undefined);
});

// ── sync / progress ──────────────────────────────────────────────────────
test('sync : le défaut du thème est téléchargé en premier (ordre des requêtes), puis les autres dans l ordre du pack', async () => {
  writeRawConfig({ theme: 'frieren' });
  const f = wallFetch();
  const r = await wp(['sync', 'frieren'], { fetch: f.fetch, sleep: noSleep });
  const order = syncOrder('frieren');
  assert.equal(order[0], '9ozlpk');
  assert.deepEqual(f.calls.map((c) => c.url), order.flatMap((id) => [`${API}/w/${id}`, img(id)]));
  assert.deepEqual(r.downloaded, order);
  assert.equal(r.defaultId, '9ozlpk');
  assert.equal(r.total, order.length);
  assert.equal(f.maxInFlight(), 1);
});

test('sync : 404 sur un ID du pack tolérée (failed), y compris sur le défaut ; les suivants continuent ; defaultApplied faux', async () => {
  writeRawConfig({ theme: 'frieren' });
  const f = wallFetch({
    '9ozlpk': () => jsonRes({ error: 'Not found' }, 404),
    ly3lyy: () => jsonRes({ error: 'Not found' }, 404),
  });
  const r = await wp(['sync', 'frieren'], { fetch: f.fetch, sleep: noSleep });
  const order = syncOrder('frieren');
  assert.deepEqual(r.failed.map((x) => x.id), ['9ozlpk', 'ly3lyy']);
  assert.match(r.failed[0].reason, /introuvable/);
  assert.equal(r.stopped, null);
  assert.equal(r.defaultApplied, false);
  assert.deepEqual(r.downloaded, order.filter((id) => id !== '9ozlpk' && id !== 'ly3lyy'));
  assert.equal(readConfig().background, undefined);
  assert.equal(readConfig().backgroundByTheme, undefined);
});

test('sync : defaultApplied vrai à la fin du téléchargement du défaut (thème actif, pas de choix, fond null ou de galerie)', async () => {
  writeRawConfig({ theme: 'frieren' });
  const file = path.join(bgDir('frieren'), 'wallhaven-9ozlpk.jpg');
  const r = await wp(['sync', 'frieren'], { fetch: wallFetch().fetch, sleep: noSleep });
  assert.equal(r.defaultApplied, true);
  assert.equal(r.defaultId, '9ozlpk');
  assert.equal(readConfig().background, file);
  assert.equal(readConfig().backgroundByTheme.frieren, file);

  // Fond de galerie d'un autre thème : remplacé par le défaut.
  fs.rmSync(bgDir('frieren'), { recursive: true, force: true });
  const files = seedGallery();
  writeRawConfig({ theme: 'frieren', background: files.aaaa });
  const again = await wp(['sync', 'frieren'], { fetch: wallFetch().fetch, sleep: noSleep });
  assert.equal(again.defaultApplied, true);
  assert.equal(readConfig().background, file);
});

test('sync : defaultApplied faux si le thème n est pas actif, si un choix existe (sentinelle ou chemin), si le fond est perso hors galerie, ou si le défaut est bundled', async () => {
  // Thème non actif : téléchargé, mais rien n'est appliqué.
  writeRawConfig({ theme: 'naruto' });
  let r = await wp(['sync', 'frieren'], { fetch: wallFetch().fetch, sleep: noSleep });
  assert.equal(r.defaultApplied, false);
  assert.equal(readConfig().background, undefined);
  assert.equal(fs.existsSync(path.join(bgDir('frieren'), 'wallhaven-9ozlpk.jpg')), true, 'défaut téléchargé quand même');

  // Choix explicite (sentinelle) mémorisé pour le thème actif.
  fs.rmSync(bgDir('frieren'), { recursive: true, force: true });
  writeRawConfig({ theme: 'frieren', backgroundByTheme: { frieren: 'theme' } });
  r = await wp(['sync', 'frieren'], { fetch: wallFetch().fetch, sleep: noSleep });
  assert.equal(r.defaultApplied, false);
  assert.equal(readConfig().background, undefined);
  assert.equal(readConfig().backgroundByTheme.frieren, 'theme');

  // Choix explicite (chemin mémorisé pour le thème actif, fichier de galerie d'un autre thème).
  fs.rmSync(bgDir('frieren'), { recursive: true, force: true });
  const files = seedGallery();
  writeRawConfig({ theme: 'frieren', background: files.bbbb, backgroundByTheme: { frieren: files.bbbb } });
  r = await wp(['sync', 'frieren'], { fetch: wallFetch().fetch, sleep: noSleep });
  assert.equal(r.defaultApplied, false);
  assert.equal(readConfig().background, files.bbbb);

  // Fond perso hors galerie : jamais remplacé.
  fs.rmSync(bgDir('frieren'), { recursive: true, force: true });
  const own = path.join(outsideDir(), 'perso.jpg');
  fs.writeFileSync(own, JPEG);
  writeRawConfig({ theme: 'frieren', background: own });
  r = await wp(['sync', 'frieren'], { fetch: wallFetch().fetch, sleep: noSleep });
  assert.equal(r.defaultApplied, false);
  assert.equal(readConfig().background, own);

  // Défaut « bundled » : rien d'appliqué.
  writeRawConfig({ theme: 'naruto' });
  r = await wp(['sync', 'naruto'], { fetch: wallFetch().fetch, sleep: noSleep });
  assert.equal(r.defaultId, 'bundled');
  assert.equal(r.defaultApplied, false);
  assert.equal(readConfig().background, undefined);
});

test('sentinelle : use theme puis sync : le défaut est téléchargé mais pas réappliqué ; set-theme garde le fond du thème ; write-config accepte theme seulement en valeur de backgroundByTheme', async () => {
  writeRawConfig({ theme: 'frieren' });
  await wp(['use', 'theme']);
  assert.equal(readConfig().backgroundByTheme.frieren, 'theme');
  const r = await wp(['sync', 'frieren'], { fetch: wallFetch().fetch, sleep: noSleep });
  assert.equal(r.downloaded[0], '9ozlpk', 'le défaut est bien téléchargé');
  assert.equal(r.defaultApplied, false);
  assert.equal(readConfig().background, undefined);
  assert.equal(readConfig().backgroundByTheme.frieren, 'theme');

  await setup.main(['set-theme', 'naruto']);
  const back = await setup.main(['set-theme', 'frieren']);
  assert.equal(back.background, null, 'sentinelle : fond du thème, défaut présent ignoré');
  assert.equal(back.hasDownloads, true);

  await setup.main(['write-config', JSON.stringify({ backgroundByTheme: { naruto: 'theme' } })]);
  assert.equal(readConfig().backgroundByTheme.naruto, 'theme');
  for (const bad of [{ naruto: 'theme-perso' }, { naruto: 'Theme' }]) {
    await assert.rejects(setup.main(['write-config', JSON.stringify({ backgroundByTheme: bad })]), /backgroundByTheme/, JSON.stringify(bad));
  }
  await assert.rejects(setup.main(['write-config', JSON.stringify({ background: 'theme' })]), /background/);
  assert.equal(readConfig().backgroundByTheme.naruto, 'theme', 'config inchangée après refus');
});

test('bundled : ignoré par sync et needsSync ; list ne le télécharge pas et renvoie default bundled pour naruto', async () => {
  seedFiles('naruto', curatedIds('naruto'));
  const s = await setup.main(['set-theme', 'naruto']);
  assert.equal(s.needsSync, false, 'bundled n est pas un fond à télécharger');

  const f = wallFetch();
  const r = await wp(['sync', 'naruto'], { fetch: f.fetch, sleep: noSleep });
  assert.deepEqual(r, {
    ok: true,
    theme: 'naruto',
    defaultId: 'bundled',
    defaultApplied: false,
    total: curatedIds('naruto').length,
    downloaded: [],
    skipped: curatedIds('naruto'),
    failed: [],
    stopped: null,
  });
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(progressOf('naruto')), false);

  const g = wallFetch();
  const l = await wp(['list', 'naruto'], { fetch: g.fetch, sleep: noSleep });
  assert.equal(l.default, 'bundled');
  assert.equal(g.calls.length, curatedIds('naruto').length);
  assert.equal(g.calls.some((c) => c.url.endsWith('/w/bundled')), false, 'bundled jamais interrogé sur Wallhaven');
  assert.equal(l.wallpapers.length, curatedIds('naruto').length);
  assert.equal(l.wallpapers.every((w) => w.downloaded), true);
});

test('sync nominal : déjà présent sauté, SFW téléchargé, sketchy en failed, ordre du pack curé, config inchangée (bundled non téléchargé)', async () => {
  seedFiles('naruto', ['mlq73y']);
  writeRawConfig({ theme: 'naruto' });
  const f = wallFetch({ dpg97o: () => jsonRes(apiData('dpg97o', { purity: 'sketchy' })) });
  const r = await wp(['sync', 'naruto'], { fetch: f.fetch, sleep: noSleep });
  const ids = curatedIds('naruto');
  const downloaded = ids.filter((id) => id !== 'mlq73y' && id !== 'dpg97o');
  assert.deepEqual(r, {
    ok: true,
    theme: 'naruto',
    defaultId: 'bundled',
    defaultApplied: false,
    total: ids.length,
    downloaded,
    skipped: ['mlq73y'],
    failed: [{ id: 'dpg97o', reason: 'image refusée : contenu non SFW (sketchy).' }],
    stopped: null,
  });
  assert.deepEqual(f.calls.map((c) => c.url), [`${API}/w/dpg97o`, ...downloaded.flatMap((id) => [`${API}/w/${id}`, img(id)])]);
  assert.equal(f.maxInFlight(), 1);
  for (const id of downloaded) {
    const file = path.join(bgDir('naruto'), `wallhaven-${id}.jpg`);
    assert.deepEqual(fs.readFileSync(file), JPEG);
    assertMode(file, 0o600);
  }
  assert.deepEqual(readConfig(), { theme: 'naruto' }, 'config non modifiée : le défaut bundled ne change pas le fond');
  assert.equal(fs.existsSync(progressOf('naruto')), false, 'progression retirée en fin de sync');
  const local = await wp(['local', 'naruto']);
  assert.equal(local.count, 1 + downloaded.length);
  assert.equal(local.wallpapers[0].builtin, true);
});

test('sync : progression lisible pendant le run (running, total, done, current), fichier 0600, retirée ensuite', async () => {
  seedFiles('naruto', ['mlq73y']);
  const snaps = [];
  const f = fakeFetch(async (url) => {
    if (!url.startsWith(`${API}/w/`)) return imgRes(JPEG);
    const id = url.split('/w/')[1];
    if (id === 'dpg97o') {
      const p = await wp(['progress', 'naruto']);
      const file = progressOf('naruto');
      snaps.push({ ...p, current: JSON.parse(fs.readFileSync(file, 'utf8')).current, ...(POSIX_MODES && { mode: modeOf(file) }) });
    }
    return jsonRes(apiData(id));
  });
  await wp(['sync', 'naruto'], { fetch: f.fetch, sleep: noSleep });
  assert.deepEqual(snaps, [{ ok: true, theme: 'naruto', running: true, total: curatedIds('naruto').length, done: 1, current: 'dpg97o', ...(POSIX_MODES && { mode: 0o600 }) }]);
  assert.deepEqual(await wp(['progress', 'naruto']), { ok: true, theme: 'naruto', running: false, total: 0, done: 0 });
});

test('sync : erreur bloquante (403, 429, réseau, délai) arrête le sync ; ce qui est téléchargé reste, le reste n est pas demandé', async () => {
  const cases = [
    ['naruto', () => jsonRes({}, 403), /Wallhaven a refusé la requête/],
    ['frieren', () => jsonRes({}, 429), /trop de requêtes/],
    ['one-piece', () => { throw new TypeError('fetch failed'); }, /erreur réseau vers Wallhaven/],
    ['mushoku-tensei', () => { const e = new Error('délai'); e.name = 'TimeoutError'; throw e; }, /délai dépassé/],
  ];
  for (const [theme, bad, re] of cases) {
    const order = syncOrder(theme);
    const f = wallFetch({ [order[1]]: bad });
    const r = await wp(['sync', theme], { fetch: f.fetch, sleep: noSleep });
    assert.equal(r.ok, true, theme);
    assert.deepEqual(r.downloaded, [order[0]], theme);
    assert.deepEqual(r.failed, [], theme);
    assert.match(r.stopped, re, theme);
    for (const later of order.slice(2)) {
      assert.equal(f.calls.some((c) => c.url === `${API}/w/${later}`), false, `${theme} : ${later} non demandé`);
    }
    assert.equal(fs.existsSync(progressOf(theme)), false, `${theme} : progression retirée`);
  }
});

test('sync : 404 sur chaque ID -> failed, sans arrêt ; thème par défaut = thème actif', async () => {
  writeRawConfig({ theme: 'frieren' });
  const f = fakeFetch(async (url) => {
    if (!url.startsWith(`${API}/w/`)) return imgRes(JPEG);
    return jsonRes({ error: 'Not found' }, 404);
  });
  const r = await wp(['sync'], { fetch: f.fetch, sleep: noSleep });
  const n = curatedIds('frieren').length;
  assert.equal(r.theme, 'frieren');
  assert.equal(r.total, n);
  assert.deepEqual(r.downloaded, []);
  assert.equal(r.failed.length, n);
  assert.match(r.failed[0].reason, /introuvable/);
  assert.equal(r.stopped, null);
  assert.equal(f.calls.length, n, 'une requête par ID, aucune image');
});

test('sync : tous les fonds curés présents -> aucune requête, aucune progression écrite', async () => {
  seedFiles('naruto', curatedIds('naruto'));
  const f = wallFetch();
  const r = await wp(['sync', 'naruto'], { fetch: f.fetch, sleep: noSleep });
  assert.deepEqual(r, {
    ok: true,
    theme: 'naruto',
    defaultId: 'bundled',
    defaultApplied: false,
    total: curatedIds('naruto').length,
    downloaded: [],
    skipped: curatedIds('naruto'),
    failed: [],
    stopped: null,
  });
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(progressOf('naruto')), false);
});

test('sync : espacement de 1 s entre toutes les requêtes (API et images), une seule à la fois', async () => {
  delete process.env.DOJO_WALLHAVEN_MIN_INTERVAL_MS;
  const sleeps = [];
  const f = wallFetch();
  const n = curatedIds('naruto').length;
  const r = await wp(['sync', 'naruto'], { fetch: f.fetch, now: () => 0, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(r.downloaded.length, n);
  assert.equal(f.calls.length, 2 * n);
  assert.deepEqual(sleeps, Array(2 * n - 1).fill(1000));
  assert.equal(f.maxInFlight(), 1);
});

test('sync : un second sync pendant qu un sync vit renvoie alreadyRunning, sans requête ni changement du verrou', async () => {
  fs.mkdirSync(bgDir('naruto'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(progressOf('naruto'), JSON.stringify({ pid: process.pid, total: 5, done: 1, current: 'mlq73y' }), { mode: 0o600 });
  const f = wallFetch();
  const r = await wp(['sync', 'naruto'], { fetch: f.fetch, sleep: noSleep });
  assert.deepEqual(r, { ok: true, theme: 'naruto', alreadyRunning: true });
  assert.equal(f.calls.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(progressOf('naruto'), 'utf8')).current, 'mlq73y', 'verrou intact');
  assert.deepEqual(await wp(['progress', 'naruto']), { ok: true, theme: 'naruto', running: true, total: 5, done: 1 });
});

test('sync : verrou périmé (fichier de plus de 90 s, ou pid mort) repris', async () => {
  const stale = [
    { pid: process.pid, ageMs: 200 * 1000 },
    { pid: 2147483646, ageMs: 0 },
  ];
  for (const { pid, ageMs } of stale) {
    fs.mkdirSync(bgDir('naruto'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(progressOf('naruto'), JSON.stringify({ pid, total: 5, done: 0, current: null }), { mode: 0o600 });
    if (ageMs > 0) {
      const old = new Date(Date.now() - ageMs);
      fs.utimesSync(progressOf('naruto'), old, old);
    }
    const f = wallFetch();
    const r = await wp(['sync', 'naruto'], { fetch: f.fetch, sleep: noSleep });
    assert.equal(r.downloaded.length, curatedIds('naruto').length, `reprise (pid ${pid}, âge ${ageMs} ms)`);
    assert.equal(fs.existsSync(progressOf('naruto')), false);
    fs.rmSync(bgDir('naruto'), { recursive: true, force: true });
  }
});

test('progress : absent -> rien en cours ; récent -> running ; plus de 90 s -> pas running, valeurs gardées ; thème inconnu refusé', async () => {
  assert.deepEqual(await wp(['progress', 'naruto']), { ok: true, theme: 'naruto', running: false, total: 0, done: 0 });
  fs.mkdirSync(bgDir('naruto'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(progressOf('naruto'), JSON.stringify({ pid: 1, total: 7, done: 3, current: 'x' }), { mode: 0o600 });
  const old = new Date(Date.now() - 200 * 1000);
  fs.utimesSync(progressOf('naruto'), old, old);
  assert.deepEqual(await wp(['progress', 'naruto']), { ok: true, theme: 'naruto', running: false, total: 7, done: 3 });
  const now = new Date();
  fs.utimesSync(progressOf('naruto'), now, now);
  assert.deepEqual(await wp(['progress', 'naruto']), { ok: true, theme: 'naruto', running: true, total: 7, done: 3 });
  await assert.rejects(wp(['progress', 'zzz']), /thème inconnu/);
});

// ── Schéma des theme.json (galeries curées finales) ──────────────────────
test('theme.json : ids sans doublon, format Wallhaven (bundled seulement pour naruto), default présent dans ids', () => {
  const themes = fs.readdirSync(path.join(REPO, 'src', 'themes')).sort();
  assert.equal(themes.length, 8);
  for (const theme of themes) {
    const w = curatedFile(theme);
    assert.equal(new Set(w.ids).size, w.ids.length, `${theme} : doublon dans ids`);
    for (const id of w.ids) {
      if (id === 'bundled') {
        assert.equal(theme, 'naruto', 'bundled réservé à naruto');
        continue;
      }
      assert.match(id, /^[a-z0-9]{4,10}$/, `${theme} : identifiant ${id}`);
    }
    assert.ok(w.ids.includes(w.default), `${theme} : default absent de ids`);
  }
  assert.equal(curatedFile('naruto').default, 'bundled');
});

// ── Verrous (sync et index.json), source des fonds, option autoDownload ───────────────────────────
const DEAD_PID = 2147483646; // pid qui ne correspond à aucun processus vivant
const indexFileOf = () => path.join(bgRoot(), 'index.json');
const indexLockOf = () => `${indexFileOf()}.lock`;
const readIndexFile = () => JSON.parse(fs.readFileSync(indexFileOf(), 'utf8'));
const ageFile = (file, ms) => { const old = new Date(Date.now() - ms); fs.utimesSync(file, old, old); };
const dlPlan = { '8o99v2': 'jpg', mlq73y: 'png' };
const dlFetch = () => fakeFetch(async (url) => {
  if (url.startsWith(`${API}/w/`)) {
    const id = url.split('/w/')[1];
    return jsonRes(apiData(id, { path: `https://w.wallhaven.cc/full/ab/wallhaven-${id}.${dlPlan[id] || 'jpg'}` }));
  }
  return imgRes(url.endsWith('.png') ? PNG : JPEG, { 'content-length': '120' });
});

test('sync : reprise d un verrou périmé, le perdant reçoit ENOENT (rename déjà fait par un autre processus) : renonce sans toucher au verrou du gagnant', async () => {
  fs.mkdirSync(bgDir('naruto'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(progressOf('naruto'), JSON.stringify({ pid: DEAD_PID, total: 5, done: 0, current: null }), { mode: 0o600 });
  ageFile(progressOf('naruto'), 200 * 1000);
  const lock = progressOf('naruto');
  const realRename = fs.renameSync;
  let raced = false;
  // Le gagnant prend le verrou juste avant nous : son rename réussit, il crée son verrou frais, et notre rename voit ENOENT.
  fs.renameSync = (from, to) => {
    if (from === lock && !raced) {
      raced = true;
      realRename(from, `${from}.stale-winner`);
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, total: 5, done: 0, current: 'winner' }), { mode: 0o600, flag: 'wx' });
      throw Object.assign(new Error('ENOENT simulé'), { code: 'ENOENT' });
    }
    return realRename(from, to);
  };
  const f = wallFetch();
  let r;
  try {
    r = await wp(['sync', 'naruto'], { fetch: f.fetch, sleep: noSleep });
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(raced, true, 'la course a bien eu lieu');
  assert.deepEqual(r, { ok: true, theme: 'naruto', alreadyRunning: true });
  assert.equal(f.calls.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).current, 'winner', 'verrou du gagnant intact');
});

test('sync : verrou périmé remplacé entre la lecture et le rename : le verrou vivant du gagnant est remis en place, pas supprimé', async () => {
  fs.mkdirSync(bgDir('naruto'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(progressOf('naruto'), JSON.stringify({ pid: DEAD_PID, total: 5, done: 0, current: null }), { mode: 0o600 });
  ageFile(progressOf('naruto'), 200 * 1000);
  const lock = progressOf('naruto');
  const realRename = fs.renameSync;
  let raced = false;
  // Entre notre lecture (verrou périmé) et notre rename, le gagnant reprend le verrou et crée le sien (frais, pid vivant).
  fs.renameSync = (from, to) => {
    if (from === lock && !raced) {
      raced = true;
      realRename(from, `${from}.stale-winner`);
      fs.rmSync(`${from}.stale-winner`, { force: true });
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, total: 5, done: 0, current: 'winner' }), { mode: 0o600, flag: 'wx' });
    }
    return realRename(from, to);
  };
  const f = wallFetch();
  let r;
  try {
    r = await wp(['sync', 'naruto'], { fetch: f.fetch, sleep: noSleep });
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(raced, true, 'la course a bien eu lieu');
  assert.deepEqual(r, { ok: true, theme: 'naruto', alreadyRunning: true }, 'nous ne prenons pas un verrou vivant');
  assert.equal(f.calls.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).current, 'winner', 'verrou du gagnant remis en place');
  assert.deepEqual(fs.readdirSync(bgDir('naruto')).filter((n) => n.startsWith('.sync-progress.json')).sort(), ['.sync-progress.json'], 'pas de .stale résiduel');
});

test('sync : deux processus reprennent le même verrou périmé en même temps : un seul sync, chaque fond téléchargé une fois', async () => {
  const base = outsideDir(); // thème factice à 3 fonds, pour un test multi-processus rapide
  fs.mkdirSync(path.join(base, 'themes', 'race'), { recursive: true });
  fs.writeFileSync(path.join(base, 'themes', 'race', 'theme.json'), JSON.stringify({
    id: 'race', name: 'Race', wallpapers: { provider: 'wallhaven', ids: ['aaaa111', 'bbbb222', 'cccc333'], default: null, query: 'race' },
  }));
  writeRawConfig({ theme: 'race' });
  fs.mkdirSync(bgDir('race'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(progressOf('race'), JSON.stringify({ pid: DEAD_PID, total: 3, done: 0, current: null }), { mode: 0o600 });
  ageFile(progressOf('race'), 200 * 1000);
  // Barrière par fichiers : chaque processus signale son départ avant d'appeler sync, et ses requêtes attendent le départ
  // de l'autre. Le premier à prendre le verrou le garde donc pendant toute la tentative du second (pas de course au chronomètre).
  const script = `
    const fs = require('fs');
    const setup = require(${JSON.stringify(SETUP)});
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    fs.writeFileSync(process.env.RACE_SELF, '');
    const barrier = async () => { for (let i = 0; i < 1000 && !fs.existsSync(process.env.RACE_OTHER); i += 1) await wait(5); };
    const fetch = async (url) => {
      await barrier();
      await wait(60);
      if (url.includes('/api/v1/w/')) {
        const id = url.split('/w/')[1];
        const data = { id, url: 'https://wallhaven.cc/w/' + id, purity: 'sfw', resolution: '1920x1080',
          path: 'https://w.wallhaven.cc/full/ab/wallhaven-' + id + '.jpg' };
        return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(120, 7)]), { status: 200 });
    };
    setup.main(['wallpapers', 'sync', 'race'], { fetch }).then((r) => process.stdout.write(JSON.stringify(r)));
  `;
  const mark = (name) => path.join(base, `started-${name}`);
  const runChild = (self, other) => new Promise((resolve, reject) => {
    const env = {
      ...process.env, DOJO_THEMES_DIR: base, DOJO_WALLHAVEN_MIN_INTERVAL_MS: '0', RACE_SELF: mark(self), RACE_OTHER: mark(other),
    };
    const child = spawn(process.execPath, ['-e', script], { env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`processus enfant en échec (${code}) : ${err}`));
      else resolve(JSON.parse(out));
    });
  });
  const [a, b] = await Promise.all([runChild('a', 'b'), runChild('b', 'a')]);
  const results = [a, b];
  assert.equal(results.filter((x) => x.alreadyRunning === true).length, 1, 'un seul processus a pris le verrou');
  assert.equal(results.reduce((n, x) => n + (x.downloaded || []).length, 0), 3, 'chaque fond téléchargé une seule fois');
  assert.deepEqual(fs.readdirSync(bgDir('race')).filter((n) => n.startsWith('wallhaven-')).sort(),
    ['wallhaven-aaaa111.jpg', 'wallhaven-bbbb222.jpg', 'wallhaven-cccc333.jpg']);
  assert.equal(fs.existsSync(progressOf('race')), false, 'verrou libéré');
});

test('download : deux téléchargements concurrents : index.json contient les deux entrées, verrou libéré', async () => {
  const f = dlFetch();
  await Promise.all([wp(['download', '8o99v2', 'naruto'], { fetch: f.fetch }), wp(['download', 'mlq73y', 'naruto'], { fetch: f.fetch })]);
  assert.deepEqual(readIndexFile().map((e) => e.id).sort(), ['8o99v2', 'mlq73y']);
  assert.equal(fs.existsSync(indexLockOf()), false);
  assert.deepEqual(fs.readdirSync(bgRoot()).sort(), ['index.json', 'naruto'], 'aucun verrou ni fichier temporaire résiduel');
});

test('download : verrou d index tenu par un autre processus : attend, relit l index sous verrou (son entrée n est pas perdue)', async () => {
  fs.mkdirSync(bgRoot(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(indexLockOf(), '99999\n', { mode: 0o600 });
  const f = dlFetch();
  const pending = wp(['download', '8o99v2', 'naruto'], { fetch: f.fetch });
  // L'autre processus écrit son entrée, puis libère le verrou avant la fin de nos essais.
  await new Promise((resolve) => setTimeout(resolve, 120));
  fs.writeFileSync(indexFileOf(), JSON.stringify([{ id: 'xxxx', theme: 'frieren', source: null, resolution: null, file: 'x', downloadedAt: '2026-10-02T00:00:00.000Z' }]), { mode: 0o600 });
  fs.rmSync(indexLockOf(), { force: true });
  await pending;
  assert.deepEqual(readIndexFile().map((e) => e.id).sort(), ['8o99v2', 'xxxx']);
  assert.equal(fs.existsSync(indexLockOf()), false);
});

test('download : verrou d index frais jamais libéré : erreur claire après 20 essais, verrou d autrui intact, aucune entrée', async () => {
  fs.mkdirSync(bgRoot(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(indexLockOf(), '99999\n', { mode: 0o600 });
  const f = dlFetch();
  await assert.rejects(wp(['download', '8o99v2', 'naruto'], { fetch: f.fetch }), /occupé par un autre téléchargement/);
  assert.equal(fs.readFileSync(indexLockOf(), 'utf8'), '99999\n', 'verrou d autrui intact');
  assert.equal(fs.existsSync(indexFileOf()), false, 'aucune entrée écrite');
});

test('download : verrou d index périmé (plus de 10 s) repris par rename, créé en wx 0600, puis libéré', async () => {
  fs.mkdirSync(bgRoot(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(indexLockOf(), '99999\n', { mode: 0o600 });
  ageFile(indexLockOf(), 20 * 1000);
  const realWrite = fs.writeFileSync;
  const lockWrites = [];
  fs.writeFileSync = (file, data, opts) => {
    if (String(file) === indexLockOf()) lockWrites.push(opts);
    return realWrite(file, data, opts);
  };
  let r;
  try {
    r = await wp(['download', '8o99v2', 'naruto'], { fetch: dlFetch().fetch });
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.equal(r.ok, true);
  assert.ok(lockWrites.length >= 1);
  for (const o of lockWrites) assert.deepEqual(o, { mode: 0o600, flag: 'wx' });
  assert.deepEqual(readIndexFile().map((e) => e.id), ['8o99v2']);
  assert.deepEqual(fs.readdirSync(bgRoot()).sort(), ['index.json', 'naruto'], 'pas de .stale résiduel');
});

test('source : seules les pages https de wallhaven.cc ou www.wallhaven.cc sont gardées, sinon null (download, index, search, local)', async () => {
  const urls = {
    '8o99v2': 'http://wallhaven.cc/w/8o99v2',
    mlq73y: 'https://evil.example.com/w/mlq73y',
    dpg97o: 'https://wallhaven.cc.evil.example/w/dpg97o',
    gw5ypd: 'https://www.wallhaven.cc/w/gw5ypd',
  };
  const f = fakeFetch(async (url) => {
    if (url.startsWith(`${API}/w/`)) {
      const id = url.split('/w/')[1];
      return jsonRes(apiData(id, { url: urls[id] }));
    }
    return imgRes(JPEG);
  });
  const bad = await wp(['download', '8o99v2', 'naruto'], { fetch: f.fetch });
  assert.equal(bad.source, null, 'http refusé');
  assert.equal(bad.file.endsWith('wallhaven-8o99v2.jpg'), true, 'le fond reste téléchargé');
  assert.equal((await wp(['download', 'mlq73y', 'naruto'], { fetch: f.fetch })).source, null, 'hôte étranger refusé');
  assert.equal((await wp(['download', 'dpg97o', 'naruto'], { fetch: f.fetch })).source, null, 'sous-domaine piégé refusé');
  assert.equal((await wp(['download', 'gw5ypd', 'naruto'], { fetch: f.fetch })).source, 'https://www.wallhaven.cc/w/gw5ypd');
  assert.deepEqual(readIndexFile().map((e) => [e.id, e.source]).sort(), [
    ['8o99v2', null], ['dpg97o', null], ['gw5ypd', 'https://www.wallhaven.cc/w/gw5ypd'], ['mlq73y', null],
  ]);

  const searchBody = { data: [apiData('abc123', { url: 'http://wallhaven.cc/w/abc123' }).data, apiData('def456').data], meta: { last_page: 1 } };
  const s = await wp(['search', 'naruto'], { fetch: fakeFetch(async () => jsonRes(searchBody)).fetch });
  assert.deepEqual(s.wallpapers.map((w) => [w.id, w.source]), [['abc123', null], ['def456', 'https://wallhaven.cc/w/def456']]);

  // index.json ancien (écrit avant la validation) : l'entrée invalide ressort à null en local.
  writeRawConfig({});
  fs.writeFileSync(indexFileOf(), JSON.stringify([
    { id: 'aaaa', theme: 'naruto', source: 'https://evil.example.com/w/aaaa', resolution: '1x1', file: 'x', downloadedAt: 'd' },
  ]), { mode: 0o600 });
  const dir = bgDir('naruto');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'wallhaven-aaaa.jpg'), JPEG, { mode: 0o600 });
  const local = await wp(['local', 'naruto']);
  assert.equal(local.wallpapers.find((w) => w.id === 'aaaa').source, null);
});

// autoDownload : config.json, wallpapers: { autoDownload } (défaut true). Ne pas confondre avec theme.json.
test('autoDownload : write-config accepte true et false (fusion profonde), refuse le reste avec un message clair, sans rien écrire', async () => {
  const r = await setup.main(['write-config', JSON.stringify({ wallpapers: { autoDownload: false } })]);
  assert.equal(r.ok, true);
  assert.deepEqual(readConfig().wallpapers, { autoDownload: false });
  await setup.main(['write-config', JSON.stringify({ theme: 'frieren' })]);
  assert.deepEqual(readConfig().wallpapers, { autoDownload: false }, 'clé conservée par la fusion');
  const before = fs.readFileSync(configFile(), 'utf8');
  await assert.rejects(setup.main(['write-config', JSON.stringify({ wallpapers: { autoDownload: 'no' } })]), /wallpapers\.autoDownload doit être un booléen/);
  await assert.rejects(setup.main(['write-config', JSON.stringify({ wallpapers: { autoDownload: 0 } })]), /wallpapers\.autoDownload doit être un booléen/);
  await assert.rejects(setup.main(['write-config', JSON.stringify({ wallpapers: { autoDownload: null } })]), /wallpapers\.autoDownload doit être un booléen/);
  await assert.rejects(setup.main(['write-config', JSON.stringify({ wallpapers: 'oui' })]), /wallpapers doit être un objet/);
  assert.equal(fs.readFileSync(configFile(), 'utf8'), before, 'config.json inchangé après refus');
  await setup.main(['write-config', JSON.stringify({ wallpapers: { autoDownload: true } })]);
  assert.equal(readConfig().wallpapers.autoDownload, true);
});

test('autoDownload : themes renvoie autoDownload (true par défaut, false si désactivé)', async () => {
  assert.equal((await setup.main(['themes'])).autoDownload, true, 'absent : true');
  writeRawConfig({ wallpapers: { autoDownload: false } });
  assert.equal((await setup.main(['themes'])).autoDownload, false);
});

test('autoDownload : set-theme renvoie needsSync false si désactivé, vrai sinon (fonds curés manquants)', async () => {
  writeRawConfig({ wallpapers: { autoDownload: false } });
  assert.deepEqual(await setup.main(['set-theme', 'frieren']), { ok: true, theme: 'frieren', background: null, hasDownloads: false, needsSync: false });
  await setup.main(['write-config', JSON.stringify({ wallpapers: { autoDownload: true } })]);
  assert.equal((await setup.main(['set-theme', 'frieren'])).needsSync, true);
});

test('autoDownload : wallpapers sync sans thème ne fait rien si désactivé (retour skipped, aucune requête, aucun verrou)', async () => {
  writeRawConfig({ theme: 'naruto', wallpapers: { autoDownload: false } });
  const f = wallFetch();
  const r = await wp(['sync'], { fetch: f.fetch, sleep: noSleep });
  assert.deepEqual(r, { ok: true, theme: 'naruto', skipped: true, reason: 'autoDownload désactivé' });
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(progressOf('naruto')), false);
});

test('autoDownload : sync sans thème repart quand c est activé ; sync <thème> explicite marche toujours quand c est désactivé', async () => {
  writeRawConfig({ theme: 'frieren', wallpapers: { autoDownload: false } });
  const manual = await wp(['sync', 'frieren'], { fetch: wallFetch().fetch, sleep: noSleep });
  assert.equal(manual.theme, 'frieren');
  assert.equal(manual.ok, true);
  assert.equal(manual.downloaded.length, curatedIds('frieren').length, 'action manuelle : téléchargé');
  fs.rmSync(bgDir('frieren'), { recursive: true, force: true });
  writeRawConfig({ theme: 'frieren', wallpapers: { autoDownload: true } });
  const auto = await wp(['sync'], { fetch: wallFetch().fetch, sleep: noSleep });
  assert.equal(auto.theme, 'frieren');
  assert.ok(Array.isArray(auto.skipped), 'sync sans thème : résultat normal (skipped = ids déjà présents), pas le retour de désactivation');
  assert.equal(auto.downloaded.length, curatedIds('frieren').length);
});

test('autoDownload : USAGE mentionne la règle du sync sans thème', async () => {
  const u = (await setup.main([])).usage.join('\n');
  assert.match(u, /wallpapers sync \[theme\].*autoDownload/);
});

// ── Intégration réseau réelle (sautée sauf DOJO_NET_TESTS=1) ─────────────
test('intégration réseau Wallhaven : list frieren puis download d’un ID curé (magic bytes)', { skip: process.env.DOJO_NET_TESTS !== '1' }, async () => {
  globalThis.fetch = REAL_FETCH;
  delete process.env.DOJO_WALLHAVEN_MIN_INTERVAL_MS;
  const listed = await setup.main(['wallpapers', 'list', 'frieren']);
  assert.equal(listed.ok, true);
  assert.ok(listed.wallpapers.length >= 1, 'au moins un fond SFW');
  const dl = await setup.main(['wallpapers', 'download', listed.wallpapers[0].id, 'frieren']);
  const buf = fs.readFileSync(dl.file);
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf.subarray(0, 8).equals(PNG.subarray(0, 8));
  const isWebp = buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
  assert.ok(isJpeg || isPng || isWebp, 'signature JPEG, PNG ou WEBP');
  assert.equal(dl.theme, 'frieren');
});
