// Collecteur « Dojo » : usage IA (€), GitHub, projets locaux, Sentry, météo, agenda.
// Tourne en continu et écrit cache/insights.json, lu par l'agent local (agent-mac.js).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const HOME = os.homedir();
const ROOT = __dirname;
const CACHE = path.join(ROOT, 'cache');
const OUT = path.join(CACHE, 'insights.json');
const STATE = path.join(CACHE, 'usage-state.json');
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
const CLAUDE_STATUS = path.join(HOME, '.claude', 'dojo', 'status');
const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions');
const KEEP_MS = 15 * 864e5;

fs.mkdirSync(CACHE, { recursive: true });
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const config = () => readJson(path.join(ROOT, 'config.json'), {});
const insights = readJson(OUT, {});
const save = () => { insights.updated = Date.now(); fs.writeFileSync(OUT + '.tmp', JSON.stringify(insights)); fs.renameSync(OUT + '.tmp', OUT); };
const log = (...a) => fs.appendFileSync(path.join(CACHE, 'collector.log'), new Date().toISOString() + ' ' + a.join(' ') + '\n');

// ── Tarifs Claude ($/MTok, tarifs API publics) ───────────────────────
// [préfixe, entrée, sortie, lecture cache]  — écriture cache 5 min = 1,25× entrée, 1 h = 2× entrée
const PRICES = [
  ['claude-fable-5-1', 10, 50, .25], ['claude-mythos-5-1', 10, 50, .25],
  ['claude-fable-5', 10, 50, 1], ['claude-mythos-5', 10, 50, 1],
  ['claude-opus-5-5', 4, 20, .2], ['claude-opus-5', 5, 25, .5],
  ['claude-opus-4-1', 15, 75, 1.5], ['claude-opus-4-2', 15, 75, 1.5], ['claude-opus-4', 5, 25, .5],
  ['claude-sonnet-5', 2, 10, .2], ['claude-sonnet-4', 3, 15, .3], ['claude-3', 3, 15, .3],
  ['claude-haiku-5-5', .1, .5, .01], ['claude-haiku-4', 1, 5, .1],
];
const priceOf = (model) => PRICES.find(([p]) => model.startsWith(p)) || null;
const prettyModel = (m) => m.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1')
  .replace(/^\w/, (c) => c.toUpperCase());

// Coût ventilé : entrée, sortie, écriture cache, lecture cache ($)
function costParts(r) {
  const p = priceOf(r.model);
  if (!p) return { i: 0, o: 0, w: 0, cr: 0 };
  const [, inp, out, cr] = p;
  const k = (r.speed === 'fast' ? 2 : 1) / 1e6;
  return { i: k * r.i * inp, o: k * r.o * out, w: k * (r.w5 * inp * 1.25 + r.w1 * inp * 2), cr: k * r.cr * cr };
}
// Économie du cache : ce que les jetons relus auraient coûté au prix d'entrée normal
function cacheSavedUsd(r) {
  const p = priceOf(r.model);
  return p ? (r.speed === 'fast' ? 2 : 1) * r.cr * (p[1] - p[3]) / 1e6 : 0;
}
const costUsd = (r) => { const c = costParts(r); return c.i + c.o + c.w + c.cr; };

// ── Lecture incrémentale des fichiers JSONL ──────────────────────────
const state = readJson(STATE, { offsets: {}, claude: {}, codex: {}, codexLimits: null });
// v2 : lignes produites par outil (tl) dans state.claude. Une seule relecture complète des JSONL Claude ; Codex n'est pas touché.
const SCHEMA = 2;
if (state.v !== SCHEMA) {
  for (const f in state.offsets) if (f.startsWith(CLAUDE_PROJECTS + path.sep)) delete state.offsets[f];
  state.v = SCHEMA;
}

function* walk(dir, depth = 0) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 6) yield* walk(p, depth + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

function readNewLines(file, onLine) {
  let st; try { st = fs.statSync(file); } catch { return; }
  if (Date.now() - st.mtimeMs > KEEP_MS) return;
  let off = state.offsets[file] || 0;
  if (off > st.size) off = 0;
  if (off === st.size) return;
  const fd = fs.openSync(file, 'r');
  try {
    const CHUNK = 8 << 20;
    let rest = '';
    while (off < st.size) {
      const buf = Buffer.alloc(Math.min(CHUNK, st.size - off));
      const n = fs.readSync(fd, buf, 0, buf.length, off);
      if (!n) break;
      off += n;
      const text = rest + buf.toString('utf8', 0, n);
      const lines = text.split('\n');
      rest = lines.pop();
      for (const l of lines) onLine(l);
    }
    state.offsets[file] = off - Buffer.byteLength(rest);   // la ligne incomplète sera relue
  } finally { fs.closeSync(fd); }
}

// Lignes produites par les outils d'édition (Write, Edit, MultiEdit, NotebookEdit). Lignes vides ignorées.
const nonBlank = (s) => typeof s === 'string' ? s.split('\n').filter((l) => l.trim() !== '') : [];
// Lignes ajoutées par un Edit : lignes de new absentes de old (multiset ligne à ligne)
function addedLines(oldS, newS) {
  const seen = new Map();
  for (const l of nonBlank(oldS)) seen.set(l, (seen.get(l) || 0) + 1);
  let n = 0;
  for (const l of nonBlank(newS)) {
    const c = seen.get(l) || 0;
    if (c) seen.set(l, c - 1); else n++;
  }
  return n;
}
function locOfTool(b) {
  const x = b.input || {};
  if (b.name === 'Write') return nonBlank(x.content).length;
  if (b.name === 'Edit') return addedLines(x.old_string, x.new_string);
  if (b.name === 'MultiEdit') return (Array.isArray(x.edits) ? x.edits : []).reduce((a, e) => a + addedLines(e?.old_string, e?.new_string), 0);
  if (b.name === 'NotebookEdit') return nonBlank(x.new_source).length;
  return 0;
}
// Total d'un enregistrement : une entrée par tool_use id, donc relire une même ligne ne compte pas deux fois
const locOf = (r) => Object.values(r.tl || {}).reduce((a, n) => a + n, 0);

function scanClaude() {
  for (const file of walk(CLAUDE_PROJECTS)) {
    readNewLines(file, (line) => {
      if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
      let o; try { o = JSON.parse(line); } catch { return; }
      const m = o.message;
      if (!m || !m.usage || !m.model || m.model.startsWith('<')) return;
      const id = m.id || o.requestId || o.uuid;
      const u = m.usage, cc = u.cache_creation || {};
      const w1 = cc.ephemeral_1h_input_tokens || 0;
      const w5 = cc.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - w1);
      const effort = (line.match(/"effort":"(\w+)"/) || [])[1] || 'n/a';
      const speed = u.speed || (line.match(/"speed":"(\w+)"/) || [])[1] || 'standard';
      // streaming : un bloc de contenu par ligne, même message id → on reprend les tool_use déjà comptés
      const tl = { ...state.claude[id]?.tl };
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type !== 'tool_use' || !b.id) continue;
        const n = locOfTool(b);
        if (n) tl[b.id] = n;
      }
      const rec = {
        t: Date.parse(o.timestamp), model: m.model, effort, speed,
        i: u.input_tokens || 0, o: u.output_tokens || 0, cr: u.cache_read_input_tokens || 0, w5, w1,
        // session (le fichier), projet, et sous-agent : utilisés par le coach
        s: path.basename(file, '.jsonl'), p: path.basename(o.cwd || '') || '~', sub: !!o.isSidechain || file.includes('subagents'),
      };
      if (Object.keys(tl).length) rec.tl = tl;   // omis quand vide (taille du state)
      state.claude[id] = rec;
    });
  }
}

function scanCodex() {
  for (const file of walk(CODEX_SESSIONS)) {
    let model = state.codexModel?.[file] || null;
    readNewLines(file, (line) => {
      if (line.includes('"turn_context"')) {
        const mm = line.match(/"model":"([^"]+)"/); if (mm) { model = mm[1]; (state.codexModel ??= {})[file] = model; }
        return;
      }
      if (!line.includes('"token_count"')) return;
      let o; try { o = JSON.parse(line); } catch { return; }
      const p = o.payload || {};
      const t = Date.parse(o.timestamp);
      const last = p.info?.last_token_usage;
      if (last) state.codex[file + '#' + (o.ordinal ?? t)] = { t, model, i: last.input_tokens || 0, cr: last.cached_input_tokens || 0, o: last.output_tokens || 0 };
      const rl = p.rate_limits;
      if (rl && (rl.primary || rl.secondary) && (!state.codexLimits || t >= state.codexLimits.t)) {
        state.codexLimits = { t, plan: rl.plan_type, primary: rl.primary, secondary: rl.secondary };
      }
    });
  }
}

function prune() {
  const min = Date.now() - KEEP_MS;
  for (const k of ['claude', 'codex']) for (const id in state[k]) if (!(state[k][id].t > min)) delete state[k][id];
  for (const f in state.offsets) if (!fs.existsSync(f)) delete state.offsets[f];
}

function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }
function startOfWeek() { const x = new Date(); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.getTime(); }

function latestClaudeLimits() {
  let best = null;
  try {
    for (const f of fs.readdirSync(CLAUDE_STATUS)) {
      const s = readJson(path.join(CLAUDE_STATUS, f), null);
      if (s?.rate_limits && (!best || s.updated > best.updated)) best = s;
    }
  } catch {}
  return best ? { ...best.rate_limits, updated: best.updated } : null;
}

// ── Coach : où le contexte et le cache coûtent, et combien on peut gagner ──
// Estimations sur les 7 derniers jours, en €/semaine.
const LONG_CTX = 150e3, TARGET_CTX = 80e3;
function coach(recs, eur) {
  const ctxOf = (r) => r.i + r.cr + r.w5 + r.w1;
  const mult = (r) => (r.speed === 'fast' ? 2 : 1) / 1e6;
  const total = recs.reduce((a, r) => a + costUsd(r), 0);
  const cr = recs.reduce((a, r) => a + r.cr, 0), w = recs.reduce((a, r) => a + r.w5 + r.w1, 0), inp = recs.reduce((a, r) => a + r.i, 0);
  const ctxs = recs.map(ctxOf).sort((a, b) => a - b);
  const stats = {
    reqs: recs.length,
    hit: cr + w + inp ? 100 * cr / (cr + w + inp) : 0,
    ctxMedian: ctxs[ctxs.length >> 1] || 0,
    ctxP90: ctxs[Math.floor(ctxs.length * .9)] || 0,
    perReq: recs.length ? total * eur / recs.length : 0,
    longShare: recs.length ? 100 * ctxs.filter((c) => c > LONG_CTX).length / recs.length : 0,
  };
  const tips = [];

  // 1) contextes trop longs : chaque requête relit tout l'historique
  let longUsd = 0, longN = 0;
  for (const r of recs) {
    const c = ctxOf(r), p = priceOf(r.model);
    if (c <= LONG_CTX || !p) continue;
    longN++; longUsd += mult(r) * Math.min(r.cr, c - TARGET_CTX) * p[3];
  }
  if (longN) tips.push({ kind: 'ctx', save: longUsd * eur,
    text: `${longN} requêtes ont relu plus de 150k jetons de contexte (médiane ${Math.round(stats.ctxMedian / 1e3)}k). Lance /compact ou /clear entre deux tâches.` });

  // 2) sessions marathon : la plus chère, et son contexte moyen
  const bySess = {};
  for (const r of recs) { const s = (bySess[r.s || '?'] ??= { p: r.p || '~', usd: 0, n: 0, ctx: 0, list: [] }); s.usd += costUsd(r); s.n++; s.ctx += ctxOf(r); s.list.push(r); }
  const top = Object.values(bySess).sort((a, b) => b.usd - a.usd)[0];
  if (top && total && top.usd / total > .3 && top.n > 40) {
    const avg = top.ctx / top.n;
    // si on repartait à neuf toutes les ~40 requêtes, le contexte moyen tomberait vers TARGET_CTX
    const p = priceOf(top.list[0].model);
    const save = p && avg > TARGET_CTX ? top.list.reduce((a, r) => a + mult(r) * Math.max(0, Math.min(r.cr, ctxOf(r) - TARGET_CTX)) * p[3], 0) * .5 : 0;
    tips.push({ kind: 'session', save: save * eur,
      text: `La session « ${top.p} » pèse ${Math.round(100 * top.usd / total)} % du coût (${top.n} requêtes, ${Math.round(avg / 1e3)}k de contexte en moyenne). Une session par tâche coûte bien moins cher.` });
  }

  // 3) cache reconstruit en cours de session (pause trop longue, changement de modèle, CLAUDE.md modifié…)
  let rebN = 0, rebUsd = 0;
  for (const s of Object.values(bySess)) {
    s.list.sort((a, b) => a.t - b.t);
    for (let k = 1; k < s.list.length; k++) {
      const r = s.list[k], p = priceOf(r.model);
      if (!p || r.w5 + r.w1 < 30e3) continue;
      rebN++;
      rebUsd += mult(r) * ((r.w5 * 1.25 + r.w1 * 2) * p[1] - (r.w5 + r.w1) * p[3]);
    }
  }
  if (rebN) tips.push({ kind: 'rebuild', save: rebUsd * eur * .7,
    text: `Le cache a été reconstruit ${rebN} fois en cours de session (pause de plus d'1 h, changement de modèle ou de config). Évite de changer de modèle en plein travail.` });

  // 4) tout en Opus : les tâches simples passeraient en Sonnet (même prix de lecture du cache)
  const opus = recs.filter((r) => /opus|fable|mythos/.test(r.model));
  const opusUsd = opus.reduce((a, r) => a + costUsd(r), 0);
  if (total && opusUsd / total > .7) {
    const alt = opus.reduce((a, r) => a + costUsd(r) - costUsd({ ...r, model: 'claude-sonnet-5' }), 0);
    if (alt > 0) tips.push({ kind: 'model', save: alt * .3 * eur,
      text: `${Math.round(100 * opusUsd / total)} % du coût en ${prettyModel(opus[0].model)}. Passer les tâches simples (tests, renommages, docs) en Sonnet avec /model.` });
  }

  // 5) mode rapide : facturé ×2
  const fastUsd = recs.filter((r) => r.speed === 'fast').reduce((a, r) => a + costUsd(r), 0);
  if (fastUsd > 0) tips.push({ kind: 'fast', save: fastUsd / 2 * eur, text: `Le mode rapide (/fast) double le prix : ${Math.round(100 * fastUsd / total)} % du coût cette semaine.` });

  const sorted = tips.filter((t) => t.save >= .5).sort((a, b) => b.save - a.save);
  return { stats, tips: sorted, potential: sorted.filter((t) => t.kind !== 'session').reduce((a, t) => a + t.save, 0) };   // « session » recoupe « ctx »
}

function usage() {
  scanClaude(); scanCodex(); prune();
  fs.writeFileSync(STATE, JSON.stringify(state));

  const eur = insights.fx?.usdEur || 0.92;
  const day0 = startOfDay(), week0 = startOfDay(new Date(Date.now() - 6 * 864e5));   // 7 jours glissants
  const sum = () => ({ usd: 0, msgs: 0, i: 0, o: 0, cr: 0, w: 0, cost: { i: 0, o: 0, w: 0, cr: 0 }, saved: 0 });
  const today = sum(), week = sum();
  const byModel = {}, byEffort = {}, daily = {};
  const readByModel = {}, writeByModel = {};   // tokens 7 j par modèle : lus (entrée + cache) et écrits (sortie)
  for (let d = 13; d >= 0; d--) daily[startOfDay(new Date(Date.now() - d * 864e5))] = 0;

  for (const r of Object.values(state.claude)) {
    const parts = costParts(r), saved = cacheSavedUsd(r), c = parts.i + parts.o + parts.w + parts.cr;
    const add = (s) => { s.usd += c; s.msgs++; s.i += r.i; s.o += r.o; s.cr += r.cr; s.w += r.w5 + r.w1; for (const k in parts) s.cost[k] += parts[k]; s.saved += saved; };
    const dk = startOfDay(new Date(r.t));
    if (dk in daily) daily[dk] += c;
    if (r.t >= day0) add(today);
    if (r.t >= week0) {
      add(week);
      const mk = prettyModel(r.model);
      byModel[mk] = (byModel[mk] || 0) + c;
      readByModel[mk] = (readByModel[mk] || 0) + r.i + r.cr + r.w5 + r.w1;
      writeByModel[mk] = (writeByModel[mk] || 0) + r.o;
      byEffort[r.effort] = (byEffort[r.effort] || 0) + c;
    }
  }
  // sans cache, tout ce qui a été lu depuis le cache aurait été facturé au prix d'entrée
  const toEur = (s) => ({ ...s, eur: s.usd * eur, savedEur: s.saved * eur, costEur: Object.fromEntries(Object.entries(s.cost).map(([k, v]) => [k, v * eur])) });
  const shares = (o) => Object.entries(o).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ name: k, eur: v * eur, pct: week.usd ? 100 * v / week.usd : 0 }));
  // part de la liste elle-même (pas du coût) : un modèle bon marché garde sa part de tokens
  const tokShares = (o) => {
    const rows = Object.entries(o).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const tot = rows.reduce((a, [, v]) => a + v, 0);
    return rows.map(([k, v]) => ({ name: k, tok: v, pct: tot ? 100 * v / tot : 0 }));
  };

  const cx = { today: 0, week: 0, model: null };
  for (const r of Object.values(state.codex)) {
    const tok = r.i + r.o;
    if (r.t >= day0) cx.today += tok;
    if (r.t >= week0) cx.week += tok;
    if (r.model) cx.model = r.model;
  }

  // coût Claude et lignes produites : aujourd'hui, 7 j, et les 7 j précédents (KEEP_MS = 15 j couvre week0 - 7 j)
  const prev0 = week0 - 7 * 864e5;
  const locWin = { today: [day0, Infinity], week: [week0, Infinity], prev: [prev0, week0] };
  const locSum = { today: { usd: 0, lines: 0 }, week: { usd: 0, lines: 0 }, prev: { usd: 0, lines: 0 } };
  for (const r of Object.values(state.claude)) {
    const c = costUsd(r), n = locOf(r);
    for (const k in locWin) if (r.t >= locWin[k][0] && r.t < locWin[k][1]) { locSum[k].usd += c; locSum[k].lines += n; }
  }
  const perK = (s) => ({ lines: s.lines, eur: s.usd * eur, per1k: s.lines ? s.usd * eur * 1000 / s.lines : null });

  insights.ai = {
    eurRate: eur,
    loc: { today: perK(locSum.today), week: perK(locSum.week), prev: perK(locSum.prev) },
    coach: coach(Object.values(state.claude).filter((r) => r.t >= week0), eur),
    today: toEur(today), week: toEur(week),
    byModel: shares(byModel), byEffort: shares(byEffort),
    tokensByModel: { read: tokShares(readByModel), write: tokShares(writeByModel) },
    daily: Object.entries(daily).map(([t, v]) => ({ t: +t, eur: v * eur })),
    claudeLimits: latestClaudeLimits(),
    codex: { ...cx, limits: state.codexLimits },
  };
}

// ── Services externes ────────────────────────────────────────────────
const getJson = async (url, opts = {}) => {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(url.split('?')[0] + ' → HTTP ' + r.status);
  return r.json();
};

async function fx() {
  const d = await getJson('https://api.frankfurter.app/latest?from=USD&to=EUR');
  insights.fx = { usdEur: d.rates.EUR, date: d.date };
}

async function weather() {
  const w = config().weather;
  const lat = parseFloat(w?.lat), lon = parseFloat(w?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) { delete insights.weather; return; }   // non configurée : aucun appel réseau
  const q = new URLSearchParams({
    latitude: lat, longitude: lon, timezone: w.timezone || 'auto', forecast_days: 3,
    current: 'temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,relative_humidity_2m',
    hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
  });
  const d = await getJson('https://api.open-meteo.com/v1/forecast?' + q);
  const now = Date.now();
  const hours = d.hourly.time.map((t, i) => ({ t: Date.parse(t), temp: d.hourly.temperature_2m[i], code: d.hourly.weather_code[i], rain: d.hourly.precipitation_probability[i], day: d.hourly.is_day[i] }))
    .filter((h) => h.t > now - 36e5).slice(0, 8);
  insights.weather = {
    place: w.name, current: d.current, hours,
    days: d.daily.time.map((t, i) => ({ t, code: d.daily.weather_code[i], max: d.daily.temperature_2m_max[i], min: d.daily.temperature_2m_min[i], rain: d.daily.precipitation_probability_max[i] })),
    sunrise: d.daily.sunrise[0], sunset: d.daily.sunset[0],
  };
}

async function calendar() {
  const urls = (config().calendars || []).filter((u) => /^(https?|webcal):\/\//.test(u));
  if (!urls.length) { insights.calendar = { configured: false }; return; }
  let ical;
  try { ical = require('node-ical'); } catch { insights.calendar = { configured: false }; return; }   // dépendance absente : agenda masqué
  const now = Date.now(), horizon = now + 14 * 864e5;
  const events = [];
  for (const url of urls) {
    const data = await ical.async.fromURL(url.replace(/^webcal:/, 'https:'));
    for (const ev of Object.values(data)) {
      if (ev.type !== 'VEVENT' || ev.status === 'CANCELLED') continue;
      const dur = (ev.end ? +ev.end : +ev.start) - +ev.start;
      const allDay = ev.datetype === 'date';
      const push = (start, src = ev) => {
        const s = +start, e = s + dur;
        if (e > now && s < horizon) events.push({ title: src.summary?.val ?? src.summary ?? '(sans titre)', start: s, end: e, allDay, location: src.location?.val ?? src.location ?? '', url: (String(src.description || '').match(/https:\/\/(meet\.google\.com|[\w.-]*zoom\.us|teams\.microsoft\.com)\/\S+/) || [])[0] || '' });
      };
      if (ev.rrule) {
        const ex = new Set(Object.values(ev.exdate || {}).map((d) => +d));
        for (const d of ev.rrule.between(new Date(now - dur - 864e5), new Date(horizon), true)) {
          const key = d.toISOString().slice(0, 10);
          const override = ev.recurrences && Object.entries(ev.recurrences).find(([k]) => k.startsWith(key));
          if (override) { if (override[1].status !== 'CANCELLED') push(override[1].start, override[1]); continue; }
          if (!ex.has(+d)) push(d);
        }
      } else push(ev.start);
    }
  }
  events.sort((a, b) => a.start - b.start);
  insights.calendar = { configured: true, next: events.filter((e) => !e.allDay).slice(0, 3), allDay: events.filter((e) => e.allDay && e.start < startOfDay() + 864e5) };
}

function gh(args) {
  return new Promise((res, rej) => execFile('gh', args, { timeout: 30000, windowsHide: true, maxBuffer: 8 << 20 }, (err, out) => err ? rej(err) : res(JSON.parse(out))));
}
// Seulement les dépôts perso (config.github.owners), pas ceux du travail
const owners = () => (config().github?.owners || []).map((o) => o.toLowerCase());
async function github() {
  // aucun propriétaire suivi : pas d'appel gh (sinon la recherche porterait sur tout GitHub)
  if (!owners().length) { insights.github = { configured: false }; return; }
  // toutes les PR ouvertes sur mes dépôts perso, quel que soit l'auteur (moi, agents, bots…)
  const q = `query($q: String!) {
    viewer { login }
    search(query: $q, type: ISSUE, first: 50) { nodes { ... on PullRequest {
      number title url isDraft updatedAt author { login __typename } repository { name owner { login } } reviewDecision
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } }
  }`;
  const search = 'is:pr is:open archived:false sort:updated-desc ' + owners().map((o) => 'user:' + o).join(' ');
  const d = (await gh(['api', 'graphql', '-f', 'query=' + q, '-f', 'q=' + search])).data;
  // les miennes, plus celles des autres (agents…) actives depuis 60 jours ; pas les bots type dependabot
  const fresh = Date.now() - 60 * 864e5;
  const mine = (p) => p.repository && owners().includes(p.repository.owner.login.toLowerCase()) &&
    (p.author?.login === d.viewer.login || (p.author?.__typename !== 'Bot' && Date.parse(p.updatedAt) > fresh));
  const prs = d.search.nodes.filter(mine).map((p) => ({
    n: p.number, title: p.title, url: p.url, draft: p.isDraft, repo: p.repository.name, updated: Date.parse(p.updatedAt),
    ci: p.commits.nodes[0]?.commit.statusCheckRollup?.state || 'NONE', review: p.reviewDecision,
  }));
  insights.github = {
    login: d.viewer.login, prs,
    counts: { open: prs.length, failing: prs.filter((p) => p.ci === 'FAILURE' || p.ci === 'ERROR').length, pending: prs.filter((p) => p.ci === 'PENDING').length },
  };
}

// Calendrier de contributions (grille façon profil GitHub) + série de jours d'affilée
async function streak() {
  const q = 'query { viewer { contributionsCollection { contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } } } } }';
  const cal = (await gh(['api', 'graphql', '-f', 'query=' + q])).data.viewer.contributionsCollection.contributionCalendar;
  const days = cal.weeks.flatMap((w) => w.contributionDays.map((d) => ({ date: d.date, n: d.contributionCount })));
  const today = new Date().toLocaleDateString('sv-SE');           // AAAA-MM-JJ local
  let i = days.length - 1;
  while (i >= 0 && days[i].date > today) i--;
  if (i >= 0 && days[i].n === 0) i--;                              // aujourd'hui pas encore commité : la série tient toujours
  let current = 0; for (; i >= 0 && days[i].n > 0; i--) current++;
  let best = 0, run = 0; for (const d of days) { run = d.n ? run + 1 : 0; best = Math.max(best, run); }
  insights.streak = {
    current, best, total: cal.totalContributions,
    todayCount: days.find((d) => d.date === today)?.n || 0,
    days: days.filter((d) => d.date <= today).slice(-7 * 22),
  };
}

// Projets locaux : modifs non commitées, commits à pousser, dernier build GitHub Actions
const git = (cwd, args) => new Promise((res) => execFile('git', ['--no-optional-locks', ...args], { cwd, timeout: 15000, windowsHide: true }, (e, out) => res(e ? '' : out)));
function findRepos(root, depth = 0, acc = []) {
  let ents = []; try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return acc; }
  if (ents.some((e) => e.name === '.git')) { acc.push(root); return acc; }
  if (depth < 3) for (const e of ents) if (e.isDirectory() && !/^(node_modules|\.|vendor|dist|build|Library)/.test(e.name)) findRepos(path.join(root, e.name), depth + 1, acc);
  return acc;
}
const ciCache = {};
async function projects() {
  const roots = (config().projects?.roots || ['Projects', 'Projets', 'Developer', 'Code', 'dev', 'src', 'repos'].map((d) => path.join(HOME, d))).map((d) => d.replace(/^~(?=$|[\\/])/, HOME)).filter((d) => fs.existsSync(d));
  const repos = roots.flatMap((r) => findRepos(r));
  const list = [];
  for (const dir of repos) {
    const st = await git(dir, ['status', '--porcelain=v2', '--branch']);
    if (!st) continue;
    const head = (st.match(/^# branch\.head (.+)$/m) || [])[1] || '?';
    const ab = st.match(/^# branch\.ab \+(\d+) -(\d+)$/m);
    const changed = st.split('\n').filter((l) => /^[12u?] /.test(l)).length;
    const last = +(await git(dir, ['log', '-1', '--format=%ct'])).trim() * 1000 || 0;
    const remote = (await git(dir, ['remote', 'get-url', 'origin'])).trim();
    const gm = remote.match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/);
    // activité = dernier commit ou dernier fichier modifié non commité
    let touched = last;
    for (const l of st.split('\n').filter((l) => /^[12?] /.test(l)).slice(0, 40)) {
      try { touched = Math.max(touched, fs.statSync(path.join(dir, l.split(' ').pop().split('\t')[0])).mtimeMs); } catch {}
    }
    list.push({ name: path.relative(roots.find((r) => dir.startsWith(r)) || HOME, dir).replace(/\\/g, '/'), dir, branch: head, ahead: ab ? +ab[1] : 0, behind: ab ? +ab[2] : 0,
      changed, upstream: !!ab, last, touched, key: gm ? (gm[1] + '/' + gm[2]).toLowerCase() : dir,
      repo: gm && owners().includes(gm[1].toLowerCase()) ? gm[1] + '/' + gm[2] : null });
  }
  // Plusieurs copies / worktrees du même dépôt (Univers, Univers-eau2…) → une seule ligne
  const groups = {};
  for (const p of list) (groups[p.key] ??= []).push(p);
  const merged = Object.values(groups).map((g) => {
    g.sort((a, b) => a.name.length - b.name.length);           // la copie principale a le nom le plus court
    const main = { ...g[0] };
    if (g.length > 1) {
      main.copies = g.map((c) => ({ name: c.name.split('/').pop(), branch: c.branch, changed: c.changed, ahead: c.ahead }));
      main.changed = g.reduce((a, c) => a + c.changed, 0);
      main.ahead = g.reduce((a, c) => a + c.ahead, 0);
      main.touched = Math.max(...g.map((c) => c.touched));
    }
    return main;
  });
  merged.sort((a, b) => b.touched - a.touched);
  // projects.onlyOwners : seulement les dépôts des propriétaires suivis (config.github.owners)
  const shown = (config().projects?.onlyOwners ? merged.filter((p) => p.repo) : merged).slice(0, 6);
  for (const p of shown) {
    if (!p.repo) continue;
    const c = ciCache[p.repo + '@' + p.branch];
    if (c && Date.now() - c.t < 5 * 60e3 && !(c.ci?.status && c.ci.status !== 'completed')) { p.ci = c.ci; continue; }
    try {
      // dernier build de la branche en cours
      const runs = await gh(['run', 'list', '-R', p.repo, '-b', p.branch, '-L', '1', '--json', 'status,conclusion,workflowName,createdAt,headBranch,url']);
      const r = runs[0];
      p.ci = r ? { status: r.status, conclusion: r.conclusion, name: r.workflowName, at: Date.parse(r.createdAt), branch: r.headBranch, url: r.url } : null;
    } catch { p.ci = null; }
    ciCache[p.repo + '@' + p.branch] = { t: Date.now(), ci: p.ci };
  }
  insights.projects = { total: merged.length, dirty: merged.filter((p) => p.changed).length, unpushed: merged.filter((p) => p.ahead).length, items: shown };
}

// macOS : Claude Code range ses identifiants dans le Trousseau (service « Claude Code-credentials »).
function keychainCreds() {
  if (process.platform !== 'darwin') return null;
  try { return JSON.parse(require('child_process').execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return null; }
}

// Quotas de l'abonnement Claude (même source que /usage dans Claude Code).
// Endpoint non documenté : si ça casse, le fond d'écran retombe sur les quotas de la statusline.
async function claudeQuota() {
  const creds = (readJson(path.join(HOME, '.claude', '.credentials.json'), null) || keychainCreds() || {}).claudeAiOauth;
  if (!creds?.accessToken || creds.expiresAt < Date.now()) throw new Error('jeton OAuth expiré — se renouvelle à la prochaine session Claude Code');
  const d = await getJson('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: 'Bearer ' + creds.accessToken, 'anthropic-beta': 'oauth-2025-04-20' },
  });
  const w = (x) => x && x.utilization != null ? { used_percentage: x.utilization, resets_at: Math.round(Date.parse(x.resets_at) / 1000) } : null;
  insights.claudeQuota = {
    five_hour: w(d.five_hour), seven_day: w(d.seven_day),
    seven_day_opus: w(d.seven_day_opus), seven_day_sonnet: w(d.seven_day_sonnet),
    plan: creds.subscriptionType, updated: Date.now(),
  };
}

// Valeur réelle : non vide et pas un placeholder du type <SET_ME>
const isSet = (v) => typeof v === 'string' && v.trim() !== '' && !v.trim().startsWith('<');
async function sentry() {
  const s = config().sentry || {};
  if (!isSet(s.token) || !isSet(s.org)) { insights.sentry = { configured: false }; return; }
  const list = await getJson(`https://sentry.io/api/0/organizations/${s.org}/issues/?query=is:unresolved&statsPeriod=24h&sort=freq&limit=5`,
    { headers: { Authorization: 'Bearer ' + s.token } });
  insights.sentry = { configured: true, issues: list.map((i) => ({ title: i.title, project: i.project?.slug, count: +i.count, users: i.userCount, level: i.level, url: i.permalink, firstSeen: Date.parse(i.firstSeen) })) };
}

// ── Planification ────────────────────────────────────────────────────
const JOBS = [
  [fx, 6 * 3600], [usage, 60], [claudeQuota, 300], [github, 300], [streak, 300], [projects, 300], [sentry, 300], [weather, 900], [calendar, 600],
];
const errors = (insights.errors = {});
async function run(fn) {
  try { await fn(); delete errors[fn.name]; (insights.jobAt ??= {})[fn.name] = Date.now(); }
  catch (e) { errors[fn.name] = String(e.message || e).slice(0, 200); log(fn.name, e.stack || e); }
  save();
}
(async () => {
  for (const [fn] of JOBS) await run(fn);
  for (const [fn, every] of JOBS) setInterval(() => run(fn), every * 1000);
  // relit le config.json à chaud : agenda/météo rafraîchis dès qu'il change
  let mtime = 0;
  setInterval(() => {
    try { const m = fs.statSync(path.join(ROOT, 'config.json')).mtimeMs; if (mtime && m !== mtime) { run(weather); run(calendar); run(sentry); run(projects); } mtime = m; } catch {}
  }, 5000);
})();
