// Assistant de configuration (Windows) : logique pure, sans DOM ni pont (window.dojo).
// Porte mac/SetupModel.swift et mac/SetupSteps.swift : étapes, validations, construction de la config,
// aperçu, plan d'application. Chargé par wizard.html (window.DojoWizardModel) et par les tests (module.exports).
(function () {
  'use strict';

  var STEPS = [
    { id: 'welcome', title: 'Bienvenue' },
    { id: 'dependencies', title: 'Dépendances' },
    { id: 'weather', title: 'Météo' },
    { id: 'github', title: 'GitHub' },
    { id: 'projects', title: 'Projets' },
    { id: 'calendars', title: 'Calendriers' },
    { id: 'claude', title: 'Claude Code' },
    { id: 'autostart', title: 'Démarrage automatique' },
    { id: 'theme', title: 'Thème' },
    { id: 'done', title: 'Terminé' }
  ];
  var LAST = STEPS.length - 1;
  var CALENDAR_URL_RE = /^(https?|webcal):\/\//i;
  var CALENDAR_ERROR = 'URL invalide : elle doit commencer par https://, http:// ou webcal://';
  var STATUS_LABELS = { replace: 'remplacée', keep: 'conservée', none: 'non gérée' };
  var TERMINAL_KEYS = ['windowsTerminal', 'welcome'];

  function str(v) { return typeof v === 'string' ? v : ''; }
  function trim(v) { return str(v).trim(); }
  function nonEmpty(list) {
    return (Array.isArray(list) ? list : []).map(trim).filter(function (x) { return x !== ''; });
  }
  function strings(list) {
    return Array.isArray(list) ? list.filter(function (x) { return typeof x === 'string'; }) : [];
  }

  // ── Calendriers ───────────────────────────────────────────────────────────
  function isCalendarUrl(text) { return CALENDAR_URL_RE.test(trim(text)); }

  // Message d'erreur d'un champ d'agenda ; '' si vide ou valide.
  function calendarError(text) {
    var t = trim(text);
    return t === '' || isCalendarUrl(t) ? '' : CALENDAR_ERROR;
  }

  function validCalendars(list) { return nonEmpty(list).filter(isCalendarUrl); }

  function calendarsValid(list) {
    return (Array.isArray(list) ? list : []).every(function (x) { return calendarError(x) === ''; });
  }

  // ── Dossiers (projets) ────────────────────────────────────────────────────
  function normalizeSep(p) { return str(p).replace(/\\/g, '/'); }
  function stripTrailingSep(p) { return p.replace(/\/+$/, ''); }

  // Chemin sous le dossier personnel -> « ~ » (séparateurs d'origine conservés). Hors dossier personnel : inchangé.
  function abbreviateHome(path, home) {
    var p = trim(path);
    var h = stripTrailingSep(normalizeSep(trim(home)));
    if (!p || !h) return p;
    var head = normalizeSep(p).slice(0, h.length);
    if (head.toLowerCase() !== h.toLowerCase()) return p;
    var rest = p.slice(h.length);
    if (rest === '') return '~';
    return rest.charAt(0) === '/' || rest.charAt(0) === '\\' ? '~' + rest : p;
  }

  // Clé de comparaison : « ~ » développé, séparateurs unifiés, sans fin de séparateur, sans casse (Windows).
  function pathKey(path, home) {
    var s = normalizeSep(trim(path));
    if (s === '~' || s.indexOf('~/') === 0) {
      s = stripTrailingSep(normalizeSep(trim(home))) + s.slice(1);
    }
    return stripTrailingSep(s).toLowerCase();
  }

  // Ajoute un dossier (abrégé avec ~) si absent ; renvoie une nouvelle liste.
  function addRoot(roots, rawPath, home) {
    var list = strings(roots);
    var shown = abbreviateHome(trim(rawPath), home);
    if (!shown) return list.slice();
    var key = pathKey(shown, home);
    var exists = list.some(function (r) { return pathKey(trim(r), home) === key; });
    return exists ? list.slice() : list.concat([shown]);
  }

  // Liste de dossiers prête pour write-config : sans vides, dédoublonnée (ordre conservé).
  function uniqueRoots(roots, home) {
    var out = [];
    var keys = {};
    nonEmpty(roots).forEach(function (r) {
      var k = pathKey(r, home);
      if (!keys[k]) { keys[k] = true; out.push(r); }
    });
    return out;
  }

  function addOwner(owners, raw) {
    var list = strings(owners);
    var v = trim(raw);
    return v ? list.concat([v]) : list.slice();
  }

  // ── Dépendances ───────────────────────────────────────────────────────────
  function nodeOk(detect) { return !!(detect && detect.node && detect.node.ok === true); }

  function nodeDetail(node) {
    if (!node || !node.path) return 'absent (requis : 18 ou plus récent)';
    var version = node.version || 'version inconnue';
    return node.ok === true ? version : version + ', 18 minimum requis';
  }

  // ── Météo ─────────────────────────────────────────────────────────────────
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  // Résultats de geocode utilisables (coordonnées numériques).
  function usableGeoResults(list) {
    return (Array.isArray(list) ? list : []).filter(function (r) {
      return r && isNum(r.lat) && isNum(r.lon);
    });
  }

  function geoLabel(r) {
    return [str(r.name), str(r.country)].filter(function (x) { return x !== ''; }).join(', ');
  }

  // Lieu choisi -> objet weather de config.json (timezone omis si absent : write-config refuse null).
  function weatherFrom(r) {
    var w = { name: str(r.name), lat: r.lat, lon: r.lon };
    if (typeof r.timezone === 'string' && r.timezone !== '') w.timezone = r.timezone;
    return w;
  }

  function weatherChoiceText(w) {
    var tz = w.timezone || 'inconnu';
    return 'Choisi : ' + w.name + ' · lat ' + Number(w.lat).toFixed(4) + ' · lon ' + Number(w.lon).toFixed(4) + ' · fuseau ' + tz;
  }

  // ── Fond et terminal ──────────────────────────────────────────────────────
  function backgroundOf(path) {
    var p = trim(path);
    return p ? { kind: 'file', path: p } : { kind: 'theme' };
  }

  function sameBackground(a, b) {
    return a.kind === b.kind && (a.path || null) === (b.path || null) && (a.id || null) === (b.id || null);
  }

  function baseName(p) { return str(p).split(/[\\/]/).pop(); }

  function backgroundLabel(bg) {
    var b = bg || { kind: 'theme' };
    if (b.kind === 'file') return 'image « ' + baseName(b.path) + ' »';
    if (b.kind === 'wallhaven') return 'fond Wallhaven « ' + str(b.id) + ' »';
    return 'fond du thème';
  }

  function terminalOf(t) {
    var src = t && typeof t === 'object' ? t : {};
    return { windowsTerminal: src.windowsTerminal === true, welcome: src.welcome === true };
  }

  // Différence entre options initiales et voulues : retraits (true seulement) et application (les deux clés).
  function terminalDelta(initial, wanted) {
    var removed = {};
    var added = false;
    TERMINAL_KEYS.forEach(function (k) {
      if (initial[k] && !wanted[k]) removed[k] = true;
      if (wanted[k] && !initial[k]) added = true;
    });
    var hasRemoved = Object.keys(removed).length > 0;
    return {
      remove: hasRemoved ? removed : null,
      apply: added || hasRemoved ? { windowsTerminal: !!wanted.windowsTerminal, welcome: !!wanted.welcome } : null
    };
  }

  function terminalLabel(t) {
    var names = [];
    if (t.windowsTerminal) names.push('Windows Terminal');
    if (t.welcome) names.push("message d'accueil");
    return names.length ? names.join(', ') : 'aucun';
  }

  // ── Aperçu settings.json ──────────────────────────────────────────────────
  // Compte les lignes du diff (« + » ajouté, « - » retiré) ; les paires retrait/ajout deviennent « modifié ».
  function diffCounts(diff) {
    var added = 0;
    var removed = 0;
    str(diff).split('\n').forEach(function (line) {
      if (line.indexOf('+ ') === 0) added++;
      else if (line.indexOf('- ') === 0) removed++;
    });
    var modified = Math.min(added, removed);
    return { added: added - modified, removed: removed - modified, modified: modified };
  }

  function changeLines(diff) {
    var c = diffCounts(diff);
    var out = [];
    if (c.added) out.push('Ajouté : ' + c.added + ' ligne(s)');
    if (c.modified) out.push('Modifié : ' + c.modified + ' ligne(s)');
    if (c.removed) out.push('Retiré : ' + c.removed + ' ligne(s)');
    return out;
  }

  // Résultat de merge-settings (dryRun) -> aperçu affichable.
  function previewFromResult(result) {
    var r = result || {};
    var diff = str(r.diff);
    var t = r.heavyGateThresholds;
    return {
      changed: r.changed === true,
      changes: changeLines(diff),
      diff: diff,
      error: null,
      heavyLimits: t && isNum(t.HEAVY_GATE_MAX) ? { suites: t.HEAVY_GATE_MAX, nodes: t.HEAVY_GATE_MAX_NODE } : null
    };
  }

  // ── Assistant ─────────────────────────────────────────────────────────────
  // opts : detect (réponse de `detect`), autostart (bool, autostart.get), activeTheme / activeBackground (réponse
  // de `themes`), chooserAvailable (bool), editing (bool, défaut : config.json existant), loadError (texte).
  function createWizard(opts) {
    opts = opts || {};
    var detect = opts.detect || null;
    var config = (detect && detect.config && typeof detect.config === 'object') ? detect.config : {};
    var settings = (detect && detect.settings) || {};
    var home = str(detect && detect.home);
    var editing = opts.editing !== undefined ? !!opts.editing : !!(detect && detect.install && detect.install.configExists);
    var weather = null;
    if (config.weather && typeof config.weather === 'object' && config.weather.name && isNum(config.weather.lat) && isNum(config.weather.lon)) {
      weather = weatherFrom(config.weather);
    }
    var themeBackground = opts.activeBackground !== undefined ? opts.activeBackground : config.background;

    var state = {
      step: 0,
      editing: editing,
      home: home,
      detect: detect,
      loadError: opts.loadError ? str(opts.loadError) : null,
      stepError: null,
      nodeOk: nodeOk(detect),
      claudeFound: !!(detect && detect.claude && detect.claude.path),
      ghInstalled: !!(detect && detect.gh && detect.gh.path),
      ghAuthed: !!(detect && detect.gh && detect.gh.authed),
      weather: weather,
      city: weather ? weather.name : '',
      geoResults: [],
      geoBusy: false,
      geoError: null,
      owners: strings(config.github && config.github.owners),
      roots: strings(config.projects && config.projects.roots),
      onlyOwners: !!(config.projects && config.projects.onlyOwners === true),
      calendars: strings(config.calendars),
      hooks: true,
      statusLine: settings.statusLine ? 'keep' : 'replace',
      heavyGate: !settings.heavyGatePerso,
      vitestWorkers: true,
      preview: { changed: false, changes: [], diff: '', error: null, heavyLimits: null, loaded: false },
      autostart: !!opts.autostart || !editing,
      chooserAvailable: !!opts.chooserAvailable,
      themeInitial: {
        theme: str(opts.activeTheme) || str(config.theme),
        background: backgroundOf(themeBackground),
        terminal: terminalOf(config.terminal),
        autoDownload: opts.autoDownload !== undefined ? opts.autoDownload !== false : !(config.wallpapers && config.wallpapers.autoDownload === false)
      },
      themeSelection: null,
      applying: false,
      applied: false,
      applyError: null,
      log: [],
      plan: null,
      resumeAt: 0
    };

    function stepId() { return STEPS[state.step].id; }

    function stepCanPass(id) {
      if (id === 'dependencies') return state.nodeOk;
      if (id === 'calendars') return calendarsValid(state.calendars);
      if (id === 'done') return false;
      return true;
    }

    var api = {
      state: state,
      STEPS: STEPS,

      stepInfo: function () {
        return { index: state.step + 1, total: STEPS.length, id: stepId(), title: STEPS[state.step].title,
          text: 'Étape ' + (state.step + 1) + ' sur ' + STEPS.length + ' · ' + STEPS[state.step].title,
          progress: (state.step + 1) / STEPS.length };
      },

      canGoNext: function () {
        return !state.applying && state.step < LAST && stepCanPass(stepId());
      },

      canGoBack: function () {
        return !state.applying && !state.applied && state.step > 0;
      },

      next: function () {
        if (!api.canGoNext()) return false;
        state.step += 1;
        state.stepError = null;
        state.plan = null;
        return true;
      },

      back: function () {
        if (!api.canGoBack()) return false;
        state.step -= 1;
        state.stepError = null;
        state.plan = null;
        return true;
      },

      // Boutons du pied : Précédent (absent à l'étape 1), action principale (Suivant, Appliquer, Application…, Fermer).
      footer: function () {
        var primary;
        if (state.applied) {
          primary = { label: 'Fermer', action: 'close', disabled: false };
        } else if (stepId() === 'done') {
          primary = state.applying
            ? { label: 'Application…', action: 'apply', disabled: true }
            : { label: 'Appliquer', action: 'apply', disabled: false };
        } else {
          primary = { label: 'Suivant', action: 'next', disabled: !api.canGoNext() };
        }
        return {
          cancel: { visible: !state.applied },
          back: { visible: state.step > 0 && !state.applied, disabled: state.applying },
          primary: primary
        };
      },

      // Ligne de texte de l'action « Entrée » : next, apply ou close ; null si rien à faire.
      defaultAction: function () {
        var p = api.footer().primary;
        return p.disabled ? null : p.action;
      },

      // ── Dépendances / GitHub / projets / agendas ──
      addOwner: function (raw) { state.owners = addOwner(state.owners, raw); },
      setOwner: function (i, text) { state.owners[i] = str(text); },
      removeOwner: function (i) { state.owners.splice(i, 1); },

      addRoot: function (rawPath) { state.roots = addRoot(state.roots, rawPath, state.home); },
      setRoot: function (i, text) { state.roots[i] = str(text); },
      removeRoot: function (i) { state.roots.splice(i, 1); },

      addCalendar: function () { state.calendars.push(''); },
      setCalendar: function (i, text) { state.calendars[i] = str(text); },
      removeCalendar: function (i) { state.calendars.splice(i, 1); },
      calendarError: calendarError,

      // ── Météo ──
      setCity: function (text) { state.city = str(text); },
      geoStart: function () { state.geoBusy = true; state.geoError = null; state.geoResults = []; },
      // Résultats de geocode : liste filtrée, message « Aucun résultat » si vide.
      setGeoResults: function (list, query) {
        state.geoBusy = false;
        state.geoResults = usableGeoResults(list);
        state.geoError = state.geoResults.length ? null : 'Aucun résultat pour « ' + str(query) + ' ».';
      },
      setGeoError: function (message) { state.geoBusy = false; state.geoResults = []; state.geoError = str(message) || 'géocodage impossible.'; },
      chooseWeather: function (result) { state.weather = weatherFrom(result); },
      clearWeather: function () { state.weather = null; state.city = ''; state.geoResults = []; state.geoError = null; },

      // ── Claude Code ──
      setOptions: function (partial) {
        ['hooks', 'statusLine', 'heavyGate', 'vitestWorkers', 'onlyOwners', 'autostart'].forEach(function (k) {
          if (partial && partial[k] !== undefined) state[k] = partial[k];
        });
      },
      setPreview: function (preview) { state.preview = Object.assign({ loaded: true }, preview); },
      setPreviewError: function (message) {
        state.preview = { changed: false, changes: [], diff: '', error: str(message) || 'erreur', heavyLimits: null, loaded: true };
      },

      // ── Thème ──
      setThemeSelection: function (selection) { state.themeSelection = selection || null; },

      setStepError: function (message) { state.stepError = message ? str(message) : null; },

      // Ligne du journal affiché à l'étape Terminé.
      addLog: function (line) { state.log.push(str(line)); },

      // Pour les appels de l'assistant : configuration, aperçu, plan.
      buildConfigPatch: function (selection) { return buildConfigPatch(state, selection); },
      buildMergeOptions: function (dryRun) { return buildMergeOptions(state, dryRun); },
      previewCall: function () {
        return { cmd: 'merge-settings', args: ['-'], stdin: JSON.stringify(buildMergeOptions(state, true)) };
      },
      buildApplyPlan: function (selection) { return buildApplyPlan(state, selection); },

      // Démarre l'application, ou reprend après une erreur à l'étape en échec. Renvoie { plan, from } (null si déjà en cours).
      startApply: function (selection) {
        if (state.applying || state.applied) return null;
        state.applying = true;
        state.applyError = null;
        state.themeSelection = selection || null;
        if (!state.plan) {
          state.plan = buildApplyPlan(state, selection || null);
          state.resumeAt = 0;
          state.log = [];
        }
        return { plan: state.plan, from: state.resumeAt };
      },

      // Fin : ok -> applied ; sinon message d'erreur, et reprise à failedIndex au prochain « Appliquer ».
      finishApply: function (ok, errorMessage, failedIndex) {
        state.applying = false;
        if (ok) {
          state.applied = true;
          state.applyError = null;
          state.plan = null;
          state.resumeAt = 0;
          state.log.push('Terminé. Le fond d\'écran est lancé.');
        } else {
          state.resumeAt = typeof failedIndex === 'number' ? failedIndex : 0;
          state.applyError = 'Application impossible : ' + str(errorMessage);
          state.log.push('Échec : ' + str(errorMessage));
        }
      },

      summaryLines: function (selection) { return summaryLines(state, selection); }
    };
    return api;
  }

  function trimmedNonEmpty(list) { return nonEmpty(list); }

  function buildConfigPatch(state, selection) {
    var patch = {
      weather: state.weather ? weatherFrom(state.weather) : null,
      calendars: validCalendars(state.calendars),
      github: { owners: trimmedNonEmpty(state.owners) },
      projects: { roots: uniqueRoots(state.roots, state.home), onlyOwners: !!state.onlyOwners }
    };
    if (selection && typeof selection.autoDownload === 'boolean') {
      patch.wallpapers = { autoDownload: selection.autoDownload };
    }
    return patch;
  }

  function buildMergeOptions(state, dryRun) {
    return {
      hooks: !!state.hooks,
      statusLine: state.statusLine,
      heavyGate: !!state.heavyGate,
      vitestWorkers: !!state.vitestWorkers,
      dryRun: !!dryRun
    };
  }

  // Commande de fond : défaut -> set-background default ; fichier -> set-background <chemin> ; Wallhaven -> wallpapers use <id> <thème>.
  function backgroundCall(bg, theme) {
    if (bg.kind === 'file') return { label: 'Fond d\'écran : copie de l\'image choisie…', cmd: 'set-background', args: [bg.path] };
    if (bg.kind === 'wallhaven') return { label: 'Fond d\'écran : ' + backgroundLabel(bg) + '…', cmd: 'wallpapers', args: ['use', str(bg.id), str(theme)] };
    return { label: 'Fond d\'écran : fond du thème…', cmd: 'set-background', args: ['default'] };
  }

  // Plan d'application, dans l'ordre : write-config, set-theme, fond, terminal, merge-settings, autostart, fond rechargé.
  // Chaque entrée : { label, cmd, args, stdin? } ou { label, native, payload }. Rien n'est appelé avant « Appliquer ».
  function buildApplyPlan(state, selection) {
    var plan = [{
      label: 'Écriture de config.json…',
      cmd: 'write-config',
      args: ['-'],
      stdin: JSON.stringify(buildConfigPatch(state, selection))
    }];
    if (selection) {
      var initial = state.themeInitial;
      var theme = str(selection.theme);
      if (theme && theme !== initial.theme) {
        plan.push({ label: 'Thème : ' + theme + '…', cmd: 'set-theme', args: [theme] });
      }
      var bg = selection.background || { kind: 'theme' };
      if (!sameBackground(bg, initial.background)) {
        plan.push(backgroundCall(bg, theme || initial.theme));
      }
      var delta = terminalDelta(initial.terminal, terminalOf(selection.terminal));
      if (delta.remove) {
        plan.push({ label: 'Terminal : retrait des options…', cmd: 'terminal', args: ['remove', JSON.stringify(delta.remove)] });
      }
      if (delta.apply) {
        plan.push({ label: 'Terminal : options…', cmd: 'terminal', args: ['apply', JSON.stringify(delta.apply)] });
      }
    }
    plan.push({
      label: 'Mise à jour de settings.json…',
      cmd: 'merge-settings',
      args: ['-'],
      stdin: JSON.stringify(buildMergeOptions(state, false))
    });
    plan.push({ label: 'Démarrage automatique…', native: 'autostart.set', payload: { enabled: !!state.autostart } });
    plan.push({ label: 'Rechargement du fond d\'écran…', native: 'reloadWallpaper', payload: {} });
    return plan;
  }

  // Exécute le plan à partir de `from` ; exec(step) renvoie une promesse. S'arrête à la 1re erreur.
  // Renvoie { ok:true } ou { ok:false, index, error }. onStart(step, index) est appelé avant chaque étape.
  function runPlan(plan, exec, from, onStart) {
    var i = from || 0;
    function next() {
      if (i >= plan.length) return Promise.resolve({ ok: true });
      var index = i;
      var step = plan[index];
      if (onStart) onStart(step, index);
      return Promise.resolve()
        .then(function () { return exec(step, index); })
        .then(function () { i = index + 1; return next(); }, function (err) {
          return { ok: false, index: index, error: err && err.message ? err.message : String(err) };
        });
    }
    return next();
  }

  // Lignes de l'étape Terminé (puces), d'après l'état et le sélecteur de thème (null = indisponible).
  function summaryLines(state, selection) {
    var weatherText = state.weather ? state.weather.name : 'désactivée';
    var validOwners = trimmedNonEmpty(state.owners).length;
    var validRoots = uniqueRoots(state.roots, state.home).length;
    var validCals = validCalendars(state.calendars).length;
    var lines = [
      'Node.js : ' + (state.detect && state.detect.node && state.detect.node.version ? state.detect.node.version : 'non détecté'),
      'Météo : ' + weatherText,
      'GitHub : ' + validOwners + ' propriétaire(s)',
      'Projets : ' + validRoots + ' dossier(s), ' + (state.onlyOwners ? 'dépôts des propriétaires seulement' : 'tous les dépôts'),
      'Calendriers : ' + validCals
    ];
    if (selection) {
      lines.push('Thème : ' + (selection.theme || 'inchangé'));
      lines.push('Fond : ' + backgroundLabel(selection.background || { kind: 'theme' }));
      lines.push('Terminal : ' + terminalLabel(terminalOf(selection.terminal)));
    } else {
      lines.push('Thème : inchangé (sélecteur indisponible)');
      lines.push('Fond : inchangé (sélecteur indisponible)');
      lines.push('Terminal : inchangé (sélecteur indisponible)');
    }
    lines.push('Claude Code : hooks Dojo ' + (state.hooks ? 'oui' : 'non') + ', barre de statut ' + STATUS_LABELS[state.statusLine]);
    lines.push('Démarrage automatique : ' + (state.autostart ? 'oui' : 'non'));
    return lines;
  }

  var model = {
    STEPS: STEPS,
    createWizard: createWizard,
    isCalendarUrl: isCalendarUrl,
    calendarError: calendarError,
    validCalendars: validCalendars,
    abbreviateHome: abbreviateHome,
    pathKey: pathKey,
    addRoot: addRoot,
    uniqueRoots: uniqueRoots,
    addOwner: addOwner,
    nodeOk: nodeOk,
    nodeDetail: nodeDetail,
    usableGeoResults: usableGeoResults,
    geoLabel: geoLabel,
    weatherFrom: weatherFrom,
    weatherChoiceText: weatherChoiceText,
    backgroundLabel: backgroundLabel,
    terminalDelta: terminalDelta,
    terminalLabel: terminalLabel,
    diffCounts: diffCounts,
    changeLines: changeLines,
    previewFromResult: previewFromResult,
    buildConfigPatch: buildConfigPatch,
    buildMergeOptions: buildMergeOptions,
    buildApplyPlan: buildApplyPlan,
    runPlan: runPlan,
    summaryLines: summaryLines
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = model;
  if (typeof window !== 'undefined') window.DojoWizardModel = model;
})();
