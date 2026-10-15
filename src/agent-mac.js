// Agent local du fond d'écran « Dojo » pour macOS : équivalent de agent.ps1 (Windows).
// Ce fichier ne contient que les échantillonneurs macOS (ps, macmon, sysctl, vm_stat, mount, netstat, ping, ioreg,
// lsof, open, osascript, defaults/sips, media-control) ; le serveur, les sessions, les thèmes et le cycle
// d'échantillonnage sont dans agent-core.js. Sert http://localhost:7777/stats (et la page elle-même sur http://localhost:7777/).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');
const { startAgent } = require('./agent-core');

const ROOT = __dirname;
const CACHE = path.join(ROOT, 'cache');
const HOME = os.homedir();
const BREW = ['/opt/homebrew/bin', '/usr/local/bin'];
const ENV = { ...process.env, PATH: [...BREW, process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].join(':') };

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const config = () => readJson(path.join(ROOT, 'config.json'), {});
const run = (cmd, args, opts = {}) => new Promise((res) => execFile(cmd, args, { env: ENV, timeout: 8000, maxBuffer: 16 << 20, ...opts }, (e, out) => res(e && !out ? '' : String(out || ''))));
const which = (bin) => [...BREW, '/usr/bin'].map((d) => path.join(d, bin)).find((p) => fs.existsSync(p)) || null;

// ── Processus : une passe de ps, plus une passe pour le chemin de l'exécutable ──
function parseEtime(s) {      // [[dd-]hh:]mm:ss -> secondes
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  return m ? (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+m[3]) * 60 + (+m[4]) : null;
}
function isDescendantOfName(map, pid, name) {
  for (let i = 0, p = map.get(pid); p && i < 20; i++, p = map.get(p.ppid)) if ((p.comm || '').includes(name)) return true;
  return false;
}
async function sampleProcesses() {
  const out = await run('/bin/ps', ['-axww', '-o', 'pid=,ppid=,pcpu=,rss=,etime=,args=']);
  const map = new Map();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    map.set(+m[1], { pid: +m[1], ppid: +m[2], cpu: +m[3], rss: +m[4] * 1024, etime: parseEtime(m[5]), args: m[6], comm: '', name: '' });
  }
  // chemin de l'exécutable (peut contenir des espaces) : 2e passe, ps ne sait pas le délimiter des arguments
  const comms = await run('/bin/ps', ['-axww', '-o', 'pid=,comm=']);
  for (const line of comms.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    const p = m && map.get(+m[1]);
    if (!p) continue;
    p.comm = m[2].trim();
    p.name = path.basename(p.comm);
  }
  for (const p of map.values()) {
    p.desktop = /^\/Applications\/Claude\.app\//.test(p.comm);   // Claude Desktop : hôte des sessions
    // interface du fond d'écran (DojoWallpaper et ses WebKit) : jamais dans les tops ni les serveurs
    p.hidden = /DojoWallpaper|com\.apple\.WebKit\.(WebContent|GPU|Networking)/.test(p.comm) && isDescendantOfName(map, p.pid, 'DojoWallpaper');
  }
  return [...map.values()];
}
// Bruit système : ces groupes n'apparaissent dans les tops qu'au-delà de 5 % de CPU
const hideGroup = (name, cpu) => /^(kernel_task|launchd|WindowServer)$/.test(name) && cpu <= 5;

// ── Mémoire, capteurs, puissance : macmon (sans sudo) ──────────────
let macmon = null, hw = null, memMacmon = null, lastEnsure = 0;
function ensureMacmon() {
  if (macmon) return;
  const bin = which('macmon');
  if (!bin) return;
  macmon = spawn(bin, ['pipe', '-i', '2000'], { env: ENV, stdio: ['ignore', 'pipe', 'ignore'] });
  let buf = '';
  macmon.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try {
        const j = JSON.parse(line);
        const fan = (j.fans || []).reduce((m, f) => Math.max(m, f.rpm || 0), 0);
        hw = {
          cpuTemp: j.temp?.cpu_temp_avg ?? null,
          cpuPower: j.cpu_power ?? null,
          cpuFan: (j.fans || []).length ? fan : null,
          gpuName: chip + ' GPU',
          gpuTemp: j.temp?.gpu_temp_avg ?? null,
          gpuHot: null,
          gpuLoad: j.gpu_usage ? Math.round(100 * j.gpu_usage[1]) : null,
          gpuPower: j.gpu_power ?? null,
          gpuFan: null,
          ssdTemp: null,
          sysPower: j.sys_power ?? null,
        };
        if (j.memory?.ram_total) memMacmon = { total: j.memory.ram_total, used: j.memory.ram_usage };
      } catch {}
    }
  });
  macmon.on('exit', () => { macmon = null; hw = null; });
  macmon.on('error', () => { macmon = null; hw = null; });   // binaire présent mais non exécutable : repli vm_stat
}
let chip = 'Apple';
run('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']).then((s) => { chip = s.trim() || chip; });

async function memVmStat() {   // repli si macmon est absent : app + wired + compressée
  const out = await run('/usr/bin/vm_stat', []);
  const ps = +(/page size of (\d+)/.exec(out) || [0, 16384])[1];
  const g = (k) => +((new RegExp(k + ':\\s+(\\d+)')).exec(out) || [0, 0])[1];
  const used = (g('Anonymous pages') - g('Pages purgeable') + g('Pages wired down') + g('Pages occupied by compressor')) * ps;
  return { total: os.totalmem(), used: used > 0 ? used : os.totalmem() - os.freemem() };
}
async function sampleSensors() {   // appelé à chaque cycle ; macmon est relancé au plus une fois par minute
  const now = Date.now();
  if (now - lastEnsure >= 60000) { lastEnsure = now; ensureMacmon(); }
  const mem = memMacmon || await memVmStat();
  return { cpuName: chip, hw, memory: mem };
}

// ── Disques ─────────────────────────────────────────────────────────
function sampleDisks() {
  const out = [];
  const add = (mount, name, label) => {
    try { const s = fs.statfsSync(mount); out.push({ name, label, total: s.blocks * s.bsize, free: s.bavail * s.bsize }); } catch {}
  };
  add('/System/Volumes/Data', 'Macintosh HD', '');
  // volumes montés en lecture seule (images .dmg, installeurs) : ignorés
  let ro = new Set();
  try { ro = new Set(execFileSync('/sbin/mount', { encoding: 'utf8' }).split('\n').filter((l) => /read-only/.test(l)).map((l) => (/ on (.+?) \(/.exec(l) || [])[1])); } catch {}
  try {
    for (const v of fs.readdirSync('/Volumes')) {
      const p = path.join('/Volumes', v);
      try { if (fs.realpathSync(p) === '/' || ro.has(p)) continue; } catch { continue; }
      add(p, v, '');
    }
  } catch {}
  return out;
}

// ── Réseau : compteurs d'octets (netstat -ib) et ping toutes les 5 s ──
let pingMs = null, lastPing = 0;
async function sampleNet() {
  const out = await run('/usr/sbin/netstat', ['-ibn']);
  let rx = 0, tx = 0;
  for (const line of out.split('\n')) {
    const c = line.trim().split(/\s+/);
    if (c.length < 10 || !/^<Link#/.test(c[2]) || /^(lo|gif|stf|utun|awdl|llw|anpi|ap|bridge)\d/.test(c[0])) continue;
    // Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll  (Address peut manquer)
    const nums = c.slice(3).filter((x) => /^\d+$/.test(x)).map(Number);
    if (nums.length >= 6) { rx += nums[nums.length - 5]; tx += nums[nums.length - 2]; }
  }
  const now = Date.now();
  if (now - lastPing >= 5000) {
    lastPing = now;
    run('/sbin/ping', ['-c', '1', '-t', '1', '1.1.1.1'], { timeout: 2000 }).then((o) => {
      const m = /time=([\d.]+)/.exec(o); pingMs = m ? Math.round(+m[1]) : null;
    });
  }
  return { rx, tx, ping: pingMs };
}

// ── Batterie (ioreg AppleSmartBattery) ────────────────────────────
async function sampleBattery() {
  const out = await run('/usr/sbin/ioreg', ['-rn', 'AppleSmartBattery']);
  if (!out) return null;
  const g = (k) => { const m = new RegExp('^\\s*"' + k + '" = (\\S+)', 'm').exec(out); return m ? m[1] : null; };
  const n = (k) => { const v = g(k); if (v == null || !/^-?\d+$/.test(v)) return null; const x = Number(v); return x > 2 ** 63 ? x - 2 ** 64 : x; };
  const pct = n('CurrentCapacity');
  if (pct == null) return null;
  const amps = n('InstantAmperage') ?? n('Amperage'), volts = n('Voltage');
  const left = n('TimeRemaining'), raw = n('AppleRawMaxCapacity'), design = n('DesignCapacity');
  return {
    percent: pct, plugged: g('ExternalConnected') === 'Yes', charging: g('IsCharging') === 'Yes', full: g('FullyCharged') === 'Yes',
    minutes: left != null && left < 65535 && left > 0 ? left : null,
    cycles: n('CycleCount'), health: raw && design ? Math.round(100 * raw / design) : null,
    temp: n('Temperature') != null ? n('Temperature') / 100 : null,
    watts: amps != null && volts != null ? Math.round(amps * volts / 1e5) / 10 : null,   // < 0 : décharge
  };
}

// ── Serveurs locaux en écoute (lsof), cadence 5 s ──────────────────
const DEV_NAMES = /^(node|bun|deno|python\d*(\.\d+)?|Python|php|php-fpm|java|ruby|dotnet|go|air|nginx|httpd|caddy|postgres|mysqld|mariadbd|redis-server|mongod|ollama|lms|docker|com\.docker\.backend|vpnkit-bridge|uvicorn|gunicorn|hugo|godot.*|workerd|wrangler|esbuild|cargo|flask|streamlit|jupyter.*|meilisearch|minio|mailpit|stripe|ngrok|cloudflared|supabase|turso|sqld|OrbStack Helper)$/;
const projectRoots = () => (config().projects?.roots || ['Projects', 'Projets', 'Developer', 'Code', 'dev', 'src', 'repos'].map((d) => path.join(HOME, d))).map((d) => d.replace(/^~(?=$|\/)/, HOME)).filter((r) => fs.existsSync(r));
// processus qui se renomment (titre de processus) : next-server (v16.3.8), nuxt, vite…
const DEV_TITLES = /^(next-server|next-router-worker|nuxt|vite|astro|remix|wrangler|storybook)\b/i;
function projectFrom(cmd) {
  for (const r of projectRoots()) {
    const i = cmd.indexOf(r);
    if (i < 0) continue;
    const parts = cmd.slice(i + r.length).replace(/^[\\/]+/, '').split(/[\\/"\s]/).filter(Boolean).slice(0, 3);
    const keep = [];
    for (const x of parts) { if (/^(node_modules|src|dist|build|\.venv|venv|vendor|bin|\.next|\.output)$/.test(x) || /\.\w{1,4}$/.test(x)) break; keep.push(x); }
    if (keep.length) return keep.join('/');
  }
  return null;
}
function whatFrom(name, cmd) {
  if (/^next-server/i.test(cmd)) return 'next';
  const m = /(vite|next|nuxt|astro|remix|webpack|wrangler|nodemon|tsx|ts-node|nest|expo|storybook|svelte-kit|react-scripts|parcel|turbo|http-server|json-server|prisma|drizzle-kit|uvicorn|gunicorn|flask|django|manage\.py|streamlit|jupyter|artisan|rails|puma)/i.exec(cmd);
  return m ? m[1].toLowerCase().replace(/\.py$/, '') : name;
}
let servers = [], lastServers = 0;
async function sampleServers(ctx) {
  const now = Date.now();
  if (now - lastServers < 5000) return servers;
  lastServers = now;
  const out = await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn']);
  const ports = new Map();
  let pid = null;
  for (const line of out.split('\n')) {
    if (line[0] === 'p') pid = +line.slice(1);
    else if (line[0] === 'n' && pid) {
      const m = /:(\d+)$/.exec(line);
      if (m) { if (!ports.has(pid)) ports.set(pid, new Set()); ports.get(pid).add(+m[1]); }
    }
  }
  // dossier de travail de chaque processus : certains serveurs (Next.js…) renomment leur processus
  // et effacent leur ligne de commande, le projet ne se lit plus que là
  const cwds = new Map();
  if (ports.size) {
    const out2 = await run('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-p', [...ports.keys()].join(','), '-Fpn']);
    let cp = null;
    for (const line of out2.split('\n')) {
      if (line[0] === 'p') cp = +line.slice(1);
      else if (line[0] === 'n' && cp) cwds.set(cp, line.slice(1));
    }
  }
  const list = [];
  for (const [id, set] of ports) {
    const p = ctx.procs.get(id);
    if (!p || ctx.self.has(id)) continue;
    if (/^\/(System|usr\/libexec|usr\/sbin|sbin)\//.test(p.comm || '')) continue;
    const cmd = p.args || p.comm || '';
    const cwd = cwds.get(id) || '';
    const project = projectFrom(cmd) || projectFrom(cwd + '/');
    if (!project && !DEV_NAMES.test(p.name) && !DEV_TITLES.test(cmd)) continue;
    let mem = 0, cpu = 0;
    const t = ctx.tree(id);
    for (const x of t) { const q = ctx.procs.get(x); if (q) { mem += q.rss; cpu += q.cpu; } }
    list.push({
      pid: id, name: p.name, what: whatFrom(p.name, cmd), project,
      ports: [...set].sort((a, b) => a - b), mem, cpu: Math.round(10 * cpu / ctx.cores) / 10, procs: t.size,
      since: p.etime != null ? Date.now() - p.etime * 1000 : null,
    });
  }
  servers = list.sort((a, b) => a.ports[0] - b.ports[0]);
  return servers;
}
function stopServer(id, ctx) {
  if (!servers.some((s) => s.pid === id)) return 'refusé : pas un serveur listé';
  const t = [...ctx.tree(id)].reverse();
  let ok = true;
  for (const x of t) { try { process.kill(x, 'SIGKILL'); } catch (e) { if (x === id) ok = false; } }
  lastServers = 0;
  return ok ? 'ok' : 'échec';
}

// ── Ouvre un lien dans le navigateur par défaut ────────────────────
function openUrl(url) {
  if (!/^(https:\/\/[\w.-]+|http:\/\/localhost:\d+)(\/\S*)?$/.test(url || '')) return 'refusé : lien non https';
  execFile('/usr/bin/open', [url]);
  return 'ok';
}

// ── Musique : media-control (Now Playing de macOS) ─────────────────
let media = null, coverKey = '', coverId = 0;
const COVER = path.join(CACHE, 'cover.jpg');
async function readMedia() {
  const bin = which('media-control');
  if (!bin) { media = null; return null; }
  const out = await run(bin, ['get'], { timeout: 4000 });
  let j = null;
  try { j = JSON.parse(out); } catch {}
  if (!j || !j.title) { media = { active: false, updated: Date.now() }; return media; }
  const key = `${j.bundleIdentifier}|${j.title}|${j.artist}`;
  if (key !== coverKey) {
    coverKey = key;
    if (j.artworkData) { try { fs.writeFileSync(COVER, Buffer.from(j.artworkData, 'base64')); coverId++; } catch { coverId = 0; } }
    else { try { fs.rmSync(COVER, { force: true }); } catch {} coverId = 0; }
  }
  const app = (j.bundleIdentifier || '').split('.').pop() || '';
  const ts = j.timestamp ? Date.parse(j.timestamp) : Date.now();
  media = {
    active: true, app: app.charAt(0).toUpperCase() + app.slice(1), title: j.title, artist: j.artist || '', album: j.album || '',
    status: j.playing ? 'Playing' : 'Paused',
    position: j.elapsedTime || 0, duration: j.duration || 0, positionAt: Number.isFinite(ts) ? ts : Date.now(),
    cover: coverId, canNext: true, canPrev: true, updated: Date.now(),
  };
  return media;
}
async function mediaCmd(c) {
  const bin = which('media-control');
  const map = { toggle: 'toggle-play-pause', next: 'next-track', prev: 'previous-track' };
  if (!bin || !map[c]) return null;
  await run(bin, [map[c]], { timeout: 4000 });
  await new Promise((r) => setTimeout(r, c === 'toggle' ? 150 : 400));   // le temps que le lecteur change d'état
  return readMedia();
}

// ── Clic sur un ninja : ramène la fenêtre (et l'onglet) de la session ─
function osa(script) { return new Promise((res) => execFile('/usr/bin/osascript', ['-e', script], { timeout: 5000 }, (e, out) => res(e ? null : String(out).trim()))); }
async function focusGhosttyByCwd(cwd) {
  const out = await osa(`set out to ""
    tell application "Ghostty"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with x in terminals of t
            set out to out & (id of x) & (ASCII character 9) & (working directory of x) & linefeed
          end repeat
        end repeat
      end repeat
    end tell
    return out`);
  const t = (out || '').split('\n').map((l) => l.split('\t')).find(([, wd]) => wd === cwd);
  if (!t || !/^[\w-]+$/.test(t[0])) return false;
  return (await osa(`tell application "Ghostty"
      focus terminal id "${t[0]}"
      activate
    end tell
    return "ok"`)) === 'ok';
}

// info = { session, status, codex } fournis par agent-core.js (fichiers de session, statut, entrée Codex)
async function focusSession(id, info) {
  // Codex : Codex Desktop → lien direct vers la conversation ; CLI → onglet Ghostty du même dossier
  const cx = info.codex;
  if (cx) {
    if (/desktop/i.test(cx.originator) && /^[0-9a-f-]{36}$/.test(cx.thread)) { execFile('/usr/bin/open', ['codex://threads/' + cx.thread]); return 'ok'; }
    if (cx.cwd && await focusGhosttyByCwd(cx.cwd)) return 'ok';
    execFile('/usr/bin/open', ['-a', 'Codex']);
    return 'ok';
  }
  const s = info.session;
  if (!s || !s.pid) return 'session inconnue';
  const procs = new Map((await sampleProcesses()).map((p) => [p.pid, p]));
  // remonte la chaîne de parents : tty de la session, puis l'application (.app) qui l'héberge
  let tty = null, app = null;
  for (let i = 0, p = procs.get(s.pid); p && i < 30; i++, p = procs.get(p.ppid)) {
    if (!tty) { const t = (await run('/bin/ps', ['-o', 'tty=', '-p', String(p.pid)])).trim(); if (t && t !== '??') tty = '/dev/' + t; }
    const m = /^(.*?\.app)\/Contents\/MacOS\//.exec(p.comm || '');
    // ignore les .app internes (ex. le binaire claude embarqué par Claude Desktop dans Application Support)
    if (m && !/\/Library\/Application Support\//.test(m[1])) { app = m[1]; break; }
  }
  if (!app) return 'fenêtre introuvable';
  const name = path.basename(app, '.app');
  if (tty && name === 'Terminal') {
    const r = await osa(`tell application "Terminal"
      repeat with w in windows
        repeat with t in tabs of w
          if tty of t is "${tty}" then
            set selected of t to true
            set index of w to 1
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end tell`);
    if (r === 'ok') return 'ok';
  }
  if (tty && /^iTerm/.test(name)) {
    const r = await osa(`tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if tty of s is "${tty}" then
              select w
              select t
              select s
              activate
              return "ok"
            end if
          end repeat
        end repeat
      end repeat
    end tell`);
    if (r === 'ok') return 'ok';
  }
  if (name === 'Ghostty') {
    // Ghostty ≥ 1.3 : AppleScript, terminaux avec titre et dossier de travail
    const SEP = 'ASCII character 9';
    const out = await osa(`set out to ""
    tell application "Ghostty"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with x in terminals of t
            set out to out & (id of x) & (${SEP}) & (working directory of x) & (${SEP}) & (name of x) & linefeed
          end repeat
        end repeat
      end repeat
    end tell
    return out`);
    const terms = (out || '').split('\n').filter(Boolean).map((l) => { const [id, wd, title] = l.split('\t'); return { id, wd, title: (title || '').replace(/^[^\p{L}\p{N}]+/u, '').trim() }; });
    const st = info.status || {};
    const t = (st.name && terms.find((x) => x.title === st.name)) || (st.name && terms.find((x) => x.title.includes(st.name)))
      || terms.find((x) => x.wd === s.cwd);
    if (t && /^[\w-]+$/.test(t.id)) {
      const r = await osa(`tell application "Ghostty"
        focus terminal id "${t.id}"
        activate
      end tell
      return "ok"`);
      if (r === 'ok') return 'ok';
    }
  }
  execFile('/usr/bin/open', ['-a', app]);
  return 'ok';
}

// ── Vraies icônes des IA, extraites des applis installées (PNG 64 px dans cache/icons) ──
const ICON_APPS = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini', windsurf: 'Windsurf', opencode: 'OpenCode', goose: 'Goose' };
async function buildIcons(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const icons = [];
  for (const [agent, name] of Object.entries(ICON_APPS)) {
    const app = ['/Applications', path.join(HOME, 'Applications')].map((d) => path.join(d, name + '.app')).find((p) => fs.existsSync(p));
    if (!app) continue;
    const out = path.join(dir, agent + '.png');
    try {
      if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(app).mtimeMs) {
        let file = (await run('/usr/bin/defaults', ['read', path.join(app, 'Contents/Info.plist'), 'CFBundleIconFile'])).trim() || 'AppIcon';
        if (!file.endsWith('.icns')) file += '.icns';
        await run('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '64', path.join(app, 'Contents/Resources', file), '--out', out]);
      }
      if (fs.existsSync(out)) icons.push(agent);
    } catch {}
  }
  return icons;
}

// Arrêt des sous-processus macOS (appelé par stop() du noyau)
function onStop() { try { macmon?.kill(); } catch {} }

// ── Démarrage : CLI (node agent-mac.js), port DOJO_PORT pour les tests ─
// onCreated fournit stop() dès la création de l'agent, avant la fin du démarrage (≈1 s) : un SIGTERM reçu pendant
// ce délai arrête aussi collector.js et macmon, au lieu de les laisser orphelins.
let stopAgent = null;
const stop = () => { try { stopAgent?.(); } catch {} onStop(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
startAgent({
  port: Number(process.env.DOJO_PORT) || 7777,   // DOJO_PORT ne sert qu'aux tests (port libre)
  root: ROOT,
  env: ENV,
  sampleProcesses, hideGroup, sampleNet, sampleDisks, sampleSensors, sampleBattery,
  sampleServers, stopServer, focusSession, openUrl,
  media: { read: readMedia, cmd: mediaCmd, coverFile: () => COVER },
  icons: buildIcons,
  onStop,
  onCreated: (fn) => { stopAgent = fn; },
}).catch((e) => {
  if (e.code === 'EADDRINUSE') process.exit(0);   // une seule instance
  throw e;
});
