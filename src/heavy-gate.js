// PreToolUse (matcher Bash|PowerShell) : limite le nombre de suites lourdes (vitest, turbo run, tsc, eslint, next build)
// lancees en parallele sur la machine. Si le seuil est atteint, refus via permissionDecision "deny".
// Seuils par defaut adaptes a la machine :
//   - HEAVY_GATE_MAX (suites racines) : max(2, floor(coeurs / 3))
//   - HEAVY_GATE_MAX_NODE (processus node) : 2 x RAM en Go (plancher 2)
// Les variables d'environnement HEAVY_GATE_MAX / HEAVY_GATE_MAX_NODE restent prioritaires.
// Echappement : HEAVY_GATE=off dans la commande ou dans l'env.
// Fail-open : toute erreur -> exit 0 silencieux (ne jamais bloquer Claude Code).
// Ne tue aucun processus : lecture seule via `ps` (macOS/Linux) ou Get-CimInstance (Windows, `ps` n'existe pas).
'use strict';
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const WIN = process.platform === 'win32';

const DEFAULT_MAX = Math.max(2, Math.floor(os.cpus().length / 3));
const DEFAULT_MAX_NODE = Math.max(2, Math.round(os.totalmem() / 2 ** 30) * 2);   // plafond global de processus node (tous outils confondus)
const MAX_LISTED = 20;

// Commandes considerees comme lourdes (regex sur tool_input.command).
// Ancre en position d'execution : debut de commande, apres ; & | ( saut de ligne, do/then, ou bash -c "...".
const PRE = String.raw`(?:^|[;&|(\n]|\b(?:do|then)\b|\b(?:ba|z)?sh\s+-c\s+["'])\s*(?:\w+=\S*\s+)*(?:(?:sudo|time|nohup|env|command|exec|nice|timeout(?:\s+-\S+)*\s+\d+\S*)\s+)*`;
const RUNNER = String.raw`(?:(?:npx|bunx|pnpm|yarn)\s+(?:(?:-F|--filter|-C|--dir)(?:=|\s+)\S+\s+|-\S+\s+)*(?:(?:exec|dlx)\s+)?)?`;
const PM = String.raw`(?:pnpm|npm|yarn)\s+(?:(?:-F|--filter|-C|--dir|--workspace)(?:=|\s+)\S+\s+|-\S+\s+)*(?:run\s+)?(?:test|check|lint|typecheck|build)\b`;
const TOOL = String.raw`(?:(?:\S*/)?(?:vitest|tsc|eslint|playwright)\b|turbo\s+run\b|next\s+build\b|node\s+(?:\S*/)?(?:vitest|tsc|eslint|playwright)(?:\.m?js)?(?=\s|$))`;
const HEAVY_CMD = new RegExp(PRE + '(?:' + PM + '|' + RUNNER + TOOL + ')');
const BYPASS_CMD = /\bHEAVY_GATE=off\b/;

// Processus enveloppes (shells, gestionnaires de paquets, xargs, timeout...) : jamais comptes,
// seul le binaire reel qu'ils lancent l'est.
const WRAPPER_START = /^(\S*\/)?(sh|bash|zsh|dash|xargs|timeout|env|nohup|npm|npx|pnpm|yarn)\s/;
const WRAPPER_PM = /\/(pnpm|npm|npx|yarn)(\.c?js)?\s/;

// Racines lourdes (hors workers) -> libelle.
const KINDS = [
  {
    label: 'vitest',
    test: (a) => /(\/vitest\.mjs|\.bin\/vitest)(\s|$)/.test(a) && !/--experimental-import-meta-resolve|\/workers\//.test(a),
  },
  // Le binaire natif @turbo/<plateforme> est lance par le launcher JS : on ne compte que le launcher.
  { label: 'turbo run', test: (a) => /\bturbo run\b/.test(a) && !/@turbo[/+]/.test(a) },
  { label: 'tsc', test: (a) => /bin\/tsc(\s|$)/.test(a) },
  { label: 'eslint', test: (a) => /eslint\.js(\s|$)|\.bin\/eslint(\s|$)/.test(a) },
  { label: 'next build', test: (a) => /\bnext build\b/.test(a) },
];

function parseMax() {
  const v = parseInt(process.env.HEAVY_GATE_MAX, 10);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MAX;
}

function parseMaxNode() {
  const v = parseInt(process.env.HEAVY_GATE_MAX_NODE, 10);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MAX_NODE;
}

// Windows : une seule requete CIM (pid, ppid, nom, ligne de commande), memorisee pour countNode et listHeavy.
// Chemins normalises : `\` -> `/` et guillemets retires, pour que les regex ci-dessous marchent comme sous ps.
// Environ 1,2 s a chaud, bien plus a froid (runner CI, antivirus) : delai de 7 s, le hook reste sous ses 10 s.
// Au-dela, execFileSync leve une erreur : fail-open (aucune sortie, la commande passe).
const WIN_PROCS_TIMEOUT = 7000;
let winProcs = null;
function winProcesses() {
  if (winProcs) return winProcs;
  const script =
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
    'Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine |' +
    ' Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
  const out = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: WIN_PROCS_TIMEOUT,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const list = [].concat(JSON.parse(out.trim() || '[]') || []); // ConvertTo-Json rend un objet seul si un processus
  winProcs = list.map((p) => ({
    pid: Number(p.ProcessId),
    ppid: Number(p.ParentProcessId),
    comm: String(p.Name || ''),
    args: String(p.CommandLine || '').replace(/\\/g, '/').replace(/"/g, ''),
  }));
  return winProcs;
}

// Nombre de processus node sur la machine (workers vitest, outils, serveurs…).
function countNode() {
  if (WIN) return winProcesses().filter((p) => /^node(\.exe)?$/i.test(p.comm)).length;
  const out = execFileSync('ps', ['-axo', 'comm='], { encoding: 'utf8', timeout: 3000 });
  return out.split('\n').filter((c) => /(^|\/)node$/.test(c.trim())).length;
}

// Libelle lisible d'un dossier : worktree <nom>/<sous-dossier> ou chemin relatif a ~.
function labelOf(p) {
  const wt = /^(.*?)\/(?:\.claude\/worktrees|\.worktrees)\/([^/]+)(.*)$/.exec(p);
  if (wt) return `worktree ${wt[2]}${wt[3]}`;
  const home = os.homedir().replace(/\\/g, '/');
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

// Repli sans lsof : dossier deduit du premier chemin absolu de la ligne de commande.
// Sous Windows (chemins C:/…), l'executable (ex. C:/Program Files/nodejs/node.exe) est saute avant.
const ABS_ARG = WIN ? /(?:^|\s)([A-Za-z]:\/[^\s]+|\/[^\s]+)/ : /(?:^|\s)(\/[^\s]+)/;
const WIN_EXE = /^[A-Za-z]:\/.*?\.exe\s/i;
function dirFromArgs(args) {
  const m = ABS_ARG.exec(WIN ? args.replace(WIN_EXE, '') : args);
  if (!m) return null;
  let p = m[1];
  const nm = p.indexOf('/node_modules');
  return nm > 0 ? p.slice(0, nm) : path.dirname(p);
}

// Cwd reels des processus (lsof, rapide ; en cas d'echec, Map vide -> repli sur les args).
function cwdsOf(pids) {
  const map = new Map();
  if (WIN || !pids.length) return map; // pas de lsof sous Windows : repli sur les args
  let out = '';
  try {
    out = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    out = (e && e.stdout) || ''; // lsof renvoie 1 si un pid a disparu : on garde ce qu'il a imprime
  }
  let pid = null;
  for (const l of String(out).split('\n')) {
    if (l[0] === 'p') pid = Number(l.slice(1));
    else if (l[0] === 'n' && pid !== null) map.set(pid, l.slice(1));
  }
  return map;
}

// macOS/Linux : pid, ppid, ligne de commande via ps.
function psProcesses() {
  const out = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,args='], {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const procs = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] });
  }
  return procs;
}

function listHeavy() {
  const procs = WIN ? winProcesses() : psProcesses();
  const ppid = new Map(); // pid -> ppid, sur TOUS les processus (pour remonter les ancetres)
  const found = [];
  for (const { pid, ppid: parent, args } of procs) {
    ppid.set(pid, parent);
    if (pid === process.pid || args.includes('heavy-gate.js')) continue;
    if (WRAPPER_START.test(args) || WRAPPER_PM.test(args)) continue;
    const kind = KINDS.find((k) => k.test(args));
    if (kind) found.push({ pid, kind: kind.label, args });
  }
  // Racines seulement : un processus lourd qui a un ancetre lourd (ex. turbo -> vitest) n'est pas compte.
  const heavySet = new Set(found.map((f) => f.pid));
  const roots = found.filter((f) => {
    let p = ppid.get(f.pid), d = 0;
    while (p > 1 && d++ < 50) {
      if (heavySet.has(p)) return false;
      p = ppid.get(p);
    }
    return true;
  });
  const cwds = cwdsOf(roots.map((f) => f.pid));
  return roots.map((f) => {
    const dir = cwds.get(f.pid) || dirFromArgs(f.args);
    return { pid: f.pid, kind: f.kind, where: dir ? labelOf(dir) : 'dossier inconnu' };
  });
}

function denyReason(items, max) {
  const shown = items.slice(0, MAX_LISTED).map((i) => `- ${i.kind} : ${i.where} (pid ${i.pid})`);
  if (items.length > MAX_LISTED) shown.push(`- ... et ${items.length - MAX_LISTED} autre(s)`);
  return [
    `Machine saturée : ${items.length} suite(s) lourde(s) (tests/typecheck/lint/build) déjà en cours, seuil ${max} atteint.`,
    'En cours :',
    ...shown,
    'Attends environ 1 minute puis relance.',
    'De préférence, ne lance que les fichiers de test touchés (`vitest run <fichiers>`) plutôt que la suite complète ou `turbo run test`.',
  ].join('\n');
}

// Retourne null (laisser passer) ou la raison du refus (string).
function decide(command) {
  if (!HEAVY_CMD.test(command)) return null;
  if (BYPASS_CMD.test(command)) return null;
  const max = parseMax();
  // Seuil 0 : aucune suite lourde n'est autorisee. Refus sans lire les processus : le resultat ne depend pas
  // d'eux, et la lecture peut echouer ou depasser son delai (fail-open) sur une machine lente.
  if (max === 0) {
    return [
      'Machine saturée : HEAVY_GATE_MAX=0, aucune suite lourde (tests/typecheck/lint/build) n\'est autorisée.',
      'Relance avec HEAVY_GATE=off si ce lancement est voulu, ou augmente HEAVY_GATE_MAX.',
    ].join('\n');
  }
  const heavy = listHeavy();
  const maxNode = parseMaxNode();
  const nodes = countNode();
  if (heavy.length < max && nodes < maxNode) return null;
  const reason = denyReason(heavy, max);
  return nodes >= maxNode
    ? `Machine saturée : ${nodes} processus node en cours (plafond ${maxNode}).\n` + reason.split('\n').slice(1).join('\n')
    : reason;
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    raw += chunk;
  });
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw);
      if (!input || (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell')) return;
      const ti = input.tool_input || {};
      const command = typeof ti.command === 'string' ? ti.command : '';
      if (!command) return;
      if (process.env.HEAVY_GATE === 'off') return;
      const reason = decide(command);
      if (reason) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: reason,
            },
          })
        );
      }
    } catch (_) {
      // Fail-open : aucune sortie, exit 0.
    }
  });
}

main();
