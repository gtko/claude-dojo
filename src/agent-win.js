// Agent Windows du fond d'écran « Dojo » : équivalent de agent-mac.js (et de agent.ps1 pour l'ancienne version).
// Ce fichier ne contient que les échantillonneurs Windows ; le serveur, les sessions, les thèmes et le cycle
// d'échantillonnage sont dans agent-core.js. Sert http://localhost:7777/stats (et la page elle-même sur http://localhost:7777/).
//
// Coût : un seul powershell.exe par relevé (processus, compteurs réseau, batterie, disques), partagé entre les
// échantillonneurs d'un même cycle (gather : relevé réutilisé pendant 2,5 s). Les serveurs en écoute passent par
// netstat, sans PowerShell : Get-NetTCPConnection charge son module à chaque appel, plus d'une seconde.
// La température vient de LibreHardwareMonitor (http://localhost:8085, optionnel). La mémoire et le nom du CPU viennent d'os.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { startAgent } = require('./agent-core');

const ROOT = __dirname;
const HOME = os.homedir();
const SYSROOT = process.env.SystemRoot || 'C:\\Windows';
const PS = path.join(SYSROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CPU_NAME = (os.cpus()[0]?.model || '').trim() || 'CPU';
const SENTINEL = '@@DOJO@@';   // préfixe de la ligne de sortie des scripts PowerShell
const GATHER_TTL = 2500;       // ms : au-delà, un nouveau relevé PowerShell est lancé

// Interface et aides du Dojo : cachées (comme agent.ps1). Bruit système : caché aussi.
const UI_RE = /^(DojoWallpaper|Lively|LibreHardwareMonitor)/i;
const NOISE_CMD = /media\.ps1|collector\.js/i;   // média et collecteur du Dojo, lancés hors de l'agent
const SYS_NOISE = new Set(['System Idle Process', 'System', 'Registry', 'Memory Compression', 'Secure System']);
// Serveurs : runtimes de dev connus (liste d'agent.ps1), ou tout ce qui tourne depuis un dossier de projets
const DEV_NAMES = /^(node|python\d*|pythonw|py|php|php-cgi|java|javaw|ruby|dotnet|go|air|nginx|httpd|caddy|postgres|mysqld|mariadbd|redis-server|memurai|mongod|ollama|lms|docker|com\.docker\.backend|wslrelay|uvicorn|gunicorn|hugo|godot.*|workerd|wrangler|esbuild|cargo|flask|streamlit|jupyter.*|meilisearch|minio|mailpit|stripe|ngrok|cloudflared|supabase|turso|sqld)$/i;

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const config = () => readJson(path.join(ROOT, 'config.json'), {});

// ── Commandes : sous-processus suivis (libérés par onStop), délai maximal, sans shell ──
const live = new Set();
function run(cmd, args, { env, timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false, code = -1;
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: env || process.env });
    live.add(child);
    const finish = () => {
      if (done) return;
      done = true; clearTimeout(timer); live.delete(child);
      resolve({ code, out: Buffer.concat(chunks).toString('utf8') });
    };
    const timer = setTimeout(() => { try { child.kill(); } catch {} setTimeout(finish, 500); }, timeout);
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('error', finish);
    child.on('close', (c) => { code = c ?? -1; finish(); });
  });
}
function spawnDetached(cmd, args) {
  const c = spawn(cmd, args, { windowsHide: true, detached: true, stdio: 'ignore' });
  c.on('error', () => {});
  c.unref();
}

// PowerShell : script encodé en base64 (aucun souci de guillemets), une seule ligne de sortie préfixée.
// Les scripts écrivent en octets UTF-8 (pas de codepage de console) via Emit.
function ps(script, env, timeout) {
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  return run(PS, ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { env: { ...process.env, ...env }, timeout });
}
function payload(out) { const i = out.lastIndexOf(SENTINEL); return i < 0 ? null : out.slice(i + SENTINEL.length).trim(); }
const EMIT = String.raw`function Emit([string]$s) { $bytes = [Text.Encoding]::UTF8.GetBytes('@@DOJO@@' + $s + [char]10); $o = [Console]::OpenStandardOutput(); $o.Write($bytes, 0, $bytes.Length); $o.Flush() }`;

// ── Relevé unique : processus, compteurs réseau, batterie, disques ────
const GATHER_PS = EMIT + '\n' + String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$procs = New-Object System.Collections.ArrayList
foreach ($p in @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, CreationDate, WorkingSetSize, KernelModeTime, UserModeTime)) {
  $start = $null
  if ($p.CreationDate) { $start = [long]([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }
  [void]$procs.Add([pscustomobject]@{
    pid = [int]$p.ProcessId; ppid = [int]$p.ParentProcessId; name = [string]$p.Name; path = [string]$p.ExecutablePath
    args = [string]$p.CommandLine; rss = [double]$p.WorkingSetSize
    cpu = ([double]$p.KernelModeTime + [double]$p.UserModeTime) / 1e7; start = $start
  })
}
$rx = 0.0; $tx = 0.0
foreach ($n in @(Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface)) {
  if ($n.Name -match 'Loopback|isatap|Teredo|vEthernet|Virtual|Hyper-V|Bluetooth') { continue }
  $rx += [double]$n.BytesReceivedPersec; $tx += [double]$n.BytesSentPersec
}
$batt = Get-CimInstance Win32_Battery | Select-Object -First 1
$battery = $null
if ($batt) { $battery = @{ pct = [int]$batt.EstimatedChargeRemaining; status = [int]$batt.BatteryStatus; run = [int]$batt.EstimatedRunTime } }
$drives = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { @{ id = [string]$_.DeviceID; label = [string]$_.VolumeName; size = [double]$_.Size; free = [double]$_.FreeSpace } })
$o = @{ procs = @($procs); net = @{ rx = $rx; tx = $tx }; battery = $battery; drives = $drives }
Emit ($o | ConvertTo-Json -Depth 4 -Compress)
`;

// ── Focus d'une session Claude : Windows Terminal (onglet par titre, sinon par rang du shell), sinon fenêtre du parent ──
const FOCUS_PS = EMIT + '\n' + String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$title = [string]$env:DOJO_FOCUS_TITLE
$cur = [int]$env:DOJO_FOCUS_PID
$chain = @()
for ($i = 0; $i -lt 10 -and $cur -gt 0; $i++) {
  $q = Get-CimInstance Win32_Process -Filter "ProcessId=$cur"
  if (-not $q) { break }
  $chain += $q
  $cur = [int]$q.ParentProcessId
}
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class DojoWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
'@
function Focus-Window([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero) { return }
  if ([DojoWin]::IsIconic($h)) { [void][DojoWin]::ShowWindow($h, 9) }
  [DojoWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [DojoWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void][DojoWin]::SetForegroundWindow($h)
}
function Norm($s) { ([string]$s -replace '^[^\p{L}\p{N}]+', '').Trim() }
$wtAt = -1
for ($i = 0; $i -lt $chain.Count; $i++) { if ($chain[$i].Name -eq 'WindowsTerminal.exe') { $wtAt = $i; break } }
if ($wtAt -gt 0) {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $UIA = [System.Windows.Automation.AutomationElement]
  $TabCond = [System.Windows.Automation.PropertyCondition]::new($UIA::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
  $wins = @($UIA::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.PropertyCondition]::new($UIA::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')))
  if ($title) {
    foreach ($w in $wins) {
      foreach ($t in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $TabCond)) {
        if ((Norm $t.Current.Name) -eq (Norm $title)) {
          Focus-Window ([IntPtr]$w.Current.NativeWindowHandle)
          $t.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
          Emit 'ok'; exit 0
        }
      }
    }
  }
  $shell = $chain[$wtAt - 1]; $wt = $chain[$wtAt]
  $shells = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($wt.ProcessId)" | Where-Object { $_.Name -notmatch 'OpenConsole|conhost' } | Sort-Object CreationDate)
  $idx = [array]::IndexOf([int[]]@($shells | ForEach-Object { [int]$_.ProcessId }), [int]$shell.ProcessId)
  if ($wins.Count -gt 0) {
    $w = $wins[0]
    Focus-Window ([IntPtr]$w.Current.NativeWindowHandle)
    $tabs = @($w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $TabCond))
    if ($idx -ge 0 -and $idx -lt $tabs.Count) { $tabs[$idx].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() }
    Emit 'ok'; exit 0
  }
}
foreach ($p in $chain) {
  $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if ($proc -and $proc.MainWindowHandle -ne 0) { Focus-Window $proc.MainWindowHandle; Emit 'ok'; exit 0 }
}
Emit 'fenêtre introuvable'
`;

// ── Icônes des IA : PNG 64 px dans le dossier du cache (même liste d'applis que agent-mac.js) ──
const ICON_PS = EMIT + '\n' + String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
$dir = [string]$env:DOJO_ICON_DIR
$apps = [ordered]@{
  claude   = @{ appx = 'Claude';      exe = @('%LOCALAPPDATA%\Programs\Claude\Claude.exe') }
  codex    = @{ appx = 'OpenAI.Codex' }
  cursor   = @{ exe = @('%LOCALAPPDATA%\Programs\cursor\Cursor.exe') }
  gemini   = @{ exe = @('%LOCALAPPDATA%\Programs\Gemini\Gemini.exe') }
  windsurf = @{ exe = @('%LOCALAPPDATA%\Programs\Windsurf\Windsurf.exe') }
  opencode = @{ exe = @('%LOCALAPPDATA%\Programs\OpenCode\OpenCode.exe') }
  goose    = @{ exe = @('%LOCALAPPDATA%\Programs\Goose\Goose.exe') }
}
function Find-AppExe($spec) {
  if ($spec.appx) {
    $pkg = Get-AppxPackage -Name $spec.appx | Select-Object -First 1
    if ($pkg) {
      $manifest = $null
      try { $manifest = [xml]([IO.File]::ReadAllText((Join-Path $pkg.InstallLocation 'AppxManifest.xml'))) } catch {}
      $app = $null
      if ($manifest) { $app = @($manifest.Package.Applications.Application)[0] }
      if ($app -and $app.Executable) {
        $exe = Join-Path $pkg.InstallLocation (([string]$app.Executable) -replace '/', '\')
        if ([IO.File]::Exists($exe)) { return $exe }
      }
    }
  }
  if ($spec.exe) {
    foreach ($e in @($spec.exe)) { $exe = [Environment]::ExpandEnvironmentVariables($e); if ([IO.File]::Exists($exe)) { return $exe } }
  }
  return $null
}
$ok = @()
foreach ($a in @($apps.Keys)) {
  try {
    $exe = Find-AppExe $apps[$a]
    if (-not $exe) { continue }
    $out = Join-Path $dir ($a + '.png')
    if (-not (Test-Path -LiteralPath $out) -or (Get-Item -LiteralPath $exe).LastWriteTime -gt (Get-Item -LiteralPath $out).LastWriteTime) {
      $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
      $src = $icon.ToBitmap()
      $bmp = New-Object System.Drawing.Bitmap 64, 64, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.DrawImage($src, 0, 0, 64, 64)
      $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
      $g.Dispose(); $bmp.Dispose(); $src.Dispose(); $icon.Dispose()
    }
    $ok += $a
  } catch {}
}
Emit ($ok -join ',')
`;

// ── Relevé : un seul powershell.exe, partagé par les échantillonneurs d'un même cycle ──
let snap = null;            // { procs: Map<pid, Proc>, battery, drives } du dernier relevé réussi
let snapAt = 0, pending = null;
let prevCpu = new Map();    // pid -> { s, t } : secondes de CPU cumulées à l'instant t (ms)
let netPrev = null, netLast = null;   // deux derniers relevés des compteurs réseau { rx, tx, t }

function gather() {
  if (snap && Date.now() - snapAt < GATHER_TTL) return Promise.resolve(snap);
  if (!pending) pending = refresh().finally(() => { pending = null; });
  return pending;
}
async function refresh() {
  const now = Date.now();
  const raw = payload((await ps(GATHER_PS, {}, 8000)).out);
  let j = null;
  try { j = raw ? JSON.parse(raw) : null; } catch {}
  if (j && Array.isArray(j.procs)) build(j, now);
  snapAt = now;   // échec : on garde le dernier relevé, et on n'en relance pas avant GATHER_TTL
  return snap;
}
function build(j, now) {
  const procs = new Map(), nextCpu = new Map();
  for (const p of j.procs) {
    const pid = Number(p.pid);
    if (!Number.isInteger(pid) || pid < 0) continue;
    const name = String(p.name || '').replace(/\.exe$/i, '');
    const args = String(p.args || '');
    const secs = Number(p.cpu) || 0;
    const prev = prevCpu.get(pid);
    let cpu = 0;
    if (prev && now > prev.t && secs >= prev.s) cpu = 100 * (secs - prev.s) / ((now - prev.t) / 1000);
    nextCpu.set(pid, { s: secs, t: now });
    procs.set(pid, {
      pid, ppid: Number(p.ppid) || 0, cpu: Math.round(cpu * 10) / 10, rss: Number(p.rss) || 0,
      etime: p.start ? Math.max(0, (now - p.start) / 1000) : null,
      comm: p.path || name, name, args,
      hidden: SYS_NOISE.has(name) || (NOISE_CMD.test(args) && /^(node|powershell|pwsh)$/i.test(name)),
      desktop: /^claude$/i.test(name) && /Programs\\Claude\\|WindowsApps\\Claude[._]/i.test(p.path || ''),
    });
  }
  // Interface du Dojo (et ses fils, dont WebView2) : cachée avec ses aides
  const kids = new Map();
  for (const p of procs.values()) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p.pid); }
  const todo = [...procs.values()].filter((p) => UI_RE.test(p.name)).map((p) => p.pid), seen = new Set();
  while (todo.length) {
    const id = todo.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    if (procs.has(id)) procs.get(id).hidden = true;
    for (const c of kids.get(id) || []) todo.push(c);
  }
  prevCpu = nextCpu;
  netPrev = netLast;
  netLast = { rx: Number(j.net?.rx) || 0, tx: Number(j.net?.tx) || 0, t: now };
  snap = { procs, battery: j.battery || null, drives: Array.isArray(j.drives) ? j.drives : [] };
}

// ── Processus ─────────────────────────────────────────────────────────
async function sampleProcesses() {
  await gather();
  return snap ? [...snap.procs.values()] : [];
}

// ── Réseau : compteurs cumulés (le noyau calcule les débits) et ping toutes les 5 s ──
let pingMs = null, pingAt = 0;
function pingKick() {
  if (Date.now() - pingAt < 5000) return;
  pingAt = Date.now();
  run('ping.exe', ['-n', '1', '-w', '1000', '1.1.1.1'], { timeout: 3000 }).then((r) => {
    const m = /[=<]\s*(\d+)\s*ms\b/i.exec(r.out);   // « temps=12 ms » ou « time<1ms » : indépendant de la langue
    pingMs = m ? Number(m[1]) : null;
  });
}
// Compteurs à l'instant voulu : le relevé ne vient que toutes les ~4 s, on extrapole le débit entre deux relevés (≤ 6 s)
function netNow(now) {
  if (!netLast) return { rx: 0, tx: 0 };
  const dt = netPrev ? (netLast.t - netPrev.t) / 1000 : 0;
  const k = dt > 0 ? Math.min(Math.max(now - netLast.t, 0), 6000) / 1000 : 0;
  const rate = (cur, before) => (dt > 0 ? Math.max(0, (cur - before) / dt) : 0);
  return {
    rx: netLast.rx + rate(netLast.rx, netPrev?.rx ?? netLast.rx) * k,
    tx: netLast.tx + rate(netLast.tx, netPrev?.tx ?? netLast.tx) * k,
  };
}
async function sampleNet() {
  await gather();
  pingKick();
  const n = netNow(Date.now());
  return { rx: n.rx, tx: n.tx, ping: pingMs };
}

// ── Disques : lettres et volumes du relevé, tailles par fs.statfs (repli : valeurs du relevé) ──
async function sampleDisks() {
  const s = await gather();
  if (!s) return null;   // le noyau garde la liste précédente
  const out = [];
  for (const d of s.drives) {
    const id = String(d.id || '');
    if (!/^[A-Za-z]:$/.test(id)) continue;
    let total = Number(d.size) || 0, free = Number(d.free) || 0;
    if (typeof fs.promises.statfs === 'function') {
      try { const st = await fs.promises.statfs(id + '\\'); total = st.blocks * st.bsize; free = st.bavail * st.bsize; } catch {}
    }
    if (total > 0) out.push({ name: id, label: String(d.label || ''), total, free });
  }
  return out;
}

// ── Capteurs : mémoire et CPU par os ; températures par LibreHardwareMonitor (silencieux si absent) ──
const num = (v) => { const m = /(-?\d+(?:[.,]\d+)?)/.exec(String(v ?? '')); return m ? Number(m[1].replace(',', '.')) : null; };
function lhmData() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get({ host: 'localhost', port: 8085, path: '/data.json' }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return finish(null); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { finish(JSON.parse(body)); } catch { finish(null); } });
      res.on('error', () => finish(null));
    });
    req.setTimeout(1000, () => req.destroy(new Error('délai')));
    req.on('error', () => finish(null));
  });
}
async function lhmHardware() {
  const d = await lhmData();
  if (!d || !Array.isArray(d.Children) || !d.Children[0]) return null;
  const s = new Map();   // SensorId -> { text, v }
  const stack = [d];
  while (stack.length) {
    const n = stack.pop();
    if (n.SensorId) s.set(n.SensorId, { text: String(n.Text || ''), v: num(n.Value) });
    for (const c of n.Children || []) stack.push(c);
  }
  const pick = (idRe, textRe) => {
    const k = [...s.keys()].filter((x) => idRe.test(x) && textRe.test(s.get(x).text)).sort()[0];
    return k === undefined ? null : s.get(k).v;
  };
  const gpu = (d.Children[0].Children || []).find((c) => /ati|nvidia|intel|gpu/i.test(c.ImageURL || '') || /Radeon|GeForce|RTX|Arc/i.test(c.Text || ''));
  return {
    cpuTemp: pick(/^\/(amd|intel)cpu\/0\/temperature\//i, /Tctl|Package|Core Max|Core \(Tctl/i),
    cpuPower: pick(/^\/(amd|intel)cpu\/0\/power\//i, /Package/i),
    cpuFan: pick(/^\/lpc\/.*\/fan\//i, /CPU/i),
    gpuName: gpu ? String(gpu.Text) : null,
    gpuTemp: pick(/^\/gpu-\w+\/0\/temperature\//i, /^GPU Core$/i),
    gpuHot: pick(/^\/gpu-\w+\/0\/temperature\//i, /Hot Spot/i),
    gpuLoad: pick(/^\/gpu-\w+\/0\/load\//i, /^GPU Core$/i),
    gpuPower: pick(/^\/gpu-\w+\/0\/power\//i, /Package|Power/i),
    gpuFan: pick(/^\/gpu-\w+\/0\/fan\//i, /GPU/i),
    ssdTemp: pick(/^\/nvme\/\d+\/temperature\//i, /Composite/i),
    sysPower: null,
  };
}
let hwCache = null, hwAt = 0;
async function sampleSensors() {
  const now = Date.now();
  if (now - hwAt >= 3000) { hwAt = now; hwCache = await lhmHardware().catch(() => null); }
  return { cpuName: CPU_NAME, hw: hwCache, memory: { total: os.totalmem(), used: os.totalmem() - os.freemem() } };
}

// ── Batterie (Win32_Battery) : absente sur un PC fixe → carte masquée ──
async function sampleBattery() {
  const s = await gather();
  const b = s?.battery;
  if (!b) return null;
  const plugged = [2, 3, 6, 7, 8, 9, 11].includes(b.status);
  return {
    percent: Number(b.pct), plugged, charging: [6, 7, 8, 9].includes(b.status), full: b.status === 3,
    minutes: !plugged && b.run > 0 && b.run < 71582788 ? b.run : null,
    cycles: null, health: null, temp: null, watts: null,
  };
}

// ── Serveurs locaux en écoute (netstat -ano, cadence 5 s) ─────────────
let servers = [], serversAt = 0;
function projectRoots() {
  const cfg = config().projects?.roots;
  const dirs = Array.isArray(cfg) ? cfg : ['Projets', 'Projects', 'Developer', 'Code', 'dev', 'src', 'repos'];
  return dirs.map((d) => { const x = String(d).replace(/^~(?=$|[\\/])/, HOME); return path.isAbsolute(x) ? x : path.join(HOME, x); })
    .filter((r) => fs.existsSync(r));
}
// Chemins comparés avec des antislashs et sans casse ; longueurs identiques, donc les indices restent valables
const norm = (s) => s.replace(/\//g, '\\').toLowerCase();
function projectFrom(cmd, roots) {
  for (const r of roots) {
    const i = norm(cmd).indexOf(norm(r));
    if (i < 0) continue;
    const parts = cmd.slice(i + r.length).replace(/^[\\/]+/, '').split(/[\\/"\s]/).filter(Boolean).slice(0, 3);
    const keep = [];
    for (const x of parts) { if (/^(node_modules|src|dist|build|\.venv|venv|vendor|bin|\.next|\.output)$/.test(x) || /\.\w{1,4}$/.test(x)) break; keep.push(x); }
    if (keep.length) return keep.join('/');
  }
  return null;
}
function whatFrom(name, cmd) {
  const m = /(vite|next|nuxt|astro|remix|webpack|wrangler|nodemon|tsx|ts-node|nest|expo|storybook|svelte-kit|react-scripts|parcel|turbo|http-server|json-server|prisma|drizzle-kit|uvicorn|gunicorn|flask|django|manage\.py|streamlit|jupyter|artisan|rails|puma)/i.exec(cmd);
  return m ? m[1].toLowerCase().replace(/\.py$/, '') : name;
}
async function sampleServers(ctx) {
  if (Date.now() - serversAt < 5000) return servers;
  serversAt = Date.now();
  // netstat : en écoute = pas d'adresse distante (0.0.0.0:0 ou [::]:0), quelle que soit la langue de Windows
  const out = (await run('netstat.exe', ['-ano', '-p', 'TCP'], { timeout: 5000 })).out;
  const ports = new Map();   // pid -> Set(port)
  for (const line of out.split(/\r?\n/)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 5 || c[0] !== 'TCP' || !/^(0\.0\.0\.0|\[::\]):0$/.test(c[2])) continue;
    const port = Number((/:(\d+)$/.exec(c[1]) || [])[1]), pid = Number(c[4]);
    if (!port || !(pid > 4)) continue;
    if (!ports.has(pid)) ports.set(pid, new Set());
    ports.get(pid).add(port);
  }
  const roots = projectRoots();
  const list = [];
  for (const [id, set] of ports) {
    const p = ctx.procs.get(id);
    if (!p || ctx.self.has(id)) continue;
    if ((p.comm || '').toLowerCase().startsWith((SYSROOT + '\\').toLowerCase())) continue;   // processus système
    const cmd = p.args || p.comm || '';
    const project = projectFrom(cmd, roots);
    if (!project && !DEV_NAMES.test(p.name)) continue;
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
async function stopServer(id) {
  if (!servers.some((s) => s.pid === id)) return 'refusé : pas un serveur listé';
  const r = await run('taskkill.exe', ['/PID', String(id), '/T', '/F'], { timeout: 8000 });
  serversAt = 0;   // la liste sera relue au prochain cycle
  return r.code === 0 ? 'ok' : 'échec';
}

// ── Ouvre un lien (PR, build, Sentry…) dans le navigateur par défaut ─
function openUrl(url) {
  if (!/^(https:\/\/[\w.-]+|http:\/\/localhost:\d+)(\/\S*)?$/.test(url || '')) return 'refusé : lien non https';
  spawnDetached('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
  return 'ok';
}

// ── Clic sur un ninja : ramène la fenêtre (et l'onglet) de la session ─
async function focusSession(id, info) {
  const cx = info.codex;
  if (cx) {
    // Codex Desktop : conversation ouverte par son lien codex:// (seulement si l'app est installée)
    if (/desktop/i.test(cx.originator || '') && /^[0-9a-f-]{36}$/.test(cx.thread || '')
      && (await run('reg.exe', ['query', 'HKCR\\codex'], { timeout: 5000 })).code === 0) {
      spawnDetached('rundll32.exe', ['url.dll,FileProtocolHandler', 'codex://threads/' + cx.thread]);
      return 'ok';
    }
    return 'session inconnue';
  }
  const s = info.session;
  const pid = Number(s?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return 'session inconnue';
  const r = await ps(FOCUS_PS, { DOJO_FOCUS_PID: String(pid), DOJO_FOCUS_TITLE: String(info.status?.name || '') }, 30000);
  return payload(r.out) || 'erreur : pas de réponse';
}

// ── Icônes : une fois au démarrage ─────────────────────────────────────
async function buildIcons(dir) {
  const list = payload((await ps(ICON_PS, { DOJO_ICON_DIR: dir }, 90000)).out) || '';
  return list.split(',').map((x) => x.trim()).filter((x) => /^[a-z]+$/.test(x));
}

// Musique : module écrit à part (win-media.js) ; absent ou en erreur, pas de carte musique
let winMedia = null;
try { winMedia = require('./win-media.js'); } catch { winMedia = null; }
const media = {
  read: () => winMedia?.read?.() ?? null,
  cmd: (c) => winMedia?.cmd?.(c) ?? null,
  coverFile: () => winMedia?.coverFile?.() ?? null,
};

// Arrêt : libère le processus média et les commandes encore en cours
function onStop() {
  try { winMedia?.stop?.(); } catch {}
  for (const c of live) { try { c.kill(); } catch {} }
  live.clear();
}

// ── Démarrage : CLI (node agent-win.js), port DOJO_PORT pour les tests ─
let agent = null;
const stop = () => { try { agent?.stop(); } catch {} onStop(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
startAgent({
  port: Number(process.env.DOJO_PORT) || 7777,   // DOJO_PORT ne sert qu'aux tests (port libre)
  root: ROOT,
  env: process.env,
  sampleProcesses, sampleNet, sampleDisks, sampleSensors, sampleBattery,
  sampleServers, stopServer, focusSession, openUrl,
  media, icons: buildIcons, onStop,
}).then((a) => { agent = a; }, (e) => {
  if (e.code === 'EADDRINUSE') process.exit(0);   // une seule instance
  throw e;
});
