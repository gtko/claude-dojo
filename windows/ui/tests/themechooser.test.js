'use strict';

// Logique pure du sélecteur « Thème et fond » (themechooser.js). Pas de DOM : le module se charge sans window.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const chooser = require(path.join(__dirname, '..', 'themechooser.js'));

const SAME = { windowsTerminal: false, welcome: false };

test('basename accepte / et \\ comme séparateurs', () => {
  assert.equal(chooser.basename('C:\\Users\\me\\Images\\fond.jpg'), 'fond.jpg');
  assert.equal(chooser.basename('/home/me/fond.png'), 'fond.png');
  assert.equal(chooser.basename('sans-dossier.webp'), 'sans-dossier.webp');
  assert.equal(chooser.basename(null), '');
});

test('thumbnailFile : nom de fichier renvoyé tel quel, sinon thumbnail.jpg', () => {
  assert.equal(chooser.thumbnailFile('vignette.jpg'), 'vignette.jpg');
  assert.equal(chooser.thumbnailFile('C:\\dojo\\themes\\naruto\\thumbnail.jpg'), 'thumbnail.jpg');
  assert.equal(chooser.thumbnailFile('/opt/dojo/themes/naruto/thumbnail.jpg'), 'thumbnail.jpg');
  assert.equal(chooser.thumbnailFile(null), 'thumbnail.jpg');
  assert.equal(chooser.thumbnailFile(''), 'thumbnail.jpg');
});

test('parseBackground : fond du thème, fond personnel, fond Wallhaven de galerie', () => {
  for (const value of [null, undefined, '', 'default', 'theme']) {
    assert.deepEqual(chooser.parseBackground(value), { kind: 'theme' }, `valeur ${JSON.stringify(value)}`);
  }
  assert.deepEqual(chooser.parseBackground('C:\\Users\\me\\photo.jpg'), { kind: 'file', path: 'C:\\Users\\me\\photo.jpg' });
  assert.deepEqual(
    chooser.parseBackground('C:\\Users\\me\\AppData\\Dojo\\backgrounds\\naruto\\wallhaven-abc123.jpg'),
    { kind: 'wallhaven', id: 'abc123' },
  );
  assert.deepEqual(chooser.parseBackground({ kind: 'wallhaven', id: 'xyz789' }), { kind: 'wallhaven', id: 'xyz789' });
  assert.deepEqual(chooser.parseBackground({ kind: 'file', path: '/tmp/a.png' }), { kind: 'file', path: '/tmp/a.png' });
  assert.deepEqual(chooser.parseBackground({ kind: 'file', path: '' }), { kind: 'theme' });
  assert.deepEqual(chooser.parseBackground({ kind: 'inconnu' }), { kind: 'theme' });
});

test('resolveTheme : préféré, puis repli, puis premier thème, puis vide', () => {
  const themes = [{ id: 'naruto' }, { id: 'frieren' }];
  assert.equal(chooser.resolveTheme('frieren', themes, 'naruto'), 'frieren');
  assert.equal(chooser.resolveTheme('absent', themes, 'naruto'), 'naruto');
  assert.equal(chooser.resolveTheme('absent', themes, 'absent aussi'), 'naruto');
  assert.equal(chooser.resolveTheme(undefined, [], 'naruto'), '');
});

test('downloadsFrom retire le fond intégré et les entrées incomplètes', () => {
  const res = {
    ok: true,
    theme: 'naruto',
    wallpapers: [
      { id: 'theme', file: '/dojo/themes/naruto/background.jpg', builtin: true },
      { id: 'abc123', file: 'wallhaven-abc123.jpg', source: null, resolution: '1920x1080', current: true, builtin: false },
      { id: 'def456', file: 'wallhaven-def456.png', resolution: null, builtin: false },
      { file: 'sans-id.jpg', builtin: false },
    ],
  };
  assert.deepEqual(chooser.downloadsFrom(res), [
    { id: 'abc123', file: 'wallhaven-abc123.jpg', resolution: '1920x1080' },
    { id: 'def456', file: 'wallhaven-def456.png', resolution: null },
  ]);
  assert.deepEqual(chooser.downloadsFrom({ ok: true }), []);
});

test('keepBackgroundFor : un fond Wallhaven absent du thème revient au fond du thème', () => {
  const downloads = [{ id: 'abc123', file: 'wallhaven-abc123.jpg', resolution: null }];
  assert.deepEqual(chooser.keepBackgroundFor({ kind: 'wallhaven', id: 'abc123' }, downloads), { kind: 'wallhaven', id: 'abc123' });
  assert.deepEqual(chooser.keepBackgroundFor({ kind: 'wallhaven', id: 'zzz999' }, downloads), { kind: 'theme' });
  assert.deepEqual(chooser.keepBackgroundFor({ kind: 'file', path: '/a/b.jpg' }, []), { kind: 'file', path: '/a/b.jpg' });
  assert.deepEqual(chooser.keepBackgroundFor({ kind: 'theme' }, []), { kind: 'theme' });
});

test('backgroundLabel : nom du fichier, nom du fond téléchargé, ou fond du thème', () => {
  const downloads = [{ id: 'abc123', file: 'wallhaven-abc123.jpg', resolution: null }];
  assert.equal(chooser.backgroundLabel({ kind: 'theme' }, downloads), 'fond du thème');
  assert.equal(chooser.backgroundLabel({ kind: 'file', path: 'C:\\x\\photo.heic' }, downloads), 'photo.heic');
  assert.equal(chooser.backgroundLabel({ kind: 'wallhaven', id: 'abc123' }, downloads), 'wallhaven-abc123.jpg');
  assert.equal(chooser.backgroundLabel({ kind: 'wallhaven', id: 'zzz999' }, downloads), 'fond Wallhaven zzz999');
});

test('terminalState : clés absentes comptent comme faux, known vaut vrai dès qu une réponse existe', () => {
  assert.deepEqual(chooser.terminalState(undefined), { known: false, wtInstalled: null, windowsTerminal: false, welcome: false });
  assert.deepEqual(chooser.terminalState({}), { known: true, wtInstalled: null, windowsTerminal: false, welcome: false });
  const status = {
    ok: true,
    windowsTerminal: { installed: false, applied: true },
    powershell: { welcome: true },
  };
  assert.deepEqual(chooser.terminalState(status), { known: true, wtInstalled: false, windowsTerminal: true, welcome: true });
});

test('terminalChanges : apply pour les clés activées, remove pour les clés désactivées', () => {
  assert.deepEqual(chooser.terminalChanges(SAME, SAME), { apply: null, remove: null });
  assert.deepEqual(chooser.terminalChanges(SAME, { windowsTerminal: true, welcome: false }), {
    apply: { windowsTerminal: true },
    remove: null,
  });
  assert.deepEqual(chooser.terminalChanges({ windowsTerminal: true, welcome: true }, { windowsTerminal: true, welcome: false }), {
    apply: null,
    remove: { welcome: true },
  });
  assert.deepEqual(chooser.terminalChanges({ windowsTerminal: true, welcome: false }, { windowsTerminal: false, welcome: true }), {
    apply: { welcome: true },
    remove: { windowsTerminal: true },
  });
});

test('buildSelection : forme du contrat getSelection', () => {
  const state = {
    theme: 'naruto',
    background: { kind: 'wallhaven', id: 'abc123' },
    terminal: { windowsTerminal: true, welcome: false },
    autoDownload: false,
  };
  assert.deepEqual(chooser.buildSelection(state), {
    theme: 'naruto',
    background: { kind: 'wallhaven', id: 'abc123' },
    terminal: { windowsTerminal: true, welcome: false },
    autoDownload: false,
  });
  assert.deepEqual(chooser.buildSelection({ ...state, background: { kind: 'theme' } }).background, { kind: 'theme' });
  assert.deepEqual(chooser.buildSelection({ ...state, background: { kind: 'file', path: 'C:\\a.jpg' } }).background, {
    kind: 'file',
    path: 'C:\\a.jpg',
  });
});

test('buildApplyPlan : set-theme, puis fond, puis terminal, puis téléchargement automatique', () => {
  const initial = { terminal: { windowsTerminal: false, welcome: true }, terminalKnown: true, autoDownload: true };
  const selection = {
    theme: 'frieren',
    background: { kind: 'file', path: 'C:\\Users\\me\\photo.jpg' },
    terminal: { windowsTerminal: true, welcome: false },
    autoDownload: false,
  };
  assert.deepEqual(chooser.buildApplyPlan(selection, initial), [
    { step: 'theme', cmd: 'set-theme', args: ['frieren'] },
    { step: 'background', cmd: 'set-background', args: ['C:\\Users\\me\\photo.jpg'] },
    { step: 'terminal', cmd: 'terminal', args: ['apply', '{"windowsTerminal":true}'] },
    { step: 'terminal', cmd: 'terminal', args: ['remove', '{"welcome":true}'] },
    { step: 'autoDownload', cmd: 'write-config', args: ['-'], stdin: '{"wallpapers":{"autoDownload":false}}' },
  ]);
});

test('buildApplyPlan : fond du thème, fond Wallhaven, et rien pour le terminal si son état est inconnu', () => {
  const base = { theme: 'naruto', terminal: SAME, autoDownload: true };
  const unknown = { terminal: { windowsTerminal: false, welcome: false }, terminalKnown: false, autoDownload: true };
  assert.deepEqual(chooser.buildApplyPlan({ ...base, background: { kind: 'theme' } }, unknown), [
    { step: 'theme', cmd: 'set-theme', args: ['naruto'] },
    { step: 'background', cmd: 'set-background', args: ['default'] },
  ]);
  const plan = chooser.buildApplyPlan(
    { ...base, background: { kind: 'wallhaven', id: 'abc123' }, terminal: { windowsTerminal: true, welcome: false } },
    unknown,
  );
  assert.deepEqual(plan, [
    { step: 'theme', cmd: 'set-theme', args: ['naruto'] },
    { step: 'background', cmd: 'wallpapers', args: ['use', 'abc123', 'naruto'] },
  ]);
});

test('buildApplyPlan : pas d écriture de téléchargement automatique si la valeur n a pas changé', () => {
  const initial = { terminal: SAME, terminalKnown: true, autoDownload: true };
  const plan = chooser.buildApplyPlan({ theme: 'naruto', background: { kind: 'theme' }, terminal: SAME, autoDownload: true }, initial);
  assert.deepEqual(plan.map((s) => s.cmd), ['set-theme', 'set-background']);
});

test('shouldOfferGallery : seulement si la galerie est ouvrable, hasDownloads faux, et pas encore proposée', () => {
  const none = { ok: true, theme: 'naruto', background: null, hasDownloads: false, needsSync: false };
  assert.equal(chooser.shouldOfferGallery(none, 'naruto', {}, true), true);
  assert.equal(chooser.shouldOfferGallery(none, 'naruto', {}, false), false);
  assert.equal(chooser.shouldOfferGallery({ ...none, hasDownloads: true }, 'naruto', {}, true), false);
  assert.equal(chooser.shouldOfferGallery({ ok: true, theme: 'naruto' }, 'naruto', {}, true), false);
  assert.equal(chooser.shouldOfferGallery(none, 'naruto', { naruto: true }, true), false);
  assert.equal(chooser.shouldOfferGallery(null, 'naruto', {}, true), false);
});

test('galerie : action openWindow, charge utile { page, theme } du thème courant, bouton activé', () => {
  assert.equal(chooser.GALLERY_WINDOW_ACTION, 'openWindow');
  assert.deepEqual(chooser.galleryPayload('naruto'), { page: 'gallery', theme: 'naruto' });
  assert.deepEqual(Object.keys(chooser.galleryPayload('naruto')).sort(), ['page', 'theme']);
  const none = { ok: true, theme: 'naruto', background: null, hasDownloads: false, needsSync: false };
  assert.equal(chooser.shouldOfferGallery(none, 'naruto', {}, chooser.GALLERY_WINDOW_ACTION !== null), true);
});

test('errorMessage et messages d application : Error, chaîne ou erreur vide', () => {
  assert.equal(chooser.errorMessage(new Error('fichier introuvable')), 'fichier introuvable');
  assert.equal(chooser.errorMessage('pont indisponible'), 'pont indisponible');
  assert.equal(chooser.errorMessage(new Error('   ')), 'erreur inconnue');
  assert.equal(chooser.errorMessage(undefined, 'repli'), 'repli');
  assert.equal(chooser.applyFailureText(new Error('image trop lourde')), 'Application impossible : image trop lourde');
  assert.equal(chooser.loadFailureText(new Error('dossier absent')), 'Thèmes indisponibles : dossier absent');
  assert.equal(chooser.terminalFailureText('commande refusée'), 'Options terminal indisponibles : commande refusée');
});
