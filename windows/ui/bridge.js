/* Pont JS <-> C# (DojoWallpaper) : expose window.dojo.
 * Requetes : chrome.webview.postMessage({ id, kind: 'cmd', cmd, args, stdin }) ou
 *            ({ id, kind: 'native', action, payload }). Reponses : { id, result } (PostWebMessageAsJson).
 * Hors DojoWallpaper (pas de chrome.webview) : rejet « pont indisponible », sauf dojo.setMock(fn) pour les tests. */
(function () {
  'use strict';

  var TIMEOUT_MS = 15 * 60 * 1000;
  var pending = new Map();
  var nextId = 1;
  var listening = false;
  var mock = null;
  var envCache = null;

  function webview() {
    return window.chrome && window.chrome.webview ? window.chrome.webview : null;
  }

  function settle(id, result) {
    var entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (result && result.ok === false) {
      entry.reject(new Error(result.error || 'échec de la requête'));
    } else {
      entry.resolve(result);
    }
  }

  function fail(id, message) {
    var entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(new Error(message));
  }

  function listen(wv) {
    if (listening) return;
    listening = true;
    wv.addEventListener('message', function (event) {
      var data = event && event.data;
      if (!data || typeof data.id !== 'number') return;
      settle(data.id, data.result || { ok: false, error: 'réponse vide' });
    });
  }

  function deliver(id, message) {
    if (mock) {
      Promise.resolve()
        .then(function () { return mock(message); })
        .then(function (result) { settle(id, result); }, function (err) { fail(id, err && err.message ? err.message : String(err)); });
      return;
    }
    var wv = webview();
    if (!wv) {
      fail(id, 'pont indisponible (hors DojoWallpaper)');
      return;
    }
    listen(wv);
    wv.postMessage(message);
  }

  function send(message) {
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        fail(id, 'délai dépassé (15 min)');
      }, TIMEOUT_MS);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      var full = Object.assign({ id: id }, message);
      try {
        deliver(id, full);
      } catch (err) {
        fail(id, err && err.message ? err.message : String(err));
      }
    });
  }

  function encodePath(path) {
    return String(path).split('/').map(encodeURIComponent).join('/');
  }

  var dojo = {
    // Commande de la liste blanche (setup.js). Resout avec l'objet de reponse ; rejette si ok:false.
    call: function (cmd, args, opts) {
      if (typeof cmd !== 'string' || cmd === '') {
        return Promise.reject(new Error('commande manquante'));
      }
      var stdin = opts && typeof opts.stdin === 'string' ? opts.stdin : null;
      return send({ kind: 'cmd', cmd: cmd, args: Array.isArray(args) ? args : [], stdin: stdin });
    },

    // Action native (pickFile, openUrl, close, setTitle, getEnv, autostart.get/set, pickFolder, reloadWallpaper).
    native: function (action, payload) {
      if (typeof action !== 'string' || action === '') {
        return Promise.reject(new Error('action manquante'));
      }
      return send({ kind: 'native', action: action, payload: payload || {} });
    },

    // Environnement (install, ui, platform, version) : mis en cache apres le premier succes.
    env: function () {
      if (!envCache) {
        envCache = dojo.native('getEnv').catch(function (err) {
          envCache = null;
          throw err;
        });
      }
      return envCache;
    },

    // URL d'une miniature/fond de thème : https://dojo-themes.local/<id>/<file>.
    themeAsset: function (themeId, file) {
      return 'https://dojo-themes.local/' + encodePath(themeId) + '/' + encodePath(file);
    },

    // URL d'une image de fond locale : https://dojo-bg.local/<file>.
    bgAsset: function (file) {
      return 'https://dojo-bg.local/' + encodePath(file);
    },

    openUrl: function (url) {
      return dojo.native('openUrl', { url: url });
    },

    close: function () {
      return dojo.native('close');
    },

    // Simulation du pont (tests) : fn(message) renvoie l'objet de reponse (ou une promesse). null = retire.
    setMock: function (fn) {
      mock = typeof fn === 'function' ? fn : null;
    },
  };

  window.dojo = dojo;
})();
