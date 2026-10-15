// Assistant média de Windows : musique / vidéo en cours (Spotify, navigateur…) et commandes toggle / next / prev.
// Passe par src/windows/media.ps1 (WinRT, Windows PowerShell 5.1) lancé en processus enfant long-vivant : il écrit
// media.json et cover.jpg dans %LOCALAPPDATA%\claude-dojo et s'arrête seul quand l'agent disparaît.
//   read()      -> Media | null   (synchrone : lecture de media.json ; null si rien en lecture, obsolète ou WinRT absent)
//   cmd(c)      -> Promise<Media | null>, c = 'toggle' | 'next' | 'prev'
//   coverFile() -> chemin de la pochette | null
//   stop()      tue le processus enfant (appelé aussi à la sortie de Node)
// Forme de Media identique à agent-mac.js : { active, app, title, artist, album, status, position, duration,
// positionAt, cover, canNext, canPrev, updated }. Échecs silencieux : null, jamais d'exception.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const STATE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'claude-dojo');
const MEDIA = path.join(STATE, 'media.json');
const CMD = path.join(STATE, 'media-cmd.txt');
const COVER = path.join(STATE, 'cover.jpg');
const SCRIPT = path.join(__dirname, 'windows', 'media.ps1');
const CMDS = new Set(['toggle', 'next', 'prev']);
const STALE_MS = 10000;      // media.json est réécrit chaque seconde : plus vieux que ça, le script ne tourne plus
const QUICK_EXIT_MS = 10000; // un script qui meurt avant ce délai est un échec de démarrage
const MAX_QUICK_EXITS = 3;   // au-delà, WinRT est jugé indisponible : on n'essaie plus

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const str = (v) => (typeof v === 'string' ? v : '');
const num = (v) => (Number.isFinite(v) ? v : 0);

let child = null, startedAt = 0, quickExits = 0, hooked = false;

// Lance media.ps1 s'il ne tourne pas (et si les démarrages n'ont pas déjà échoué).
function ensure() {
  if (child || quickExits >= MAX_QUICK_EXITS || !fs.existsSync(SCRIPT)) return;
  try { fs.mkdirSync(STATE, { recursive: true }); } catch { quickExits = MAX_QUICK_EXITS; return; }
  let p;
  try {
    p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-StateDir', STATE],
      { windowsHide: true, stdio: 'ignore' });
  } catch { quickExits = MAX_QUICK_EXITS; return; }
  child = p; startedAt = Date.now();
  p.on('error', () => { if (child === p) child = null; quickExits = MAX_QUICK_EXITS; });
  p.on('exit', () => {
    if (child === p) child = null;
    quickExits = Date.now() - startedAt < QUICK_EXIT_MS ? quickExits + 1 : 0;
  });
  p.unref();
  if (!hooked) { hooked = true; process.once('exit', stop); }
}

function stop() {
  const p = child;
  child = null;
  if (p) { try { p.kill(); } catch {} }
}

function read() {
  if (process.platform !== 'win32') return null;
  try {
    ensure();
    const j = JSON.parse(fs.readFileSync(MEDIA, 'utf8'));
    if (!j || j.active !== true || !j.title || !(Date.now() - j.updated < STALE_MS)) return null;
    return {
      active: true, app: str(j.app), title: str(j.title), artist: str(j.artist), album: str(j.album),
      status: j.status === 'Playing' ? 'Playing' : 'Paused',
      position: num(j.position), duration: num(j.duration), positionAt: num(j.positionAt) || Date.now(),
      cover: num(j.cover), canNext: j.canNext === true, canPrev: j.canPrev === true, updated: j.updated,
    };
  } catch { return null; }
}

async function cmd(c) {
  if (process.platform !== 'win32' || !CMDS.has(c)) return null;
  ensure();
  if (!child) return null;
  try {
    fs.writeFileSync(CMD, c);
    // le script retire le fichier avant d'exécuter la commande, puis réécrit media.json aussitôt
    for (let i = 0; i < 15 && fs.existsSync(CMD); i++) await sleep(100);
    await sleep(300);
    return read();
  } catch { return null; }
}

function coverFile() {
  if (process.platform !== 'win32') return null;
  return fs.existsSync(COVER) ? COVER : null;
}

if (process.platform === 'win32') ensure();

module.exports = { read, cmd, coverFile, stop };
