# Z.ai Auto-Resend 🔁

**chat.z.ai üçün Chrome və Firefox extension-ı** — *"system is busy"* və digər göndərmə
xətalarında mesajınızı **attachment-larla birlikdə** avtomatik yenidən göndərir.

**v1.2.0 — Ağıllı köməkçi paketi:** qaralama mühafizəsi, snippet kitabxanası, söhbətin
Markdown ixracı, "peak hours" popap bağlayıcısı, "cavab hazırdır" bildirişi, qlobal
pauza, ardıcıl retry, dublikat qorunması və statistika.

> Əsas problem: chat.z.ai-də mesaj uğursuz olanda composer təmizlənir və **attachment-lar
> silinir** — istifadəçi hər şeyi yenidən yükləməli olur. Bu extension o sorğunun
> **tam nüsxəsini yaxalayır** (attachment-lar body-nin içindədir) və uğursuzluğu avtomatik
> geri çəkilmə (backoff) ilə təkrarlayır — attachment-lar heç bir vaxt itmir.

---

## Necə işləyir

```
[chat.z.ai səhifəsi]                         [extension]
      │  POST /api/v2/chat/completions  ──►  yaxalama (fetch wrapper, MAIN world)
      │  (body: mesaj + attachment-lar)       │
      │                                       ├─ SSE axını təhlil olunur:
      ◄─ xəta ────────────────────────────────┤   • global_limit/"busy"   → RETRY
                                              │   • 429 + Retry-After     → RETRY (gecikmə hörmət edilir)
                                              │   • WAF bloku (HTML)      → RETRY
                                              │   • axın kəsintisi ([DONE] yoxdur) → RETRY
                                              │   • 400/401/captcha/imza  → FATAL (avto-retry YOX)
                                              │
                                              ├─ RETRY: eyni body + eyni başlıqlar;
                                              │   imza 4 dəq köhnəlibsə → X-Signature
                                              │   YENİDƏN hesablanır (HMAC-SHA256, LEGACY_SPEC §5)
                                              │
                                              └─ uğurda: POST /api/v1/chats/{id} (persist, §7 forması)
                                                  + səhifə avtomatik yenilənir → mesajınız görünür
```

Texniki detallar (bütün bunlar real web tətbiqindən geri mühəndisliklə alınmış
LEGACY_SPEC (zai_protokol_spec.md — ZaiMobile layihəsindən) əsasadır):

| Hissə | İzah |
|---|---|
| Completion sorğusu | `POST /api/v2/chat/completions?...&signature_timestamp={ts}` + `X-Signature` |
| Attachment-lar | body-də `messages[-1].content` massivi: `image_url` / `file_url` / `video_url` |
| "System is busy" | SSE daxilində `data.error` (`global_limit` kodu) |
| İmza pəncərəsi | 5 dəqiqə (`ts/300000`); extension 4 dəqiqədən sonra yenidən imzalayır |
| Persist | uğurlu retry-dan sonra `POST /api/v1/chats/{id}` (§7: msg-0..N + real id-lər) |

## Quraşdırma

### Chrome (və əsaslı brauzerlər: Edge/Brave)
1. `chrome://extensions` açın, sağ yuxarıda **Developer mode** aktivləşdirin.
2. **Load unpacked** → `dist/chrome` qovluğunu (və ya zip-i açıb) seçin.

### Firefox
1. `about:debugging#/runtime/this-firefox` açın.
2. **Load Temporary Add-on** → `dist/firefox` içindən istənilən fayl (məs. `manifest.json`).
   *(daimi quraşdırma üçün [AMO](https://addons.mozilla.org)-dan imzalı .xpi və ya Developer Edition)*

### Yoxlama (30 saniyə)
1. [chat.z.ai](https://chat.z.ai) açın, daxil olun.
2. Konsolda (F12): `window.__zaiExtInject` → `true`
3. Bir attachment əlavə edib mesaj göndərin → ikonkaya klik → **Şəbəkə jurnalı**nda
   `completion → 200 (N əlavə)` görünməlidir.

## Parametrlər (popup → Parametrlər)

| Parametr | Standart | İzah |
|---|---|---|
| Maks. cəhd | 6 | tükəndikdə bildiriş + "İndi cəhd et" düyməsi qalır |
| İlkin gecikmə | 5000 ms | eksponensial: 5s → 10s → 20s → … (maks 120s) |
| İmza yeniləməsi | ✅ | köhnə imzaları (X-Signature) yenidən hesablayır |
| Persist | ✅ | uğurdan sonra tarixçəni serverə yazır |
| Avto-yenilə | ✅ | uğurdan sonra səhifəni yeniləyir (başqa gözləmə varsa gözləyir) |
| DOM ehtiyat rejimi | ❌ | yalnız SSE birmənalı olanda + səhifədə "busy" mətni görünəndə retry |
| 🖼️ Preview bloku | ✅ | avtomatik açılan preview-lər bağlanılır, yalnız kliklə açılır (v1.1.0) |
| 📝 Qaralama mühafizəsi | ✅ | kompozitor mətni yadda saxlanılır, reload-dan sonra bərpa (v1.2.0) |
| ⚡ Snippetlər | ✅ | tez istifadə şablonları — CRUD ayarlar səhifəsində (v1.2.0) |
| 🔔 Cavab hazırdır | ✅ | tab arxa planda olanda bildiriş (v1.2.0) |
| 🚪 Popap bağlayıcı | ✅ | "peak hours" tipli popaplar bağlanılır — açar sözlər redaktə olunur (v1.2.0) |
| 🎯 Ardıcıl retry | ✅ | eyni anda yalnız bir mesaj yenidən göndərilir (v1.2.0) |
| 🛡️ Dublikat qorunması | ✅ | retry-dan əvvəl server tarixçəsi yoxlanılır (v1.2.0) |

## Testlər

| Suit | Nəticə | Əhatə |
|---|---|---|
| Unit (Node vm) | **58/58 ✔** | təsnifat, backoff, imza cross-implementation, preview prioritetləri, **popap qərarları, markdown ixracı, draft köməkçiləri** |
| Chrome E2E (Playwright + xvfb) | **21 ssenari / 41 yoxlama ✔** | busy→retry (attachment, imza, persist, avto-reload), 429, 400 fatal, axın kəsintisi, dedup, ləğv, preview (3), ayarlar (4), **qaralama (3), snippet (2), ixrac, popap (3), ardıcıl retry, dublikat (2), pauza (2), statistika, ⧉ kopyala (2), bildiriş** |
| Firefox E2E (Marionette) | **9 yoxlama ✔** | inject (page world), busy→retry, imza, persist, avto-reload, preview (2), **popap bağlayıcı, qaralama bərpası** |
| addons-linter | **0 error / 0 warning / 0 notice** | AMO qaydalarına uyğun |

Mock server (`test/mock/`) real protokolu təkrarlayır: imza yoxlaması müstəqil
Node crypto implementasiyası ilə, `global_limit` SSE xətası, multipart upload, persist.

## Məhdudiyyətlər / qeydlər

- İmza alqoritmi `LEGACY_SPEC §5`-dən götürülüb (prod-fe-1.1.123 web tətbiqindən).
  Car bundle-da `X-Signature`, `&signature_timestamp=`, `global_limit` təsdiqləndi.
  İmza **açarı** dəyişsə, 4 dəqiqədən uzun retry-lər imza xətası verər → FATAL
  bildiriş (əvvəlki 4 dəqiqəlik replay hələ də işləyir).
- Completion gəzsə WS nəqliyyatına keçsə, capture düşə bilər → popup-da
  **Şəbəkə jurnalı** baxın (`WS açıldı:` sətirləri görünür).
- Captcha / sessiya (401) xətalarına avtomatik retry YOXDUR — yalnız bildiriş.
- Heç bir məlumat kənar serverə getmir: tutulan sorğular yalnız brauzerin
  `chrome.storage.local`-ında saxlanılır (səhifə bağlı olanda silinə bilər).

## Build

```bash
python3 build.py          # prod → dist/chrome + dist/firefox + dist/zips/*.zip
python3 build.py --test   # E2E üçün (localhost, sürətli backoff)
npm run unit              # 58 unit test
npm run e2e:chrome        # xvfb altında Chrome E2E (21 ssenari)
python3 test/e2e/firefox_spec.py   # Marionette Firefox E2E
npx addons-linter dist/firefox     # AMO linteri
```

Layihə strukturu:

```
src/
  core/classifier.js   — xəta təsnifatı (hər world + Node vm)
  core/backoff.js      — eksponensial gecikmə
  core/sign.js         — X-Signature alqoritmi (HMAC-SHA256 ×2)
  core/preview.js      — PREVIEW GUARD: avto-açılışın bloklanması (v1.1.0)
  core/popupcloser.js  — POPAP BAĞLAYICI: "peak hours" tipli popaplar (v1.2.0)
  core/drafts.js       — QARALAMA köməkçiləri (v1.2.0)
  core/mdexport.js     — Markdown İXRACI (v1.2.0)
  inject.js            — MAIN world: fetch/XHR yaxalama + SSE skan + retry + persist + dublikat yoxlaması + ixrac GET
  content.js           — ISOLATED: vəziyyət maşını, ardıcıl retry, pauza, pill, draft, snippet, statistika, storage
  background.js        — badge, bildirişlər, canlı tab
  ff-bootstrap.js      — Firefox: inject.bundle.js script-teqi ilə (WAR)
  popup/               — vəziyyət + parametrlər + alətlər (ixrac/pauza) + şəbəkə jurnalı
  options/             — AYARLAR SƏHİFƏSİ: preview, qaralama, snippet CRUD, popap açar sözləri, statistika, backup
  pill.css, welcome.html, manifest.chrome.json (MV3), manifest.firefox.json (MV2)
test/
  unit/ mock/ e2e/     — yuxarıdakı cədvəldə
```

## Lisenziya

MIT — bax `LICENSE`.
