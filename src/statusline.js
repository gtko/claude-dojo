// Status line Claude Code : affiche modèle / effort / contexte / quotas,
// et enregistre ces infos pour le fond d'écran Dojo (~/.claude/dojo/status/<session>.json).
const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = path.join(os.homedir(), '.claude', 'dojo', 'status');
const c = (hex, s) => { const n = parseInt(hex.slice(1), 16); return `\x1b[38;2;${n >> 16};${(n >> 8) & 255};${n & 255}m${s}\x1b[0m`; };
const level = (p) => p < 50 ? '#50fa7b' : p < 80 ? '#ffb86c' : '#ff5555';
const bar = (p, n = 8) => { const f = Math.round((Math.min(p, 100) / 100) * n); return '█'.repeat(f) + '░'.repeat(n - f); };
const hhmm = (s) => new Date(s * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const dayHHmm = (s) => new Date(s * 1000).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let j = {};
  try { j = JSON.parse(raw || '{}'); } catch {}

  const ctx = j.context_window?.used_percentage;
  const rl = j.rate_limits || null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const id = String(j.session_id || 'unknown').replace(/[^\w-]/g, '');
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({
      id, name: j.session_name || null, model: j.model?.display_name || j.model?.id, modelId: j.model?.id, effort: j.effort?.level || null,
      ctx: ctx ?? null, ctxSize: j.context_window?.context_window_size || null,
      cost: j.cost?.total_cost_usd ?? null, rate_limits: rl, fast: !!j.fast_mode, updated: Date.now(),
    }));
  } catch {}

  const parts = [];
  parts.push(c('#bd93f9', '◆ ' + (j.model?.display_name || 'Claude')) + (j.effort?.level ? c('#6272a4', ' · ') + c('#ff79c6', j.effort.level) : '') + (j.fast_mode ? c('#f1fa8c', ' ⚡') : ''));
  if (ctx != null) parts.push(c('#6272a4', 'ctx ') + c(level(ctx), bar(ctx) + ' ' + Math.round(ctx) + '%'));
  if (rl?.five_hour) parts.push(c('#6272a4', '5h ') + c(level(rl.five_hour.used_percentage), Math.round(rl.five_hour.used_percentage) + '%') + c('#6272a4', ' →' + hhmm(rl.five_hour.resets_at)));
  if (rl?.seven_day) parts.push(c('#6272a4', '7j ') + c(level(rl.seven_day.used_percentage), Math.round(rl.seven_day.used_percentage) + '%') + c('#6272a4', ' →' + dayHHmm(rl.seven_day.resets_at)));
  const cwd = j.workspace?.current_dir || j.cwd;
  if (cwd) parts.push(c('#8be9fd', '  ' + path.basename(cwd)));
  process.stdout.write(parts.join(c('#44475a', '  │  ')));
});
