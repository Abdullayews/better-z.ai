/*
 * better z.ai — draft helpers.
 * Pure functions — shared by the content script (ISOLATED) and Node vm unit tests.
 */
(function (root) {
  'use strict';
  var D = root.__zaiExtDrafts = root.__zaiExtDrafts || {};

  /* Page path -> draft key (z.ai chats are /c/<id>; overly long paths are truncated) */
  D.key = function (pathname) {
    var p = String(pathname || '/');
    if (p.length > 120) p = p.slice(0, 120);
    return p;
  };

  /* Is the draft fresh? (maxAgeH hours; now is passed for tests) */
  D.fresh = function (d, maxAgeH, now) {
    if (!d || typeof d.at !== 'number') return false;
    now = typeof now === 'number' ? now : Date.now();
    var max = (Number(maxAgeH) || 72) * 3600000;
    return now - d.at <= max && now - d.at >= -60000;
  };

  /* Drops the oldest drafts when the limit is exceeded */
  D.prune = function (map, limit, now) {
    now = typeof now === 'number' ? now : Date.now();
    limit = Number(limit) || 20;
    var keys = Object.keys(map || {});
    if (keys.length <= limit) return map;
    keys.sort(function (a, b) { return (map[a].at || 0) - (map[b].at || 0); });
    while (keys.length > limit) delete map[keys.shift()];
    return map;
  };

  /* Age label like "5 min", "3 h" */
  D.ageLabel = function (d, now) {
    if (!d || typeof d.at !== 'number') return '';
    now = typeof now === 'number' ? now : Date.now();
    var mins = Math.max(0, Math.floor((now - d.at) / 60000));
    if (mins < 1) return 'now';
    if (mins < 60) return mins + ' min';
    var h = Math.floor(mins / 60);
    if (h < 24) return h + ' h';
    return Math.floor(h / 24) + ' d';
  };
})(typeof self !== 'undefined' ? self : globalThis);
