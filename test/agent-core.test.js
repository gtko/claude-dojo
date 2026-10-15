// Tests du noyau portable de l'agent (src/agent-core.js) : /stats, /theme, protection Host / Origin, valeurs par défaut.
// Échantillonneurs factices, port éphémère (0), dossier de l'agent temporaire et HOME temporaire :
// le test ne lit ni n'écrit jamais dans ~/.claude ni dans la vraie configuration.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startAgent } = require('../src/agent-core');

const MIB = 1024 * 1024;

// Exécute body avec HOME et USERPROFILE (lu par os.homedir sous Windows) pointant vers un dossier temporaire.
async function withTempHome(body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-core-home-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { HOME: home, USERPROFILE: home });
  try {
    return await body(home);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// Dossier de l'agent : un thème (naruto), pas de config.json (thème par défaut).
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-core-root-'));
  const theme = path.join(root, 'themes', 'naruto');
  fs.mkdirSync(theme, { recursive: true });
  fs.writeFileSync(path.join(theme, 'theme.json'), JSON.stringify({ name: 'Naruto test', palette: { accent: '#ff9900' }, chars: [] }));
  return root;
}

function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

// Échantillonneurs de la plateforme, factices : une application visible et un processus masqué (hidden).
const fakeSamplers = () => ({
  sampleProcesses: async () => [
    { pid: 4242, ppid: 1, cpu: 12.5, rss: 200 * MIB, etime: 3600, comm: '/usr/bin/fake', name: 'fake', args: 'fake --serve' },
    { pid: 99, ppid: 1, cpu: 30, rss: 500 * MIB, etime: 60, comm: 'hidden', name: 'hidden', args: 'hidden', hidden: true },
  ],
  sampleNet: async () => ({ rx: 1000, tx: 500, ping: 12 }),
  sampleDisks: () => [{ name: 'Disque test', label: '', total: 1000, free: 400 }],
  sampleSensors: async () => ({ cpuName: 'CPU test', hw: null, memory: { total: 8192 * MIB, used: 2048 * MIB } }),
  sampleBattery: async () => null,
  sampleServers: async () => [],
  stopServer: () => 'refusé : test',
  focusSession: async () => 'ok',
  openUrl: () => 'ok',
  media: { read: async () => null, cmd: async () => null, coverFile: () => null },
  icons: async () => [],
});

test('startAgent : /stats (sessions, cpu, mémoire, disques, réseau, batterie, média), /theme, 403 sur Origin ou Host étrangers', async () => {
  await withTempHome(async () => {
    const root = makeRoot();
    try {
      const agent = await startAgent({ port: 0, root, ...fakeSamplers() });
      try {
        const { port } = agent;
        assert.ok(port > 0, 'port éphémère attribué');

        const r = await get(port, '/stats');
        assert.equal(r.status, 200);
        const s = JSON.parse(r.body);
        assert.ok(Array.isArray(s.sessions), 'sessions : tableau');
        assert.equal(typeof s.cpu, 'number', 'cpu : nombre');
        assert.equal(s.cpuName, 'CPU test');
        assert.equal(s.memTotal, 8192 * MIB);
        assert.equal(s.memUsed, 2048 * MIB);
        assert.deepEqual(s.disks, [{ name: 'Disque test', label: '', total: 1000, free: 400 }]);
        assert.equal(s.net.ping, 12);
        assert.ok(Array.isArray(s.net.history), 'net.history : tableau');
        assert.equal(s.battery, null);
        assert.equal(s.media, null, 'media présent, null sans lecteur');
        assert.ok(s.top.some((g) => g.name === 'fake'), 'le processus visible figure dans les tops');
        assert.ok(!s.top.some((g) => g.name === 'hidden'), 'le processus hidden reste hors des tops');

        const t = await get(port, '/theme');
        assert.equal(t.status, 200);
        const theme = JSON.parse(t.body);
        assert.equal(theme.id, 'naruto');
        assert.equal(theme.name, 'Naruto test');
        assert.equal(theme.palette.accent, '#ff9900');

        const own = await get(port, '/stats', { Origin: `http://127.0.0.1:${port}` });
        assert.equal(own.status, 200, 'Origin de l\'agent accepté');
        const foreign = await get(port, '/stats', { Origin: 'http://evil.example' });
        assert.equal(foreign.status, 403, 'Origin étranger refusé');
        const rebind = await get(port, '/stats', { Host: 'evil.example' });
        assert.equal(rebind.status, 403, 'Host étranger refusé (DNS rebinding)');
      } finally {
        agent.stop();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test('startAgent : session Claude rattachée à un processus (Claude Desktop, ancienneté) dans /stats', async () => {
  await withTempHome(async (home) => {
    const dojo = path.join(home, '.claude', 'dojo');
    fs.mkdirSync(dojo, { recursive: true });
    // pid = celui du test : vivant, donc la session n'est pas purgée
    fs.writeFileSync(path.join(dojo, 's1.json'), JSON.stringify({ id: 's1', pid: process.pid, cwd: home, state: 'working', since: Date.now(), updated: Date.now(), agent: 'claude', prompted: true }));
    const root = makeRoot();
    try {
      const agent = await startAgent({
        port: 0, root,
        sampleProcesses: async () => [
          { pid: process.pid, ppid: 1, cpu: 0, rss: MIB, etime: 120, comm: '/Applications/Claude.app/Contents/MacOS/Claude', name: 'Claude', args: '', desktop: true },
        ],
      });
      try {
        const s = JSON.parse((await get(agent.port, '/stats')).body);
        const sess = s.sessions.find((x) => x.id === 's1');
        assert.ok(sess, 'la session figure dans /stats');
        assert.equal(sess.host, 'desktop', 'hôte Claude Desktop déduit du processus parent');
        assert.equal(typeof sess.started, 'number', 'début de session déduit de l\'ancienneté du processus');
        assert.ok(Math.abs(Date.now() - 120e3 - sess.started) < 20e3, 'début ≈ maintenant - 120 s');
        assert.equal(sess.title, null, 'pas de titre : dossier affiché');
      } finally {
        agent.stop();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test('startAgent sans échantillonneur : valeurs par défaut servies, aucune erreur', async () => {
  await withTempHome(async () => {
    const root = makeRoot();
    try {
      const agent = await startAgent({ port: 0, root });
      try {
        const s = JSON.parse((await get(agent.port, '/stats')).body);
        assert.equal(typeof s.cpu, 'number');
        assert.deepEqual(s.disks, []);
        assert.deepEqual(s.top, []);
        assert.deepEqual(s.servers, []);
        assert.equal(s.battery, null);
        assert.equal(s.media, null);
        assert.equal(s.hw, null);
        assert.equal(s.net.ping, null);
        assert.equal(s.net.down, 0);
        assert.deepEqual(JSON.parse((await get(agent.port, '/media?cmd=next')).body), { result: 'ok', media: null });
        assert.equal(JSON.parse((await get(agent.port, '/open?url=https%3A%2F%2Fexemple.org')).body).result, 'non pris en charge');
      } finally {
        agent.stop();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test('startAgent : carte média gardée si la lecture lève une exception, effacée quand le lecteur renvoie null', async () => {
  await withTempHome(async () => {
    const root = makeRoot();
    let mode = 'media';   // media | throw | null : comportement du lecteur, lu à chaque cycle (toutes les 2 s)
    const media = { active: true, title: 'Titre test', artist: 'Artiste', updated: 1 };
    try {
      const agent = await startAgent({
        port: 0, root,
        ...fakeSamplers(),
        media: {
          read: async () => { if (mode === 'throw') throw new Error('lecture impossible'); return mode === 'media' ? media : null; },
          cmd: async () => null,
          coverFile: () => null,
        },
      });
      try {
        const title = async () => (JSON.parse((await get(agent.port, '/stats')).body).media || {}).title || null;
        const cycle = () => new Promise((r) => setTimeout(r, 2500));   // au moins un cycle de lecture média (2 s)
        assert.equal(await title(), 'Titre test', 'carte lue au démarrage');
        mode = 'throw';
        await cycle();
        assert.equal(await title(), 'Titre test', 'exception de lecture : dernière carte conservée');
        mode = 'null';
        await cycle();
        assert.equal(await title(), null, 'lecteur sans média (null) : carte effacée');
      } finally {
        agent.stop();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test('startAgent : onCreated fournit stop() avant la résolution, qui appelle onStop', async () => {
  await withTempHome(async () => {
    const root = makeRoot();
    let stopNow = null, stopped = 0;
    // startAgent n'est pas attendu : stop() est appelé avant que le serveur n'écoute (cas d'un SIGTERM précoce).
    const started = startAgent({
      port: 0, root,
      ...fakeSamplers(),
      onStop: () => { stopped++; },
      onCreated: (fn) => { stopNow = fn; },
    });
    started.catch(() => {});
    try {
      assert.equal(typeof stopNow, 'function', 'stop disponible dès la création');
      stopNow();
      assert.equal(stopped, 1, 'onStop appelé par stop()');
    } finally {
      // sans stop précoce (échec ci-dessus), l'agent resterait ouvert et bloquerait le processus de test
      if (!stopNow) started.then((a) => a.stop(), () => {});
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
