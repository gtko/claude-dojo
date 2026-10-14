// Agent local du fond d'écran « Dojo » pour macOS : équivalent de agent.ps1 (Windows).
// Sert http://localhost:7777/stats (et la page elle-même sur http://localhost:7777/) :
// CPU, RAM, disques, top 5 processus, réseau, capteurs (macmon), serveurs locaux, musique (media-control) et sessions IA.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile, spawn } = require('child_process');

const PORT = 7777;
const HOME = os.homedir();
const ROOT = __dirname;
const WALL = path.join(ROOT, 'wallpaper');
const CACHE = path.join(ROOT, 'cache');
const DOJO = path.join(HOME, '.claude', 'dojo');
const STATUS = path.join(DOJO, 'status');
const CORES = os.cpus().length;
const BREW = ['/opt/homebrew/bin', '/usr/local/bin'];
const ENV = { ...process.env, PATH: [...BREW, process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].join(':') };
fs.mkdirSync(CACHE, { recursive: true });

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const config = () => readJson(path.join(ROOT, 'config.json'), {});
const run = (cmd, args, opts = {}) => new Promise((res) => execFile(cmd, args, { env: ENV, timeout: 8000, maxBuffer: 16 << 20, ...opts }, (e, out) => res(e && !out ? '' : String(out || ''))));
const which = (bin) => [...BREW, '/usr/bin'].map((d) => path.join(d, bin)).find((p) => fs.existsSync(p)) || null;

// ── CPU (deltas de os.cpus) ─────────────────────────────────────────
let prevCpu = os.cpus();
const cpuHistory = [];
function sampleCpu() {
  const cur = os.cpus();
  let idle = 0, total = 0;
  cur.forEach((c, i) => {
    const p = prevCpu[i] ? prevCpu[i].times : { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
    const t = c.times;
    const dt = (t.user - p.user) + (t.nice - p.nice) + (t.sys - p.sys) + (t.idle - p.idle) + (t.irq - p.irq);
    idle += t.idle - p.idle; total += dt;
  });
  prevCpu = cur;
  const pct = total > 0 ? Math.round(1000 * (1 - idle / total)) / 10 : 0;
  cpuHistory.push(pct); if (cpuHistory.length > 60) cpuHistory.shift();
  return pct;
}

// ── Processus : une seule passe de ps, réutilisée partout ──────────
let procs = new Map();      // pid -> { pid, ppid, cpu (% d'un cœur), rss, comm, args, etime }
let children = new Map();   // ppid -> [pid]
let top = [], topMem = [];
let selfPids = new Set();
function parseEtime(s) {      // [[dd-]hh:]mm:ss -> secondes
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  return m ? (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+m[3]) * 60 + (+m[4]) : null;
}
async function sampleProcesses() {
  const out = await run('/bin/ps', ['-axww', '-o', 'pid=,ppid=,pcpu=,rss=,etime=,args=']);
  const map = new Map(), kids = new Map();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const p = { pid: +m[1], ppid: +m[2], cpu: +m[3], rss: +m[4] * 1024, etime: parseEtime(m[5]), args: m[6] };
    map.set(p.pid, p);
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p.pid);
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
  procs = map; children = kids;

  // Processus du Dojo lui-même (agent + ses enfants + hôte du fond d'écran) : exclus des tops
  const self = new Set([process.pid]);
  const q = [process.pid];
  while (q.length) for (const c of kids.get(q.shift()) || []) if (!self.has(c)) { self.add(c); q.push(c); }
  for (const p of map.values()) if (/DojoWallpaper|com\.apple\.WebKit\.(WebContent|GPU|Networking)/.test(p.comm || '') && isDescendantOfName(p.pid, 'DojoWallpaper')) self.add(p.pid);
  selfPids = self;

  const groups = new Map();
  for (const p of map.values()) {
    if (self.has(p.pid) || !p.name || p.pid === 0) continue;
    const g = groups.get(p.name) || { name: p.name, cpu: 0, mem: 0, count: 0 };
    g.cpu += p.cpu; g.mem += p.rss; g.count++;
    groups.set(p.name, g);
  }
  const list = [...groups.values()].filter((g) => !/^(kernel_task|launchd|WindowServer)$/.test(g.name) || g.cpu > 5)
    .map((g) => ({ ...g, cpu: Math.round(10 * g.cpu / CORES) / 10 }));
  top = [...list].sort((a, b) => b.cpu - a.cpu || b.mem - a.mem).slice(0, 5);
  topMem = [...list].sort((a, b) => b.mem - a.mem).slice(0, 5);
}
function isDescendantOfName(pid, name) {
  for (let i = 0, p = procs.get(pid); p && i < 20; i++, p = procs.get(p.ppid)) if ((p.comm || '').includes(name)) return true;
  return false;
}
function tree(pid) {
  const set = new Set([pid]), q = [pid];
  while (q.length) for (const c of children.get(q.shift()) || []) if (!set.has(c)) { set.add(c); q.push(c); }
  return set;
}

// ── Mémoire, capteurs, puissance : macmon (sans sudo) ──────────────
let macmon = null, hw = null, memMacmon = null;
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

// ── Disques ─────────────────────────────────────────────────────────
let disks = [];
function sampleDisks() {
  const out = [];
  const add = (mount, name, label) => {
    try { const s = fs.statfsSync(mount); out.push({ name, label, total: s.blocks * s.bsize, free: s.bavail * s.bsize }); } catch {}
  };
  add('/System/Volumes/Data', 'Macintosh HD', '');
  // volumes montés en lecture seule (images .dmg, installeurs) : ignorés
  let ro = new Set();
  try { ro = new Set(require('child_process').execFileSync('/sbin/mount', { encoding: 'utf8' }).split('\n').filter((l) => /read-only/.test(l)).map((l) => (/ on (.+?) \(/.exec(l) || [])[1])); } catch {}
  try {
    for (const v of fs.readdirSync('/Volumes')) {
      const p = path.join('/Volumes', v);
      try { if (fs.realpathSync(p) === '/' || ro.has(p)) continue; } catch { continue; }
      add(p, v, '');
    }
  } catch {}
  disks = out;
}

// ── Réseau : débit total (netstat -ib) + ping ──────────────────────
let prevNet = null, net = null, pingMs = null, lastPing = 0;
const netHistory = [];
async function sampleNetwork() {
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
  let down = 0, up = 0;
  if (prevNet && now > prevNet.t) {
    const dt = (now - prevNet.t) / 1000;
    down = Math.max(0, (rx - prevNet.rx) / dt); up = Math.max(0, (tx - prevNet.tx) / dt);
  }
  prevNet = { rx, tx, t: now };
  if (now - lastPing >= 5000) {
    lastPing = now;
    run('/sbin/ping', ['-c', '1', '-t', '1', '1.1.1.1'], { timeout: 2000 }).then((o) => {
      const m = /time=([\d.]+)/.exec(o); pingMs = m ? Math.round(+m[1]) : null;
    });
  }
  netHistory.push({ d: Math.round(down), u: Math.round(up) }); if (netHistory.length > 60) netHistory.shift();
  net = { down, up, ping: pingMs, history: [...netHistory] };
}

// ── Batterie (ioreg AppleSmartBattery) ────────────────────────────
let battery = null;
async function sampleBattery() {
  const out = await run('/usr/sbin/ioreg', ['-rn', 'AppleSmartBattery']);
  if (!out) { battery = null; return; }
  const g = (k) => { const m = new RegExp('^\\s*"' + k + '" = (\\S+)', 'm').exec(out); return m ? m[1] : null; };
  const n = (k) => { const v = g(k); if (v == null || !/^-?\d+$/.test(v)) return null; const x = Number(v); return x > 2 ** 63 ? x - 2 ** 64 : x; };
  const pct = n('CurrentCapacity');
  if (pct == null) { battery = null; return; }
  const amps = n('InstantAmperage') ?? n('Amperage'), volts = n('Voltage');
  const left = n('TimeRemaining'), raw = n('AppleRawMaxCapacity'), design = n('DesignCapacity');
  battery = {
    percent: pct, plugged: g('ExternalConnected') === 'Yes', charging: g('IsCharging') === 'Yes', full: g('FullyCharged') === 'Yes',
    minutes: left != null && left < 65535 && left > 0 ? left : null,
    cycles: n('CycleCount'), health: raw && design ? Math.round(100 * raw / design) : null,
    temp: n('Temperature') != null ? n('Temperature') / 100 : null,
    watts: amps != null && volts != null ? Math.round(amps * volts / 1e5) / 10 : null,   // < 0 : décharge
  };
}

// ── Titres des sessions Claude ─────────────────────────────────────
const CLAUDE_SESSIONS = path.join(HOME, '.claude', 'sessions');   // <pid>.json : name, sessionId
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');   // <cwd encodé>/<sessionId>.jsonl
const titleCache = new Map();   // sessionId -> { m (mtime du transcript), t (titre) }
function sessionNames() {       // sessionId -> name ; « derived » = nom généré depuis le dossier, ignoré
  const names = new Map();
  let files = [];
  try { files = fs.readdirSync(CLAUDE_SESSIONS).filter((f) => f.endsWith('.json')); } catch {}
  for (const f of files) {
    const s = readJson(path.join(CLAUDE_SESSIONS, f), null);
    if (s?.sessionId && s.name && s.nameSource !== 'derived') names.set(s.sessionId, String(s.name).trim());
  }
  return names;
}
function transcriptFile(sid, cwd) {   // dossier = cwd encodé, sinon recherche (la session peut avoir changé de dossier)
  const enc = path.join(CLAUDE_PROJECTS, String(cwd || '').replace(/[^A-Za-z0-9]/g, '-'), sid + '.jsonl');
  if (fs.existsSync(enc)) return enc;
  try {
    for (const d of fs.readdirSync(CLAUDE_PROJECTS)) { const f = path.join(CLAUDE_PROJECTS, d, sid + '.jsonl'); if (fs.existsSync(f)) return f; }
  } catch {}
  return null;
}
function transcriptTitle(sid, cwd) {   // dernier customTitle du transcript, lu sur les 64 derniers Ko
  const c = titleCache.get(sid);
  if (c?.miss && Date.now() - c.miss < 30e3) return null;   // transcript introuvable : on ne refouille pas ~/.claude/projects à chaque cycle
  const file = c?.file || transcriptFile(sid, cwd);
  if (!file) { titleCache.set(sid, { miss: Date.now() }); return null; }
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (c && c.m === st.mtimeMs) return c.t;
  let t = c?.t ?? null;   // le titre sort des 64 derniers Ko quand la session s'allonge : on garde le précédent
  try {
    const len = Math.min(st.size, 64 * 1024), buf = Buffer.alloc(len), fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
    const last = buf.toString('utf8').split('\n').filter((l) => l.includes('"type":"custom-title"')).pop();
    if (last) t = JSON.parse(last).customTitle || t;
  } catch {}
  titleCache.set(sid, { file, m: st.mtimeMs, t });
  return t;
}

// ── Sessions Claude (écrites par hook.js) ──────────────────────────
function readSessions() {
  const now = Date.now(), list = [], names = sessionNames();
  let files = [];
  try { files = fs.readdirSync(DOJO).filter((f) => f.endsWith('.json')); } catch {}
  for (const f of files) {
    const s = readJson(path.join(DOJO, f), null);
    if (!s) continue;
    // processus Claude Code disparu (fermé sans SessionEnd) : session retirée
    if (s.pid) { try { process.kill(s.pid, 0); } catch (e) { if (e.code === 'ESRCH') { try { fs.rmSync(path.join(DOJO, f)); } catch {} continue; } } }
    // début réel de la session = démarrage du processus Claude Code (ordre stable des ninjas)
    const pp = procs.get(s.pid);
    if (pp?.etime != null) s.started = Math.round((Date.now() - pp.etime * 1000) / 10000) * 10000;
    // hôte : Claude Desktop ou terminal
    for (let i = 0, p = procs.get(s.pid); p && i < 12; i++, p = procs.get(p.ppid)) if (/^\/Applications\/Claude\.app\//.test(p.comm || '')) { s.host = 'desktop'; break; }
    // Desktop recharge d'anciennes sessions en arrière-plan : on ne montre que celles qui ont reçu un message
    if (s.host === 'desktop' && !(s.prompted || s.tool || s.state !== 'idle')) continue;
    const age = now - s.updated;
    if (s.state !== 'idle' && age > 20 * 60e3) { s.state = 'idle'; s.since = s.updated; }   // probablement fermée
    if (s.state === 'idle' && age > 6 * 3600e3) { try { fs.rmSync(path.join(DOJO, f)); } catch {} continue; }
    if (!s.agent) s.agent = 'claude';
    s.title = names.get(s.id) || transcriptTitle(s.id, s.cwd) || null;   // titre de la session, sinon null (dossier affiché)
    const st = readJson(path.join(STATUS, s.id + '.json'), null);
    if (st) for (const k of ['model', 'effort', 'ctx', 'fast']) s[k] = st[k];
    list.push(s);
  }
  return list.sort((a, b) => a.since - b.since);
}

// ── Autres IA (Codex, Gemini, OpenCode…) ───────────────────────────
const aiTrack = new Map();
const codexThreads = new Map();
// Dernière vraie activité d'un fil Codex : Codex Desktop réécrit des réglages (thread_settings_applied…)
// dans l'ancien fil quand on en ouvre un nouveau, ce qui ne doit pas le faire passer pour actif.
const CODEX_NOISE = /^(thread_settings_applied|session_meta|turn_context|token_count)$/;
const codexAct = new Map();   // fichier -> { m (mtime), t (activité) }
function codexActivity(file, mtime) {
  const c = codexAct.get(file);
  if (c && c.m === mtime) return c.t;
  let t = 0;
  try {
    const fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size, len = Math.min(size, 256 << 10), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const l of lines) {
      const type = (/"payload"\s*:\s*\{\s*"type"\s*:\s*"([^"]+)"/.exec(l) || [])[1], ts = (/^\{"timestamp":"([^"]+)"/.exec(l) || [])[1];
      if (ts && type && !CODEX_NOISE.test(type)) { t = Date.parse(ts) || 0; break; }
    }
  } catch {}
  codexAct.set(file, { m: mtime, t });
  return t;
}   // id ninja -> { thread (uuid), originator (Codex Desktop / CLI), cwd }
function track(id, working) {
  const st = working ? 'working' : 'idle';
  const t = aiTrack.get(id);
  if (!t || t.state !== st) aiTrack.set(id, { state: st, since: Date.now() });
  return aiTrack.get(id);
}
function readOtherAgents() {
  const now = Date.now(), list = [];
  const all = [...procs.values()];
  if (all.some((p) => p.name === 'codex')) {
    const root = path.join(HOME, '.codex', 'sessions');
    const files = [];
    for (const back of [0, 1]) {
      const d = new Date(now - back * 864e5);
      const dir = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
      try { for (const f of fs.readdirSync(dir)) if (/^rollout-.*\.jsonl$/.test(f)) { const p = path.join(dir, f); const m = fs.statSync(p).mtimeMs; if (now - m < 20 * 60e3) files.push({ p, f, m: codexActivity(p, m) }); } } catch {}
    }
    // sessions actives, ou inactives depuis moins de 20 min (pas celles de la veille restées ouvertes)
    for (const x of files.filter((x) => now - x.m < 20 * 60e3).sort((a, b) => b.m - a.m).slice(0, 4)) {
      const base = x.f.replace(/\.jsonl$/, '');
      const id = 'codex-' + base.slice(-12);
      const t = track(id, now - x.m < 20e3);
      let cwd = '', originator = '', started = null;
      try {
        const first = fs.readFileSync(x.p, 'utf8').split('\n', 1)[0];
        cwd = (/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(first) || [0, ''])[1];
        originator = (/"originator"\s*:\s*"([^"]*)"/.exec(first) || [0, ''])[1];
        started = Date.parse((/"timestamp"\s*:\s*"([^"]*)"/.exec(first) || [0, ''])[1]) || null;
      } catch {}
      codexThreads.set(id, { thread: base.slice(-36), originator, cwd });
      list.push({ id, agent: 'codex', cwd, state: t.state, tool: null, since: t.since, started, updated: now });
    }
  }
  const groups = new Map();
  for (const p of all) {
    let agent = null;
    if (p.name === 'node' || p.name === 'bun') {
      const m = /(gemini|qwen|@sourcegraph[\\/]amp|opencode)/i.exec(p.args || '');
      if (m) agent = m[1].toLowerCase().replace(/.*amp$/, 'amp');
    } else if (/^(opencode|aider|cursor-agent|crush|goose)$/.test(p.name)) agent = p.name;
    if (agent) groups.set(agent, (groups.get(agent) || 0) + p.cpu);
  }
  for (const [agent, cpu] of groups) {
    const id = agent + '-proc';
    const t = track(id, cpu > 1.5);
    list.push({ id, agent, cwd: '', state: t.state, tool: null, since: t.since, updated: now });
  }
  return list;
}

// ── Serveurs locaux en écoute ──────────────────────────────────────
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
let servers = [];
async function sampleServers() {
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
    const p = procs.get(id);
    if (!p || selfPids.has(id)) continue;
    if (/^\/(System|usr\/libexec|usr\/sbin|sbin)\//.test(p.comm || '')) continue;
    const cmd = p.args || p.comm || '';
    const cwd = cwds.get(id) || '';
    const project = projectFrom(cmd) || projectFrom(cwd + '/');
    if (!project && !DEV_NAMES.test(p.name) && !DEV_TITLES.test(cmd)) continue;
    let mem = 0, cpu = 0;
    const t = tree(id);
    for (const x of t) { const q = procs.get(x); if (q) { mem += q.rss; cpu += q.cpu; } }
    list.push({
      pid: id, name: p.name, what: whatFrom(p.name, cmd), project,
      ports: [...set].sort((a, b) => a - b), mem, cpu: Math.round(10 * cpu / CORES) / 10, procs: t.size,
      since: p.etime != null ? Date.now() - p.etime * 1000 : null,
    });
  }
  servers = list.sort((a, b) => a.ports[0] - b.ports[0]);
}
function stopServer(id) {
  if (!servers.some((s) => s.pid === id)) return 'refusé : pas un serveur listé';
  const t = [...tree(id)].reverse();
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
async function sampleMedia() {
  const bin = which('media-control');
  if (!bin) { media = null; return; }
  const out = await run(bin, ['get'], { timeout: 4000 });
  let j = null;
  try { j = JSON.parse(out); } catch {}
  if (!j || !j.title) { media = { active: false, updated: Date.now() }; return; }
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
}
async function mediaCmd(c) {
  const bin = which('media-control');
  const map = { toggle: 'toggle-play-pause', next: 'next-track', prev: 'previous-track' };
  if (!bin || !map[c]) return null;
  await run(bin, [map[c]], { timeout: 4000 });
  await new Promise((r) => setTimeout(r, c === 'toggle' ? 150 : 400));   // le temps que le lecteur change d'état
  await sampleMedia();
  lastMedia = Date.now();
  state.media = media;
  return media;
}

// ── Collecteur Node (usage IA, GitHub, météo, agenda…) ─────────────
let collector = null;
function ensureCollector() {
  if (collector) return;
  collector = spawn(process.execPath, [path.join(ROOT, 'collector.js')], { cwd: ROOT, env: ENV, stdio: 'ignore' });
  collector.on('exit', () => { collector = null; });
  collector.on('error', () => { collector = null; });
}
const readInsights = () => readJson(path.join(CACHE, 'insights.json'), null);

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

async function focusSession(id) {
  // Codex : Codex Desktop → lien direct vers la conversation ; CLI → onglet Ghostty du même dossier
  const cx = codexThreads.get(String(id));
  if (cx) {
    if (/desktop/i.test(cx.originator) && /^[0-9a-f-]{36}$/.test(cx.thread)) { execFile('/usr/bin/open', ['codex://threads/' + cx.thread]); return 'ok'; }
    if (cx.cwd && await focusGhosttyByCwd(cx.cwd)) return 'ok';
    execFile('/usr/bin/open', ['-a', 'Codex']);
    return 'ok';
  }
  const s = readJson(path.join(DOJO, String(id).replace(/[^\w-]/g, '') + '.json'), null);
  if (!s || !s.pid) return 'session inconnue';
  await sampleProcesses();
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
    const st = readJson(path.join(STATUS, s.id + '.json'), {});
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
const ICONS = path.join(CACHE, 'icons');
const icons = [];
async function buildIcons() {
  fs.mkdirSync(ICONS, { recursive: true });
  for (const [agent, name] of Object.entries(ICON_APPS)) {
    const app = ['/Applications', path.join(HOME, 'Applications')].map((d) => path.join(d, name + '.app')).find((p) => fs.existsSync(p));
    if (!app) continue;
    const out = path.join(ICONS, agent + '.png');
    try {
      if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(app).mtimeMs) {
        let file = (await run('/usr/bin/defaults', ['read', path.join(app, 'Contents/Info.plist'), 'CFBundleIconFile'])).trim() || 'AppIcon';
        if (!file.endsWith('.icns')) file += '.icns';
        await run('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '64', path.join(app, 'Contents/Resources', file), '--out', out]);
      }
      if (fs.existsSync(out)) icons.push(agent);
    } catch {}
  }
}

// ── Boucle d'échantillonnage ───────────────────────────────────────
let state = {}, lastBattery = 0, lastProc = 0, lastDisk = 0, lastServers = 0, lastMedia = 0, lastCheck = 0;
async function sample() {
  const now = Date.now();
  const cpu = sampleCpu();
  if (now - lastProc >= 3000) { lastProc = now; await sampleProcesses(); }
  if (now - lastDisk >= 60000) { lastDisk = now; sampleDisks(); }
  await sampleNetwork();
  if (now - lastServers >= 5000) { lastServers = now; await sampleServers(); }
  if (now - lastMedia >= 2000) { lastMedia = now; await sampleMedia(); }
  if (now - lastBattery >= 10000) { lastBattery = now; await sampleBattery(); }
  if (now - lastCheck >= 60000) { lastCheck = now; ensureCollector(); ensureMacmon(); }
  const mem = memMacmon || await memVmStat();
  state = {
    cpu, cpuName: chip, cpuHistory: [...cpuHistory], cores: CORES,
    memTotal: mem.total, memUsed: mem.used,
    disks, top, topMem, net,
    sessions: [...readSessions(), ...readOtherAgents()],
    hw, servers, media, battery, insights: readInsights(),
    uptime: Math.round(os.uptime()), time: Date.now(),
    icons,
    pageVersion: (() => { try { return fs.statSync(path.join(WALL, 'index.html')).mtimeMs; } catch { return null; } })(),
  };
}

// ── Serveur HTTP ───────────────────────────────────────────────────
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': type, 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Allow-Headers': '*',
  });
  res.end(body);
}
function sendFile(res, file) {
  fs.readFile(file, (e, b) => e ? send(res, 404, '{}') : send(res, 200, b, TYPES[path.extname(file)] || 'application/octet-stream'));
}
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const q = (k) => u.searchParams.get(k);
    if (req.method === 'OPTIONS') return send(res, 204, '');
    switch (u.pathname) {
      case '/stats': return send(res, 200, JSON.stringify(state));
      case '/focus': return send(res, 200, JSON.stringify({ result: await focusSession(q('id')).catch((e) => 'erreur: ' + e.message) }));
      case '/kill': return send(res, 200, JSON.stringify({ result: stopServer(+q('pid')) }));
      case '/open': return send(res, 200, JSON.stringify({ result: openUrl(q('url')) }));
      case '/media': return send(res, 200, JSON.stringify({ result: 'ok', media: await mediaCmd(q('cmd')) }));
      case '/cover': return sendFile(res, COVER);
      case '/icon': return /^[a-z]+$/.test(q('a') || '') ? sendFile(res, path.join(ICONS, q('a') + '.png')) : send(res, 404, '{}');
      default: {
        // la page du fond d'écran elle-même (hôte DojoWallpaper)
        const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname).replace(/^\/+/, '');
        const file = path.join(WALL, rel);
        if (!file.startsWith(WALL + path.sep)) return send(res, 404, '{}');
        return sendFile(res, file);
      }
    }
  } catch { send(res, 500, '{}'); }
});
server.on('error', (e) => { if (e.code === 'EADDRINUSE') process.exit(0); });   // une seule instance
server.listen(PORT, '127.0.0.1', async () => {
  ensureMacmon(); ensureCollector(); sampleDisks(); buildIcons().catch(() => {});
  await sampleProcesses();
  await new Promise((r) => setTimeout(r, 800));
  try { await sample(); } catch {}
  (async function loop() { try { await sample(); } catch {} setTimeout(loop, 2000); })();
});
const stop = () => { try { macmon?.kill(); collector?.kill(); } catch {} process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
