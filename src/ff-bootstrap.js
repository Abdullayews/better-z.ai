/*
 * better z.ai — Firefox bootstrap (ISOLATED world).
 *
 * Firefox content_scripts does not support `world: "MAIN"`; therefore the MAIN
 * world code (inject.bundle.js) is placed into the page by this bootstrap as
 * a <script src> (via web_accessible_resources — no CSP problem:
 * chat.z.ai has no CSP header/meta, verified).
 */
(function () {
  'use strict';
  try {
    if (document.getElementById('zai-ext-inject-tag')) return;
    var api = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;
    var s = document.createElement('script');
    s.id = 'zai-ext-inject-tag';
    s.src = api.runtime.getURL('inject.bundle.js');
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
  } catch (e) { /* ignore */ }
})();
