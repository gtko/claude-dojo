/* Page « Fonds d'écran » (gallery.html) : galerie Wallhaven en HTML/CSS/JS pur, sans dépendance externe.
 * Reprend mac/GalleryWindow.swift (état et actions) et mac/GalleryService.swift (liens acceptés, éléments).
 * Le pont est dans bridge.js (window.dojo). Commandes : themes ; wallpapers list|search|local|download|sync|progress|use|next.
 * Les fonctions sans DOM sont exportées (module.exports) pour windows/ui/tests/gallery.test.js. */
(function () {
  'use strict';

  const TABS = ['selection', 'more', 'downloaded'];
  const TAB_EMPTY = {
    selection: 'Aucun fond à proposer pour ce thème.',
    more: 'Aucun résultat sur cette page.',
    downloaded: 'Aucun fond téléchargé pour ce thème.',
  };
  const WALLHAVEN_ID_RE = /^[a-z0-9]{4,10}$/;
  const THEME_ID_RE = /^[a-z0-9_-]{1,40}$/;
  const BUILTIN_ID = 'theme'; // fond embarqué du thème : wallpapers use theme
  const BUILTIN_FILE = 'background.jpg';
  const THUMB_HOSTS = ['th.wallhaven.cc', 'w.wallhaven.cc'];
  const SOURCE_HOSTS = ['wallhaven.cc', 'www.wallhaven.cc'];
  const ARROW_KEYS = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'];
  const PROGRESS_POLL_MS = 1500;
  const FLASH_MS = 3000;
  const CANCELLED_TEXT = 'Suivi arrêté : la synchronisation continue en arrière-plan.';
  const STAGE = {
    load: 'Chargement impossible',
    download: 'Téléchargement impossible',
    apply: 'Application du fond impossible',
    next: 'Fond suivant impossible',
    sync: 'Synchronisation impossible',
    open: 'Ouverture impossible',
    close: 'Fermeture impossible',
  };

  // ---------- Logique pure (sans DOM) ----------

  const strOrNull = (v) => (typeof v === 'string' && v !== '' ? v : null);
  const count = (v) => (Array.isArray(v) ? v.length : 0);
  const nonNegative = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

  // URL https, sans identifiants ni port, dont l'hôte est dans la liste : sinon null (comme GalleryLinks).
  function secureUrl(text, hosts) {
    if (typeof text !== 'string') return null;
    let url;
    try {
      url = new URL(text.trim());
    } catch (e) {
      return null;
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return null;
    return hosts.includes(url.hostname) ? url.href : null;
  }

  const thumbnailUrl = (text) => secureUrl(text, THUMB_HOSTS);
  const sourceUrl = (text) => secureUrl(text, SOURCE_HOSTS);

  // Chemin relatif au dossier des fonds (hôte dojo-bg.local) : ce qui suit le dossier « backgrounds ». Sinon null.
  function backgroundRelative(file) {
    if (typeof file !== 'string') return null;
    const parts = file.split(/[\\/]+/).filter((p) => p !== '');
    const at = parts.lastIndexOf('backgrounds');
    const rest = at < 0 ? [] : parts.slice(at + 1);
    if (rest.length === 0 || rest.some((p) => p === '.' || p === '..')) return null;
    return rest.join('/');
  }

  // Élément de list, search ou local ramené à une forme sûre. Null si l'identifiant est invalide.
  // Le fond embarqué (builtin) porte l'identifiant « theme » ; il est toujours téléchargé.
  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const builtin = raw.builtin === true;
    const id = typeof raw.id === 'string' ? raw.id : '';
    const validId = builtin ? id === BUILTIN_ID : WALLHAVEN_ID_RE.test(id) && id !== BUILTIN_ID;
    if (!validId) return null;
    const file = strOrNull(raw.file);
    return {
      id,
      builtin,
      downloaded: builtin || raw.downloaded === true,
      resolution: strOrNull(raw.resolution),
      thumb: builtin ? null : thumbnailUrl(raw.thumb),
      source: sourceUrl(raw.source),
      localPath: builtin ? null : backgroundRelative(file),
    };
  }

  // downloaded = true : liste locale (wallpapers local), où chaque élément est téléchargé.
  function normalizeItems(list, downloaded) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const raw of list) {
      const item = normalizeItem(downloaded ? { ...(raw || {}), downloaded: true } : raw);
      if (item) out.push(item);
    }
    return out;
  }

  function normalizeThemes(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter((t) => t && typeof t.id === 'string' && THEME_ID_RE.test(t.id) && typeof t.name === 'string' && t.name !== '')
      .map((t) => ({ id: t.id, name: t.name }));
  }

  // Thème demandé (paramètre d'URL) s'il existe, sinon thème courant, sinon le premier.
  function chooseTheme(themes, requested, current) {
    const ids = themes.map((t) => t.id);
    if (requested && ids.includes(requested)) return requested;
    if (current && ids.includes(current)) return current;
    return ids.length > 0 ? ids[0] : '';
  }

  // ?theme=<id> : valeur acceptée seulement si elle respecte ^[a-z0-9_-]{1,40}$, sinon null.
  function themeFromQuery(search) {
    let value = null;
    try {
      value = new URLSearchParams(typeof search === 'string' ? search : '').get('theme');
    } catch (e) {
      value = null;
    }
    return value !== null && THEME_ID_RE.test(value) ? value : null;
  }

  const lastPageOf = (v) => (Number.isInteger(v) && v >= 1 ? v : null);
  const pageLabel = (page, lastPage) => (lastPage ? `Page ${page} sur ${lastPage}` : `Page ${page}`);

  // Précédent si page > 1 ; Suivant si page < lastPage (lastPage connu seulement).
  function pagerState(page, lastPage) {
    return { previous: page > 1, next: lastPage != null && page < lastPage };
  }

  // Page visée par Précédent (delta -1) ou Suivant (delta +1), ou null si hors bornes.
  function targetPage(page, delta, lastPage) {
    const target = page + delta;
    if (target < 1) return null;
    if (delta > 0 && (lastPage == null || target > lastPage)) return null;
    return target;
  }

  function isDownloaded(item, downloadedIds) {
    return item.downloaded || (downloadedIds ? downloadedIds.has(item.id) : false);
  }

  // Clic sur une vignette : 'download-use' (télécharger puis appliquer), 'use' (appliquer) ou null (rien à faire).
  // ctx : { theme, busyId, downloadedIds }. Une seule opération à la fois.
  function tileAction(item, ctx) {
    if (!item || !ctx.theme || ctx.busyId) return null;
    return isDownloaded(item, ctx.downloadedIds) ? 'use' : 'download-use';
  }

  const downloadArgs = (id, theme) => ['download', id, theme];

  // Fond embarqué : « use theme » sans second argument (le bridge et setup.js refusent un thème ici).
  const useArgs = (id, theme) => (id === BUILTIN_ID ? ['use', BUILTIN_ID] : ['use', id, theme]);

  // Message lisible : les conseils de ligne de commande « (wallpapers …) » sont retirés. Vide : « erreur inconnue ».
  function errorText(err) {
    let text = '';
    if (typeof err === 'string') text = err;
    else if (err && typeof err.message === 'string') text = err.message;
    text = text.replace(/\s*\((?:wallpapers|node setup\.js)[^)]*\)/g, '').replace(/\s+/g, ' ').trim();
    return text === '' ? 'erreur inconnue' : text;
  }

  const failure = (stage, err) => `${stage} : ${errorText(err)}`;

  // Résumé de `wallpapers sync` : { kind: 'ok' | 'warn', text }.
  function syncOutcome(res) {
    if (!res || typeof res !== 'object') return { kind: 'ok', text: 'Synchronisation terminée.' };
    if (res.alreadyRunning === true) {
      return { kind: 'warn', text: 'Une synchronisation est déjà en cours pour ce thème.' };
    }
    const failed = count(res.failed);
    const stopped = strOrNull(res.stopped);
    let text = `Synchronisation terminée : ${count(res.downloaded)} téléchargé(s), ${count(res.skipped)} ignoré(s), ${failed} échec(s).`;
    if (stopped) text += ` Arrêtée : ${errorText(stopped)}`;
    return { kind: failed > 0 || Boolean(stopped) ? 'warn' : 'ok', text };
  }

  function progressPercent(done, total) {
    if (!(total > 0)) return 0;
    const d = Number.isFinite(done) ? done : 0;
    return Math.min(100, Math.max(0, Math.round((d / total) * 100)));
  }

  const progressLabel = (done, total) => (total > 0 ? `Téléchargement… ${done}/${total}` : 'Téléchargement…');
  const countLabel = (n) => `${n} ${n <= 1 ? 'fond' : 'fonds'}`;

  // Sources d'image d'une vignette, dans l'ordre d'essai : fond embarqué, vignette distante, fichier local.
  function imageSources(item, theme) {
    const out = [];
    if (item.builtin) out.push({ kind: 'theme', theme, file: BUILTIN_FILE });
    if (item.thumb) out.push({ kind: 'remote', url: item.thumb });
    if (item.localPath) out.push({ kind: 'local', path: item.localPath });
    return out;
  }

  function tileLabel(item, isCurrent) {
    let text = item.builtin ? 'Fond du thème' : `Fond ${item.id}`;
    if (item.resolution) text += `, ${item.resolution}`;
    if (isCurrent) text += ', actuel';
    return text;
  }

  // Résultat de `wallpapers local` : identifiants téléchargés, fond actuel, éléments (téléchargés).
  // Sans réponse (échec non bloquant), rien n'est affirmé : ni « Actuel », ni coche.
  function localState(res) {
    const list = res && Array.isArray(res.wallpapers) ? res.wallpapers : [];
    const downloadedIds = new Set();
    let currentId = null;
    for (const raw of list) {
      if (!raw || typeof raw.id !== 'string') continue;
      downloadedIds.add(raw.id);
      if (raw.current === true && currentId === null) currentId = raw.id;
    }
    return { downloadedIds, currentId, items: normalizeItems(list, true) };
  }

  // ---------- Interface ----------

  const state = {
    themes: [],
    theme: '',
    requestedTheme: null,
    tab: 'selection',
    page: 1,
    lastPage: null,
    phase: 'loading', // loading | loaded | failed
    failText: '',
    items: [],
    currentId: null,
    downloadedIds: new Set(),
    busyId: null, // carte occupée (téléchargement ou application)
    toolBusy: false, // « Fond suivant » en cours
    syncing: false,
    syncTheme: null,
    syncCancelled: false,
    syncProgress: { done: 0, total: 0 },
    syncResult: null,
    notice: null, // { kind: 'error' | 'ok', text }
  };
  let dom = null;
  let loadToken = 0;
  let flashTimer = 0;
  let follow = null; // suivi de progression de la synchronisation en cours

  const wp = (args) => window.dojo.call('wallpapers', args);
  const safeLocal = (theme) => wp(['local', theme]).catch(() => null);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Données d'un onglet. « Sélection » et « Plus » ne dépendent pas de `local` : son échec est non bloquant.
  async function fetchTab(theme, tab, page) {
    if (theme === '') return { items: [], lastPage: null, currentId: null, downloadedIds: new Set() };
    if (tab === 'downloaded') {
      const local = localState(await wp(['local', theme]));
      return { items: local.items, lastPage: null, currentId: local.currentId, downloadedIds: local.downloadedIds };
    }
    const [locals, body] = await Promise.all([
      safeLocal(theme),
      wp(tab === 'more' ? ['search', theme, String(page)] : ['list', theme]),
    ]);
    const local = localState(locals);
    return {
      items: normalizeItems((body || {}).wallpapers, false),
      lastPage: tab === 'more' ? lastPageOf((body || {}).lastPage) : null,
      currentId: local.currentId,
      downloadedIds: local.downloadedIds,
    };
  }

  async function load(withThemes) {
    const token = ++loadToken;
    state.phase = 'loading';
    state.items = [];
    render();
    try {
      if (withThemes || state.themes.length === 0) {
        const res = await window.dojo.call('themes', []);
        if (token !== loadToken) return;
        state.themes = normalizeThemes(res && res.themes);
        state.theme = chooseTheme(state.themes, state.requestedTheme, res && res.theme);
        state.requestedTheme = null;
      }
      const view = await fetchTab(state.theme, state.tab, state.page);
      if (token !== loadToken) return;
      state.items = view.items;
      state.lastPage = view.lastPage;
      state.currentId = view.currentId;
      state.downloadedIds = view.downloadedIds;
      state.phase = 'loaded';
    } catch (err) {
      if (token !== loadToken) return;
      state.phase = 'failed';
      state.failText = failure(STAGE.load, err);
    }
    render();
  }

  async function refreshLocal(theme) {
    const local = localState(await safeLocal(theme));
    if (theme === state.theme) {
      state.currentId = local.currentId;
      state.downloadedIds = local.downloadedIds;
    }
  }

  function flash(text) {
    const notice = { kind: 'ok', text };
    state.notice = notice;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      if (state.notice === notice) {
        state.notice = null;
        render();
      }
    }, FLASH_MS);
  }

  function showError(text) {
    state.notice = { kind: 'error', text };
    render();
  }

  function selectTheme(id) {
    if (id === state.theme || state.busyId !== null) return;
    state.theme = id;
    state.page = 1;
    state.lastPage = null;
    state.syncResult = null;
    load(false);
  }

  function selectTab(tab) {
    if (!TABS.includes(tab) || tab === state.tab || state.busyId !== null) return;
    state.tab = tab;
    load(false);
  }

  function changePage(delta) {
    const target = targetPage(state.page, delta, state.lastPage);
    if (target === null || state.busyId !== null || state.phase === 'loading') return;
    state.page = target;
    load(false);
  }

  function retry() {
    if (state.busyId === null) load(state.themes.length === 0);
  }

  // Clic sur une carte : télécharge si besoin, puis applique le fond (au thème affiché).
  async function activate(item) {
    const target = state.theme;
    const action = tileAction(item, { theme: target, busyId: state.busyId, downloadedIds: state.downloadedIds });
    if (action === null) return;
    state.busyId = item.id;
    state.notice = null;
    render();
    let stage = STAGE.download;
    try {
      if (action === 'download-use') {
        await wp(downloadArgs(item.id, target));
        state.downloadedIds.add(item.id);
      }
      stage = STAGE.apply;
      const used = await wp(useArgs(item.id, target));
      if (state.theme === target) state.currentId = strOrNull(used && used.id) || item.id;
      flash('Fond appliqué.');
    } catch (err) {
      state.notice = { kind: 'error', text: failure(stage, err) };
    } finally {
      state.busyId = null;
      render();
    }
  }

  async function nextWallpaper() {
    const target = state.theme;
    if (!target || state.toolBusy || state.syncing || state.busyId !== null) return;
    state.toolBusy = true;
    state.notice = null;
    render();
    try {
      await wp(['next']);
      flash('Fond appliqué.');
      await refreshLocal(target);
    } catch (err) {
      state.notice = { kind: 'error', text: failure(STAGE.next, err) };
    } finally {
      state.toolBusy = false;
      render();
    }
  }

  // Synchronisation du thème affiché. La progression est lue toutes les 1,5 s pendant que la commande tourne.
  async function syncTheme() {
    const target = state.theme;
    if (!target || state.syncing || state.toolBusy || state.busyId !== null) return;
    state.syncing = true;
    state.syncTheme = target;
    state.syncCancelled = false;
    state.syncProgress = { done: 0, total: 0 };
    state.syncResult = null;
    state.notice = null;
    render();

    const session = { on: true, timer: 0 };
    follow = session;
    const tick = async () => {
      session.timer = 0;
      try {
        const p = await wp(['progress', target]);
        if (session.on && !state.syncCancelled && p && p.running === true) {
          state.syncProgress = { done: nonNegative(p.done), total: nonNegative(p.total) };
          renderSync();
        }
      } catch (e) {
        // Suivi non bloquant : la synchronisation continue, seul l'affichage reste figé.
      }
      if (session.on) session.timer = setTimeout(tick, PROGRESS_POLL_MS);
    };
    session.timer = setTimeout(tick, PROGRESS_POLL_MS);

    let outcome;
    try {
      outcome = syncOutcome(await wp(['sync', target]));
    } catch (err) {
      outcome = { kind: 'error', text: failure(STAGE.sync, err) };
    } finally {
      session.on = false;
      clearTimeout(session.timer);
      if (follow === session) follow = null;
    }
    state.syncing = false;
    state.syncCancelled = false;
    state.syncResult = outcome;
    if (state.theme === target) {
      if (state.tab === 'downloaded') await load(false);
      else await refreshLocal(target);
    }
    render();
  }

  // « Annuler » : aucune commande d'arrêt n'existe (wallpapers n'en a pas) ; on arrête seulement le suivi.
  function cancelFollow() {
    if (follow) {
      follow.on = false;
      clearTimeout(follow.timer);
    }
    state.syncCancelled = true;
    renderSync();
  }

  function openSource(id) {
    const item = state.items.find((i) => i.id === id);
    if (!item || !item.source) return;
    window.dojo.openUrl(item.source).catch((err) => showError(failure(STAGE.open, err)));
  }

  function closeWindow() {
    window.dojo.close().catch((err) => showError(failure(STAGE.close, err)));
  }

  // ---------- Rendu ----------

  function render() {
    renderThemeSelect();
    renderTabs();
    renderPager();
    renderNotice();
    renderTools();
    renderContent();
    dom.count.textContent = countLabel(state.items.length);
    renderSync();
  }

  function renderThemeSelect() {
    const select = dom.theme;
    const key = state.themes.map((t) => `${t.id}\n${t.name}`).join('\u0001');
    if (select.dataset.key !== key) {
      select.textContent = '';
      for (const t of state.themes) {
        const option = el('option', null, t.name);
        option.value = t.id;
        select.appendChild(option);
      }
      select.dataset.key = key;
    }
    select.value = state.theme;
    select.disabled = state.themes.length === 0 || state.busyId !== null;
  }

  function renderTabs() {
    for (const btn of dom.tabs) {
      btn.setAttribute('aria-selected', String(btn.dataset.tab === state.tab));
      btn.disabled = state.busyId !== null;
    }
  }

  function renderPager() {
    dom.pager.classList.toggle('hidden', state.tab !== 'more');
    const busy = state.phase === 'loading' || state.busyId !== null;
    const pager = pagerState(state.page, state.lastPage);
    dom.prev.disabled = !pager.previous || busy;
    dom.pageNext.disabled = !pager.next || busy;
    dom.pageLabel.textContent = pageLabel(state.page, state.lastPage);
  }

  function renderNotice() {
    const n = state.notice;
    const kind = n && n.kind === 'ok' ? 'notice-ok' : 'notice-error';
    dom.notice.className = `gal-notice notice ${kind}${n ? '' : ' hidden'}`;
    dom.noticeText.textContent = n ? n.text : '';
  }

  function renderTools() {
    const busy = state.busyId !== null || state.toolBusy || state.syncing;
    dom.next.disabled = !state.theme || busy;
    dom.sync.disabled = !state.theme || busy;
  }

  function statusBox(children) {
    const wrap = el('div', 'gal-status');
    for (const child of children) wrap.appendChild(child);
    return wrap;
  }

  function messageEl(text, isError) {
    return el('div', isError ? 'notice notice-error' : 'gal-message', text);
  }

  function retryButton() {
    const btn = el('button', 'btn', 'Réessayer');
    btn.type = 'button';
    btn.dataset.action = 'retry';
    return btn;
  }

  function focusedTileId() {
    const active = document.activeElement;
    return active && active.classList && active.classList.contains('tile') ? active.dataset.id : null;
  }

  function renderContent() {
    const box = dom.content;
    const focusId = focusedTileId();
    const scroll = box.scrollTop;
    box.textContent = '';
    if (state.phase === 'loading') {
      box.appendChild(statusBox([el('span', 'spinner'), el('span', 'gal-message', 'Chargement…')]));
    } else if (state.phase === 'failed') {
      box.appendChild(statusBox([messageEl(state.failText, true), retryButton()]));
    } else if (state.themes.length === 0) {
      box.appendChild(statusBox([messageEl("Aucun thème trouvé dans l'application.", true), retryButton()]));
    } else if (state.items.length === 0) {
      box.appendChild(statusBox([messageEl(TAB_EMPTY[state.tab])]));
    } else {
      const list = el('ul', 'tiles');
      for (const item of state.items) list.appendChild(buildCell(item));
      box.appendChild(list);
      box.scrollTop = scroll;
      if (focusId) {
        const again = Array.from(box.querySelectorAll('.tile')).find((t) => t.dataset.id === focusId);
        if (again) again.focus({ preventScroll: true });
      }
    }
  }

  function buildCell(item) {
    const isCurrent = item.id === state.currentId;
    const busy = state.busyId === item.id;
    const elsewhere = state.busyId !== null && !busy;
    const li = el('li', 'tile-cell');

    const tile = el('button', 'tile');
    tile.type = 'button';
    tile.dataset.id = item.id;
    tile.setAttribute('aria-label', tileLabel(item, isCurrent));
    tile.setAttribute('aria-disabled', String(elsewhere));
    if (busy) tile.setAttribute('aria-busy', 'true');

    const art = el('span', 'tile-art');
    attachImage(art, imageSources(item, state.theme));
    if (isCurrent) {
      art.appendChild(el('span', 'tile-badge', 'Actuel'));
    } else if (isDownloaded(item, state.downloadedIds)) {
      const check = el('span', 'tile-check', '✓');
      check.setAttribute('aria-hidden', 'true');
      art.appendChild(check);
    }
    if (busy) {
      const veil = el('span', 'tile-busy');
      veil.appendChild(el('span', 'spinner'));
      art.appendChild(veil);
    }
    tile.appendChild(art);
    li.appendChild(tile);

    const meta = el('div', 'tile-meta');
    meta.appendChild(el('span', 'tile-res', item.resolution || ''));
    if (item.source) {
      const link = el('button', 'link-btn', 'Ouvrir la source');
      link.type = 'button';
      link.dataset.action = 'source';
      link.dataset.id = item.id;
      meta.appendChild(link);
    }
    li.appendChild(meta);
    return li;
  }

  function urlOf(source) {
    if (source.kind === 'theme') return window.dojo.themeAsset(source.theme, source.file);
    if (source.kind === 'local') return window.dojo.bgAsset(source.path);
    return source.url || null;
  }

  // Essaie les sources dans l'ordre ; si aucune ne charge, un repère « Aperçu indisponible ».
  function attachImage(art, sources) {
    let index = 0;
    const next = () => {
      if (index >= sources.length) {
        art.appendChild(el('span', 'tile-empty', 'Aperçu indisponible'));
        return;
      }
      const url = urlOf(sources[index]);
      index += 1;
      if (!url) {
        next();
        return;
      }
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => {
        img.remove();
        next();
      };
      img.src = url;
      art.insertBefore(img, art.firstChild);
    };
    next();
  }

  function renderSync() {
    const here = state.syncTheme !== null && state.syncTheme === state.theme;
    const running = here && state.syncing;
    const following = running && !state.syncCancelled;
    const result = here && !state.syncing ? state.syncResult : null;
    const visible = running || result !== null;
    const kinds = { ok: 'notice-ok', warn: 'notice-warn', error: 'notice-error' };
    const kind = result ? ` ${kinds[result.kind] || 'notice-error'}` : '';
    dom.syncBox.className = `gal-sync notice${kind}${visible ? '' : ' hidden'}`;
    dom.syncBar.classList.toggle('hidden', !following);
    dom.syncFill.style.width = `${progressPercent(state.syncProgress.done, state.syncProgress.total)}%`;
    dom.cancelSync.classList.toggle('hidden', !following);
    if (running) {
      dom.syncText.textContent = state.syncCancelled ? CANCELLED_TEXT : progressLabel(state.syncProgress.done, state.syncProgress.total);
    } else {
      dom.syncText.textContent = result ? result.text : '';
    }
  }

  // ---------- Clavier et délégation ----------

  function columnsOf(tiles) {
    if (tiles.length === 0) return 1;
    const top = tiles[0].parentElement.offsetTop;
    let n = 0;
    for (const tile of tiles) {
      if (tile.parentElement.offsetTop !== top) break;
      n += 1;
    }
    return Math.max(1, n);
  }

  // Flèches : gauche/droite d'une carte à l'autre, haut/bas d'une ligne à l'autre. Entrée et espace : bouton natif.
  function onGridKey(event) {
    if (!ARROW_KEYS.includes(event.key) || !event.target.classList.contains('tile')) return;
    const tiles = Array.from(dom.content.querySelectorAll('.tile'));
    const index = tiles.indexOf(event.target);
    if (index < 0) return;
    const cols = columnsOf(tiles);
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[event.key];
    const to = index + step;
    event.preventDefault();
    if (to >= 0 && to < tiles.length) tiles[to].focus();
  }

  function onContentClick(event) {
    const target = event.target;
    if (target.closest('[data-action="retry"]')) {
      retry();
      return;
    }
    const link = target.closest('[data-action="source"]');
    if (link) {
      openSource(link.dataset.id);
      return;
    }
    const tile = target.closest('.tile');
    if (tile) {
      const item = state.items.find((i) => i.id === tile.dataset.id);
      if (item) activate(item);
    }
  }

  function start() {
    const $ = (id) => document.getElementById(id);
    dom = {
      theme: $('theme-select'),
      tabs: Array.from(document.querySelectorAll('[data-tab]')),
      pager: $('pager'),
      prev: $('btn-prev'),
      pageNext: $('btn-page-next'),
      pageLabel: $('page-label'),
      next: $('btn-next'),
      sync: $('btn-sync'),
      close: $('btn-close'),
      notice: $('notice'),
      noticeText: $('notice-text'),
      noticeClose: $('notice-close'),
      syncBox: $('sync-box'),
      syncText: $('sync-text'),
      syncBar: $('sync-bar'),
      syncFill: $('sync-fill'),
      cancelSync: $('btn-cancel-sync'),
      content: $('content'),
      count: $('count'),
    };
    dom.theme.addEventListener('change', () => selectTheme(dom.theme.value));
    for (const btn of dom.tabs) btn.addEventListener('click', () => selectTab(btn.dataset.tab));
    dom.prev.addEventListener('click', () => changePage(-1));
    dom.pageNext.addEventListener('click', () => changePage(1));
    dom.next.addEventListener('click', nextWallpaper);
    dom.sync.addEventListener('click', syncTheme);
    dom.cancelSync.addEventListener('click', cancelFollow);
    dom.close.addEventListener('click', closeWindow);
    dom.noticeClose.addEventListener('click', () => {
      state.notice = null;
      render();
    });
    dom.content.addEventListener('click', onContentClick);
    dom.content.addEventListener('keydown', onGridKey);
    state.requestedTheme = themeFromQuery(window.location.search);
    load(true);
  }

  const api = {
    secureUrl,
    thumbnailUrl,
    sourceUrl,
    backgroundRelative,
    normalizeItem,
    normalizeItems,
    normalizeThemes,
    chooseTheme,
    themeFromQuery,
    lastPageOf,
    pageLabel,
    pagerState,
    targetPage,
    isDownloaded,
    tileAction,
    downloadArgs,
    useArgs,
    errorText,
    failure,
    syncOutcome,
    progressPercent,
    progressLabel,
    countLabel,
    imageSources,
    tileLabel,
    localState,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined') start();
})();
