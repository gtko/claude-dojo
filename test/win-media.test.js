// Tests de src/win-media.js (assistant média Windows) : le module charge et read() / coverFile() ne jettent pas.
// Dossier d'état temporaire (LOCALAPPDATA redirigé avant le chargement du module) : le test n'écrit jamais
// dans le vrai profil. Hors Windows, le test est ignoré.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const skip = process.platform === 'win32' ? false : 'Windows uniquement';

test('win-media : le module charge, read() et coverFile() ne jettent pas', { skip }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-media-'));
  const prevLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = tmp;
  let m = null;
  try {
    m = require('../src/win-media');
    assert.equal(typeof m.read, 'function');
    assert.equal(typeof m.cmd, 'function');
    assert.equal(typeof m.coverFile, 'function');
    assert.equal(typeof m.stop, 'function');
    const media = m.read();
    // sans média : null ; avec média : objet actif (le test ne dépend pas de l'état de la machine)
    assert.ok(media === null || (media.active === true && typeof media.title === 'string'), 'forme de read()');
    const cover = m.coverFile();
    assert.ok(cover === null || typeof cover === 'string', 'forme de coverFile()');
  } finally {
    if (m) m.stop();
    if (prevLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prevLocal;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});
