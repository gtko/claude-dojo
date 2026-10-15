/* Sélecteur « Thème et fond » : window.DojoThemeChooser.mount(container, opts) -> { getSelection, reload, destroy }.
 * Deux usages : la page de fenêtre (themes.html, boutons Appliquer / Fermer) et l'assistant d'installation
 * (opts.embedded : pas de bouton, le choix est lu par getSelection et appliqué par l'assistant).
 * Aucune dépendance externe : window.dojo (bridge.js) doit être chargé avant ce fichier.
 * La logique pure (sélection, plan d'application, messages) est exportée pour node:test via module.exports. */
(function () {
  'use strict';

  // Nom d'un fichier de la galerie Wallhaven (setup.js) : son identifiant désigne le fond téléchargé.
  var GALLERY_FILE_RE = /^wallhaven-([a-z0-9]{4,10})\.(jpg|jpeg|png|webp)$/;
  var TERMINAL_KEYS = ['windowsTerminal', 'welcome'];
  // Action native d'ouverture d'une page de l'interface (UiBridge.cs, openWindow) : payload { page, theme }.
  var GALLERY_WINDOW_ACTION = 'openWindow';

  var TEXT = {
    title: 'Thème',
    subEmbedded: "Couleurs, vocabulaire et personnages du dojo. Le thème et le fond sont appliqués à la dernière étape, et modifiables ensuite depuis le menu de l'icône.",
    subWindow: 'Couleurs, vocabulaire et personnages du dojo.',
    themesLabel: 'Thèmes',
    loading: 'Chargement des thèmes…',
    retry: 'Réessayer',
    empty: "Aucun thème trouvé dans l'application.",
    terminal: 'Terminal',
    noLogo: 'Pas de logo de terminal pour ce thème.',
    wt: 'Appliquer aussi à Windows Terminal',
    wtMissing: "Windows Terminal n'est pas installé.",
    welcome: "Message d'accueil du terminal (PowerShell)",
    bg: "Fond d'écran",
    pick: 'Choisir un fond…',
    themeBg: 'Fond du thème',
    gallery: "Galerie de fonds d'écran…",
    galleryHint: "Utilise le menu de l'icône : Galerie de fonds…",
    help: 'Images jpg, png, heic ou webp : Dojo en garde une copie dans sa configuration.',
    noDownloads: 'Aucun fond téléchargé pour ce thème.',
    noPreview: "Pas d'aperçu pour ce fond.",
    selected: 'Fond sélectionné : ',
    themeBgLabel: 'fond du thème',
    wallhavenLabel: 'fond Wallhaven ',
    autoDownload: 'Télécharger automatiquement le pack du thème',
    apply: 'Appliquer',
    close: 'Fermer',
    applied: 'Appliqué.',
    galleryAsk: 'Ouvrir la galerie de fonds pour ce thème ?',
    open: 'Ouvrir',
    later: 'Plus tard',
    themesFailed: 'Thèmes indisponibles : ',
    terminalFailed: 'Options terminal indisponibles : ',
    downloadsFailed: 'Fonds téléchargés indisponibles : ',
    applyFailed: 'Application impossible : ',
    unknownError: 'erreur inconnue',
  };

  // ── Logique pure (exportée pour les tests) ────────────────────────────────

  // Dernier segment d'un chemin (séparateurs / et \).
  function basename(p) {
    var s = p === null || p === undefined ? '' : String(p);
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  // Message lisible d'une erreur (Error, chaîne ou rien).
  function errorMessage(err, fallback) {
    var raw = typeof err === 'string' ? err : err && typeof err.message === 'string' ? err.message : '';
    var msg = raw.trim();
    return msg !== '' ? msg : fallback || TEXT.unknownError;
  }

  function loadFailureText(err) { return TEXT.themesFailed + errorMessage(err); }
  function terminalFailureText(err) { return TEXT.terminalFailed + errorMessage(err); }
  function applyFailureText(err) { return TEXT.applyFailed + errorMessage(err); }

  // Vignette : nom de fichier renvoyé par `themes` (thumbnail), sinon thumbnail.jpg. Un chemin absolu n'est pas un nom de fichier.
  function thumbnailFile(thumbnail) {
    if (typeof thumbnail === 'string' && thumbnail !== '' && !/[\\/]/.test(thumbnail)) return thumbnail;
    return 'thumbnail.jpg';
  }

  // Fond : null, 'default' ou 'theme' = fond du thème ; chemin = fond personnel, ou fond Wallhaven si le nom
  // est celui d'un fichier de galerie ; objet { kind:'file', path } ou { kind:'wallhaven', id } déjà structuré.
  function parseBackground(value) {
    if (value && typeof value === 'object') {
      if (value.kind === 'file' && typeof value.path === 'string' && value.path !== '') return { kind: 'file', path: value.path };
      if (value.kind === 'wallhaven' && typeof value.id === 'string' && value.id !== '') return { kind: 'wallhaven', id: value.id };
      return { kind: 'theme' };
    }
    if (typeof value !== 'string' || value === '' || value === 'default' || value === 'theme') return { kind: 'theme' };
    var m = GALLERY_FILE_RE.exec(basename(value));
    return m ? { kind: 'wallhaven', id: m[1] } : { kind: 'file', path: value };
  }

  // Thème choisi : le préféré s'il existe, sinon le repli, sinon le premier de la liste.
  function resolveTheme(preferred, themes, fallback) {
    var ids = themes.map(function (t) { return t.id; });
    if (preferred && ids.indexOf(preferred) >= 0) return preferred;
    if (fallback && ids.indexOf(fallback) >= 0) return fallback;
    return ids.length > 0 ? ids[0] : '';
  }

  // Fonds téléchargés d'un thème (wallpapers local) : le fond intégré (builtin) est proposé à part.
  function downloadsFrom(res) {
    var list = res && Array.isArray(res.wallpapers) ? res.wallpapers : [];
    return list
      .filter(function (w) { return w && !w.builtin && typeof w.id === 'string' && typeof w.file === 'string'; })
      .map(function (w) {
        return { id: w.id, file: w.file, resolution: typeof w.resolution === 'string' ? w.resolution : null };
      });
  }

  // Changement de thème : un fond Wallhaven absent des téléchargements du nouveau thème revient au fond du thème.
  function keepBackgroundFor(bg, downloads) {
    if (bg.kind !== 'wallhaven') return bg;
    return downloads.some(function (d) { return d.id === bg.id; }) ? bg : { kind: 'theme' };
  }

  function backgroundLabel(bg, downloads) {
    if (bg.kind === 'file') return basename(bg.path);
    if (bg.kind === 'wallhaven') {
      var hit = downloads.filter(function (d) { return d.id === bg.id; })[0];
      return hit ? hit.file : TEXT.wallhavenLabel + bg.id;
    }
    return TEXT.themeBgLabel;
  }

  // État du terminal à partir de `terminal status`. Une clé absente compte comme faux ; known = réponse reçue.
  function terminalState(status) {
    var wt = status && status.windowsTerminal;
    var ps = status && status.powershell;
    return {
      known: !!status && typeof status === 'object',
      wtInstalled: wt && typeof wt.installed === 'boolean' ? wt.installed : null,
      windowsTerminal: !!(wt && wt.applied === true),
      welcome: !!(ps && ps.welcome === true),
    };
  }

  // Passage de l'état initial au choix : clés à activer (apply) et à retirer (remove). null = rien à faire.
  function terminalChanges(from, to) {
    var on = {};
    var off = {};
    var hasOn = false;
    var hasOff = false;
    TERMINAL_KEYS.forEach(function (key) {
      var before = !!from[key];
      var after = !!to[key];
      if (before === after) return;
      if (after) { on[key] = true; hasOn = true; } else { off[key] = true; hasOff = true; }
    });
    return { apply: hasOn ? on : null, remove: hasOff ? off : null };
  }

  // Sélection renvoyée par getSelection (forme du contrat du composant).
  function buildSelection(state) {
    var bg = state.background;
    var background = { kind: 'theme' };
    if (bg.kind === 'file') background = { kind: 'file', path: bg.path };
    else if (bg.kind === 'wallhaven') background = { kind: 'wallhaven', id: bg.id };
    return {
      theme: state.theme,
      background: background,
      terminal: { windowsTerminal: !!state.terminal.windowsTerminal, welcome: !!state.terminal.welcome },
      autoDownload: !!state.autoDownload,
    };
  }

  // Ce qu'Appliquer exécute, dans l'ordre : set-theme, fond, options terminal, téléchargement automatique.
  // initial = { terminal, terminalKnown, autoDownload } : l'état lu au chargement (terminal inconnu = pas de commande terminal).
  function buildApplyPlan(selection, initial) {
    var plan = [{ step: 'theme', cmd: 'set-theme', args: [selection.theme] }];
    var bg = selection.background;
    if (bg.kind === 'file') plan.push({ step: 'background', cmd: 'set-background', args: [bg.path] });
    else if (bg.kind === 'wallhaven') plan.push({ step: 'background', cmd: 'wallpapers', args: ['use', bg.id, selection.theme] });
    else plan.push({ step: 'background', cmd: 'set-background', args: ['default'] });
    if (initial.terminalKnown) {
      var changes = terminalChanges(initial.terminal, selection.terminal);
      if (changes.apply) plan.push({ step: 'terminal', cmd: 'terminal', args: ['apply', JSON.stringify(changes.apply)] });
      if (changes.remove) plan.push({ step: 'terminal', cmd: 'terminal', args: ['remove', JSON.stringify(changes.remove)] });
    }
    if (selection.autoDownload !== initial.autoDownload) {
      plan.push({
        step: 'autoDownload',
        cmd: 'write-config',
        args: ['-'],
        stdin: JSON.stringify({ wallpapers: { autoDownload: selection.autoDownload } }),
      });
    }
    return plan;
  }

  // La galerie est proposée seulement si elle peut s'ouvrir, que set-theme annonce des fonds absents, et une fois par thème.
  function shouldOfferGallery(res, themeId, prompted, available) {
    return !!available && !!res && res.hasDownloads === false && !(prompted && prompted[themeId]);
  }

  // Charge utile de l'ouverture de la galerie pour un thème (le thème est validé côté UiBridge.cs).
  function galleryPayload(themeId) {
    return { page: 'gallery', theme: themeId };
  }

  var api = {
    basename: basename,
    errorMessage: errorMessage,
    loadFailureText: loadFailureText,
    terminalFailureText: terminalFailureText,
    applyFailureText: applyFailureText,
    thumbnailFile: thumbnailFile,
    parseBackground: parseBackground,
    resolveTheme: resolveTheme,
    downloadsFrom: downloadsFrom,
    keepBackgroundFor: keepBackgroundFor,
    backgroundLabel: backgroundLabel,
    terminalState: terminalState,
    terminalChanges: terminalChanges,
    buildSelection: buildSelection,
    buildApplyPlan: buildApplyPlan,
    shouldOfferGallery: shouldOfferGallery,
    galleryPayload: galleryPayload,
    GALLERY_WINDOW_ACTION: GALLERY_WINDOW_ACTION,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // ── Interface (navigateur) ────────────────────────────────────────────────

  function bridge() { return window.dojo; }

  // Création d'élément sans innerHTML : les textes passent par textContent (createTextNode).
  function el(tag, props, children) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (key) {
      var value = props[key];
      if (value === undefined || value === null || value === false) return;
      if (key === 'className') node.className = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    });
    (children || []).forEach(function (child) {
      if (child === undefined || child === null) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function checkIcon() {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M4.5 8.5l2.3 2.3 4.7-5.1');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  // Image avec repli texte (sans src, ou si l'image ne charge pas).
  function mediaFor(src, fallback) {
    var wrap = el('div', { className: 'tc-media' });
    function fallbackNode() { return el('span', { className: 'tc-fallback' }, [fallback]); }
    if (!src) {
      wrap.appendChild(fallbackNode());
      return wrap;
    }
    var img = el('img', { alt: '' });
    img.addEventListener('error', function () { wrap.replaceChildren(fallbackNode()); });
    img.src = src;
    wrap.appendChild(img);
    return wrap;
  }

  // Case à cocher dans un libellé. onToggle reçoit la nouvelle valeur.
  function checkbox(text, onToggle) {
    var input = el('input', { type: 'checkbox' });
    input.addEventListener('change', function () { onToggle(input.checked); });
    var label = el('label', { className: 'tc-check' }, [input, el('span', { className: 'tc-check-text' }, [text])]);
    return { label: label, input: input };
  }

  // Flèches, Début et Fin déplacent le focus dans un groupe radio ; Entrée et Espace activent.
  function radioKeys(event, getNodes, node, activate) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
      return;
    }
    var nodes = getNodes();
    var i = nodes.indexOf(node);
    var next = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = Math.min(nodes.length - 1, i + 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = Math.max(0, i - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = nodes.length - 1;
    if (next >= 0 && next !== i && nodes[next]) {
      event.preventDefault();
      nodes[next].focus();
    }
  }

  // Coche la carte choisie ; sans choix, la première reste atteignable à la tabulation (tabindex roving).
  function markRadios(entries, selectedId) {
    var anySelected = entries.some(function (e) { return e.id === selectedId; });
    entries.forEach(function (e, i) {
      var on = e.id === selectedId;
      e.node.classList.toggle('is-selected', on);
      e.node.setAttribute('aria-checked', on ? 'true' : 'false');
      e.node.tabIndex = on || (!anySelected && i === 0) ? 0 : -1;
    });
  }

  function checkBadge() {
    return el('span', { className: 'tc-check-badge' }, [checkIcon()]);
  }

  function mount(container, opts) {
    var options = opts || {};
    var host = typeof container === 'string' ? document.querySelector(container) : container;
    if (!host) throw new Error('conteneur introuvable');
    var embedded = options.embedded === true;

    var st = {
      loaded: false,
      themes: [],
      themesError: null,
      stateMode: '',
      cards: [],
      theme: '',
      background: { kind: 'theme' },
      bgApplied: false,
      downloads: [],
      downloadsError: null,
      downloadsLoaded: false,
      downloadsVersion: 0,
      bandCards: [],
      terminal: { windowsTerminal: false, welcome: false },
      terminalKnown: false,
      wtInstalled: null,
      terminalError: null,
      autoDownload: true,
      init: { terminal: { windowsTerminal: false, welcome: false }, terminalKnown: false, autoDownload: true },
      busy: false,
      destroyed: false,
      prompted: {},
      logoFor: null,
      previewKey: '',
    };

    // ── Structure, créée une fois ──
    var root = el('div', { className: 'tc' + (embedded ? ' tc-embedded' : '') });
    var head = el('header', { className: 'tc-head' }, [
      el('h2', { className: 'tc-title' }, [TEXT.title]),
      el('p', { className: 'tc-sub' }, [embedded ? TEXT.subEmbedded : TEXT.subWindow]),
    ]);
    var body = el('fieldset', { className: 'tc-body' });

    var stateBox = el('div', { className: 'tc-state' });
    var grid = el('div', { className: 'tc-grid', role: 'radiogroup', 'aria-label': TEXT.themesLabel });
    var themesSection = el('section', { className: 'tc-section' }, [stateBox, grid]);

    var logoBox = el('div', { className: 'tc-logo' });
    var wt = checkbox(TEXT.wt, function (v) { setTerminal('windowsTerminal', v); });
    var wtNote = el('p', { className: 'tc-note hidden' }, [TEXT.wtMissing]);
    var welcome = checkbox(TEXT.welcome, function (v) { setTerminal('welcome', v); });
    var terminalError = el('div', { className: 'notice notice-error hidden', role: 'alert' });
    var terminalSection = el('section', { className: 'tc-section' }, [
      el('h3', { className: 'tc-h' }, [TEXT.terminal]),
      logoBox,
      wt.label,
      wtNote,
      welcome.label,
      terminalError,
    ]);

    var pickBtn = el('button', { type: 'button', className: 'btn' }, [TEXT.pick]);
    var themeBtn = el('button', { type: 'button', className: 'btn' }, [TEXT.themeBg]);
    var galleryBtn = el('button', { type: 'button', className: 'btn' }, [TEXT.gallery]);
    pickBtn.addEventListener('click', chooseFile);
    themeBtn.addEventListener('click', useThemeBackground);
    galleryBtn.addEventListener('click', function () { openGallery(st.theme); });
    var band = el('div', { className: 'tc-band', role: 'radiogroup', 'aria-label': TEXT.bg });
    var bandNote = el('p', { className: 'tc-note hidden' });
    var preview = el('div', { className: 'tc-preview' });
    var caption = el('p', { className: 'tc-caption' });
    var bgSection = el('section', { className: 'tc-section' }, [
      el('h3', { className: 'tc-h' }, [TEXT.bg]),
      el('div', { className: 'row' }, [pickBtn, themeBtn, galleryBtn]),
      el('p', { className: 'tc-note' }, [TEXT.help]),
      band,
      bandNote,
      preview,
      caption,
    ]);

    var auto = checkbox(TEXT.autoDownload, function (v) { setAutoDownload(v); });
    var autoSection = el('section', { className: 'tc-section' }, [auto.label]);

    var notice = el('div', { className: 'tc-notice hidden', role: 'status', 'aria-live': 'polite' });
    var prompt = el('div', { className: 'tc-prompt hidden' });

    var closeBtn = el('button', { type: 'button', className: 'btn' }, [TEXT.close]);
    var applyBtn = el('button', { type: 'button', className: 'btn btn-primary' }, [TEXT.apply]);
    closeBtn.addEventListener('click', close);
    applyBtn.addEventListener('click', apply);
    var footer = el('footer', { className: 'tc-foot' }, [closeBtn, applyBtn]);

    var veil = el('div', { className: 'tc-veil', 'aria-hidden': 'true' }, [el('span', { className: 'spinner' })]);

    body.appendChild(themesSection);
    body.appendChild(terminalSection);
    body.appendChild(bgSection);
    if (!embedded) body.appendChild(autoSection);
    body.appendChild(notice);
    body.appendChild(prompt);
    if (!embedded) body.appendChild(footer);
    root.appendChild(head);
    root.appendChild(body);
    root.appendChild(veil);
    host.appendChild(root);

    // ── Rendu (mise à jour en place : le focus reste sur les cartes) ──

    function render() {
      renderThemes();
      renderTerminal();
      renderBackground();
      renderMisc();
    }

    function renderThemes() {
      var mode = !st.loaded ? 'loading' : st.themesError ? 'error' : st.themes.length === 0 ? 'empty' : 'ok';
      grid.classList.toggle('hidden', mode !== 'ok');
      stateBox.classList.toggle('hidden', mode === 'ok');
      if (mode !== st.stateMode) {
        st.stateMode = mode;
        stateBox.replaceChildren(stateContent(mode));
      }
      if (mode === 'ok') markRadios(st.cards, st.theme);
    }

    function stateContent(mode) {
      if (mode === 'loading') {
        return el('div', { className: 'tc-loading' }, [el('span', { className: 'spinner' }), el('span', {}, [TEXT.loading])]);
      }
      if (mode === 'error') {
        var retry = el('button', { type: 'button', className: 'btn' }, [TEXT.retry]);
        retry.addEventListener('click', function () { loadAll(false); });
        return el('div', { className: 'tc-stack' }, [
          el('div', { className: 'notice notice-error', role: 'alert' }, [loadFailureText(st.themesError)]),
          el('div', { className: 'row' }, [retry]),
        ]);
      }
      if (mode === 'empty') return el('div', { className: 'notice' }, [TEXT.empty]);
      return el('span', {});
    }

    function renderTerminal() {
      var offline = st.busy || !st.terminalKnown;
      wt.input.checked = st.terminal.windowsTerminal;
      wt.input.disabled = offline || st.wtInstalled === false;
      wt.label.classList.toggle('is-disabled', wt.input.disabled);
      wtNote.classList.toggle('hidden', st.wtInstalled !== false);
      welcome.input.checked = st.terminal.welcome;
      welcome.input.disabled = offline;
      welcome.label.classList.toggle('is-disabled', welcome.input.disabled);
      terminalError.classList.toggle('hidden', !st.terminalError);
      terminalError.textContent = st.terminalError ? terminalFailureText(st.terminalError) : '';
      if (st.logoFor !== st.theme) {
        st.logoFor = st.theme;
        logoBox.replaceChildren(mediaFor(st.theme ? bridge().themeAsset(st.theme, 'terminal/logo.png') : null, TEXT.noLogo));
      }
    }

    function renderBackground() {
      var bg = st.background;
      pickBtn.disabled = st.busy;
      themeBtn.disabled = st.busy || bg.kind === 'theme';
      galleryBtn.disabled = st.busy || GALLERY_WINDOW_ACTION === null || !st.theme;
      galleryBtn.title = GALLERY_WINDOW_ACTION === null ? TEXT.galleryHint : '';
      markRadios(st.bandCards, bg.kind === 'wallhaven' ? bg.id : null);
      var msg = st.downloadsError ? TEXT.downloadsFailed + st.downloadsError
        : st.downloadsLoaded && st.downloads.length === 0 && st.theme ? TEXT.noDownloads : '';
      bandNote.textContent = msg;
      bandNote.classList.toggle('hidden', !msg);
      var key = [bg.kind, bg.path || bg.id || '', st.theme, st.bgApplied, st.downloadsVersion].join('|');
      if (key !== st.previewKey) {
        st.previewKey = key;
        renderPreview();
      }
      caption.textContent = TEXT.selected + backgroundLabel(bg, st.downloads);
    }

    function renderPreview() {
      var bg = st.background;
      var src = null;
      var fallback = TEXT.noPreview;
      if (bg.kind === 'wallhaven') {
        var hit = st.downloads.filter(function (d) { return d.id === bg.id; })[0];
        if (hit) src = bridge().bgAsset(hit.file);
      } else if (bg.kind === 'file') {
        // Avant application, seul le nom du fichier est connu : pas d'aperçu.
        fallback = basename(bg.path);
        if (st.bgApplied) src = bridge().bgAsset(basename(bg.path));
      } else if (st.theme) {
        src = bridge().themeAsset(st.theme, 'background.jpg');
      }
      preview.replaceChildren(mediaFor(src, fallback));
    }

    function renderMisc() {
      auto.input.checked = st.autoDownload;
      auto.input.disabled = st.busy;
      applyBtn.disabled = st.busy || !st.theme;
    }

    function setNotice(kind, text) {
      notice.className = text ? 'tc-notice notice' + (kind ? ' notice-' + kind : '') : 'tc-notice hidden';
      notice.textContent = text || '';
    }

    function showGalleryPrompt(themeId) {
      var later = el('button', { type: 'button', className: 'btn' }, [TEXT.later]);
      var open = el('button', { type: 'button', className: 'btn btn-primary' }, [TEXT.open]);
      later.addEventListener('click', hidePrompt);
      open.addEventListener('click', function () { hidePrompt(); openGallery(themeId); });
      prompt.replaceChildren(el('div', { className: 'notice tc-prompt-row' }, [
        el('span', {}, [TEXT.galleryAsk]),
        el('span', { className: 'spacer' }),
        later,
        open,
      ]));
      prompt.classList.remove('hidden');
    }

    function hidePrompt() {
      prompt.classList.add('hidden');
      prompt.replaceChildren();
    }

    // Une modification de l'utilisateur efface le message précédent (Appliqué, erreur).
    function changed() {
      setNotice(null, '');
      render();
      notify();
    }

    function notify() {
      if (typeof options.onChange !== 'function') return;
      try {
        options.onChange(buildSelection(st));
      } catch (err) {
        console.error('DojoThemeChooser onChange :', err);
      }
    }

    function setBusy(value) {
      st.busy = value;
      root.classList.toggle('is-busy', value);
      root.setAttribute('aria-busy', value ? 'true' : 'false');
      body.disabled = value;
      render();
    }

    // ── Cartes et fonds ──

    function buildCards() {
      st.cards = st.themes.map(function (theme) {
        return { id: theme.id, node: themeCard(theme) };
      });
      grid.replaceChildren.apply(grid, st.cards.map(function (c) { return c.node; }));
    }

    function themeCard(theme) {
      var img = el('img', { alt: '', loading: 'lazy', draggable: 'false' });
      var thumb = el('div', { className: 'tc-thumb' }, [img, checkBadge()]);
      img.addEventListener('error', function () {
        img.remove();
        thumb.classList.add('is-missing');
      });
      img.src = bridge().themeAsset(theme.id, thumbnailFile(theme.thumbnail));
      var node = el('div', {
        className: 'tc-card',
        role: 'radio',
        tabindex: '-1',
        'aria-checked': 'false',
        'data-theme': theme.id,
      }, [thumb, el('div', { className: 'tc-name' }, [theme.name])]);
      node.addEventListener('click', function () { pickTheme(theme.id); });
      node.addEventListener('keydown', function (event) {
        radioKeys(event, function () { return st.cards.map(function (c) { return c.node; }); }, node, function () { pickTheme(theme.id); });
      });
      return node;
    }

    function buildBand() {
      st.bandCards = st.downloads.map(function (d, i) {
        var img = el('img', { alt: '', loading: 'lazy', draggable: 'false' });
        var thumb = el('div', { className: 'tc-bgthumb' }, [img, checkBadge()]);
        img.addEventListener('error', function () {
          img.remove();
          thumb.classList.add('is-missing');
        });
        img.src = bridge().bgAsset(d.file);
        var node = el('div', {
          className: 'tc-bgcard',
          role: 'radio',
          tabindex: '-1',
          'aria-checked': 'false',
          'aria-label': 'Fond ' + (i + 1),
        }, [thumb, el('div', { className: 'tc-bgname' }, ['Fond ' + (i + 1)])]);
        node.addEventListener('click', function () { chooseDownload(d.id); });
        node.addEventListener('keydown', function (event) {
          radioKeys(event, function () { return st.bandCards.map(function (c) { return c.node; }); }, node, function () { chooseDownload(d.id); });
        });
        return { id: d.id, node: node };
      });
      band.replaceChildren.apply(band, st.bandCards.map(function (c) { return c.node; }));
    }

    // ── Chargement ──

    async function loadAll(keep) {
      if (!keep) {
        st.loaded = false;
        render();
      }
      var res;
      try {
        res = await bridge().call('themes');
      } catch (err) {
        if (st.destroyed) return;
        st.themes = [];
        st.themesError = errorMessage(err);
        st.cards = [];
        st.loaded = true;
        buildCards();
        render();
        return;
      }
      if (st.destroyed) return;
      st.themes = Array.isArray(res.themes)
        ? res.themes.filter(function (t) { return t && typeof t.id === 'string' && t.id !== ''; })
        : [];
      st.themesError = null;
      st.loaded = true;
      var initial = options.initial || {};
      if (keep) {
        st.theme = resolveTheme(st.theme, st.themes, res.theme);
      } else {
        st.theme = resolveTheme(initial.theme, st.themes, res.theme);
        st.background = parseBackground(initial.background !== undefined ? initial.background : res.background);
        st.bgApplied = st.background.kind === 'file';
        st.autoDownload = res.autoDownload !== false;
      }
      buildCards();
      await Promise.all([loadTerminal(!keep), loadDownloads()]);
      if (st.destroyed) return;
      changed();
    }

    async function loadTerminal(fresh) {
      try {
        var status = await bridge().call('terminal', ['status']);
        if (st.destroyed) return;
        var t = terminalState(status);
        st.terminalKnown = t.known;
        st.wtInstalled = t.wtInstalled;
        st.terminalError = null;
        st.init.terminal = { windowsTerminal: t.windowsTerminal, welcome: t.welcome };
        st.init.terminalKnown = t.known;
        if (fresh) st.terminal = { windowsTerminal: t.windowsTerminal, welcome: t.welcome };
      } catch (err) {
        if (st.destroyed) return;
        st.terminalKnown = false;
        st.wtInstalled = null;
        st.terminalError = errorMessage(err);
        st.init.terminalKnown = false;
        if (fresh) st.terminal = { windowsTerminal: false, welcome: false };
      }
    }

    async function loadDownloads() {
      var theme = st.theme;
      var downloads = [];
      var error = null;
      if (theme) {
        try {
          downloads = downloadsFrom(await bridge().call('wallpapers', ['local', theme]));
        } catch (err) {
          error = errorMessage(err);
        }
      }
      if (st.destroyed || theme !== st.theme) return;
      st.downloads = downloads;
      st.downloadsError = error;
      st.downloadsLoaded = true;
      st.downloadsVersion += 1;
      if (!error) st.background = keepBackgroundFor(st.background, downloads);
      buildBand();
      changed();
    }

    // ── Actions utilisateur ──

    function pickTheme(id) {
      if (st.busy || id === st.theme || !st.themes.some(function (t) { return t.id === id; })) return;
      st.theme = id;
      st.downloads = [];
      st.downloadsError = null;
      st.downloadsLoaded = false;
      st.downloadsVersion += 1;
      buildBand();
      changed();
      loadDownloads();
    }

    function chooseDownload(id) {
      if (st.busy || (st.background.kind === 'wallhaven' && st.background.id === id)) return;
      st.background = { kind: 'wallhaven', id: id };
      st.bgApplied = false;
      changed();
    }

    function useThemeBackground() {
      if (st.busy || st.background.kind === 'theme') return;
      st.background = { kind: 'theme' };
      st.bgApplied = false;
      changed();
    }

    function chooseFile() {
      if (st.busy) return;
      Promise.resolve()
        .then(function () { return bridge().native('pickFile'); })
        .then(function (res) {
          if (st.destroyed || !res || typeof res.path !== 'string' || res.path === '') return;
          st.background = { kind: 'file', path: res.path };
          st.bgApplied = false;
          changed();
        }, function (err) {
          if (!st.destroyed) setNotice('error', 'Sélection impossible : ' + errorMessage(err));
        });
    }

    function openGallery(themeId) {
      if (st.busy || GALLERY_WINDOW_ACTION === null || !themeId) return;
      Promise.resolve()
        .then(function () { return bridge().native(GALLERY_WINDOW_ACTION, galleryPayload(themeId)); })
        .catch(function (err) { setNotice('error', 'Galerie indisponible : ' + errorMessage(err)); });
    }

    function setTerminal(key, value) {
      st.terminal[key] = value;
      changed();
    }

    function setAutoDownload(value) {
      st.autoDownload = value;
      changed();
    }

    async function apply() {
      if (st.busy || !st.theme) return;
      var selection = buildSelection(st);
      var plan = buildApplyPlan(selection, st.init);
      var setThemeRes = null;
      var bgRes = null;
      setNotice(null, '');
      hidePrompt();
      setBusy(true);
      try {
        for (var i = 0; i < plan.length; i++) {
          var step = plan[i];
          var res = await bridge().call(step.cmd, step.args, step.stdin === undefined ? undefined : { stdin: step.stdin });
          if (step.step === 'theme') setThemeRes = res;
          if (step.step === 'background' && step.cmd === 'set-background') bgRes = res;
        }
        if (st.destroyed) return;
        st.init = {
          terminal: { windowsTerminal: selection.terminal.windowsTerminal, welcome: selection.terminal.welcome },
          terminalKnown: st.init.terminalKnown,
          autoDownload: selection.autoDownload,
        };
        // set-background copie une image personnelle dans la configuration : la suite utilise cette copie.
        if (st.background.kind === 'file') {
          if (bgRes && typeof bgRes.background === 'string' && bgRes.background !== '') st.background = { kind: 'file', path: bgRes.background };
          st.bgApplied = true;
        }
        setNotice('ok', TEXT.applied);
        if (shouldOfferGallery(setThemeRes, selection.theme, st.prompted, GALLERY_WINDOW_ACTION !== null)) {
          st.prompted[selection.theme] = true;
          showGalleryPrompt(selection.theme);
        }
      } catch (err) {
        if (!st.destroyed) setNotice('error', applyFailureText(err));
      } finally {
        if (!st.destroyed) setBusy(false);
        if (!st.destroyed) notify();
      }
    }

    function close() {
      if (st.busy) return;
      if (typeof options.onClose === 'function') {
        options.onClose();
        return;
      }
      Promise.resolve()
        .then(function () { return bridge().close(); })
        .catch(function (err) { setNotice('error', 'Fermeture impossible : ' + errorMessage(err)); });
    }

    function getSelection() {
      return buildSelection(st);
    }

    function destroy() {
      st.destroyed = true;
      root.remove();
    }

    render();
    loadAll(false).catch(function (err) {
      if (!st.destroyed) setNotice('error', 'Chargement impossible : ' + errorMessage(err));
    });

    return {
      getSelection: getSelection,
      reload: function () { return loadAll(true); },
      destroy: destroy,
    };
  }

  if (typeof window !== 'undefined') window.DojoThemeChooser = { mount: mount };
})();
