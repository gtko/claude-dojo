// Tests de l'agent local (src/agent-mac.js) : confinement de /themes et /custom-bg, en-têtes (nosniff, CSP sandbox),
// protection Host / Origin / Sec-Fetch-Site, paramètre id de /theme.
// L'agent tourne comme dans ~/.config/claude-dojo : copie du runtime dans un HOME temporaire (config.json, backgrounds/,
// cache/ sont à côté de l'agent), sur un port libre (DOJO_PORT). Arrêt par PID dans after : jamais pkill ni killall.
'use strict';
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SRC = path.join(REPO, 'src');

let home, runtime, bgDir, outsideJpg, child, PORT;
const VALID_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('valid-bg')]);
const FRIEREN_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('frieren-bg')]);
const waitFor = async (fn, ms = 8000) => {   // attend qu'une condition devienne vraie (l'agent échantillonne toutes les 2 s)
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

// ── Helpers ──────────────────────────────────────────────────────────────
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function get(p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: p, method: 'GET',
      headers: { Host: `127.0.0.1:${PORT}`, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
const json = (r) => JSON.parse(r.body.toString('utf8'));

const setConfig = (obj) => fs.writeFileSync(path.join(runtime, 'config.json'), JSON.stringify(obj));

function waitExit(proc, ms) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    proc.once('exit', () => { clearTimeout(t); resolve(true); });
  });
}

async function waitReady(proc, ms = 20000) {
  let exited = false;
  proc.once('exit', () => { exited = true; });
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (exited) throw new Error('agent arrêté avant d être prêt');
    try {
      const r = await get('/theme');
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('agent non prêt après ' + ms + ' ms');
}

// ── Mise en place : une fois pour tout le fichier ───────────────────────
before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-agent-test-'));
  runtime = path.join(home, '.config', 'claude-dojo');
  bgDir = path.join(runtime, 'backgrounds');
  fs.mkdirSync(bgDir, { recursive: true });
  fs.copyFileSync(path.join(SRC, 'agent-mac.js'), path.join(runtime, 'agent-mac.js'));
  fs.copyFileSync(path.join(SRC, 'agent-core.js'), path.join(runtime, 'agent-core.js'));
  fs.copyFileSync(path.join(SRC, 'collector.js'), path.join(runtime, 'collector.js'));
  fs.cpSync(path.join(SRC, 'wallpaper'), path.join(runtime, 'wallpaper'), { recursive: true });
  fs.cpSync(path.join(SRC, 'themes'), path.join(runtime, 'themes'), { recursive: true });
  // fichier hors liste blanche, à côté des fichiers d'un thème
  fs.writeFileSync(path.join(runtime, 'themes', 'naruto', 'secret.json'), 'SECRET');

  // fonds : une image valide, un SVG, une page HTML, un lien vers l'extérieur ; une image hors de backgrounds/
  fs.writeFileSync(path.join(bgDir, 'valid.jpg'), VALID_JPEG);
  fs.writeFileSync(path.join(bgDir, 'fond.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  fs.writeFileSync(path.join(bgDir, 'page.html'), '<!doctype html><p>page</p>');
  outsideJpg = path.join(home, 'dehors.jpg');
  fs.writeFileSync(outsideJpg, VALID_JPEG);
  fs.symlinkSync(outsideJpg, path.join(bgDir, 'lien.jpg'));

  // sous-dossiers de thème : backgrounds/frieren/ (fond valide, SVG, deux niveaux, fichier lien, fichier lien interne)
  const frieren = path.join(bgDir, 'frieren');
  fs.mkdirSync(path.join(frieren, 'deux'), { recursive: true });
  fs.writeFileSync(path.join(frieren, 'fond.jpg'), FRIEREN_JPEG);
  fs.writeFileSync(path.join(frieren, 'fond.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  fs.writeFileSync(path.join(frieren, 'deux', 'profond.jpg'), FRIEREN_JPEG);
  fs.symlinkSync(outsideJpg, path.join(frieren, 'lien.jpg'));
  fs.symlinkSync(path.join(bgDir, 'valid.jpg'), path.join(frieren, 'lien-interne.jpg'));
  // même contenu et même mtime que valid.jpg, autre chemin : seule la clé de version peut les distinguer
  const sameDate = path.join(frieren, 'meme-date.jpg');
  fs.writeFileSync(sameDate, VALID_JPEG);
  const ref = fs.statSync(path.join(bgDir, 'valid.jpg'));
  fs.utimesSync(sameDate, new Date(Math.floor(ref.atimeMs)), new Date(Math.floor(ref.mtimeMs)));
  // dossier de thème hors liste (majuscule) et sous-dossier lien vers l'extérieur
  fs.mkdirSync(path.join(bgDir, 'Fond_Perso'));   // nom hors [a-z0-9-] (macOS est insensible à la casse : pas de doublon de frieren)
  fs.writeFileSync(path.join(bgDir, 'Fond_Perso', 'x.jpg'), VALID_JPEG);
  const dehors = path.join(home, 'dehors-dossier');
  fs.mkdirSync(dehors);
  fs.writeFileSync(path.join(dehors, 'x.jpg'), VALID_JPEG);
  fs.symlinkSync(dehors, path.join(bgDir, 'lien-dossier'));
  setConfig({ theme: 'naruto', background: null });

  PORT = await freePort();
  child = spawn(process.execPath, [path.join(runtime, 'agent-mac.js')], {
    // USERPROFILE aussi : sous Windows, os.homedir() (lu par l'agent) ne regarde que USERPROFILE.
    env: { ...process.env, HOME: home, USERPROFILE: home, DOJO_PORT: String(PORT) },
    stdio: 'ignore',
  });
  await waitReady(child);
});

// Arrêt par PID : SIGTERM (l'agent arrête ses enfants), SIGKILL en filet de sécurité.
after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    process.kill(child.pid, 'SIGTERM');
    if (!(await waitExit(child, 3000))) process.kill(child.pid, 'SIGKILL');
  }
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

// ── Confinement de /themes ───────────────────────────────────────────────
test('/themes : %2e%2e, fichier hors liste blanche, %00 et traversée encodée -> 404', async () => {
  const attempts = [
    '/themes/%2e%2e/%2e%2e/config.json',
    '/themes/naruto/secret.json',
    '/themes/naruto/background.jpg%00',
    '/themes/%00/background.jpg',
    '/themes/..%2f..%2fconfig.json',
    '/themes/naruto/..%2f..%2fconfig.json',
  ];
  for (const p of attempts) {
    const r = await get(p);
    assert.equal(r.status, 404, `${p} -> ${r.status}`);
    assert.doesNotMatch(r.body.toString('utf8'), /SECRET|claude-dojo|config/, `${p} ne fuit rien`);
  }
});

test('/themes : fichiers de la liste blanche servis avec nosniff et CSP sandbox', async () => {
  const theme = await get('/themes/naruto/theme.json');
  assert.equal(theme.status, 200);
  assert.equal(theme.headers['content-type'], 'application/json', 'type JSON');
  assert.equal(theme.headers['x-content-type-options'], 'nosniff');
  assert.equal(theme.headers['content-security-policy'], 'sandbox');

  const bg = await get('/themes/naruto/background.jpg');
  assert.equal(bg.status, 200);
  assert.equal(bg.headers['content-type'], 'image/jpeg');
  assert.equal(bg.headers['content-security-policy'], 'sandbox');
});

test('X-Content-Type-Options: nosniff sur toutes les réponses (JSON, 404, page)', async () => {
  for (const p of ['/stats', '/theme', '/nexiste-pas', '/%00', '/']) {
    const r = await get(p);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
  }
  const page = await get('/');
  assert.equal(page.status, 200, 'la page du fond reste servie');
});

test('route par défaut : %00 -> 404 (et non 500), traversée ..%2f refusée', async () => {
  const nul = await get('/%00');
  assert.equal(nul.status, 404);
  const trav = await get('/..%2fconfig.json');
  assert.equal(trav.status, 404);
  assert.doesNotMatch(trav.body.toString('utf8'), /claude-dojo|config/);
});

// ── /custom-bg ───────────────────────────────────────────────────────────
test('/custom-bg : symlink sortant, chemin absolu extérieur, .svg, .html -> 404', async () => {
  const cases = {
    'lien symbolique sortant': path.join(bgDir, 'lien.jpg'),
    'chemin absolu extérieur': outsideJpg,
    'svg': path.join(bgDir, 'fond.svg'),
    'html': path.join(bgDir, 'page.html'),
  };
  for (const [label, file] of Object.entries(cases)) {
    setConfig({ theme: 'naruto', background: file });
    const r = await get('/custom-bg');
    assert.equal(r.status, 404, label);
    assert.equal(json(await get('/theme')).background, '/themes/naruto/background.jpg', `${label} : /theme garde le fond du thème`);
  }
});

test('/custom-bg : .jpg valide -> 200 image/jpeg, nosniff et CSP sandbox ; /theme pointe dessus', async () => {
  setConfig({ theme: 'naruto', background: path.join(bgDir, 'valid.jpg') });
  const r = await get('/custom-bg');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'image/jpeg');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['content-security-policy'], 'sandbox');
  assert.deepEqual(r.body, VALID_JPEG);
  assert.match(json(await get('/theme')).background, /^\/custom-bg\?v=\d+-[0-9a-f]{8}$/);
});

test('/custom-bg : fichier valide dans backgrounds/<theme>/ -> 200 image/jpeg, nosniff et CSP sandbox', async () => {
  setConfig({ theme: 'naruto', background: path.join(bgDir, 'frieren', 'fond.jpg') });
  const r = await get('/custom-bg');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'image/jpeg');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['content-security-policy'], 'sandbox');
  assert.deepEqual(r.body, FRIEREN_JPEG);
  assert.match(json(await get('/theme')).background, /^\/custom-bg\?v=\d+-[0-9a-f]{8}$/);
});

test('/custom-bg : sous-dossier ou fichier lien, deux niveaux, svg, dossier hors liste, .. -> 404', async () => {
  const cases = {
    'sous-dossier lien vers l\'extérieur': path.join(bgDir, 'lien-dossier', 'x.jpg'),
    'fichier lien vers l\'extérieur dans sous-dossier': path.join(bgDir, 'frieren', 'lien.jpg'),
    'fichier lien interne dans sous-dossier': path.join(bgDir, 'frieren', 'lien-interne.jpg'),
    'deux niveaux': path.join(bgDir, 'frieren', 'deux', 'profond.jpg'),
    'svg dans sous-dossier': path.join(bgDir, 'frieren', 'fond.svg'),
    'dossier hors [a-z0-9-]': path.join(bgDir, 'Fond_Perso', 'x.jpg'),
    '.. normalisé vers l\'extérieur': `${bgDir}/frieren/../../../../dehors.jpg`,
    '.. même normalisé à l\'intérieur (aucun .. accepté)': `${bgDir}/frieren/../valid.jpg`,
  };
  for (const [label, file] of Object.entries(cases)) {
    setConfig({ theme: 'naruto', background: file });
    const r = await get('/custom-bg');
    assert.equal(r.status, 404, label);
    assert.equal(json(await get('/theme')).background, '/themes/naruto/background.jpg', `${label} : /theme garde le fond du thème`);
  }
});

test('changement de config.background : background et themeKey changent, aussi à même mtime (/theme et /stats)', async () => {
  setConfig({ theme: 'naruto', background: path.join(bgDir, 'valid.jpg') });
  const a = json(await get('/theme'));
  setConfig({ theme: 'naruto', background: path.join(bgDir, 'frieren', 'meme-date.jpg') });
  const b = json(await get('/theme'));
  assert.notEqual(b.background, a.background, 'background change');
  assert.notEqual(b.themeKey, a.themeKey, 'themeKey change');
  // la page relit /stats (themeKey) toutes les 2 s : la nouvelle clé doit y arriver
  assert.equal(await waitFor(async () => json(await get('/stats')).themeKey === b.themeKey), true, '/stats porte la nouvelle themeKey');
  // retour au fond du thème : la clé change encore
  setConfig({ theme: 'naruto', background: null });
  const c = json(await get('/theme'));
  assert.equal(c.background, '/themes/naruto/background.jpg');
  assert.notEqual(c.themeKey, b.themeKey);
});

// ── Host / Origin / Sec-Fetch-Site ───────────────────────────────────────
test('Host, Origin ou Sec-Fetch-Site étrangers -> 403 sur /theme, /themes/naruto/theme.json, /custom-bg', async () => {
  setConfig({ theme: 'naruto', background: path.join(bgDir, 'valid.jpg') });
  const foreign = [
    { Host: 'evil.example' },
    { Origin: 'http://evil.example' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ];
  for (const p of ['/theme', '/themes/naruto/theme.json', '/custom-bg']) {
    for (const h of foreign) {
      const r = await get(p, h);
      assert.equal(r.status, 403, `${p} avec ${JSON.stringify(h)}`);
    }
  }
  // contrôle : la même requête avec l'origine de l'agent passe
  const own = await get('/theme', { Origin: `http://localhost:${PORT}`, 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(own.status, 200);
});

// ── /theme?id= ───────────────────────────────────────────────────────────
test('/theme?id=../x -> thème naruto (identifiant invalide ignoré)', async () => {
  const r = await get('/theme?id=' + encodeURIComponent('../x'));
  assert.equal(r.status, 200);
  assert.equal(json(r).id, 'naruto');
});

test('/%00 et chemins mal encodés ne provoquent jamais 500', async () => {
  for (const p of ['/%00', '/%00%00.html', '/a%00b']) {
    const r = await get(p);
    assert.notEqual(r.status, 500, p);
    assert.equal(r.status, 404, p);
  }
});
