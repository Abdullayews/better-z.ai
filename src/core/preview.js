/*
 * Z.ai Auto-Resend — Preview Guard modulu (v1.1.0).
 *
 * Vəzifəsi: chat.z.ai tərəfindən ÖZ-ÖZÜNƏ açılan fayl/şəkil preview
 * pəncərələrini avtomatik bağlamaq. İstifadəçi kliklə açılan preview-lərə
 * toxunmur → "preview yalnız basılanda açılır".
 *
 * Aşkarlama qaydaları (prioritet sırası):
 *   1. istifadəçi media/fayl elementinə (şəkil, chip, thumbnail) klikləyib
 *      → bu, bilərəkdən açılışdır → saxla
 *   2. uğurlu completion-dən sonrakı 4 saniyədə açılıb → generasiya bitdi,
 *      sayt özü açdı → bağla
 *   3. fayl əlavəsindən (file input change) sonrakı 2.5 saniyədə açılıb → bağla
 *   4. son 2.2 saniyədə heç bir etibarlı klik yoxdur → bağla
 *   5. qalan hallar (son klik olub, pəncərələr boşdur) → saxla
 *
 * ISOLATED world content script kimi işləyir; Node vm-də yalnız saf qərar
 * hissəsi (P.decide) yüklənir (unit testlər üçün).
 */
(function (root) {
  'use strict';
  var P = root.__zaiExtPreview = root.__zaiExtPreview || {};

  /* Pəncərələmələr (ms) və limitlər */
  P.WINDOWS = {
    click: 2200,        // "son klik" pəncərəsi
    completion: 4000,   // uğurlu completion-dan sonra avto-açılış pəncərəsi
    fileChange: 2500,   // fayl əlavəsindən sonra avto-açılış pəncərəsi
    scan: 700,          // təhlükəsizlik ehtiyat skan intervalı
    step: 200,          // bağlama kaskadının addım gözləməsi
    maxCloses: 5,       // eyni element üçün maksimum bağlama cəhdi
    closeWindow: 30000  // dövrə qoruyucusu (circuit breaker) pəncərəsi
  };

  /*
   * SAF QƏRAR FUNKSIYASI (unit-test olunur).
   * st: {
   *   blockAutoPreview, now,
   *   lastClickTs, lastClickIsPreviewTrigger,
   *   lastFileChangeTs, lastCompletionOkTs
   * }
   * → 'allow' (saxla) | 'close' (avtomatik açılış sayılır → bağla)
   */
  P.decide = function (st) {
    st = st || {};
    if (!st.blockAutoPreview) return 'allow';
    var now = st.now || 0;
    var W = P.WINDOWS;
    var clickAge = (typeof st.lastClickTs === 'number' && st.lastClickTs >= 0)
      ? now - st.lastClickTs : Infinity;
    var clickKnown = clickAge >= 0;                 // gələcək zaman → naməlum, "yoxdur" deyil
    var hadClick = clickKnown && clickAge <= W.click;
    // 1) istifadəçi media/fayl elementinə klikləyib → bilərəkdən açılış
    if (hadClick && st.lastClickIsPreviewTrigger) return 'allow';
    // 2) uğurlu completion pəncərəsi
    if (typeof st.lastCompletionOkTs === 'number') {
      var cAge = now - st.lastCompletionOkTs;
      if (cAge >= 0 && cAge <= W.completion) return 'close';
    }
    // 3) fayl əlavəsi pəncərəsi
    if (typeof st.lastFileChangeTs === 'number') {
      var fAge = now - st.lastFileChangeTs;
      if (fAge >= 0 && fAge <= W.fileChange) return 'close';
    }
    // 4) klik vaxtı naməlumdur (saat uyğunsuzluğu) → toxunma
    if (!clickKnown) return 'allow';
    // 5) heç bir klik yoxdur / klik çox köhnədir → avtomatik
    if (!hadClick) return 'close';
    // 6) son klik var, pəncərələr boş → istifadəçi edib
    return 'allow';
  };

  /* ============ DOM hissəsi (yalnız brauzerdə) ============ */
  if (typeof document === 'undefined' || !document) return;

  var hooks = null;             // { getSettings, log }
  var started = false;
  var lastClickTs = null;
  var lastClickTarget = null;
  var lastFileChangeTs = null;
  var lastCompletionOkTs = null;
  var seen = null;              // Map: BU skanda görünən elementlər (bağlanan düşür →
                                // yenidən açılan modal yenidən qiymətləndirilir)
  var closeStats = null;        // WeakMap: element -> { n, first }
  var lastLogTs = 0;
  var scanTimer = null;

  var SEL = [
    '[role="dialog"]', '[aria-modal="true"]', 'dialog[open]', '[data-state="open"]',
    '[class*="modal"]', '[class*="Modal"]', '[class*="dialog"]', '[class*="Dialog"]',
    '[class*="overlay"]', '[class*="Overlay"]', '[class*="preview"]', '[class*="Preview"]',
    '[class*="lightbox"]', '[class*="Lightbox"]', '[class*="viewer"]', '[class*="Viewer"]',
    '[class*="gallery"]', '[class*="artifact"]'
  ].join(',');

  /* istifadəçinin kliklədikdə preview AÇAN elementlər (şəkil/chip/thumbnail…) */
  var TRIGGER_SEL = [
    'img', 'video', 'figure',
    'a[href]',
    '[class*="chip"]', '[class*="Chip"]', '[class*="thumb"]', '[class*="Thumb"]',
    '[class*="preview"]', '[class*="Preview"]', '[class*="image"]', '[class*="Image"]',
    '[class*="photo"]', '[class*="artifact"]', '[class*="viewer"]', '[class*="lightbox"]',
    '[data-preview]', '[data-file-url]'
  ].join(',');

  var FILE_HREF_RE = /\.(png|jpe?g|gif|webp|svg|pdf|mp4|mp3|docx?|xlsx?|pptx?|zip|txt|md|csv)([?#]|$)/i;
  var STRONG_NAME_RE = /preview|lightbox|viewer|gallery|artifact/i;
  var CLOSE_ARIA_RE = /^(close|bağla|shut|×|✕)$/i;

  function isPreviewTriggerTarget(t) {
    try {
      if (!t || !t.closest) return false;
      var el = t.closest(TRIGGER_SEL);
      if (!el) return false;
      if (el.tagName === 'IMG' || el.tagName === 'VIDEO' || el.tagName === 'FIGURE') return true;
      var href = el.getAttribute ? (el.getAttribute('href') || '') : '';
      if (href && FILE_HREF_RE.test(href)) return true;
      return true; // selektora uyğun element klikləndi
    } catch (e) { return false; }
  }

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

  function nameHint(el) {
    try {
      var cls = el.className;
      if (cls && typeof cls !== 'string') cls = cls.baseVal || '';
      return String(cls + ' ' + (el.id || '') + ' ' +
        (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('data-testid') || ''));
    } catch (e) { return ''; }
  }

  function looksLikePreview(el) {
    try {
      if (!el || !el.isConnected) return false;
      if (el.closest && el.closest('.zai-ext-pill')) return false;   // bizim HUD
      if (!isOverlayish(el)) return false;                            // yalnız overlay-lər
      if (STRONG_NAME_RE.test(nameHint(el))) return true;             // adı "preview/viewer/…"
      return !!el.querySelector('img, video, iframe, embed, object, canvas');
    } catch (e) { return false; }
  }

  /* ---------- bağlama kaskadı ---------- */

  function pressEscape(el) {
    try {
      var opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      document.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      document.dispatchEvent(new KeyboardEvent('keyup', opts));
    } catch (e) { /* ignore */ }
  }

  function clickCloseButton(el) {
    try {
      var btns = el.querySelectorAll('button, [role="button"]');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        var aria = (b.getAttribute('aria-label') || '').trim();
        var cls = (typeof b.className === 'string' ? b.className : '');
        var tx = (b.innerText || b.textContent || '').trim();
        if (CLOSE_ARIA_RE.test(aria) || /close|bağla/i.test(cls) ||
            (tx.length <= 2 && /^(×|✕|x|X)$/.test(tx))) {
          b.click();
          return true;
        }
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function clickBackdrop(el) {
    try {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch (e) { /* ignore */ }
  }

  function forceHide(el) {
    try {
      el.style.setProperty('display', 'none', 'important');
      el.setAttribute('data-zai-preview-guard', 'hidden');
    } catch (e) { /* ignore */ }
  }

  function logClose(how) {
    try {
      var now = Date.now();
      if (now - lastLogTs < 2000) return;
      lastLogTs = now;
      if (hooks && hooks.log) hooks.log('preview bloklandı (' + how + ')');
    } catch (e) { /* ignore */ }
  }

  function closeCascade(el, step) {
    try {
      if (!el || !el.isConnected) return;
      if (!visibleEl(el)) return; // artıq bağlıdır
      if (step === 0) {
        // dövrə qoruyucusu: sayt dəfələrlə yenidən açırsa müdaxiləni dayandırırıq
        var now = Date.now();
        var st = closeStats.get(el);
        if (!st || now - st.first > P.WINDOWS.closeWindow) st = { n: 0, first: now };
        st.n += 1;
        closeStats.set(el, st);
        if (st.n > P.WINDOWS.maxCloses) {
          logClose('təkrar açılır — müdaxilə dayandırıldı');
          return;
        }
        // v1.2.0: statistika üçün bloklanma sayğacı
        if (hooks && hooks.onBlocked) { try { hooks.onBlocked(); } catch (e) { /* ignore */ } }
        pressEscape(el);
      } else if (step === 1) {
        clickCloseButton(el);
      } else if (step === 2) {
        clickBackdrop(el);
      } else {
        forceHide(el);
        logClose('məcburi gizlədildi');
        return;
      }
      setTimeout(function () {
        if (visibleEl(el)) closeCascade(el, step + 1);
        else logClose(['escape', 'düymə', 'fon kliki'][step] || 'addım ' + step);
      }, P.WINDOWS.step);
    } catch (e) { /* ignore */ }
  }

  /* ---------- skan ---------- */

  function scan() {
    scanTimer = null;
    try {
      if (!hooks || !document.body) return;
      var s = hooks.getSettings();
      if (!s || !s.blockAutoPreview) {
        seen = new Map(); // parametr söndürüldü → yenidən yandıqda təzədən işləsin
        return;
      }
      var now = Date.now();
      var els = document.querySelectorAll(SEL);
      var live = new Map();   // yalnız hazırda görünənlər
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (!visibleEl(el)) continue;
        live.set(el, true);
        if (seen && seen.has(el)) continue;   // bu sessiyada artıq qiymətləndirilib
        if (!looksLikePreview(el)) continue;
        var verdict = P.decide({
          blockAutoPreview: true,
          now: now,
          lastClickTs: lastClickTs,
          lastClickIsPreviewTrigger: isPreviewTriggerTarget(lastClickTarget),
          lastFileChangeTs: lastFileChangeTs,
          lastCompletionOkTs: lastCompletionOkTs
        });
        if (verdict === 'close') closeCascade(el, 0);
      }
      // bağlanmış/gizlədilmiş elementləri siyahıdan çıxarırıq →
      // eyni modal yenidən açılanda yenidən qərar veriləcək
      seen = live;
    } catch (e) { /* ignore */ }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(scan, 250);
  }

  function startObserver() {
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
  }

  /* ---------- xarici API ---------- */

  /* content.js RESULT mesajlarından çağırılır: uğur → pəncərə silahlanır */
  P.noteResult = function (d) {
    if (d && d.outcome === 'success') lastCompletionOkTs = Date.now();
  };

  P.init = function (h) {
    hooks = h;
    if (!seen) seen = new Map();
    if (!closeStats) closeStats = new WeakMap();
    if (started) return;
    started = true;
    try {
      document.addEventListener('click', function (ev) {
        if (!ev.isTrusted) return;
        lastClickTs = Date.now();
        lastClickTarget = ev.target;
      }, true);
      document.addEventListener('change', function (ev) {
        try {
          var t = ev.target;
          if (t && t.tagName === 'INPUT' && String(t.type || '').toLowerCase() === 'file' &&
              t.files && t.files.length) {
            lastFileChangeTs = Date.now();
          }
        } catch (e) { /* ignore */ }
      }, true);
    } catch (e) { /* ignore */ }
    startObserver();
    setInterval(scan, P.WINDOWS.scan);
    scan();
  };
})(typeof self !== 'undefined' ? self : globalThis);
