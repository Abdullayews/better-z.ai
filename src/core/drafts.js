/*
 * Z.ai Auto-Resend — Qaralama (draft) köməkçiləri (v1.2.0).
 * Saf funksiyalar — content script (ISOLATED) və Node vm unit-testlərində ortaq.
 */
(function (root) {
  'use strict';
  var D = root.__zaiExtDrafts = root.__zaiExtDrafts || {};

  /* Səhifə yolu → draft açarı (z.ai söhbətləri /c/<id>; çox uzun yollar kəsilir) */
  D.key = function (pathname) {
    var p = String(pathname || '/');
    if (p.length > 120) p = p.slice(0, 120);
    return p;
  };

  /* Draft təzədir? (maxAgeH saat; now test üçün ötürülür) */
  D.fresh = function (d, maxAgeH, now) {
    if (!d || typeof d.at !== 'number') return false;
    now = typeof now === 'number' ? now : Date.now();
    var max = (Number(maxAgeH) || 72) * 3600000;
    return now - d.at <= max && now - d.at >= -60000;
  };

  /* Limiti aşanda ən köhnə draftları silir */
  D.prune = function (map, limit, now) {
    now = typeof now === 'number' ? now : Date.now();
    limit = Number(limit) || 20;
    var keys = Object.keys(map || {});
    if (keys.length <= limit) return map;
    keys.sort(function (a, b) { return (map[a].at || 0) - (map[b].at || 0); });
    while (keys.length > limit) delete map[keys.shift()];
    return map;
  };

  /* "5 dəq", "3 saat" tipli yaş etiketi */
  D.ageLabel = function (d, now) {
    if (!d || typeof d.at !== 'number') return '';
    now = typeof now === 'number' ? now : Date.now();
    var mins = Math.max(0, Math.floor((now - d.at) / 60000));
    if (mins < 1) return 'indi';
    if (mins < 60) return mins + ' dəq';
    var h = Math.floor(mins / 60);
    if (h < 24) return h + ' saat';
    return Math.floor(h / 24) + ' gün';
  };
})(typeof self !== 'undefined' ? self : globalThis);
