'use strict';
// Tests de la logique pure de la galerie de fonds (sans WebView ni DOM) : node --test windows/ui/tests/gallery.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../gallery.js');

test('pagination : Précédent si page > 1, Suivant si page < lastPage', () => {
  assert.deepEqual(g.pagerState(1, 3), { previous: false, next: true });
  assert.deepEqual(g.pagerState(2, 3), { previous: true, next: true });
  assert.deepEqual(g.pagerState(3, 3), { previous: true, next: false });
  assert.deepEqual(g.pagerState(1, null), { previous: false, next: false });
});

test('pagination : page visée bornée entre 1 et lastPage', () => {
  assert.equal(g.targetPage(1, -1, 3), null);
  assert.equal(g.targetPage(1, 1, 3), 2);
  assert.equal(g.targetPage(3, 1, 3), null);
  assert.equal(g.targetPage(3, -1, 3), 2);
  assert.equal(g.targetPage(1, 1, null), null);
});

test('libellé de page : « Page N sur M » ou « Page N »', () => {
  assert.equal(g.pageLabel(2, 5), 'Page 2 sur 5');
  assert.equal(g.pageLabel(2, null), 'Page 2');
  assert.equal(g.lastPageOf(4), 4);
  assert.equal(g.lastPageOf(0), null);
  assert.equal(g.lastPageOf('3'), null);
});

test('liens : vignettes sur th/w.wallhaven.cc seulement, sources sur wallhaven.cc seulement, https sans identifiants ni port', () => {
  assert.equal(g.thumbnailUrl('https://th.wallhaven.cc/small/ab/abc.jpg'), 'https://th.wallhaven.cc/small/ab/abc.jpg');
  assert.equal(g.thumbnailUrl('https://w.wallhaven.cc/full/ab/abc.jpg'), 'https://w.wallhaven.cc/full/ab/abc.jpg');
  assert.equal(g.thumbnailUrl('http://th.wallhaven.cc/a.jpg'), null);
  assert.equal(g.thumbnailUrl('https://evil.example/a.jpg'), null);
  assert.equal(g.thumbnailUrl('https://user:pw@th.wallhaven.cc/a.jpg'), null);
  assert.equal(g.thumbnailUrl('https://th.wallhaven.cc:8443/a.jpg'), null);
  assert.equal(g.thumbnailUrl(undefined), null);
  assert.equal(g.sourceUrl('https://wallhaven.cc/w/abc12'), 'https://wallhaven.cc/w/abc12');
  assert.equal(g.sourceUrl('https://www.wallhaven.cc/w/abc12'), 'https://www.wallhaven.cc/w/abc12');
  assert.equal(g.sourceUrl('https://th.wallhaven.cc/w/abc12'), null);
  assert.equal(g.sourceUrl('javascript:alert(1)'), null);
});

test('chemin local : ce qui suit le dossier backgrounds, séparateurs Windows et POSIX', () => {
  assert.equal(
    g.backgroundRelative('C:\\Users\\u\\AppData\\Local\\Dojo\\backgrounds\\naruto\\wallhaven-abc12.jpg'),
    'naruto/wallhaven-abc12.jpg',
  );
  assert.equal(g.backgroundRelative('/home/u/.config/dojo/backgrounds/naruto/wallhaven-abc12.jpg'), 'naruto/wallhaven-abc12.jpg');
  assert.equal(g.backgroundRelative('/tmp/autre/fond.jpg'), null);
  assert.equal(g.backgroundRelative('/x/backgrounds/../secret.jpg'), null);
  assert.equal(g.backgroundRelative('/x/backgrounds'), null);
  assert.equal(g.backgroundRelative(null), null);
});

test('normalisation d un élément : identifiant valide, liens filtrés, fond embarqué', () => {
  const item = g.normalizeItem({
    id: 'abc123',
    resolution: '1920x1080',
    thumb: 'https://th.wallhaven.cc/small/ab/abc123.jpg',
    source: 'https://wallhaven.cc/w/abc123',
    downloaded: true,
    file: 'C:\\d\\backgrounds\\naruto\\wallhaven-abc123.jpg',
  });
  assert.deepEqual(item, {
    id: 'abc123',
    builtin: false,
    downloaded: true,
    resolution: '1920x1080',
    thumb: 'https://th.wallhaven.cc/small/ab/abc123.jpg',
    source: 'https://wallhaven.cc/w/abc123',
    localPath: 'naruto/wallhaven-abc123.jpg',
  });

  const hostile = g.normalizeItem({ id: 'abc123', thumb: 'https://evil.example/x.jpg', source: 'http://wallhaven.cc/w/abc123' });
  assert.equal(hostile.thumb, null);
  assert.equal(hostile.source, null);
  assert.equal(hostile.downloaded, false);
  assert.equal(hostile.localPath, null);
});

test('normalisation : identifiants invalides refusés, « theme » réservé au fond embarqué', () => {
  assert.equal(g.normalizeItem({ id: 'Bad!' }), null);
  assert.equal(g.normalizeItem({ id: 'abc' }), null);
  assert.equal(g.normalizeItem({ id: 'theme' }), null);
  assert.equal(g.normalizeItem({ builtin: true, id: 'abc123' }), null);
  assert.equal(g.normalizeItem({}), null);
  assert.equal(g.normalizeItem(null), null);
  const builtin = g.normalizeItem({ id: 'theme', builtin: true, file: '/rt/themes/naruto/background.jpg', resolution: null });
  assert.equal(builtin.builtin, true);
  assert.equal(builtin.downloaded, true);
  assert.equal(builtin.localPath, null);
  assert.equal(builtin.thumb, null);
});

test('normalisation des listes : fonds locaux marqués téléchargés, éléments invalides ignorés', () => {
  const locals = g.normalizeItems([{ id: 'abc123', file: '/x/backgrounds/naruto/wallhaven-abc123.jpg' }, null, { id: 'x' }], true);
  assert.equal(locals.length, 1);
  assert.equal(locals[0].downloaded, true);
  assert.equal(g.normalizeItems(undefined, false).length, 0);
  const remote = g.normalizeItems([{ id: 'abc123', downloaded: false }], false);
  assert.equal(remote[0].downloaded, false);
});

test('localState : identifiants téléchargés, fond actuel, sans réponse rien n affirmer', () => {
  const state = g.localState({
    wallpapers: [
      { id: 'theme', builtin: true, current: false, file: '/rt/themes/naruto/background.jpg' },
      { id: 'abc123', current: true, file: '/x/backgrounds/naruto/wallhaven-abc123.jpg' },
    ],
  });
  assert.equal(state.currentId, 'abc123');
  assert.deepEqual([...state.downloadedIds].sort(), ['abc123', 'theme']);
  assert.equal(state.items.length, 2);
  const none = g.localState(null);
  assert.equal(none.currentId, null);
  assert.equal(none.downloadedIds.size, 0);
  assert.equal(none.items.length, 0);
});

test('normalisation des thèmes : identifiant et nom obligatoires', () => {
  assert.deepEqual(
    g.normalizeThemes([{ id: 'naruto', name: 'Naruto', background: '/x' }, { id: 'Bad', name: 'X' }, { id: 'aube', name: '' }, null]),
    [{ id: 'naruto', name: 'Naruto' }],
  );
  assert.deepEqual(g.normalizeThemes(null), []);
});

test('thème initial : paramètre demandé, puis thème courant, puis le premier', () => {
  const themes = [{ id: 'naruto', name: 'Naruto' }, { id: 'aube', name: 'Aube' }];
  assert.equal(g.chooseTheme(themes, 'aube', 'naruto'), 'aube');
  assert.equal(g.chooseTheme(themes, 'zzz', 'aube'), 'aube');
  assert.equal(g.chooseTheme(themes, null, 'naruto'), 'naruto');
  assert.equal(g.chooseTheme(themes, null, 'absent'), 'naruto');
  assert.equal(g.chooseTheme([], 'x', 'y'), '');
});

test('paramètre ?theme= : accepté seulement si ^[a-z0-9_-]{1,40}$', () => {
  assert.equal(g.themeFromQuery('?theme=stargate-sg1'), 'stargate-sg1');
  assert.equal(g.themeFromQuery('?theme=Bad'), null);
  assert.equal(g.themeFromQuery('?theme='), null);
  assert.equal(g.themeFromQuery('?theme=' + 'a'.repeat(41)), null);
  assert.equal(g.themeFromQuery('?autre=naruto'), null);
  assert.equal(g.themeFromQuery(''), null);
  assert.equal(g.themeFromQuery(undefined), null);
});

test('choix de l action au clic : rien pendant une opération, téléchargement puis application, application seule', () => {
  const item = g.normalizeItem({ id: 'abc123' });
  const builtin = g.normalizeItem({ id: 'theme', builtin: true });
  assert.equal(g.tileAction(item, { theme: 'naruto', busyId: 'other', downloadedIds: new Set() }), null);
  assert.equal(g.tileAction(item, { theme: '', busyId: null, downloadedIds: new Set() }), null);
  assert.equal(g.tileAction(item, { theme: 'naruto', busyId: null, downloadedIds: new Set() }), 'download-use');
  assert.equal(g.tileAction(item, { theme: 'naruto', busyId: null, downloadedIds: new Set(['abc123']) }), 'use');
  assert.equal(g.tileAction(builtin, { theme: 'naruto', busyId: null, downloadedIds: new Set() }), 'use');
  assert.equal(g.tileAction(null, { theme: 'naruto', busyId: null, downloadedIds: new Set() }), null);
});

test('arguments des commandes : fond embarqué sans second argument', () => {
  assert.deepEqual(g.downloadArgs('abc123', 'naruto'), ['download', 'abc123', 'naruto']);
  assert.deepEqual(g.useArgs('abc123', 'naruto'), ['use', 'abc123', 'naruto']);
  assert.deepEqual(g.useArgs('theme', 'naruto'), ['use', 'theme']);
});

test('messages d erreur : conseils CLI retirés, repli « erreur inconnue »', () => {
  assert.equal(
    g.errorText({ message: 'fond abc non téléchargé pour le thème x (wallpapers download abc x).' }),
    'fond abc non téléchargé pour le thème x.',
  );
  assert.equal(g.errorText({ message: 'Délai (node setup.js wallpapers sync) dépassé' }), 'Délai dépassé');
  assert.equal(g.errorText(new Error('')), 'erreur inconnue');
  assert.equal(g.errorText(null), 'erreur inconnue');
  assert.equal(g.errorText('   '), 'erreur inconnue');
  assert.equal(g.errorText('texte brut'), 'texte brut');
  assert.equal(g.failure('Chargement impossible', new Error('pont indisponible')), 'Chargement impossible : pont indisponible');
  assert.equal(g.failure('Fond suivant impossible', null), 'Fond suivant impossible : erreur inconnue');
});

test('bilan de synchronisation : compteurs, arrêt et déjà en cours', () => {
  assert.deepEqual(g.syncOutcome({ downloaded: ['a', 'b'], skipped: ['c'], failed: [] }), {
    kind: 'ok',
    text: 'Synchronisation terminée : 2 téléchargé(s), 1 ignoré(s), 0 échec(s).',
  });
  const failed = g.syncOutcome({ downloaded: [], skipped: [], failed: [{ id: 'x', reason: '404' }] });
  assert.equal(failed.kind, 'warn');
  assert.match(failed.text, /1 échec\(s\)/);
  const stopped = g.syncOutcome({ downloaded: ['a'], skipped: [], failed: [], stopped: 'délai dépassé (wallpapers sync)' });
  assert.equal(stopped.kind, 'warn');
  assert.equal(stopped.text.endsWith('Arrêtée : délai dépassé'), true);
  assert.deepEqual(g.syncOutcome({ ok: true, alreadyRunning: true }), {
    kind: 'warn',
    text: 'Une synchronisation est déjà en cours pour ce thème.',
  });
  assert.equal(g.syncOutcome(undefined).kind, 'ok');
});

test('progression : pourcentage borné et libellé « done/total »', () => {
  assert.equal(g.progressPercent(3, 4), 75);
  assert.equal(g.progressPercent(0, 0), 0);
  assert.equal(g.progressPercent(9, 4), 100);
  assert.equal(g.progressPercent(undefined, 4), 0);
  assert.equal(g.progressLabel(2, 5), 'Téléchargement… 2/5');
  assert.equal(g.progressLabel(0, 0), 'Téléchargement…');
});

test('compteur de pied et libellé de carte', () => {
  assert.equal(g.countLabel(0), '0 fond');
  assert.equal(g.countLabel(1), '1 fond');
  assert.equal(g.countLabel(3), '3 fonds');
  const item = g.normalizeItem({ id: 'abc123', resolution: '1920x1080' });
  assert.equal(g.tileLabel(item, true), 'Fond abc123, 1920x1080, actuel');
  assert.equal(g.tileLabel(g.normalizeItem({ id: 'theme', builtin: true }), false), 'Fond du thème');
});

test('sources d image : fond embarqué, puis vignette distante, puis fichier local', () => {
  const item = g.normalizeItem({
    id: 'abc123',
    thumb: 'https://th.wallhaven.cc/small/ab/abc123.jpg',
    downloaded: true,
    file: '/x/backgrounds/naruto/wallhaven-abc123.jpg',
  });
  assert.deepEqual(g.imageSources(item, 'naruto'), [
    { kind: 'remote', url: 'https://th.wallhaven.cc/small/ab/abc123.jpg' },
    { kind: 'local', path: 'naruto/wallhaven-abc123.jpg' },
  ]);
  assert.deepEqual(g.imageSources(g.normalizeItem({ id: 'theme', builtin: true }), 'naruto'), [
    { kind: 'theme', theme: 'naruto', file: 'background.jpg' },
  ]);
  assert.deepEqual(g.imageSources(g.normalizeItem({ id: 'abc123' }), 'naruto'), []);
});

test('le module exporte les fonctions pures sans DOM', () => {
  assert.equal(typeof g.tileAction, 'function');
  assert.equal(typeof g.normalizeItem, 'function');
  assert.equal(typeof document, 'undefined');
});
