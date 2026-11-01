/*
 * better z.ai — Firefox bootstrap (ISOLATED world).
 *
 * Firefox content_scripts `world: "MAIN"`-i dəstəkləmir; ona görə MAIN world
 * kodu (inject.bundle.js) bu bootstrap tərəfindən <script src> kimi səhifəyə
 * yerləşdirilir (web_accessible_resources vasitəsilə — CSP problemi yoxdur:
 * chat.z.ai CSP başlığı/metası yoxdur, yoxlanıldı).
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
