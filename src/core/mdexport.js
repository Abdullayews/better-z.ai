/*
 * better z.ai — Söhbətin Markdown ixracı.
 * Saf funksiya: /api/v1/chats/{id} cavabındakı tarixçəni Markdown sənədinə
 * çevirir. Node vm-də unit-test olunur, content script-də istifadə olunur.
 */
(function (root) {
  'use strict';
  var MD = root.__zaiExtMdExport = root.__zaiExtMdExport || {};

  /*
   * history.currentId-dən parentId zənciri ilə kökə qalxıb tərsinə çevirir →
   * xronoloji sıra. Zəncir pozulubsa (köhnə format) timestamp sırasına düşür.
   * Dövrə qorunması: eyni id iki dəfə ziyarət olunmur, maksimum 1000 mesaj.
   */
  MD.orderMessages = function (history) {
    var msgs = (history && history.messages) || {};
    var out = [];
    var cur = history && history.currentId;
    var seenIds = {};
    while (cur && msgs[cur] && !seenIds[cur] && out.length < 1000) {
      seenIds[cur] = 1;
      out.push(msgs[cur]);
      cur = msgs[cur].parentId;
    }
    out.reverse();
    if (!out.length) {
      out = Object.keys(msgs).map(function (k) { return msgs[k]; })
        .sort(function (a, b) { return (a.timestamp || 0) - (b.timestamp || 0); });
    }
    return out;
  };

  /* mesaj məzmunu → mətn (string | massiv hissələr | obyekt) */
  MD.contentText = function (c) {
    if (c == null) return '';
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map(function (p) {
        if (!p) return '';
        if (p.type === 'text') return p.text || '';
        if (p.type === 'image_url') return '📎 [şəkil]';
        if (p.type === 'file_url') return '📎 [fayl]';
        if (p.type === 'video_url') return '📎 [video]';
        return '📎 [' + (p.type || 'əlavə') + ']';
      }).filter(Boolean).join('\n');
    }
    try { return JSON.stringify(c, null, 2); } catch (e) { return String(c); }
  };

  MD.buildMarkdown = function (chat, meta) {
    if (!chat || !chat.history) return null;
    var chain = MD.orderMessages(chat.history);
    if (!chain.length) return null;
    meta = meta || {};
    var lines = ['# ' + (chat.title || 'Z.ai söhbəti'), ''];
    var dateStr = '';
    try {
      dateStr = new Date(meta.date || Date.now()).toLocaleString('az-AZ');
    } catch (e) {
      dateStr = String(new Date(meta.date || Date.now()));
    }
    lines.push('> İxrac tarixi: ' + dateStr +
      (chat.models && chat.models.length ? ' · Model: ' + chat.models.join(', ') : '') +
      (meta.url ? ' · Mənbə: ' + meta.url : ''), '');
    lines.push('---', '');
    for (var i = 0; i < chain.length; i++) {
      var m = chain[i];
      if (!m) continue;
      var head = m.role === 'assistant' ? '## 🤖 Z.ai'
        : (m.role === 'system' ? '## ⚙️ Sistem' : '## 🧑 Siz');
      lines.push(head, '', MD.contentText(m.content), '');
    }
    return lines.join('\n');
  };
})(typeof self !== 'undefined' ? self : globalThis);
