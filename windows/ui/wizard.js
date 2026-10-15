// Assistant de configuration (Windows) : rendu DOM et actions du pont (window.dojo).
// La logique (étapes, validations, configuration, plan d'application) est dans wizard-model.js (window.DojoWizardModel).
(function () {
  'use strict';

  var M = window.DojoWizardModel;
  var app = document.getElementById('app');
  var model = null;
  var chooser = null;
  var chooserMounted = false;
  var bodyStep = null;
  var ownerDraft = '';
  var pendingFocus = null;
  var previewTimer = null;
  var previewSeq = 0;
  var geoSeq = 0;
  var refs = {};
  var BOOL_PROPS = { checked: true, disabled: true };
  var CHOOSER_ERROR = 'Sélecteur de thème indisponible : le thème par défaut sera conservé.';
  var STATUS_OPTIONS = [
    { value: 'replace', label: 'Remplacer par celle de Dojo' },
    { value: 'keep', label: 'Garder celle existante' },
    { value: 'none', label: 'Ne pas gérer la barre de statut' }
  ];

  // ── Utilitaires DOM ───────────────────────────────────────────────────────

  function messageOf(err) { return err && err.message ? err.message : String(err); }
  function trimmed(v) { return String(v || '').trim(); }

  // h(tag, props, enfants) : texte via textContent, jamais de HTML injecté.
  function h(tag, props, kids) {
    var node = document.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      var v = p[k];
      if (v === undefined || v === null) return;
      if (k === 'text') node.textContent = String(v);
      else if (k === 'on') Object.keys(v).forEach(function (ev) { node.addEventListener(ev, v[ev]); });
      else if (k === 'value') node.value = String(v);
      else if (BOOL_PROPS[k]) node[k] = !!v;
      else if (v === false) node.setAttribute(k, 'false');
      else node.setAttribute(k, v === true ? '' : String(v));
    });
    append(node, kids);
    return node;
  }

  function append(node, kids) {
    (Array.isArray(kids) ? kids : [kids]).forEach(function (k) {
      if (k === null || k === undefined || k === false) return;
      if (Array.isArray(k)) append(node, k);
      else node.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
    });
  }

  function notice(text, kind) {
    var cls = 'notice' + (kind && kind !== 'info' ? ' notice-' + kind : '');
    return h('div', { class: cls, role: kind === 'error' ? 'alert' : 'status', text: text });
  }

  function stepTitle(title, subtitle) {
    return h('div', { class: 'step-title' }, [h('h2', { tabindex: '-1', text: title }), h('p', { text: subtitle })]);
  }

  function statusRow(title, detail, ok, optional) {
    var cls = ok ? 'ok' : (optional ? 'opt' : 'ko');
    return h('div', { class: 'status-row' }, [
      h('span', { class: 'dot ' + cls, 'aria-hidden': 'true' }),
      h('div', null, [h('strong', { text: title }), h('small', { text: detail })])
    ]);
  }

  function check(key, label, checked, onChange) {
    return h('label', { class: 'check' }, [
      h('input', { type: 'checkbox', 'data-key': key, checked: checked, on: { change: function (e) { onChange(e.target.checked); } } }),
      h('span', { text: label })
    ]);
  }

  function radio(key, name, label, checked, onPick) {
    return h('label', { class: 'radio' }, [
      h('input', { type: 'radio', name: name, 'data-key': key, checked: checked, on: { change: function () { onPick(); } } }),
      h('span', { text: label })
    ]);
  }

  // Ligne « champ + supprimer ».
  function listRow(field, removeKey, onRemove) {
    return h('div', { class: 'row list-row' }, [
      field,
      h('button', { class: 'btn btn-ghost btn-icon', type: 'button', 'data-key': removeKey, 'aria-label': 'Supprimer', title: 'Supprimer', on: { click: onRemove } }, '×')
    ]);
  }

  function textField(key, value, placeholder, label, onInput) {
    return h('input', {
      type: 'text', class: 'fill', 'data-key': key, placeholder: placeholder, 'aria-label': label, value: value,
      on: { input: function (e) { onInput(e.target.value); } }
    });
  }

  // ── Focus : conservé d'un rendu à l'autre (champs et boutons repérés par data-key) ──

  function snapshotFocus() {
    var a = document.activeElement;
    if (!a || !app.contains(a) || !a.hasAttribute || !a.hasAttribute('data-key')) return null;
    var pos = null;
    try { if (typeof a.selectionStart === 'number') pos = [a.selectionStart, a.selectionEnd]; } catch (e) { pos = null; }
    return { key: a.getAttribute('data-key'), pos: pos, inFoot: !!(a.closest && a.closest('.wiz-foot')) };
  }

  function restoreFocus(snap) {
    if (!snap) return;
    var root = snap.inFoot ? refs.foot : refs.body;
    var el = root.querySelector('[data-key="' + snap.key + '"]');
    if (!el) return;
    el.focus();
    if (snap.pos && typeof el.setSelectionRange === 'function') {
      try { el.setSelectionRange(snap.pos[0], snap.pos[1]); } catch (e) { /* champ sans sélection */ }
    }
  }

  // ── Rendu ─────────────────────────────────────────────────────────────────

  function buildFrame() {
    refs.label = h('span');
    refs.progress = h('i');
    refs.body = h('div', { class: 'wiz-body' }, [h('p', { text: 'Lecture de la configuration…' })]);
    refs.notice = h('div', { class: 'wiz-notice' });
    refs.foot = h('div', { class: 'wiz-foot' });
    app.textContent = '';
    app.appendChild(h('div', { class: 'wiz' }, [
      h('div', { class: 'wiz-head' }, [h('div', { class: 'wiz-label' }, [refs.label]), h('div', { class: 'progress' }, [refs.progress])]),
      refs.body,
      refs.notice,
      refs.foot
    ]));
  }

  function render() {
    if (!model) return;
    var info = model.stepInfo();
    var snap = snapshotFocus();
    var changedStep = bodyStep !== info.id;
    refs.label.textContent = info.text;
    refs.progress.style.width = Math.round(info.progress * 100) + '%';
    // L'étape Thème garde son contenu tant qu'on y reste : le sélecteur n'est pas recréé à chaque rendu.
    if (changedStep || info.id !== 'theme') renderBody(info.id);
    refs.notice.textContent = '';
    if (model.state.stepError) append(refs.notice, [notice(model.state.stepError, 'error')]);
    renderFooter();
    if (changedStep) {
      var heading = refs.body.querySelector('h2');
      if (heading) heading.focus({ preventScroll: true });
    }
    restoreFocus(snap);
    if (pendingFocus) {
      var target = app.querySelector('[data-key="' + pendingFocus + '"]');
      pendingFocus = null;
      if (target) target.focus();
    }
    if (info.id === 'theme' && !chooserMounted) mountChooser();
  }

  function renderBody(id) {
    refs.body.textContent = '';
    append(refs.body, RENDERERS[id](model.state));
    bodyStep = id;
    chooserMounted = false;
  }

  function renderFooter() {
    var f = model.footer();
    refs.foot.textContent = '';
    if (f.cancel.visible) {
      append(refs.foot, [h('button', { class: 'btn btn-ghost', type: 'button', 'data-key': 'cancel', on: { click: closeWindow } }, 'Annuler')]);
    }
    append(refs.foot, [h('span', { class: 'spacer' })]);
    if (f.back.visible) {
      append(refs.foot, [h('button', { class: 'btn', type: 'button', 'data-key': 'back', disabled: f.back.disabled, on: { click: goBack } }, 'Précédent')]);
    }
    append(refs.foot, [h('button', { class: 'btn btn-primary', type: 'button', 'data-key': 'primary', disabled: f.primary.disabled, on: { click: function () { runAction(f.primary.action); } } }, f.primary.label)]);
  }

  // ── Étapes (contenu) ──────────────────────────────────────────────────────

  function isChosen(s, r) {
    return !!s.weather && s.weather.lat === r.lat && s.weather.lon === r.lon;
  }

  function coordsLine(r) {
    return Number(r.lat).toFixed(4) + ', ' + Number(r.lon).toFixed(4) + ' · ' + (r.timezone || 'fuseau inconnu');
  }

  function addOwnerDraft() {
    if (!trimmed(ownerDraft)) return;
    model.addOwner(ownerDraft);
    ownerDraft = '';
    pendingFocus = 'owner-draft';
    render();
  }

  var RENDERERS = {
    welcome: function (s) {
      var nodes = [stepTitle(
        s.editing ? 'Réglages de Claude Dojo' : 'Bienvenue dans Claude Dojo',
        s.editing
          ? "Tu modifies la configuration existante. Rien n'est écrit tant que tu n'as pas validé la dernière étape."
          : "Claude Dojo affiche sur ton bureau la météo, ton agenda, l'état de tes dépôts GitHub et de tes projets. Cet assistant prépare tout en quelques minutes."
      )];
      nodes.push(h('ul', { class: 'checklist' }, [
        h('li', { text: 'Dépendances : Node.js et des outils optionnels' }),
        h('li', { text: 'Météo, GitHub, projets et calendriers' }),
        h('li', { text: "Intégration à Claude Code (hooks, barre de statut)" }),
        h('li', { text: "Démarrage automatique à l'ouverture de session" })
      ]));
      if (s.loadError) nodes.push(notice("Lecture de l'état impossible : " + s.loadError, 'error'));
      return nodes;
    },

    dependencies: function (s) {
      var nodes = [stepTitle('Dépendances', 'Node.js 18 ou plus récent est requis. Les outils suivants sont optionnels.')];
      if (s.loadError) nodes.push(notice(s.loadError, 'error'));
      nodes.push(statusRow('Node.js', M.nodeDetail(s.detect && s.detect.node), s.nodeOk, false));
      if (!s.nodeOk) {
        nodes.push(h('div', { class: 'row' }, [
          h('button', { class: 'btn btn-primary', type: 'button', 'data-key': 'node-install', on: { click: openNodeSite } }, 'Installer Node.js LTS'),
          h('span', { class: 'muted' }, ['ou dans un terminal : ', h('code', { text: 'winget install OpenJS.NodeJS.LTS' })])
        ]));
      }
      nodes.push(h('h3', { text: 'Optionnels' }));
      nodes.push(statusRow('gh (GitHub CLI)',
        s.ghInstalled ? (s.ghAuthed ? 'connecté' : 'installé, non connecté') : 'pour les dépôts GitHub',
        s.ghInstalled && s.ghAuthed, true));
      if (s.ghInstalled && !s.ghAuthed) {
        nodes.push(h('p', { class: 'hint' }, ['Connexion : lance ', h('code', { text: 'gh auth login' }), ' dans un terminal.']));
      }
      nodes.push(statusRow('claude (Claude Code)', s.claudeFound ? 'installé' : 'non installé', s.claudeFound, true));
      return nodes;
    },

    weather: function (s) {
      var busy = s.geoBusy;
      var nodes = [stepTitle('Météo', 'Ville des prévisions affichées sur le fond. Étape facultative.')];
      nodes.push(h('div', { class: 'row' }, [
        h('input', {
          type: 'text', class: 'fill', 'data-key': 'city', placeholder: 'Ville, ex. Paris', 'aria-label': 'Ville', value: s.city,
          on: {
            input: function (e) { model.setCity(e.target.value); render(); },
            keydown: function (e) { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); geocode(); } }
          }
        }),
        h('button', { class: 'btn', type: 'button', 'data-key': 'geo-search', disabled: !trimmed(s.city) || busy, on: { click: geocode } }, 'Rechercher')
      ]));
      if (busy) nodes.push(h('div', { class: 'row muted' }, [h('span', { class: 'spinner' }), 'Recherche…']));
      if (s.geoError) nodes.push(notice(s.geoError, 'error'));
      s.geoResults.forEach(function (r, i) {
        var chosen = isChosen(s, r);
        nodes.push(h('button', {
          class: 'choice', type: 'button', 'data-key': 'geo-' + i, 'aria-pressed': chosen ? 'true' : 'false',
          on: { click: function () { model.chooseWeather(r); render(); } }
        }, [
          h('span', { class: 'dot ' + (chosen ? 'ok' : 'opt'), 'aria-hidden': 'true' }),
          h('span', { class: 'choice-text' }, [h('span', { text: M.geoLabel(r) }), h('small', { text: coordsLine(r) })])
        ]));
      });
      nodes.push(h('hr'));
      if (s.weather) {
        nodes.push(notice(M.weatherChoiceText(s.weather), 'ok'));
        nodes.push(h('div', { class: 'row' }, [
          h('button', { class: 'btn btn-ghost', type: 'button', 'data-key': 'weather-clear', on: { click: function () { model.clearWeather(); render(); } } }, 'Ne pas afficher la météo')
        ]));
      } else {
        nodes.push(notice('Aucune ville choisie : la météo ne sera pas affichée.'));
      }
      return nodes;
    },

    github: function (s) {
      var nodes = [stepTitle('GitHub', 'Comptes ou organisations dont Dojo suit les dépôts (pull requests, dépôts à jour). Facultatif.')];
      nodes.push(h('div', { class: 'row' }, [
        h('input', {
          type: 'text', class: 'fill', 'data-key': 'owner-draft', placeholder: 'login ou organisation', 'aria-label': 'Login ou organisation GitHub', value: ownerDraft,
          on: {
            input: function (e) { ownerDraft = e.target.value; render(); },
            keydown: function (e) { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); addOwnerDraft(); } }
          }
        }),
        h('button', { class: 'btn', type: 'button', 'data-key': 'owner-add', disabled: !trimmed(ownerDraft), on: { click: addOwnerDraft } }, 'Ajouter')
      ]));
      s.owners.forEach(function (o, i) {
        nodes.push(listRow(
          textField('owner-' + i, o, '', 'Propriétaire ' + (i + 1), function (v) { model.setOwner(i, v); render(); }),
          'owner-rm-' + i,
          function () { model.removeOwner(i); render(); }
        ));
      });
      if (!s.owners.length) nodes.push(notice('Aucun propriétaire : les dépôts GitHub ne seront pas suivis.'));
      return nodes;
    },

    projects: function (s) {
      var nodes = [stepTitle('Projets', 'Dossiers racines où Dojo cherche tes dépôts Git. Facultatif : sans dossier, Dojo utilise ses emplacements usuels.')];
      s.roots.forEach(function (r, i) {
        nodes.push(listRow(
          textField('root-' + i, r, '', 'Dossier ' + (i + 1), function (v) { model.setRoot(i, v); render(); }),
          'root-rm-' + i,
          function () { model.removeRoot(i); render(); }
        ));
      });
      nodes.push(h('div', { class: 'row' }, [
        h('button', { class: 'btn', type: 'button', 'data-key': 'pick-folder', on: { click: pickFolder } }, 'Ajouter un dossier…')
      ]));
      nodes.push(check('only-owners', 'Ne montrer que les dépôts des propriétaires GitHub suivis', s.onlyOwners, function (v) {
        model.setOptions({ onlyOwners: v });
        render();
      }));
      return nodes;
    },

    calendars: function (s) {
      var nodes = [stepTitle('Calendriers', 'Adresses ICS de tes agendas (https:// ou webcal://). Facultatif. Dans Google Agenda : Paramètres, puis ton agenda, puis Adresse secrète au format iCal.')];
      s.calendars.forEach(function (c, i) {
        var err = M.calendarError(c);
        nodes.push(h('div', { class: 'stack-sm' }, [
          listRow(
            textField('cal-' + i, c, 'https://…', 'Adresse du calendrier ' + (i + 1), function (v) { model.setCalendar(i, v); render(); }),
            'cal-rm-' + i,
            function () { model.removeCalendar(i); render(); }
          ),
          err ? h('div', { class: 'field-error', role: 'alert', text: err }) : null
        ]));
      });
      nodes.push(h('div', { class: 'row' }, [
        h('button', {
          class: 'btn', type: 'button', 'data-key': 'cal-add',
          on: { click: function () { model.addCalendar(); pendingFocus = 'cal-' + (model.state.calendars.length - 1); render(); } }
        }, 'Ajouter un calendrier')
      ]));
      if (!s.calendars.length) nodes.push(notice("Aucun calendrier : l'agenda ne sera pas affiché."));
      return nodes;
    },

    claude: function (s) {
      var p = s.preview;
      var nodes = [stepTitle('Claude Code', "Ce que Dojo ajoute à ~/.claude/settings.json. L'aperçu ci-dessous montre les modifications avant application.")];
      if (!s.claudeFound) nodes.push(notice('Claude Code introuvable : la configuration sera écrite quand même.', 'warn'));
      nodes.push(check('cb-hooks', "Hooks Dojo (suivi de session et d'activité)", s.hooks, function (v) { setOptions({ hooks: v }); }));
      nodes.push(h('h3', { text: 'Barre de statut' }));
      nodes.push(h('div', { class: 'radios', role: 'radiogroup', 'aria-label': 'Barre de statut' },
        STATUS_OPTIONS.map(function (opt) {
          return radio('sl-' + opt.value, 'statusline', opt.label, s.statusLine === opt.value, function () { setOptions({ statusLine: opt.value }); });
        })));
      nodes.push(check('cb-heavy', 'Heavy-gate : empêche Claude Code de lancer trop de suites de tests/builds en parallèle', s.heavyGate, function (v) { setOptions({ heavyGate: v }); }));
      if (s.heavyGate && p.heavyLimits) {
        nodes.push(h('p', { class: 'hint', text: 'Seuils automatiques pour ce PC : ' + p.heavyLimits.suites + ' suites en parallèle · ' + p.heavyLimits.nodes + ' processus node' }));
      }
      nodes.push(check('cb-vitest', 'VITEST_MAX_WORKERS : limite le nombre de workers de tests', s.vitestWorkers, function (v) { setOptions({ vitestWorkers: v }); }));
      nodes.push(h('h3', { text: 'Aperçu des modifications' }));
      if (p.error) nodes.push(notice(p.error, 'error'));
      nodes.push(h('div', { class: 'preview' }, previewContent(p)));
      return nodes;
    },

    autostart: function (s) {
      var nodes = [stepTitle('Démarrage automatique', "Dojo se lance à l'ouverture de session Windows (clé Exécuter de l'utilisateur, aucun droit administrateur requis).")];
      nodes.push(check('cb-autostart', "Lancer Dojo à l'ouverture de session", s.autostart, function (v) {
        model.setOptions({ autostart: v });
        render();
      }));
      if (!s.autostart) nodes.push(notice("Désactivé : Dojo reste disponible via l'icône de la zone de notification et se relance à la main."));
      return nodes;
    },

    theme: function (s) {
      var nodes = [stepTitle('Thème', "Couleurs, vocabulaire et personnages du dojo. Le thème et le fond sont appliqués à la dernière étape, et modifiables ensuite depuis l'icône de la zone de notification.")];
      if (s.chooserAvailable) nodes.push(h('div', { class: 'theme-host', 'data-theme-host': true }));
      else nodes.push(notice(CHOOSER_ERROR, 'warn'));
      return nodes;
    },

    done: function (s) {
      var nodes = [stepTitle(
        s.applied ? 'Terminé' : 'Prêt à appliquer',
        s.applied ? "Dojo est configuré et le fond d'écran est lancé." : "Vérifie le récapitulatif, puis applique. Rien n'est modifié avant ce clic."
      )];
      nodes.push(h('div', { class: 'summary' }, model.summaryLines(s.themeSelection).map(function (line) {
        return h('div', { class: 'summary-line', text: '• ' + line });
      })));
      if (s.applyError) nodes.push(notice(s.applyError, 'error'));
      if (s.log.length) nodes.push(h('div', { class: 'log' }, s.log.map(function (line) { return h('div', { text: line }); })));
      return nodes;
    }
  };

  // Contenu de l'aperçu : état d'attente, erreur, lignes de changement puis diff brut.
  function previewContent(p) {
    if (!p.loaded) return [h('span', { class: 'muted', text: "Calcul de l'aperçu…" })];
    if (p.error) return [h('span', { class: 'muted', text: 'Aperçu indisponible.' })];
    var out = p.changes.map(function (line) { return h('div', { class: 'change', text: line }); });
    if (p.changes.length) out.push(h('hr'));
    out.push(h('pre', { text: p.diff ? p.diff : 'Aucune modification.' }));
    return out;
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  function closeWindow() {
    Promise.resolve().then(function () { return dojo.close(); }).catch(function () { /* fenêtre déjà fermée */ });
  }

  function openNodeSite() {
    dojo.openUrl('https://nodejs.org/').catch(function (err) {
      model.setStepError(messageOf(err));
      render();
    });
  }

  function geocode() {
    var query = trimmed(model.state.city);
    if (!query || model.state.geoBusy) return;
    var seq = ++geoSeq;
    model.geoStart();
    render();
    dojo.call('geocode', [query]).then(function (res) {
      if (seq === geoSeq) model.setGeoResults(res && res.results, query);
    }, function (err) {
      if (seq === geoSeq) model.setGeoError(messageOf(err));
    }).then(function () {
      if (seq === geoSeq && model.stepInfo().id === 'weather') render();
    });
  }

  function pickFolder() {
    dojo.native('pickFolder').then(function (res) {
      if (res && res.path) model.addRoot(res.path);
      model.setStepError(null);
      render();
    }, function (err) {
      model.setStepError(messageOf(err));
      render();
    });
  }

  function setOptions(partial) {
    model.setOptions(partial);
    render();
    schedulePreview(300);
  }

  function schedulePreview(delay) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, delay);
  }

  // Aperçu settings.json (merge-settings dryRun, rien n'est écrit). Une réponse périmée est ignorée.
  function refreshPreview() {
    previewTimer = null;
    var seq = ++previewSeq;
    var call = model.previewCall();
    dojo.call(call.cmd, call.args, { stdin: call.stdin }).then(function (res) {
      if (seq !== previewSeq) return;
      model.setPreview(M.previewFromResult(res));
      if (model.stepInfo().id === 'claude') render();
    }, function (err) {
      if (seq !== previewSeq) return;
      model.setPreviewError(messageOf(err));
      if (model.stepInfo().id === 'claude') render();
    });
  }

  // Thème : le sélecteur est monté une fois par visite de l'étape ; son choix est lu avant de quitter l'étape.
  function mountChooser() {
    chooserMounted = true;
    var host = refs.body.querySelector('[data-theme-host]');
    if (!host) return;
    try {
      var inst = window.DojoThemeChooser.mount(host, {
        embedded: true,
        initial: model.state.themeSelection || model.state.themeInitial,
        onChange: function () {}
      });
      if (!inst || typeof inst.getSelection !== 'function') throw new Error('getSelection absent');
      chooser = inst;
    } catch (err) {
      chooser = null;
      model.state.chooserAvailable = false;
      host.parentNode.replaceChild(notice(CHOOSER_ERROR, 'warn'), host);
    }
  }

  // Lit le choix du sélecteur avant de changer d'étape. false : erreur affichée, on reste sur l'étape.
  function captureTheme() {
    if (!chooser) return true;
    try {
      model.setThemeSelection(chooser.getSelection());
      return true;
    } catch (err) {
      model.setStepError('Sélection du thème illisible : ' + messageOf(err));
      return false;
    }
  }

  function goNext() {
    if (!model.canGoNext()) return;
    if (model.stepInfo().id === 'theme' && !captureTheme()) { render(); return; }
    if (model.next()) {
      chooser = null;
      if (model.stepInfo().id === 'claude') schedulePreview(0);
      render();
    }
  }

  function goBack() {
    if (!model.canGoBack()) return;
    if (model.stepInfo().id === 'theme' && !captureTheme()) { render(); return; }
    if (model.back()) {
      chooser = null;
      if (model.stepInfo().id === 'claude') schedulePreview(0);
      render();
    }
  }

  function startApply() {
    var run = model.startApply(model.state.themeSelection);
    if (!run) return;
    render();
    M.runPlan(run.plan, execStep, run.from, function (step) {
      model.addLog(step.label);
      render();
    }).then(function (res) {
      model.finishApply(res.ok, res.error, res.index);
      render();
    });
  }

  // Une étape du plan : commande du sélecteur (stdin pour le JSON) ou action native.
  function execStep(step) {
    if (step.native) return dojo.native(step.native, step.payload || {});
    return dojo.call(step.cmd, step.args || [], step.stdin !== undefined ? { stdin: step.stdin } : undefined);
  }

  function runAction(action) {
    if (action === 'next') goNext();
    else if (action === 'apply') startApply();
    else if (action === 'close') closeWindow();
  }

  // Entrée = action par défaut (Suivant, Appliquer, Fermer). Les boutons, cases et le sélecteur de thème gardent leur propre Entrée.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing || !model) return;
    var t = e.target;
    var tag = t && t.tagName ? t.tagName : '';
    if (['BUTTON', 'A', 'SELECT', 'TEXTAREA'].indexOf(tag) >= 0) return;
    if (tag === 'INPUT' && ['checkbox', 'radio', 'button', 'submit'].indexOf(t.type) >= 0) return;
    if (t.closest && t.closest('[data-theme-host]')) return;
    var action = model.defaultAction();
    if (!action) return;
    e.preventDefault();
    runAction(action);
  });

  // ── Démarrage ─────────────────────────────────────────────────────────────

  function chooserReady() {
    return !!(window.DojoThemeChooser && typeof window.DojoThemeChooser.mount === 'function');
  }

  function boot() {
    buildFrame();
    Promise.all([
      dojo.call('detect').then(function (res) { return { res: res }; }, function (err) { return { error: messageOf(err) }; }),
      dojo.native('autostart.get').catch(function () { return null; }),
      dojo.call('themes').catch(function () { return null; })
    ]).then(function (r) {
      var det = r[0];
      var auto = r[1];
      var themes = r[2];
      model = M.createWizard({
        detect: det.error ? null : det.res,
        loadError: det.error || null,
        autostart: !!(auto && auto.enabled),
        chooserAvailable: chooserReady(),
        activeTheme: themes ? themes.theme : undefined,
        activeBackground: themes ? (themes.background || null) : undefined,
        autoDownload: themes && typeof themes.autoDownload === 'boolean' ? themes.autoDownload : undefined
      });
      render();
    });
  }

  boot();
})();
