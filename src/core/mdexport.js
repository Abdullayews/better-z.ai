/*
 * better z.ai — chat Markdown export.
 * Pure function: converts the history from the /api/v1/chats/{id} response
 * into a Markdown document. Unit-tested in Node vm, used by the content script.
 */
(function (root) {
  'use strict';
  var MD = root.__zaiExtMdExport = root.__zaiExtMdExport || {};

  /*
   * Walks the parentId chain from history.currentId up to the root, then
   * reverses it -> chronological order. If the chain is broken (old format)
   * it falls back to timestamp order.
   * Cycle safety: the same id is never visited twice, max 1000 messages.
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

  /* message content -> text (string | array of parts | object) */
  MD.contentText = function (c) {
    if (c == null) return '';
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map(function (p) {
        if (!p) return '';
        if (p.type === 'text') return p.text || '';
        if (p.type === 'image_url') return '📎 [image]';
        if (p.type === 'file_url') return '📎 [file]';
        if (p.type === 'video_url') return '📎 [video]';
        return '📎 [' + (p.type || 'attachment') + ']';
      }).filter(Boolean).join('\n');
    }
    try { return JSON.stringify(c, null, 2); } catch (e) { return String(c); }
  };

  MD.buildMarkdown = function (chat, meta) {
    if (!chat || !chat.history) return null;
    var chain = MD.orderMessages(chat.history);
    if (!chain.length) return null;
    meta = meta || {};
    var lines = ['# ' + (chat.title || 'Z.ai chat'), ''];
    var dateStr = '';
    try {
      dateStr = new Date(meta.date || Date.now()).toLocaleString('en-US');
    } catch (e) {
      dateStr = String(new Date(meta.date || Date.now()));
    }
    lines.push('> Exported: ' + dateStr +
      (chat.models && chat.models.length ? ' · Model: ' + chat.models.join(', ') : '') +
      (meta.url ? ' · Source: ' + meta.url : ''), '');
    lines.push('---', '');
    for (var i = 0; i < chain.length; i++) {
      var m = chain[i];
      if (!m) continue;
      var head = m.role === 'assistant' ? '## 🤖 Z.ai'
        : (m.role === 'system' ? '## ⚙️ System' : '## 🧑 You');
      lines.push(head, '', MD.contentText(m.content), '');
    }
    return lines.join('\n');
  };
})(typeof self !== 'undefined' ? self : globalThis);
