// Capture les pages de démo du fond d'écran Dojo (src/wallpaper/index.html#demo) avec un agent simulé.
//
// Usage : node scripts/screenshots.cjs <dossier> [largeur=2560] [hauteur=1600] [DPR=1.25]
//   ex. node scripts/screenshots.cjs /tmp/dojo-shots 2560 1600 1.25
//   -> <dossier>/overview.webp (3200 x 2000 à DPR 1,25) et <dossier>/dojo.webp
//      (sans cwebp, les PNG sont gardés ; KEEP_PNG=1 garde aussi les PNG)
//
// Thèmes (aperçu #demo:<id>, données et fond lus dans src/themes/<id>/) :
//   node scripts/screenshots.cjs --themes        tous les thèmes
//   node scripts/screenshots.cjs --theme <id>    un seul thème
//   -> docs/screenshots/themes/<id>.webp (1280 px de large, page entière) pour chaque thème,
//      src/themes/<id>/thumbnail.jpg (480 x 300, plein cadre, tous les thèmes),
//      et avec --themes seulement : docs/screenshots/themes.webp (planche 4 colonnes, 1920 px).
//   Largeur, hauteur et DPR facultatifs après l'option (mêmes défauts que ci-dessus).
//
// Variables d'environnement facultatives :
//   PLAYWRIGHT_CORE  chemin du paquet playwright-core, si absent de node_modules (npm i -D playwright-core)
//   CHROME_PATH      exécutable Chrome ou Chromium ; sinon détecté, sinon le Chromium de Playwright
//   CWEBP            binaire cwebp ; sinon recherché dans le PATH
//   WEBP_QUALITY     qualité cwebp des captures d'ensemble (défaut 90 ; les thèmes sortent à 80)
//
// Les données viennent d'une interception Playwright de http://localhost:7777 (/stats, /theme, fonds) :
// aucun agent réel n'est contacté, aucun serveur n'est lancé. Hors des modes thèmes, rien n'est écrit
// hors du dossier demandé ; les modes thèmes n'écrivent que dans docs/screenshots et les vignettes.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');
const os = require('os');

function loadPlaywright() {
  for (const id of [process.env.PLAYWRIGHT_CORE, 'playwright-core']) {
    if (!id) continue;
    try { return require(id); } catch (e) { /* essai suivant */ }
  }
  console.error('playwright-core introuvable : npm i -D playwright-core, ou PLAYWRIGHT_CORE=<dossier du paquet>.');
  process.exit(1);
}
const { chromium } = loadPlaywright();

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'src', 'wallpaper', 'index.html');
const USAGE = 'Usage : node scripts/screenshots.cjs <dossier> [largeur] [hauteur] [DPR]\n'
  + '        node scripts/screenshots.cjs --themes [largeur] [hauteur] [DPR]\n'
  + '        node scripts/screenshots.cjs --theme <id> [largeur] [hauteur] [DPR]';
const argv = process.argv.slice(2), pos = [];
let THEMES_ALL = false, THEME_ID = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--themes') THEMES_ALL = true;
  else if (argv[i] === '--theme') {
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) { console.error(USAGE); process.exit(2); }
    THEME_ID = argv[++i];
  } else pos.push(argv[i]);
}
const THEME_MODE = THEMES_ALL || THEME_ID !== null;
const OUT = THEME_MODE ? null : pos.shift();
if (!THEME_MODE && !OUT) { console.error(USAGE); process.exit(2); }
const VW = +(pos[0] || 2560), VH = +(pos[1] || 1600), DPR = +(pos[2] || 1.25);
const GB = 1024 ** 3;

const BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  return BROWSERS.find((p) => fs.existsSync(p)); // undefined : Chromium de Playwright
}
function findCwebp() {
  const candidates = [process.env.CWEBP, 'cwebp', '/opt/homebrew/bin/cwebp', '/usr/local/bin/cwebp'].filter(Boolean);
  return candidates.find((c) => spawnSync(c, ['-version']).status === 0) || null;
}

let seed = 42;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

function dayStart(offset) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset); return d.getTime();
}
function hourAt(offsetH) {
  const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + offsetH); return d.getTime();
}
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Heatmap façon GitHub : 22 semaines, colonnes = semaines (dimanche en haut), jours futurs absents.
// Semaine de travail active, week-ends calmes, majorité de jours faibles ou vides, quelques pics,
// sprints et creux (vacances), série de 12 jours en cours.
function streakDays() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today); start.setDate(today.getDate() - today.getDay() - 7 * 21);
  const WEEK_FACTOR = [.5, .9, 1.4, 1.6, 1.3, .7, .3, 1.1, 1.5, 1.7, 1.2, .6, 1.0, 1.4, 1.3, 1.6, .9, .4, 1.2, 1.5, 1.4, 1.1];
  const days = [];
  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const wk = Math.floor(Math.round((d - start) / 864e5) / 7);
    const f = WEEK_FACTOR[wk] ?? 1;
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    let n = 0;
    if (!weekend && rnd() < .8 * Math.min(1, f)) {
      const r = rnd();
      n = r < .5 ? 1 + Math.floor(rnd() * 3) : r < .82 ? 4 + Math.floor(rnd() * 5) : r < .97 ? 9 + Math.floor(rnd() * 6) : 15 + Math.floor(rnd() * 6);
      n = Math.max(1, Math.round(n * f));
    } else if (weekend && rnd() < .2 * f) {
      n = 1 + Math.floor(rnd() * 3);
    }
    days.push({ date: isoDay(d), n });
  }
  // quelques pics de travail (sprint, release)
  [[13, 3, 22], [19, 1, 19], [9, 2, 16]].forEach(([w, wd, v]) => { const i = w * 7 + wd; if (days[i]) days[i].n = v; });
  // série en cours : 12 jours d'affilée, jour précédent vide ; aujourd'hui = 6 contributions
  const L = days.length;
  days[L - 13].n = 0;
  for (let i = L - 12; i < L; i++) days[i].n = Math.max(1, days[i].n);
  days[L - 1].n = 6;
  return days;
}

function buildStats() {
  const now = Date.now(), sec = Math.floor(now / 1000);
  // 14 jours de coût IA (EUR), aujourd'hui en dernier
  const daily = Array.from({ length: 14 }, (_, i) => ({ t: dayStart(i - 13), eur: i === 13 ? 6.4 : (rnd() < 0.15 ? 0 : 0.8 + rnd() * 6.5) }));
  const week = daily.slice(-7);
  const weekEur = week.reduce((a, d) => a + d.eur, 0);
  const costW = { o: 0.34, w: 0.22, cr: 0.36, i: 0.08 };
  const costEur = (base) => Object.fromEntries(Object.entries(costW).map(([k, v]) => [k, +(base * v).toFixed(2)]));
  const share = (rows) => rows.map(([name, pct]) => ({ name, pct, eur: +(weekEur * pct / 100).toFixed(2) }));
  const resets = (h) => sec + h * 3600;

  const prs = [
    { ci: 'FAILURE', repo: 'acme/web', n: 87, title: 'Add dark mode toggle to settings', draft: false, updated: now - 3600e3, url: 'https://github.com/acme/web/pull/87' },
    { ci: 'PENDING', repo: 'acme/payments', n: 33, title: 'Refactor payment webhook handling', draft: false, updated: now - 900e3, url: 'https://github.com/acme/payments/pull/33' },
    { ci: 'SUCCESS', repo: 'acme/api', n: 142, title: 'Fix login redirect loop', draft: false, updated: now - 300e3, url: 'https://github.com/acme/api/pull/142' },
    { ci: 'SUCCESS', repo: 'acme/design-system', n: 21, title: 'Align spacing tokens', draft: true, updated: now - 7200e3, url: 'https://github.com/acme/design-system/pull/21' },
    { ci: 'NONE', repo: 'acme/docs-site', n: 9, title: 'Document rate limits', draft: false, updated: now - 86400e3, url: 'https://github.com/acme/docs-site/pull/9' },
  ];

  const streak = streakDays();
  const cpuHistory = Array.from({ length: 60 }, (_, i) => Math.max(4, Math.min(92, 30 + 16 * Math.sin(i / 6) + rnd() * 18)));
  const netHistory = Array.from({ length: 60 }, () => ({ d: 0.5e6 + rnd() * 1.6e6, u: 40e3 + rnd() * 140e3 }));

  const hours = Array.from({ length: 9 }, (_, i) => {
    const t = hourAt(i);
    const h = new Date(t).getHours();
    return { t, code: i < 5 ? 2 : 3, day: h >= 7 && h < 20 ? 1 : 0, temp: Math.round(17 - Math.abs(i - 3) * 0.7) };
  });

  return {
    time: now, uptime: 302400, cpu: 34, cpuName: 'Apple M3 Pro', cores: 12, cpuHistory,
    memTotal: 36 * GB, memUsed: 17.6 * GB,
    disks: [{ name: 'Macintosh HD', label: '', total: 994662584320, free: 402e9 }],
    topMem: [
      { name: 'Google Chrome', count: 12, cpu: 4.8, mem: 2.3 * GB },
      { name: 'Code Helper', count: 5, cpu: 3.1, mem: 1.1 * GB },
      { name: 'claude', count: 4, cpu: 6.1, mem: 1.4 * GB },
      { name: 'node', count: 4, cpu: 2.2, mem: 0.9 * GB },
      { name: 'Slack', count: 1, cpu: 0.9, mem: 0.6 * GB },
    ],
    top: [
      { name: 'claude', count: 4, cpu: 21.6, mem: 1.4 * GB },
      { name: 'node', count: 3, cpu: 12.3, mem: 0.9 * GB },
      { name: 'Google Chrome', count: 12, cpu: 9.1, mem: 2.3 * GB },
      { name: 'Code Helper', count: 5, cpu: 4.2, mem: 1.1 * GB },
      { name: 'WindowServer', count: 1, cpu: 2.7, mem: 0.3 * GB },
    ],
    net: { down: 1.3 * 1048576, up: 96e3, ping: 18, history: netHistory },
    hw: { cpuTemp: 61, cpuPower: 14.2, cpuFan: 1850, ssdTemp: 38, gpuLoad: 23, gpuTemp: 54, gpuHot: 62, gpuPower: 8.4, gpuFan: null, gpuName: 'Apple M3 Pro' },
    sessions: [], servers: [], icons: [], battery: null, media: null,
    insights: {
      updated: now,
      jobAt: { github: now - 120e3 },
      ai: {
        eurRate: 0.92,
        today: { eur: 6.4, msgs: 186, costEur: costEur(6.4) },
        week: { eur: weekEur, msgs: 1243, o: 1.2e6, w: 3.4e6, cr: 58e6, i: 2.1e6, costEur: costEur(weekEur) },
        daily,
        byModel: share([['Opus', 46], ['Sonnet', 38], ['Haiku', 9], ['GPT-5 Codex', 7]]),
        byEffort: share([['high', 44], ['medium', 31], ['xhigh', 15], ['low', 10]]),
        claudeLimits: {
          five_hour: { used_percentage: 38, resets_at: resets(2.6) },
          seven_day: { used_percentage: 54, resets_at: resets(50) },
          seven_day_opus: { used_percentage: 47, resets_at: resets(50) },
          seven_day_sonnet: { used_percentage: 21, resets_at: resets(50) },
          plan: 'Max', updated: now - 30e3,
        },
        codex: { limits: {
          primary: { used_percent: 12, window_minutes: 300, resets_at: resets(4.1) },
          secondary: { used_percent: 33, window_minutes: 10080, resets_at: resets(90) },
        } },
      },
      github: { counts: { open: 5, failing: 1 }, prs },
      sentry: { configured: true, issues: [
        { title: 'TypeError: Cannot read properties of undefined (reading "id")', project: 'acme-web', count: 128, users: 14, level: 'error', url: 'https://sentry.io/organizations/acme/issues/101/', firstSeen: now - 3 * 864e5 },
        { title: 'Timeout waiting for payment webhook', project: 'acme-payments', count: 23, users: 4, level: 'warning', url: 'https://sentry.io/organizations/acme/issues/102/', firstSeen: now - 12 * 36e5 },
      ] },
      streak: { days: streak, current: 12, best: 41, todayCount: streak[streak.length - 1].n, total: 1842 },
      projects: { total: 6, dirty: 4, unpushed: 2, items: [
        { name: 'acme-api', dir: '~/code/acme-api', repo: 'acme/api', branch: 'fix/login-redirect', changed: 4, ahead: 1, behind: 0, upstream: true, ci: { status: 'completed', conclusion: 'success', url: 'https://github.com/acme/api/actions/runs/1' } },
        { name: 'acme-web', dir: '~/code/acme-web', repo: 'acme/web', branch: 'feat/dark-mode', changed: 7, ahead: 0, behind: 2, upstream: true, ci: { status: 'completed', conclusion: 'failure', url: 'https://github.com/acme/web/actions/runs/2' } },
        { name: 'design-system', dir: '~/code/design-system', repo: 'acme/design-system', branch: 'tokens/spacing', changed: 2, ahead: 3, behind: 0, upstream: true, ci: { status: 'completed', conclusion: 'success' } },
        { name: 'mobile-app', dir: '~/code/mobile-app', repo: 'acme/mobile-app', branch: 'main', changed: 0, ahead: 0, behind: 0, upstream: true, ci: { status: 'in_progress' } },
        { name: 'playground', dir: '~/code/playground', repo: 'acme/playground', branch: 'spike/ai-router', changed: 1, ahead: 0, behind: 0, upstream: false, ci: null },
      ] },
      weather: {
        place: 'Paris',
        current: { weather_code: 2, is_day: 1, temperature_2m: 17.4, apparent_temperature: 16.8 },
        days: [{ min: 11, max: 19, rain: 20 }],
        hours,
      },
      calendar: { configured: true, allDay: [], next: [
        { title: 'Team standup', start: now + 42 * 60e3, allDay: false, url: 'https://meet.example.com/team-standup' },
        { title: 'Design review', start: now + 3.2 * 36e5, allDay: false, location: 'Room 2' },
        { title: 'Sprint planning', start: dayStart(1) + 10 * 36e5, allDay: false, location: 'Room 1' },
      ] },
    },
  };
}

function launchBrowser() {
  const executablePath = findBrowser();
  return chromium.launch({ headless: true, timeout: 60000, ...(executablePath ? { executablePath } : {}) });
}

// ── Captures des thèmes (--themes, --theme <id>) ──────────────────
// Aperçu pur : le thème demandé par #demo:<id>, sans fond personnel ni thème de la config.
const THEMES_DIR = path.join(ROOT, 'src', 'themes');
const DOCS_SHOTS = path.join(ROOT, 'docs', 'screenshots');
const THUMB_W = 480, THUMB_H = 300;
const THEME_WEBP_W = 1280, THEME_WEBP_Q = 80;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true' };
const isThemeId = (id) => typeof id === 'string' && /^[a-z0-9-]+$/.test(id);
function readThemeJson(id) {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(THEMES_DIR, id, 'theme.json'), 'utf8'));
    return t && typeof t === 'object' && !Array.isArray(t) ? t : null;
  } catch { return null; }
}
// GET /theme de l'agent : l'id demandé, sinon naruto (id inconnu ou absent)
function themeJson(wanted) {
  let id = isThemeId(wanted) ? wanted : 'naruto';
  let t = readThemeJson(id);
  if (!t) { id = 'naruto'; t = readThemeJson(id) || {}; }
  return { ...t, id, background: `/themes/${id}/background.jpg`, themeKey: `${id}|` };
}
// Faux agent : /stats (données factices), /theme, fonds et vignettes des thèmes (liste blanche)
const THEME_FILE = /^\/themes\/([a-z0-9-]+)\/(background\.jpg|thumbnail\.jpg)$/;
function fakeAgent(route) {
  const u = new URL(route.request().url());
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
  if (u.pathname === '/stats') return json(buildStats());
  if (u.pathname === '/theme') return json(themeJson(u.searchParams.get('id')));
  const f = THEME_FILE.exec(u.pathname), file = f && path.join(THEMES_DIR, f[1], f[2]);
  if (file && fs.existsSync(file)) return route.fulfill({ status: 200, contentType: 'image/jpeg', headers: CORS, body: fs.readFileSync(file) });
  return json({}, 404);
}

function themeIds() {
  if (!THEMES_ALL) {
    if (!isThemeId(THEME_ID) || !readThemeJson(THEME_ID)) { console.error(`thème introuvable : ${THEME_ID} (src/themes/<id>/theme.json)`); process.exit(2); }
    if (!fs.existsSync(path.join(THEMES_DIR, THEME_ID, 'background.jpg'))) { console.error(`${THEME_ID} : background.jpg absent`); process.exit(2); }
    return [THEME_ID];
  }
  const dirs = fs.readdirSync(THEMES_DIR).filter((d) => isThemeId(d) && readThemeJson(d));
  const ids = dirs.filter((d) => {
    const ok = fs.existsSync(path.join(THEMES_DIR, d, 'background.jpg'));
    if (!ok) console.log(`${d} : background.jpg absent, thème ignoré`);
    return ok;
  });
  // naruto d'abord, puis ordre alphabétique
  return ids.sort((a, b) => (a === 'naruto' ? -1 : b === 'naruto' ? 1 : a < b ? -1 : a > b ? 1 : 0));
}

// Une page #demo:<id> : fond décodé, 1 s d'animation, capture page entière en PNG dans tmp
async function captureTheme(context, id, tmp) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(pathToFileURL(PAGE).href + '#demo:' + id, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => !document.body.classList.contains('offline') && document.getElementById('ninjas').children.length > 0, null, { timeout: 15000 });
  await page.waitForFunction((tid) => document.body.style.backgroundImage.includes(`/themes/${tid}/background.jpg`), id, { timeout: 15000 });
  const info = await page.evaluate(async () => {
    const m = /url\("?([^"]+?)"?\)/.exec(document.body.style.backgroundImage);
    const img = new Image();
    img.src = m[1];
    await img.decode();
    return {
      bg: `${img.naturalWidth}x${img.naturalHeight}`,
      palette: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      persos: document.querySelectorAll('#ninjas > .ninja, #ninjas2 > .ninja').length,
    };
  });
  await page.waitForTimeout(1000);
  const png = path.join(tmp, id + '.png');
  await page.screenshot({ path: png, fullPage: true });
  await page.close();
  console.log(`${id} : fond ${info.bg}, --bg ${info.palette || '(défaut)'}, persos ${info.persos}`);
  if (errors.length) console.log(`${id} erreurs`, JSON.stringify(errors));
  return png;
}

function toWebp(cwebp, png, webp, width, quality) {
  const r = spawnSync(cwebp, ['-quiet', '-q', String(quality), ...(width ? ['-resize', String(width), '0'] : []), png, '-o', webp]);
  if (r.status !== 0) throw new Error(`cwebp a échoué sur ${png}: ${r.stderr}`);
  console.log('written', webp);
}

// Vignette 480 x 300 : remplissage du cadre puis rognage centré (sips, macOS)
function makeThumb(png, dest) {
  const dim = (k) => +/: (\d+)/.exec(spawnSync('sips', ['-g', k, png]).stdout.toString())[1];
  const w = dim('pixelWidth'), h = dim('pixelHeight');
  const s = Math.max(THUMB_W / w, THUMB_H / h);
  const nw = Math.max(THUMB_W, Math.ceil(w * s)), nh = Math.max(THUMB_H, Math.ceil(h * s));
  const r = spawnSync('sips', ['-z', String(nh), String(nw), '--cropToHeightWidth', String(THUMB_H), String(THUMB_W),
    '-s', 'format', 'jpeg', '-s', 'formatOptions', '85', png, '--out', dest]);
  if (r.status !== 0) throw new Error(`sips a échoué sur ${png}: ${r.stderr}`);
  console.log('written', dest);
}

// Planche : grille 4 colonnes des vignettes (images en data URI), rendue par une page HTML temporaire
async function planche(browser, ids, tmp, cwebp) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const cells = ids.filter((id) => fs.existsSync(path.join(THEMES_DIR, id, 'thumbnail.jpg'))).map((id) => ({
    name: readThemeJson(id).name || id,
    src: 'data:image/jpeg;base64,' + fs.readFileSync(path.join(THEMES_DIR, id, 'thumbnail.jpg')).toString('base64'),
  }));
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: #0b0d12; }
  .grid { width: 1920px; box-sizing: border-box; padding: 48px 40px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 36px 24px; font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; color: #eef2f6; }
  figure { margin: 0; }
  img { display: block; width: 100%; aspect-ratio: 8 / 5; object-fit: cover; border-radius: 10px; }
  figcaption { margin-top: 12px; font-size: 22px; text-align: center; }
</style></head><body><main class="grid">${cells.map((c) => `<figure><img src="${c.src}" alt=""><figcaption>${esc(c.name)}</figcaption></figure>`).join('')}</main></body></html>`;
  // hauteur de viewport réduite : la capture page entière suit la hauteur de la grille
  const context = await browser.newContext({ viewport: { width: 1920, height: 200 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
  const png = path.join(tmp, 'themes.png');
  await page.screenshot({ path: png, fullPage: true });
  await context.close();
  toWebp(cwebp, png, path.join(DOCS_SHOTS, 'themes.webp'), 0, THEME_WEBP_Q);
}

async function captureThemes() {
  const cwebp = findCwebp();
  if (!cwebp) throw new Error('cwebp introuvable : WebP requis pour les captures de thèmes (brew install webp, ou CWEBP=<chemin>)');
  const ids = themeIds();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dojo-themes-'));
  fs.mkdirSync(path.join(DOCS_SHOTS, 'themes'), { recursive: true });
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: DPR });
    await context.route('http://localhost:7777/**', fakeAgent);
    for (const id of ids) {
      const png = await captureTheme(context, id, tmp);
      toWebp(cwebp, png, path.join(DOCS_SHOTS, 'themes', id + '.webp'), THEME_WEBP_W, THEME_WEBP_Q);
      makeThumb(png, path.join(THEMES_DIR, id, 'thumbnail.jpg'));
    }
    if (THEMES_ALL) await planche(browser, ids, tmp, cwebp);
  } finally {
    await browser.close();
    if (process.env.KEEP_PNG) console.log('PNG conservés dans', tmp);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  if (THEME_MODE) return captureThemes();
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: DPR });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await context.route('http://localhost:7777/**', fakeAgent);

  await page.goto(pathToFileURL(PAGE).href + '#demo', { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => !document.body.classList.contains('offline') && document.getElementById('ninjas').children.length > 0, null, { timeout: 15000 });
  await page.waitForTimeout(3500);

  // mesures : zoom du dojo, taille réelle des titres, débordement de la grille projets
  const m = await page.evaluate(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right), bottom: Math.round(b.bottom) }; };
    const grid = document.getElementById('grid'), card = document.getElementById('projCard');
    const cols = grid.children.length;
    const lastCell = grid.lastElementChild;
    const proj = document.querySelector('.ninja .proj');
    const ninjas = [...document.querySelectorAll('#ninjas > .ninja, #ninjas2 > .ninja')];
    return {
      offline: document.body.classList.contains('offline'),
      notch: document.body.classList.contains('notch'), // layout Mac à encoche (setSafe, #demo)
      player: r(document.getElementById('hm')),
      ninjas: ninjas.length,
      dojoZoom: document.getElementById('dojo').style.zoom, dojo2Zoom: document.getElementById('dojo2').style.zoom,
      dojo: r(document.getElementById('dojo')), dojo2: getComputedStyle(document.getElementById('dojo2')).display,
      ninjaTitleFont: proj ? getComputedStyle(proj).fontSize : null,
      ninjaTitleScreenPx: proj ? parseFloat(getComputedStyle(proj).fontSize) * parseFloat(document.getElementById('dojo').style.zoom || 1) : null,
      gridCols: cols, gridBox: r(grid), gridScrollW: grid.scrollWidth, gridClientW: grid.clientWidth,
      lastCellRight: lastCell ? r(lastCell).right : null, projCardRight: r(card).right, projCardBox: r(card),
      streakRight: r(document.getElementById('streak')).right,
      left: r(document.getElementById('left')), panel: r(document.getElementById('panel')), hero: r(document.getElementById('hero')),
      summary: document.getElementById('dojoSummary').textContent,
    };
  });
  console.log('measure', JSON.stringify(m));

  await page.screenshot({ path: path.join(OUT, 'overview.png') });
  await page.locator('#dojo').screenshot({ path: path.join(OUT, 'dojo.png') });
  console.log('errors', JSON.stringify(errors));
  await browser.close();

  // PNG -> WebP (comme les captures de docs/screenshots)
  const cwebp = findCwebp();
  if (!cwebp) { console.log('cwebp absent : PNG conservés dans', OUT); return; }
  for (const name of ['overview', 'dojo']) {
    const png = path.join(OUT, name + '.png'), webp = path.join(OUT, name + '.webp');
    const r = spawnSync(cwebp, ['-quiet', '-q', process.env.WEBP_QUALITY || '90', png, '-o', webp]);
    if (r.status !== 0) throw new Error(`cwebp a échoué sur ${png}: ${r.stderr}`);
    if (!process.env.KEEP_PNG) fs.rmSync(png);
    console.log('written', webp);
  }
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
