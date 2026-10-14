// Hook Claude Code → écrit l'état de chaque session dans ~/.claude/dojo/<session>.json
// Lu par l'agent du fond d'écran pour animer les ninjas.
const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = path.join(os.homedir(), '.claude', 'dojo');

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    const id = String(input.session_id || 'unknown').replace(/[^\w-]/g, '');
    const file = path.join(dir, id + '.json');
    fs.mkdirSync(dir, { recursive: true });

    if (input.hook_event_name === 'SessionEnd') {
      fs.rmSync(file, { force: true });
      return;
    }

    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}

    const now = Date.now();
    let state = prev.state || 'idle';
    let tool = prev.tool || null;

    switch (input.hook_event_name) {
      case 'SessionStart':     state = 'idle'; tool = null; break;
      case 'UserPromptSubmit': state = 'working'; tool = null; break;
      case 'PreToolUse':       state = 'working'; tool = input.tool_name || null; break;
      case 'Stop':             state = 'idle'; tool = null; break;
      case 'Notification':
        if (/permission|approv|autoris/i.test(input.message || '')) state = 'waiting';
        break;
    }

    const record = {
      id,
      cwd: input.cwd || prev.cwd || '',
      state,
      tool,
      since: state !== prev.state ? now : prev.since || now,
      started: prev.started || now,               // début de session : ordre stable des ninjas (Naruto = la plus ancienne)
      pid: process.ppid || prev.pid,             // processus Claude Code (pour ramener sa fenêtre au clic)
      // a reçu au moins un message (Claude Desktop recharge d'anciennes sessions en arrière-plan sans qu'on y écrive)
      prompted: !!(prev.prompted || /^(UserPromptSubmit|PreToolUse)$/.test(input.hook_event_name)),
      updated: now,
    };
    fs.writeFileSync(file, JSON.stringify(record));
  } catch {
    // ne jamais bloquer Claude Code
  }
});
