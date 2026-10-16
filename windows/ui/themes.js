/* Page « Thème et fond » (themes.html) : monte le sélecteur en mode fenêtre (boutons Appliquer et Fermer).
 * Le pont est dans bridge.js (window.dojo), le sélecteur dans themechooser.js. */
(function () {
  'use strict';

  var host = document.getElementById('app');
  if (!host || !window.DojoThemeChooser) {
    var message = document.createElement('div');
    message.className = 'notice notice-error';
    message.textContent = 'Thèmes indisponibles : sélecteur non chargé.';
    if (host) host.appendChild(message);
    return;
  }
  window.DojoThemeChooser.mount(host, { embedded: false });
})();
