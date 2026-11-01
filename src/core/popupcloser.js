/*
 * better z.ai — popup closer.
 *
 * Purpose: automatically close the nag popups z.ai opens on its own
 * ("Currently in peak hours" etc.). The keyword list is edited by the
 * user on the settings page.
 *
 * SAFETY RULES:
 *   1. A dialog with a password field (input[type=password]) is NEVER closed.
 *   2. Only windows whose text matches one of the keywords are touched.
 *   3. Windows with a text input (and no close button) stay
 *      untouched — the user must not lose data.
 *   4. Loop guard: if the same element opens more than 3 times in 30 s
 *      intervention stops (we don't fight the site).
 *
 * Runs as an ISOLATED world content script; in Node vm only the pure
 * decision part (PC.decide) is loaded (for unit tests).
 */
(function (root) {
  'use strict';
  var PC = root.__zaiExtPopupCloser = root.__zaiExtPopupCloser || {};

  PC.WINDOWS = {
    scan: 900,          // safety-margin scan interval
    step: 220,          // close-cascade step wait
    maxCloses: 3,       // max close attempts per element
    closeWindow: 30000, // loop-guard window
    textCap: 600        // read-text limit
  };

  /* button texts meaning "close / later / skip" */
  PC.DISMISS_RE = /^(close|×|✕|x|later|not now|maybe later|skip|dismiss|got it)$/i;

  /*
   * PURE DECISION FUNCTION (unit-tested).
   * st: { enabled, text, patterns[], hasPassword, hasTextInput, hasDismissBtn }
   * → 'close' | 'keep'
   */
  PC.decide = function (st) {
    st = st || {};
    if (!st.enabled) return 'keep';
    if (st.hasPassword) return 'keep';          // login/confirmation form — never
    var t = String(st.text || '');
    if (!t) return 'keep';
    var hit = false;
    var pats = st.patterns || [];
    for (var i = 0; i < pats.length; i++) {
      var p = String(pats[i] || '').trim();
      if (p && t.toLowerCase().indexOf(p.toLowerCase()) >= 0) { hit = true; break; }
    }
    if (!hit) return 'keep';                    // no keyword hit → not our business
    if (st.hasDismissBtn) return 'close';
    if (!st.hasTextInput) return 'close';       // info window → close via Escape
    return 'keep';                              // has input, no button → hands off
  };

  /* ============ DOM part (browser only) ============ */
  if (typeof document === 'undefined' || !document) return;

  var hooks = null;        // { getSettings, log, onBlocked }
  var started = false;
  var seen = null;         // Map: elements seen in this scan
  var closeStats = null;   // WeakMap: element -> { n, first }
  var scanTimer = null;

  var SEL = [
    '[role="dialog"]', '[aria-modal="true"]', 'dialog[open]', '[data-state="open"]',
    '[class*="modal"]', '[class*="Modal"]', '[class*="dialog"]', '[class*="Dialog"]',
    '[class*="popup"]', '[class*="Popup"]', '[class*="overlay"]', '[class*="Overlay"]'
  ].join(',');

  /* text input areas (button/checkbox types excluded) */
  var INPUT_SEL = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio])' +
    ':not([type=file]):not([type=button]):not([type=submit]):not([type=image]):not([type=password]), textarea, select';

  function visibleEl(el) {
    try {
      if (!el || !el.isConnected) return false;
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (parseFloat(cs.opacity) === 0) return false;
      var r = el.getBoundingClientRect();
      return r.width > 24 && r.height > 24;
    } catch (e) { return false; }
  }

  function isOverlayish(el) {
    try {
      if (el.tagName === 'DIALOG' && el.open) return true;
      if (el.getAttribute('aria-modal') === 'true') return true;
      if (el.getAttribute('role') === 'dialog') return true;
      if (el.getAttribute('data-state') === 'open') return true;
      var cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
      var r = el.getBoundingClientRect();
      var area = (window.innerWidth * window.innerHeight) || 1;
      var covers = (r.width * r.height) >= area * 0.25;
      var z = parseInt(cs.zIndex, 10) || 0;
      return covers || z >= 400;
    } catch (e) { return false; }
  }

  function findDismissButton(el) {
    try {
      var btns = el.querySelectorAll('button, [role="button"]');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        var aria = (b.getAttribute('aria-label') || '').trim();
        var tx = (b.innerText || b.textContent || '').trim();
        var cls = (typeof b.className === 'string' ? b.className : '');
        if (PC.DISMISS_RE.test(aria) || PC.DISMISS_RE.test(tx) ||
            /close|later|skip|dismiss/i.test(cls)) {
          if (b.offsetParent !== null || visibleEl(b)) return b;
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function pressEscape(el) {
    try {
      var opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      document.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      document.dispatchEvent(new KeyboardEvent('keyup', opts));
    } catch (e) { /* ignore */ }
  }

  function forceHide(el) {
    try {
      el.style.setProperty('display', 'none', 'important');
      el.setAttribute('data-zai-popup-guard', 'hidden');
    } catch (e) { /* ignore */ }
  }

  function closePopup(el, btn, step) {
    try {
      if (!el || !el.isConnected) return;
      if (!visibleEl(el)) return; // already closed
      if (step === 0) {
        var now = Date.now();
        var st = closeStats.get(el);
        if (!st || now - st.first > PC.WINDOWS.closeWindow) st = { n: 0, first: now };
        st.n += 1;
        closeStats.set(el, st);
        if (st.n > PC.WINDOWS.maxCloses) {
          if (hooks && hooks.log) hooks.log('popup reopening — intervention stopped');
          return;
        }
        if (hooks && hooks.onBlocked) { try { hooks.onBlocked(); } catch (e) { /* ignore */ } }
        if (btn) btn.click();
        else pressEscape(el);
      } else if (step === 1) {
        pressEscape(el);
      } else if (step === 2) {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      } else {
        forceHide(el);
        if (hooks && hooks.log) hooks.log('popup force-hidden');
        return;
      }
      setTimeout(function () { if (visibleEl(el)) closePopup(el, btn, step + 1); }, PC.WINDOWS.step);
    } catch (e) { /* ignore */ }
  }

  /* ---------- skan ---------- */

  function scan() {
    scanTimer = null;
    try {
      if (!hooks || !document.body) return;
      var s = hooks.getSettings();
      if (!s || !s.closePopups) {
        seen = new Map(); // setting off → start fresh when re-enabled
        return;
      }
      var els = document.querySelectorAll(SEL);
      var live = new Map();
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (!visibleEl(el)) continue;
        live.set(el, true);
        if (el.closest && el.closest('.zai-ext-pill, .zai-ext-draft, .zai-ext-fab, .zai-ext-snip')) continue;
        if (seen && seen.has(el)) continue;
        if (!isOverlayish(el)) continue;
        var text = '';
        try { text = (el.innerText || '').slice(0, PC.WINDOWS.textCap); } catch (e) { text = ''; }
        var hasPassword = false, hasTextInput = false;
        try {
          hasPassword = !!el.querySelector('input[type="password"]');
          hasTextInput = !!el.querySelector(INPUT_SEL);
        } catch (e) { /* ignore */ }
        var btn = findDismissButton(el);
        var verdict = PC.decide({
          enabled: true,
          text: text,
          patterns: s.popupPatterns || [],
          hasPassword: hasPassword,
          hasTextInput: hasTextInput,
          hasDismissBtn: !!btn
        });
        if (verdict === 'close') {
          if (hooks && hooks.log) {
            hooks.log('popup closed (' + String(text).replace(/\s+/g, ' ').trim().slice(0, 40) + ')');
          }
          closePopup(el, btn, 0);
        }
      }
      seen = live;
    } catch (e) { /* ignore */ }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(scan, 250);
  }

  /* ---------- xarici API ---------- */

  PC.init = function (h) {
    hooks = h;
    if (!seen) seen = new Map();
    if (!closeStats) closeStats = new WeakMap();
    if (started) return;
    started = true;
    try {
      var mo = new MutationObserver(scheduleScan);
      var arm = function () {
        if (!document.documentElement) { setTimeout(arm, 100); return; }
        mo.observe(document.documentElement, {
          childList: true, subtree: true,
          attributes: true,
          attributeFilter: ['open', 'data-state', 'hidden', 'aria-hidden']
        });
      };
      arm();
    } catch (e) { /* ignore */ }
    setInterval(scan, PC.WINDOWS.scan);
    scan();
  };
})(typeof self !== 'undefined' ? self : globalThis);
