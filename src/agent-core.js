// Noyau portable de l'agent du Dojo : serveur HTTP sur 127.0.0.1 (protection Host/Origin), sessions Claude,
// thèmes et cycle d'échantillonnage. Aucun appel OS ici : la plateforme (agent-mac.js, agent-win.js) injecte
// ses échantillonneurs dans startAgent(opts). Tout échantillonneur est optionnel : absent ou en erreur, la valeur par défaut est servie.
//
// Contrat (mémoire et débits en octets, pourcentages de 0 à 100 sauf mention) :
//   port                  number, défaut 7777 (0 : port libre)
//   root                  dossier de l'agent (wallpaper/, themes/, config.json, cache/, collector.js), défaut : ce dossier
//   env                   environnement des enfants (collector.js), défaut process.env
//   sampleProcesses()     -> Promise<Proc[]>, toutes les 3 s. Proc = { pid, ppid, cpu (% d'un cœur), rss (octets),
//                            etime (secondes ou null), comm (chemin ou nom), name (exécutable sans chemin ni .exe),
//                            args (ligne de commande), hidden? (interface du Dojo ou bruit système : exclu des tops et
//                            des serveurs), desktop? (application Claude Desktop) }
//   hideGroup(name, cpu)  -> bool, optionnel : masque un groupe de processus des tops (cpu = somme brute)
//   sampleNet()           -> Promise<{ rx, tx, ping }>, toutes les 2 s. rx/tx : compteurs cumulés d'octets ; ping : ms ou null
//   sampleDisks()         -> Array<{ name, label, total, free }>, au démarrage puis toutes les 60 s
//   sampleSensors()       -> Promise<{ cpuName, hw, memory: { total, used } }>, à chaque cycle (2 s) ;
//                            hw = null ou { cpuTemp, cpuPower, cpuFan, gpuName, gpuTemp, gpuHot, gpuLoad, gpuPower, gpuFan, ssdTemp, sysPower }
//   sampleBattery()       -> Promise<{ percent, plugged, charging, full, minutes, cycles, health, temp, watts } | null>, toutes les 10 s
//   sampleServers(ctx)    -> Promise<Server[]>, à chaque cycle ; l'échantillonneur gère sa propre cadence (5 s).
//                            ctx = { procs: Map<pid, Proc>, tree(pid) -> Set<pid>, self: Set<pid>, cores: number }
//                            Server = { pid, name, what, project, ports: number[], mem, cpu, procs, since }
//   stopServer(pid, ctx)  -> string : 'ok' | 'échec' | 'refusé : …'
//   focusSession(id, info) -> Promise<string>, info = { session (JSON Claude ou null), status (objet ou {}), codex (entrée Codex ou null) }
//   openUrl(url)          -> string
//   media                 { read() -> Promise<Media|null> (toutes les 2 s), cmd('toggle'|'next'|'prev') -> Promise<Media|null>,
//                            coverFile() -> chemin|null } ; Media = { active, app, title, artist, album, status, position,
//                            duration, positionAt, cover, canNext, canPrev, updated }
//   icons(dir)            -> Promise<string[]>, une fois au démarrage : écrit dir/<agent>.png, renvoie les agents présents
//   onStop()              appelé par stop() pour libérer les sous-processus de la plateforme
//
// Retour : Promise<{ server, stop(), port }>, résolue quand le serveur écoute et que le premier échantillon est fait.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
// Appelle un échantillonneur optionnel : absent ou en erreur -> valeur par défaut.
const call = async (fn, dflt, ...args) => {
  if (typeof fn !== 'function') return dflt;
  try { const r = await fn(...args); return r ?? dflt; } catch { return dflt; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CPU_MODEL = (os.cpus()[0]?.model || '').trim() || 'CPU';

function startAgent(opts = {}) {
  const PORT = opts.port ?? 7777;
  const ROOT = opts.root ?? __dirname;
  const ENV = opts.env ?? process.env;
  const WALL = path.join(ROOT, 'wallpaper');
  const THEMES = path.join(ROOT, 'themes');
  const CACHE = path.join(ROOT, 'cache');
  const ICONS = path.join(CACHE, 'icons');
  const HOME = os.homedir();
  const DOJO = path.join(HOME, '.claude', 'dojo');   // sessions écrites par hook.js
  const STATUS = path.join(DOJO, 'status');
  const CLAUDE_SESSIONS = path.join(HOME, '.claude', 'sessions');   // <pid>.json : name, sessionId
  const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');   // <cwd encodé>/<sessionId>.jsonl
  const BG_DIR = path.join(HOME, '.config', 'claude-dojo', 'backgrounds');   // fonds personnels, copiés par l'installeur
  const CORES = os.cpus().length;
  const config = () => readJson(path.join(ROOT, 'config.json'), {});
  const mediaApi = opts.media || {};
  fs.mkdirSync(ICONS, { recursive: true });

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

  // ── Processus : fournis par la plateforme, indexés ici ─────────────
  let procs = new Map();      // pid -> Proc
  let children = new Map();   // ppid -> [pid]
  let selfPids = new Set();   // agent + ses enfants, processus hidden
  let top = [], topMem = [];
  function tree(pid) {
    const set = new Set([pid]), q = [pid];
    while (q.length) for (const c of children.get(q.shift()) || []) if (!set.has(c)) { set.add(c); q.push(c); }
    return set;
  }
  function setProcesses(list) {
    const map = new Map(), kids = new Map();
    for (const p of list) {
      map.set(p.pid, p);
      if (!kids.has(p.ppid)) kids.set(p.ppid, []);
      kids.get(p.ppid).push(p.pid);
    }
    // Processus du Dojo lui-même (agent + ses enfants) et ceux marqués hidden : exclus des tops et des serveurs
    const self = new Set([process.pid]);
    const q = [process.pid];
    while (q.length) for (const c of kids.get(q.shift()) || []) if (!self.has(c)) { self.add(c); q.push(c); }
    for (const p of map.values()) if (p.hidden) self.add(p.pid);
    const groups = new Map();
    for (const p of map.values()) {
      if (self.has(p.pid) || !p.name || p.pid === 0) continue;
      const g = groups.get(p.name) || { name: p.name, cpu: 0, mem: 0, count: 0 };
      g.cpu += p.cpu; g.mem += p.rss; g.count++;
      groups.set(p.name, g);
    }
    const shown = [...groups.values()].filter((g) => !(opts.hideGroup && opts.hideGroup(g.name, g.cpu)))
      .map((g) => ({ ...g, cpu: Math.round(10 * g.cpu / CORES) / 10 }));
    top = [...shown].sort((a, b) => b.cpu - a.cpu || b.mem - a.mem).slice(0, 5);
    topMem = [...shown].sort((a, b) => b.mem - a.mem).slice(0, 5);
    procs = map; children = kids; selfPids = self;
  }
  const ctx = () => ({ procs, tree, self: selfPids, cores: CORES });

  // ── Titres des sessions Claude ─────────────────────────────────────
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
      for (let i = 0, p = procs.get(s.pid); p && i < 12; i++, p = procs.get(p.ppid)) if (p.desktop) { s.host = 'desktop'; break; }
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
  const codexThreads = new Map();   // id ninja -> { thread (uuid), originator (Codex Desktop / CLI), cwd }
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
  }
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

  // ── Réseau : débit calculé ici à partir des compteurs de la plateforme ──
  let prevNet = null, net = null;
  const netHistory = [];
  async function sampleNetwork() {
    const n = await call(opts.sampleNet, { rx: 0, tx: 0, ping: null });
    const now = Date.now();
    let down = 0, up = 0;
    if (prevNet && now > prevNet.t) {
      const dt = (now - prevNet.t) / 1000;
      down = Math.max(0, ((n.rx || 0) - prevNet.rx) / dt); up = Math.max(0, ((n.tx || 0) - prevNet.tx) / dt);
    }
    prevNet = { rx: n.rx || 0, tx: n.tx || 0, t: now };
    netHistory.push({ d: Math.round(down), u: Math.round(up) }); if (netHistory.length > 60) netHistory.shift();
    net = { down, up, ping: n.ping ?? null, history: [...netHistory] };
  }

  // ── État publié par /stats ─────────────────────────────────────────
  let state = {};
  let disks = [], battery = null, media = null, servers = [], icons = [], hw = null, cpuName = CPU_MODEL;
  let lastProc = 0, lastDisk = 0, lastMedia = 0, lastBattery = 0, lastCheck = 0;

  // ── Collecteur Node (usage IA, GitHub, météo, agenda…) ─────────────
  let collector = null;
  function ensureCollector() {
    if (collector) return;
    const script = path.join(ROOT, 'collector.js');
    if (!fs.existsSync(script)) return;
    collector = spawn(process.execPath, [script], { cwd: ROOT, env: ENV, stdio: 'ignore' });
    collector.on('exit', () => { collector = null; });
    collector.on('error', () => { collector = null; });
  }
  const readInsights = () => readJson(path.join(CACHE, 'insights.json'), null);

  // ── Thèmes : themes/<id>/theme.json (palette, vocabulaire, persos, objet d'entraînement) ──
  const BG_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.heic'];   // liste blanche : SVG et HTML jamais servis comme fond
  const BG_THEME_RE = /^[a-z0-9-]+$/;   // sous-dossier de thème : backgrounds/<theme>/, un seul niveau
  const THEME_DEFAULT = 'naruto';
  const readTheme = (id) => {   // theme.json d'un id valide, lisible et objet JSON ; sinon null
    if (!/^[a-z0-9-]+$/.test(id)) return null;
    const t = readJson(path.join(THEMES, id, 'theme.json'), null);
    return t && typeof t === 'object' && !Array.isArray(t) ? t : null;
  };
  // config.background : image réelle, confinée à BG_DIR, sinon null. Acceptés : backgrounds/<fichier> et
  // backgrounds/<theme>/<fichier>. Refusés : « .. », lien symbolique à n'importe quel maillon (sous-dossier ou fichier),
  // lien sortant (realpath), deux niveaux ou plus, extension hors BG_EXT, fichier non régulier.
  // ver = mtime + hash court du chemin réel : deux fichiers différents ne partagent jamais la même version.
  function customBg() {
    const f = config().background;
    if (typeof f !== 'string' || !f || !path.isAbsolute(f) || f.includes('\0') || f.split(/[\\/]/).includes('..')) return null;
    try {
      const rel = path.relative(BG_DIR, f).split(path.sep);   // maillons tels qu'écrits dans la config
      if (rel.length > 2 || rel[0] === '..' || (rel.length === 2 && !BG_THEME_RE.test(rel[0]))) return null;
      let link = BG_DIR;
      for (const seg of rel) {
        link = path.join(link, seg);
        if (fs.lstatSync(link).isSymbolicLink()) return null;
      }
      const dir = fs.realpathSync(BG_DIR), file = fs.realpathSync(f);
      const inner = path.relative(dir, file).split(path.sep);   // même forme une fois résolu
      if (inner.length > 2 || inner[0] === '..' || (inner.length === 2 && !BG_THEME_RE.test(inner[0]))) return null;
      if (!BG_EXT.includes(path.extname(file).toLowerCase())) return null;
      const st = fs.statSync(file);
      if (!st.isFile()) return null;
      const hash = crypto.createHash('sha1').update(file).digest('hex').slice(0, 8);
      return { file, ver: `${Math.floor(st.mtimeMs)}-${hash}` };
    } catch { return null; }
  }
  // wanted : id demandé en aperçu (GET /theme?id=…), sans toucher à la config ; absent : thème de la config.
  // Thème inconnu ou theme.json illisible : naruto. L'aperçu ignore le fond personnel.
  function themeData(wanted) {
    const preview = wanted !== undefined;
    let id = preview ? wanted : (typeof config().theme === 'string' ? config().theme : THEME_DEFAULT);
    let t = readTheme(id);
    if (!t) { id = THEME_DEFAULT; t = readTheme(id) || {}; }
    const bg = preview ? null : customBg();
    return {
      id, name: t.name || id, credit: t.credit || '', accentFont: t.accentFont || null,
      palette: t.palette || {}, vocab: t.vocab || {}, prop: t.prop || 'post', propColors: t.propColors || [],
      chars: Array.isArray(t.chars) ? t.chars : [],
      background: bg ? `/custom-bg?v=${bg.ver}` : `/themes/${id}/background.jpg`,
      themeKey: `${id}|${bg ? bg.ver : ''}`,
    };
  }

  // ── Cycle d'échantillonnage ────────────────────────────────────────
  async function refreshProcesses() { setProcesses(await call(opts.sampleProcesses, [])); }
  async function sample() {
    const now = Date.now();
    const cpu = sampleCpu();
    if (now - lastProc >= 3000) { lastProc = now; await refreshProcesses(); }
    if (now - lastDisk >= 60000) { lastDisk = now; disks = await call(opts.sampleDisks, disks); }
    await sampleNetwork();
    servers = await call(opts.sampleServers, servers, ctx());
    if (now - lastMedia >= 2000) { lastMedia = now; media = await call(mediaApi.read, null); }
    if (now - lastBattery >= 10000) { lastBattery = now; battery = await call(opts.sampleBattery, null); }
    if (now - lastCheck >= 60000) { lastCheck = now; ensureCollector(); }
    const sen = await call(opts.sampleSensors, {});
    const mem = sen.memory || { total: os.totalmem(), used: os.totalmem() - os.freemem() };
    hw = sen.hw ?? null;
    cpuName = sen.cpuName || CPU_MODEL;
    state = {
      cpu, cpuName, cpuHistory: [...cpuHistory], cores: CORES,
      memTotal: mem.total, memUsed: mem.used,
      disks, top, topMem, net,
      sessions: [...readSessions(), ...readOtherAgents()],
      hw, servers, media, battery, insights: readInsights(),
      uptime: Math.round(os.uptime()), time: Date.now(),
      icons,
      themeKey: themeData().themeKey,
      pageVersion: (() => { try { return fs.statSync(path.join(WALL, 'index.html')).mtimeMs; } catch { return null; } })(),
    };
  }
  let timer = null, running = false;
  async function loop() {
    try { await sample(); } catch {}
    if (running) timer = setTimeout(loop, 2000);
  }

  // ── Serveur HTTP ───────────────────────────────────────────────────
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic', '.svg': 'image/svg+xml', '.json': 'application/json' };
  // Toutes les réponses : pas de reniflage de type (nosniff). Fichiers utilisateur et thèmes : CSP sandbox en plus.
  const SANDBOX = { 'Content-Security-Policy': 'sandbox' };
  function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(body);
  }
  // Protection CSRF / DNS rebinding : seule la page servie par cet agent (même origine, loopback) peut
  // lire ou déclencher une action. Un site tiers ouvert dans le navigateur reçoit un 403.
  let boundPort = PORT;   // port réellement écouté (utile avec port 0)
  function isOwnRequest(req) {
    const h = req.headers;
    const hosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`];
    const origins = [`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`];
    if (!hosts.includes(h.host)) return false;
    if (h.origin !== undefined && !origins.includes(h.origin)) return false;
    if (h['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(h['sec-fetch-site'])) return false;
    return true;
  }
  function sendFile(res, file, extra = {}) {
    fs.readFile(file, (e, b) => e ? send(res, 404, '{}') : send(res, 200, b, TYPES[path.extname(file)] || 'application/octet-stream', extra));
  }
  async function focus(id) {
    if (typeof opts.focusSession !== 'function') return 'non pris en charge';
    const session = readJson(path.join(DOJO, String(id).replace(/[^\w-]/g, '') + '.json'), null);
    const info = {
      session,
      status: session ? readJson(path.join(STATUS, session.id + '.json'), {}) : {},
      codex: codexThreads.get(String(id)) || null,
    };
    try { return await opts.focusSession(id, info); } catch (e) { return 'erreur: ' + e.message; }
  }
  async function handle(req, res) {
    try {
      if (!isOwnRequest(req)) return send(res, 403, '{}');
      const u = new URL(req.url, 'http://localhost');
      const q = (k) => u.searchParams.get(k);
      switch (u.pathname) {
        case '/stats': return send(res, 200, JSON.stringify(state));
        case '/focus': return send(res, 200, JSON.stringify({ result: await focus(q('id')) }));
        case '/kill': return send(res, 200, JSON.stringify({ result: await call(opts.stopServer, 'refusé : non pris en charge', +q('pid'), ctx()) }));
        case '/open': return send(res, 200, JSON.stringify({ result: await call(opts.openUrl, 'non pris en charge', q('url')) }));
        case '/media': {
          const m = await call(mediaApi.cmd, null, q('cmd'));
          if (m) { media = m; state.media = m; lastMedia = Date.now(); }
          return send(res, 200, JSON.stringify({ result: 'ok', media: m }));
        }
        case '/cover': {
          const f = typeof mediaApi.coverFile === 'function' ? mediaApi.coverFile() : null;
          return f ? sendFile(res, f) : send(res, 404, '{}');
        }
        case '/icon': return /^[a-z]+$/.test(q('a') || '') ? sendFile(res, path.join(ICONS, q('a') + '.png')) : send(res, 404, '{}');
        case '/theme': return send(res, 200, JSON.stringify(themeData(u.searchParams.has('id') ? q('id') : undefined)));
        case '/custom-bg': { const bg = customBg(); return bg ? sendFile(res, bg.file, SANDBOX) : send(res, 404, '{}'); }
        default: {
          // fichiers des thèmes : id et nom de fichier en liste blanche
          const th = /^\/themes\/([a-z0-9-]+)\/(background\.jpg|thumbnail\.jpg|theme\.json)$/.exec(u.pathname);
          if (th) return sendFile(res, path.join(THEMES, th[1], th[2]), SANDBOX);
          if (u.pathname.startsWith('/themes/')) return send(res, 404, '{}');
          // la page du fond d'écran elle-même
          let rel;
          try { rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname).replace(/^\/+/, ''); }
          catch { return send(res, 404, '{}'); }   // encodage invalide (%E0%A4%A…)
          if (rel.includes('\0')) return send(res, 404, '{}');
          const file = path.join(WALL, rel);
          if (!file.startsWith(WALL + path.sep)) return send(res, 404, '{}');
          return sendFile(res, file);
        }
      }
    } catch { send(res, 500, '{}'); }
  }

  // ── Démarrage et arrêt ─────────────────────────────────────────────
  const server = http.createServer(handle);
  function stop() {
    running = false; clearTimeout(timer);
    try { collector?.kill(); } catch {}
    try { opts.onStop?.(); } catch {}
    server.close();
    server.closeAllConnections?.();
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject);   // EADDRINUSE etc. : laissé à l'appelant
    server.listen(PORT, '127.0.0.1', async () => {
      server.removeListener('error', reject);
      boundPort = server.address().port;
      ensureCollector();
      disks = await call(opts.sampleDisks, disks);
      call(opts.icons, [], ICONS).then((l) => { icons = l; });
      await refreshProcesses();
      await sleep(800);
      try { await sample(); } catch {}
      running = true;
      loop();
      resolve({ server, stop, port: boundPort });
    });
  });
}

module.exports = { startAgent };
