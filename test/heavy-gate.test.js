// Tests du hook PreToolUse src/heavy-gate.js (node:test) : le hook est lance comme Claude Code le fait,
// avec le JSON de l'appel sur stdin, et sa sortie est lue sur stdout.
// HEAVY_GATE_MAX=0 refuse toute commande lourde reconnue, sans lire la liste des processus : le resultat ne depend
// donc ni de l'etat reel de la machine, ni de la vitesse du runner (test deterministe). Pour les autres seuils, le
// hook lit la liste (Get-CimInstance sous Windows, ps ailleurs) et, si cette lecture echoue ou depasse son delai,
// il laisse passer en silence (fail-open).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.resolve(__dirname, '..', 'src', 'heavy-gate.js');

// pathValue (optionnel) remplace PATH : une chaine vide empeche de lancer powershell.exe ou ps.
function runHook(toolName, command, pathValue) {
  const env = { ...process.env, HEAVY_GATE_MAX: '0' };
  delete env.HEAVY_GATE;
  delete env.HEAVY_GATE_MAX_NODE;
  if (pathValue !== undefined) {
    for (const k of Object.keys(env)) if (/^path$/i.test(k)) delete env[k];   // Windows : Path et PATH coexistent sinon
    env.PATH = pathValue;
  }
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command } }),
    env,
    encoding: 'utf8',
    timeout: 20000,
  });
}

test('outil PowerShell : npx vitest run est refuse (permissionDecision deny)', () => {
  const res = runHook('PowerShell', 'npx vitest run');
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Machine saturée/);
});

test('HEAVY_GATE_MAX=0 : refus meme sans powershell.exe ni ps (aucune lecture des processus)', () => {
  const res = runHook('PowerShell', 'npx vitest run', '');
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Machine saturée/);
});

test('outil PowerShell : ls ne produit aucune sortie (laisse passer)', () => {
  const res = runHook('PowerShell', 'ls');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, '');
});
