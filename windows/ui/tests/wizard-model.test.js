'use strict';
// Tests de la logique de l'assistant (wizard-model.js) : node --test windows/ui/tests/wizard-model.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../wizard-model.js');

const HOME = 'C:\\Users\\alice';

function detect(overrides) {
  return Object.assign({
    ok: true,
    node: { path: 'C:\\node\\node.exe', version: 'v20.11.0', ok: true },
    claude: { path: 'C:\\claude\\claude.exe' },
    gh: { path: 'C:\\gh\\gh.exe', authed: true },
    settings: { path: 'x', exists: true, statusLine: null, heavyGatePerso: false, hooksDojo: false },
    install: { installed: false, configExists: false },
    config: {},
    home: HOME
  }, overrides || {});
}

function wizard(opts) {
  return M.createWizard(Object.assign({ detect: detect(), autostart: false, chooserAvailable: true, activeTheme: 'dojo', activeBackground: null, autoDownload: true }, opts || {}));
}

function atStep(w, index) {
  w.state.step = index;
  return w;
}

// ── Étapes et navigation ──────────────────────────────────────────────────

test('canGoNext : Node.js absent bloque l\'étape Dépendances', () => {
  const ok = atStep(wizard(), 1);
  assert.equal(ok.canGoNext(), true);
  const ko = atStep(wizard({ detect: detect({ node: { path: null, version: null, ok: false } }) }), 1);
  assert.equal(ko.canGoNext(), false);
  assert.equal(ko.next(), false);
  assert.equal(ko.state.step, 1);
});

test('canGoNext : Node.js trop ancien bloque aussi', () => {
  const old = atStep(wizard({ detect: detect({ node: { path: 'x', version: 'v16.0.0', ok: false } }) }), 1);
  assert.equal(old.canGoNext(), false);
});

test('canGoNext : URL d\'agenda invalide bloque, vide et valide passent', () => {
  const w = atStep(wizard(), 5);
  w.state.calendars = ['https://ok.example/a.ics', ''];
  assert.equal(w.canGoNext(), true);
  w.state.calendars = ['ftp://nope.example/a.ics'];
  assert.equal(w.canGoNext(), false);
  w.state.calendars = ['webcal://ok.example/a.ics'];
  assert.equal(w.canGoNext(), true);
});

test('canGoNext : Terminé ne va nulle part, les autres étapes passent', () => {
  assert.equal(atStep(wizard(), 9).canGoNext(), false);
  assert.equal(atStep(wizard(), 0).canGoNext(), true);
  assert.equal(atStep(wizard(), 2).canGoNext(), true);
});

test('navigation : pas de Précédent à l\'étape 1, Suivant avance', () => {
  const w = wizard();
  assert.equal(w.canGoBack(), false);
  assert.equal(w.footer().back.visible, false);
  assert.equal(w.next(), true);
  assert.equal(w.stepInfo().text, 'Étape 2 sur 10 · Dépendances');
  assert.equal(w.back(), true);
  assert.equal(w.state.step, 0);
});

test('pied : Appliquer sur la dernière étape, désactivé pendant l\'application', () => {
  const w = atStep(wizard(), 9);
  assert.deepEqual(w.footer().primary, { label: 'Appliquer', action: 'apply', disabled: false });
  w.startApply(null);
  assert.deepEqual(w.footer().primary, { label: 'Application…', action: 'apply', disabled: true });
  assert.equal(w.footer().back.disabled, true);
  assert.equal(w.canGoBack(), false);
  w.finishApply(true);
  assert.deepEqual(w.footer().primary, { label: 'Fermer', action: 'close', disabled: false });
  assert.equal(w.footer().back.visible, false);
});

test('en-tête : 10 étapes, titres du Mac', () => {
  assert.equal(M.STEPS.length, 10);
  assert.deepEqual(M.STEPS.map((s) => s.title), ['Bienvenue', 'Dépendances', 'Météo', 'GitHub', 'Projets', 'Calendriers', 'Claude Code', 'Démarrage automatique', 'Thème', 'Terminé']);
});

// ── Validations ───────────────────────────────────────────────────────────

test('URL d\'agenda : https, http et webcal acceptés, le reste refusé', () => {
  assert.equal(M.isCalendarUrl('https://a.example/x.ics'), true);
  assert.equal(M.isCalendarUrl('http://a.example/x.ics'), true);
  assert.equal(M.isCalendarUrl('webcal://a.example/x.ics'), true);
  assert.equal(M.isCalendarUrl('  https://a.example  '), true);
  assert.equal(M.isCalendarUrl('ftp://a.example'), false);
  assert.equal(M.isCalendarUrl('a.example/x.ics'), false);
  assert.equal(M.isCalendarUrl(''), false);
});

test('message d\'erreur par champ d\'agenda', () => {
  assert.equal(M.calendarError(''), '');
  assert.equal(M.calendarError('   '), '');
  assert.equal(M.calendarError('https://a.example'), '');
  assert.equal(M.calendarError('nope'), 'URL invalide : elle doit commencer par https://, http:// ou webcal://');
});

test('abréviation ~ : sous le dossier personnel seulement', () => {
  assert.equal(M.abbreviateHome('C:\\Users\\alice\\Projets\\app', HOME), '~\\Projets\\app');
  assert.equal(M.abbreviateHome('C:/Users/alice/Projets', HOME), '~/Projets');
  assert.equal(M.abbreviateHome('c:\\users\\ALICE', HOME), '~');
  assert.equal(M.abbreviateHome('C:\\Users\\alicebis\\x', HOME), 'C:\\Users\\alicebis\\x');
  assert.equal(M.abbreviateHome('D:\\Code', HOME), 'D:\\Code');
  assert.equal(M.abbreviateHome('D:\\Code', ''), 'D:\\Code');
});

test('dédoublonnage des dossiers : abrégés et absolus comptent pour le même', () => {
  let roots = [];
  roots = M.addRoot(roots, 'C:\\Users\\alice\\Projets', HOME);
  assert.deepEqual(roots, ['~\\Projets']);
  roots = M.addRoot(roots, 'c:\\users\\alice\\projets\\', HOME);
  assert.deepEqual(roots, ['~\\Projets']);
  roots = M.addRoot(roots, '   ', HOME);
  assert.deepEqual(roots, ['~\\Projets']);
  roots = M.addRoot(roots, 'D:\\Code', HOME);
  assert.deepEqual(roots, ['~\\Projets', 'D:\\Code']);
  assert.deepEqual(M.uniqueRoots(['~\\Projets', 'C:\\Users\\alice\\Projets', ' ', 'D:\\Code'], HOME), ['~\\Projets', 'D:\\Code']);
});

test('propriétaires : trim, vides ignorés', () => {
  assert.deepEqual(M.addOwner([], '  acme  '), ['acme']);
  assert.deepEqual(M.addOwner(['acme'], '   '), ['acme']);
});

test('lieux géocodés : coordonnées non numériques écartées ; aucun résultat -> message', () => {
  const list = M.usableGeoResults([
    { name: 'Paris', country: 'France', lat: 48.85, lon: 2.35, timezone: 'Europe/Paris' },
    { name: 'Nulle part', lat: null, lon: 1 }
  ]);
  assert.equal(list.length, 1);
  assert.equal(M.geoLabel(list[0]), 'Paris, France');
  const w = wizard();
  w.setGeoResults([], 'Zzz');
  assert.equal(w.state.geoError, 'Aucun résultat pour « Zzz ».');
  assert.equal(w.state.geoBusy, false);
});

test('texte de nodeDetail', () => {
  assert.equal(M.nodeDetail(null), 'absent (requis : 18 ou plus récent)');
  assert.equal(M.nodeDetail({ path: 'p', version: 'v16.1.0', ok: false }), 'v16.1.0, 18 minimum requis');
  assert.equal(M.nodeDetail({ path: 'p', version: 'v20.0.0', ok: true }), 'v20.0.0');
});

// ── Construction de la configuration ─────────────────────────────────────

test('construction exacte de la config : clés attendues, aucun secret, aucun thème', () => {
  const w = wizard({ detect: detect({ config: { sentry: { token: 'SECRET', org: 'o' }, theme: 'dojo' } }) });
  w.state.weather = M.weatherFrom({ name: 'Paris', lat: 48.85, lon: 2.35, timezone: 'Europe/Paris' });
  w.state.owners = ['  acme ', '', 'globex'];
  w.state.roots = ['~\\Projets', 'C:\\Users\\alice\\Projets', 'D:\\Code'];
  w.state.onlyOwners = true;
  w.state.calendars = ['https://a.example/x.ics', 'nope', '  webcal://b.example/y.ics '];
  const patch = w.buildConfigPatch(null);
  assert.deepEqual(patch, {
    weather: { name: 'Paris', lat: 48.85, lon: 2.35, timezone: 'Europe/Paris' },
    calendars: ['https://a.example/x.ics', 'webcal://b.example/y.ics'],
    github: { owners: ['acme', 'globex'] },
    projects: { roots: ['~\\Projets', 'D:\\Code'], onlyOwners: true }
  });
  assert.equal(JSON.stringify(patch).includes('SECRET'), false);
  assert.equal('sentry' in patch, false);
  assert.equal('theme' in patch, false);
});

test('pas de météo : weather null (write-config supprime la clé) ; timezone null omis', () => {
  const w = wizard();
  assert.equal(w.buildConfigPatch(null).weather, null);
  w.state.weather = M.weatherFrom({ name: 'Lyon', lat: 45.76, lon: 4.83, timezone: null });
  assert.deepEqual(w.buildConfigPatch(null).weather, { name: 'Lyon', lat: 45.76, lon: 4.83 });
});

test('autoDownload du sélecteur de thème rejoint wallpapers dans la config', () => {
  const w = wizard();
  assert.deepEqual(w.buildConfigPatch({ autoDownload: false }).wallpapers, { autoDownload: false });
  assert.equal('wallpapers' in w.buildConfigPatch(null), false);
});

test('options Claude Code : fusion en dry-run ou réelle', () => {
  const w = wizard();
  w.setOptions({ hooks: false, statusLine: 'none', heavyGate: true, vitestWorkers: false });
  assert.deepEqual(w.buildMergeOptions(true), { hooks: false, statusLine: 'none', heavyGate: true, vitestWorkers: false, dryRun: true });
  assert.equal(w.buildMergeOptions(false).dryRun, false);
  const call = w.previewCall();
  assert.equal(call.cmd, 'merge-settings');
  assert.deepEqual(call.args, ['-']);
  assert.deepEqual(JSON.parse(call.stdin), { hooks: false, statusLine: 'none', heavyGate: true, vitestWorkers: false, dryRun: true });
});

test('préremplissage : config existante -> réglages, barre de statut conservée, gate perso', () => {
  const w = wizard({
    detect: detect({
      install: { configExists: true },
      config: { weather: { name: 'Paris', lat: 48.85, lon: 2.35 }, github: { owners: ['acme'] }, projects: { roots: ['~\\P'], onlyOwners: true }, calendars: ['https://a'] },
      settings: { statusLine: { command: 'x' }, heavyGatePerso: true }
    }),
    autostart: false
  });
  assert.equal(w.state.editing, true);
  assert.equal(w.state.city, 'Paris');
  assert.equal(w.state.statusLine, 'keep');
  assert.equal(w.state.heavyGate, false);
  assert.equal(w.state.autostart, false);
  assert.deepEqual(w.state.owners, ['acme']);
  assert.equal(w.state.onlyOwners, true);
});

test('installation neuve : autostart coché, barre de statut remplacée, gate actif', () => {
  const w = wizard();
  assert.equal(w.state.editing, false);
  assert.equal(w.state.autostart, true);
  assert.equal(w.state.statusLine, 'replace');
  assert.equal(w.state.heavyGate, true);
  assert.equal(w.state.hooks, true);
});

// ── Plan d'application ────────────────────────────────────────────────────

test('plan complet : ordre write-config, set-theme, fond, terminal, merge, autostart, rechargement', () => {
  const w = wizard({ activeTheme: 'dojo', activeBackground: null });
  w.state.statusLine = 'replace';
  w.state.autostart = true;
  const plan = w.buildApplyPlan({
    theme: 'neon',
    background: { kind: 'wallhaven', id: 'abc123' },
    terminal: { windowsTerminal: true, welcome: false },
    autoDownload: true
  });
  const kinds = plan.map((s) => s.cmd || s.native);
  assert.deepEqual(kinds, ['write-config', 'set-theme', 'wallpapers', 'terminal', 'merge-settings', 'autostart.set', 'reloadWallpaper']);
  assert.deepEqual(plan[1].args, ['neon']);
  assert.deepEqual(plan[2].args, ['use', 'abc123', 'neon']);
  assert.deepEqual(plan[3].args, ['apply', '{"windowsTerminal":true,"welcome":false}']);
  assert.deepEqual(plan[5].payload, { enabled: true });
  assert.deepEqual(plan[6].payload, {});
});

test('aucun secret en argv : seul write-config et merge-settings passent du JSON sur stdin', () => {
  const w = wizard({ detect: detect({ config: { sentry: { token: 'SECRET', org: 'o' } } }) });
  const plan = w.buildApplyPlan({ theme: 'neon', background: { kind: 'file', path: 'C:\\img\\a.jpg' }, terminal: { windowsTerminal: true, welcome: true } });
  for (const step of plan) {
    if (step.cmd) {
      assert.equal(step.args.join(' ').includes('SECRET'), false, step.cmd);
      if (step.cmd === 'write-config' || step.cmd === 'merge-settings') {
        assert.deepEqual(step.args, ['-']);
        assert.equal(typeof step.stdin, 'string');
      } else {
        assert.equal(step.stdin, undefined, step.cmd);
      }
    }
  }
  // Le jeton Sentry n'est pas recopié : write-config fusionne avec config.json existant et le conserve.
  assert.equal(JSON.stringify(plan).includes('SECRET'), false);
});

test('sélecteur inchangé : pas de set-theme, de fond ni de terminal', () => {
  const w = wizard({ activeTheme: 'dojo', activeBackground: null });
  const plan = w.buildApplyPlan({ theme: 'dojo', background: { kind: 'theme' }, terminal: { windowsTerminal: false, welcome: false } });
  assert.deepEqual(plan.map((s) => s.cmd || s.native), ['write-config', 'merge-settings', 'autostart.set', 'reloadWallpaper']);
});

test('sans sélecteur : seulement config, settings, autostart, rechargement', () => {
  const w = wizard();
  const plan = w.buildApplyPlan(null);
  assert.deepEqual(plan.map((s) => s.cmd || s.native), ['write-config', 'merge-settings', 'autostart.set', 'reloadWallpaper']);
});

test('fond : retour au fond du thème -> set-background default ; fichier -> chemin', () => {
  const w = wizard({ activeTheme: 'dojo', activeBackground: 'C:\\old\\a.jpg' });
  const toTheme = w.buildApplyPlan({ theme: 'dojo', background: { kind: 'theme' }, terminal: {} });
  assert.deepEqual(toTheme.find((s) => s.cmd === 'set-background').args, ['default']);
  const toFile = w.buildApplyPlan({ theme: 'dojo', background: { kind: 'file', path: 'C:\\new\\b.png' }, terminal: {} });
  assert.deepEqual(toFile.find((s) => s.cmd === 'set-background').args, ['C:\\new\\b.png']);
  const same = w.buildApplyPlan({ theme: 'dojo', background: { kind: 'file', path: 'C:\\old\\a.jpg' }, terminal: {} });
  assert.equal(same.some((s) => s.cmd === 'set-background'), false);
});

test('terminal : retrait puis application ; rien si identique', () => {
  const w = wizard({ detect: detect({ config: { terminal: { windowsTerminal: true, welcome: true } } }) });
  const d = M.terminalDelta({ windowsTerminal: true, welcome: true }, { windowsTerminal: true, welcome: false });
  assert.deepEqual(d.remove, { welcome: true });
  assert.deepEqual(d.apply, { windowsTerminal: true, welcome: false });
  const same = M.terminalDelta({ windowsTerminal: true, welcome: false }, { windowsTerminal: true, welcome: false });
  assert.equal(same.remove, null);
  assert.equal(same.apply, null);
  const plan = w.buildApplyPlan({ theme: '', background: { kind: 'theme' }, terminal: { windowsTerminal: true, welcome: false } });
  const terminalSteps = plan.filter((s) => s.cmd === 'terminal');
  assert.equal(terminalSteps.length, 2);
  assert.equal(terminalSteps[0].args[0], 'remove');
  assert.equal(terminalSteps[1].args[0], 'apply');
});

test('runPlan : ordre, arrêt à la première erreur, reprise à partir de l\'index', async () => {
  const plan = [{ cmd: 'a' }, { cmd: 'b' }, { cmd: 'c' }];
  const seen = [];
  const failOnB = async (step) => {
    seen.push(step.cmd);
    if (step.cmd === 'b') throw new Error('boum');
  };
  const res = await M.runPlan(plan, failOnB, 0);
  assert.deepEqual(seen, ['a', 'b']);
  assert.deepEqual(res, { ok: false, index: 1, error: 'boum' });

  const rest = [];
  const ok = await M.runPlan(plan, async (s) => { rest.push(s.cmd); }, res.index);
  assert.deepEqual(rest, ['b', 'c']);
  assert.deepEqual(ok, { ok: true });
});

test('application : erreur affichée, reprise à l\'étape en échec, puis Terminé', () => {
  const w = atStep(wizard(), 9);
  const first = w.startApply(null);
  assert.equal(first.from, 0);
  w.finishApply(false, 'stdin refusé', 2);
  assert.equal(w.state.applyError, 'Application impossible : stdin refusé');
  assert.equal(w.state.applying, false);
  const retry = w.startApply(null);
  assert.equal(retry.from, 2);
  assert.equal(retry.plan, first.plan);
  w.finishApply(true);
  assert.equal(w.state.applied, true);
  assert.equal(w.state.applyError, null);
  assert.equal(w.startApply(null), null);
});

test('changement d\'étape pendant une erreur : le plan est reconstruit', () => {
  const w = atStep(wizard(), 9);
  w.startApply(null);
  w.finishApply(false, 'x', 3);
  w.back();
  w.next();
  const again = w.startApply(null);
  assert.equal(again.from, 0);
});

// ── Aperçu et résumé ──────────────────────────────────────────────────────

test('aperçu : compte ajouts, modifications et retraits du diff', () => {
  const diff = ['+ "hooks": {', '- "old": 1', '+ "new": 2', '+ "x": 3'].join('\n');
  const c = M.diffCounts(diff);
  assert.deepEqual(c, { added: 2, removed: 0, modified: 1 });
  assert.deepEqual(M.changeLines(diff), ['Ajouté : 2 ligne(s)', 'Modifié : 1 ligne(s)']);
  const p = M.previewFromResult({ changed: true, diff, heavyGateThresholds: { HEAVY_GATE_MAX: 3, HEAVY_GATE_MAX_NODE: 16 } });
  assert.equal(p.changed, true);
  assert.deepEqual(p.heavyLimits, { suites: 3, nodes: 16 });
  assert.equal(M.previewFromResult({ changed: false, diff: '' }).heavyLimits, null);
});

test('résumé de l\'étape Terminé : puces attendues', () => {
  const w = wizard({ detect: detect({ config: { github: { owners: ['acme', ' '] }, projects: { roots: ['~\\P'] } } }) });
  w.state.statusLine = 'keep';
  w.state.hooks = false;
  w.state.autostart = false;
  const lines = w.summaryLines({ theme: 'neon', background: { kind: 'wallhaven', id: 'abc123' }, terminal: { windowsTerminal: true, welcome: false } });
  assert.equal(lines[0], 'Node.js : v20.11.0');
  assert.equal(lines[1], 'Météo : désactivée');
  assert.equal(lines[2], 'GitHub : 1 propriétaire(s)');
  assert.equal(lines[3], 'Projets : 1 dossier(s), tous les dépôts');
  assert.equal(lines[4], 'Calendriers : 0');
  assert.equal(lines[5], 'Thème : neon');
  assert.equal(lines[6], 'Fond : fond Wallhaven « abc123 »');
  assert.equal(lines[7], 'Terminal : Windows Terminal');
  assert.equal(lines[8], 'Claude Code : hooks Dojo non, barre de statut conservée');
  assert.equal(lines[9], 'Démarrage automatique : non');
});

test('choix météo : texte « Choisi » et remise à zéro', () => {
  const w = wizard();
  w.chooseWeather({ name: 'Paris', country: 'France', lat: 48.8534, lon: 2.3488, timezone: 'Europe/Paris' });
  assert.equal(M.weatherChoiceText(w.state.weather), 'Choisi : Paris · lat 48.8534 · lon 2.3488 · fuseau Europe/Paris');
  w.clearWeather();
  assert.equal(w.state.weather, null);
  assert.equal(w.state.city, '');
});
