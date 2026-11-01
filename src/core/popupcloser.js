/*
 * better z.ai — Popap bağlayıcı.
 *
 * Vəzifəsi: z.ai-in öz-özünə açdığı axsayan popapları ("Currently in peak
 * hours" və s.) avtomatik bağlamaq. Açar-söz siyahısı istifadəçi tərəfindən
 * ayarlar səhifəsində redaktə olunur.
 *
 * TƏHLÜKƏSİZLİK QAYDALARI:
 *   1. Parol (input[type=password]) olan dialoq HEÇ VAXT bağlanmır.
 *   2. Yalnız açar-sözlərdən birinə uyğun mətnli pəncərələrə toxunulur.
 *   3. Mətn daxiletmə sahəsi olan (və "bağla" düyməsi olmayan) pəncərələr
 *      toxunulmaz qalır — istifadəçi məlumat itirməsin.
 *   4. Dövrə qoruyucusu: eyni element 30 saniyədə 3 dəfədən çox açılırsa
 *      müdaxilə dayandırılır (saytla müharibə etmirik).
 *
 * ISOLATED world content script kimi işləyir; Node vm-də yalnız saf qərar
 * hissəsi (PC.decide) yüklənir (unit testlər üçün).
 */
(function (root) {
  'use strict';
  var PC = root.__zaiExtPopupCloser = root.__zaiExtPopupCloser || {};

  PC.WINDOWS = {
    scan: 900,          // təhlükəsizlik ehtiyat skan intervalı
    step: 220,          // bağlama kaskadının addım gözləməsi
    maxCloses: 3,       // eyni element üçün maksimum bağlama cəhdi
    closeWindow: 30000, // dövrə qoruyucusu pəncərəsi
    textCap: 600        // oxunan mətn limiti
  };

  /* "bağla / sonra / keç" mənalı düymə mətnləri */
  PC.DISMISS_RE = /^(close|bağla|×|✕|x|later|sonra|not now|maybe later|skip|keç|dismiss|got it|anladım|tamam)$/i;

  /*
   * SAF QƏRAR FUNKSIYASI (unit-test olunur).
   * st: { enabled, text, patterns[], hasPassword, hasTextInput, hasDismissBtn }
   * → 'close' | 'keep'
   */
  PC.decide = function (st) {
    st = st || {};
    if (!st.enabled) return 'keep';
    if (st.hasPassword) return 'keep';          // giriş/təsdiq formu — heç vaxt
    var t = String(st.text || '');
    if (!t) return 'keep';
    var hit = false;
    var pats = st.patterns || [];
    for (var i = 0; i < pats.length; i++) {
      var p = String(pats[i] || '').trim();
      if (p && t.toLowerCase().indexOf(p.toLowerCase()) >= 0) { hit = true; break; }
    }
    if (!hit) return 'keep';                    // açar söz yoxdur → bizim işimiz deyil
    if (st.hasDismissBtn) return 'close';
    if (!st.hasTextInput) return 'close';       // məlumat pəncərəsi → Escape ilə bağla
    return 'keep';                              // input var, düymə yoxdur → toxunma
  };

  /* ============ DOM hissəsi (yalnız brauzerdə) ============ */
  if (typeof document === 'undefined' || !document) return;

  var hooks = null;        // { getSettings, log, onBlocked }
  var started = false;
  var seen = null;         // Map: bu skanda görünən elementlər
  var closeStats = null;   // WeakMap: element -> { n, first }
  var scanTimer = null;

  var SEL = [
    '[role="dialog"]', '[aria-modal="true"]', 'dialog[open]', '[data-state="open"]',
    '[class*="modal"]', '[class*="Modal"]', '[class*="dialog"]', '[class*="Dialog"]',
    '[class*="popup"]', '[class*="Popup"]', '[class*="overlay"]', '[class*="Overlay"]'
  ].join(',');

  /* mətn daxiletmə sahələri (düymə/bayraq tipləri xaric) */
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
            /close|bağla|later|sonra|skip|keç/i.test(cls)) {
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
      if (!visibleEl(el)) return; // artıq bağlıdır
      if (step === 0) {
        var now = Date.now();
        var st = closeStats.get(el);
        if (!st || now - st.first > PC.WINDOWS.closeWindow) st = { n: 0, first: now };
        st.n += 1;
        closeStats.set(el, st);
        if (st.n > PC.WINDOWS.maxCloses) {
          if (hooks && hooks.log) hooks.log('popap təkrar açılır — müdaxilə dayandırıldı');
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
        if (hooks && hooks.log) hooks.log('popap məcburi gizlədildi');
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
        seen = new Map(); // parametr söndürüldü → yandıqda təzədən işləsin
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
            hooks.log('popap bağlandı (' + String(text).replace(/\s+/g, ' ').trim().slice(0, 40) + ')');
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
