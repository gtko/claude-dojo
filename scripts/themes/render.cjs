// Rend la scène procédurale d'un thème (scripts/themes/<id>/scene.html) en fond d'écran JPEG.
//
// Usage : node scripts/themes/render.cjs <id> [--png <chemin>]
//   ex. node scripts/themes/render.cjs naruto --png /tmp/naruto.png
//   -> src/themes/<id>/background.jpg (2880 x 1800, <= 900 Ko)
//
// La page doit mettre window.__ready = true une fois dessinée (attente 20 s max).
// Le PNG intermédiaire part dans os.tmpdir() et disparaît, sauf avec --png.
//
// Variables d'environnement facultatives :
//   DOJO_SCENE_DIR   dossier des scènes à la place de scripts/themes/ (<dossier>/<id>/scene.html)
//   PLAYWRIGHT_CORE  chemin du paquet playwright-core, si absent de node_modules (npm i -D playwright-core)
//   CHROME_PATH      exécutable Chrome ou Chromium ; sinon détecté, sinon le Chromium de Playwright
//
// Conversion par sips (macOS) : cwebp n'écrit pas de JPEG.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

function loadPlaywright() {
  for (const id of [process.env.PLAYWRIGHT_CORE, 'playwright-core']) {
    if (!id) continue;
    try { return require(id); } catch (e) { /* essai suivant */ }
  }
  console.error('playwright-core introuvable : npm i -D playwright-core, ou PLAYWRIGHT_CORE=<dossier du paquet>.');
  process.exit(1);
}
const { chromium } = loadPlaywright();

const ROOT = path.resolve(__dirname, '..', '..');
const SCENE_DIR = process.env.DOJO_SCENE_DIR ? path.resolve(process.env.DOJO_SCENE_DIR) : __dirname;
const VW = 1440, VH = 900, DPR = 2;
const MAX_BYTES = 900 * 1024;
const QUALITIES = [88, 84, 80, 76, 72, 68, 64, 60];
const USAGE = 'Usage : node scripts/themes/render.cjs <id> [--png <chemin>]';

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

function parseArgs(argv) {
  let id = null, png = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--png') { png = argv[++i]; if (!png) return null; }
    else if (!id) id = argv[i];
    else return null;
  }
  return id ? { id, png } : null;
}
const opts = parseArgs(process.argv.slice(2));
if (!opts || !/^[a-z0-9-]+$/.test(opts.id)) { console.error(USAGE + ' (id : [a-z0-9-]+)'); process.exit(2); }

async function capture(id, pngPath) {
  const scene = path.join(SCENE_DIR, id, 'scene.html');
  if (!fs.existsSync(scene)) throw new Error(`scène introuvable : ${scene}`);
  const executablePath = findBrowser();
  const browser = await chromium.launch({ headless: true, timeout: 60000, ...(executablePath ? { executablePath } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: DPR });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(pathToFileURL(scene).href, { waitUntil: 'load', timeout: 30000 });
    try {
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
    } catch (e) {
      throw new Error('window.__ready jamais passé à true (20 s)' + (errors.length ? ' : ' + errors.join(' | ') : ''));
    }
    await page.screenshot({ path: pngPath, type: 'png' });
  } finally {
    await browser.close();
  }
}

// JPEG de la meilleure qualité qui tient sous MAX_BYTES (88 -> 60).
function convertToJpeg(png, workDir) {
  let size = 0;
  for (const q of QUALITIES) {
    const out = path.join(workDir, `bg-q${q}.jpg`);
    const r = spawnSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(q), png, '--out', out], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`sips a échoué (q${q}) : ${r.stderr || r.stdout}`);
    size = fs.statSync(out).size;
    if (size <= MAX_BYTES) return { file: out, quality: q, size };
  }
  throw new Error(`trop lourd même à q60 : ${Math.round(size / 1024)} Ko (max 900 Ko)`);
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-render-'));
  try {
    const png = path.join(work, 'scene.png');
    await capture(opts.id, png);
    if (opts.png) {
      const keep = path.resolve(opts.png);
      fs.copyFileSync(png, keep);
      console.log('png', keep);
    }
    const { file, quality, size } = convertToJpeg(png, work);
    const dir = path.join(ROOT, 'src', 'themes', opts.id);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, 'background.jpg');
    fs.copyFileSync(file, dest);
    console.log(`written ${dest} (${Math.round(size / 1024)} Ko, q${quality})`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
