# better z.ai

**z.ai üçün Chrome və Firefox extension-ı** — *"system is busy"* və digər göndərmə
xətalarında mesajınızı **attachment-larla birlikdə** avtomatik yenidən göndərir.

> Əsas problem: chat.z.ai-də mesaj uğursuz olanda composer təmizlənir və **attachment-lar
> silinir** — istifadəçi hər şeyi yenidən yükləməli olur. Bu extension o sorğunun
> **tam nüsxəsini yaxalayır** (attachment-lar body-nin içindədir) və uğursuzluğu avtomatik
> geri çəkilmə (backoff) ilə təkrarlayır — attachment-lar heç bir vaxt itmir.

Yalnız **z.ai domenində və bütün alt domenlərində** (chat.z.ai daxil) işləyir.

---

## Funksiyalar

| Funksiya | Nə edir |
|---|---|
| 🔁 Avtomatik yenidən göndərmə | "system is busy" (global_limit), 429, WAF bloku, şəbəkə kəsintisi → eksponensial backoff ilə təkrar (imza avtomatik yenilənir) |
| 🖼️ Preview bloku | Fayl/şəkil preview-ləri öz-özünə açılmır — yalnız kliklə açılır (standart: aktiv) |
| 📝 Qaralama mühafizəsi | Yazdığınız mətn avtomatik yadda saxlanılır; reload-dan sonra "Bərpa et" təklifi |
| 🧷 Mesaj xilası | Uğursuz mesajın tam mətni bir kliklə panoya |
| ⚡ Snippet kitabxanası | Tez-tez yazdığınız şablonlar — kompozitor yanında ⚡ düyməsi, ayarlarda CRUD |
| ⤓ Söhbətin ixracı | Cari söhbət Markdown (.md) kimi |
| ⤓⤓ Tam backup | BÜTÜN söhbətlər bir klikdə: birləşdirilmiş .md + strukturlu .json |
| 🔔 "Cavab hazırdır" | Tab arxa planda olanda bildiriş (istəyə bağlı səs) |
| 🚪 Popap bağlayıcı | "Currently in peak hours" kimi popaplar avtomatik bağlanılır (parol dialoqlarına toxunulmur) |
| ⏸ Qlobal pauza | Bütün avtomatik retry-ləri dayandır / davam etdir |
| 🎯 Ardıcıl retry | Eyni anda yalnız bir mesaj yenidən göndərilir, sıra pozulmur |
| 🛡️ Dublikat qorunması | Retry-dan əvvəl server tarixçəsi yoxlanılır — mesaj onsuz da çatıbsa ikinci dəfə getmir |
| ⌨️ Qısayollar | **Alt+R** indi cəhd et · **Alt+P** pauza · **Alt+E** ixrac |
| 🔤 Söz sayğacı | Kompozitor yanında canlı "N söz · M simvol" |
| ⏱️ Adaptiv backoff | Ardıcıl "busy"-də gözləmələr tədricən uzanır (maks ×3), uğurda sıfırlanır |

## Necə işləyir

```
[z.ai səhifəsi]                              [extension]
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
                                              │   YENİDƏN hesablanır (HMAC-SHA256)
                                              │
                                              └─ uğurda: POST /api/v1/chats/{id} (persist)
                                                  + səhifə avtomatik yenilənir → mesajınız görünür
```

Texniki detallar (real web tətbiqindən geri mühəndisliklə alınmış spec əsasındadır):

| Hissə | İzah |
|---|---|
| Completion sorğusu | `POST /api/v2/chat/completions?...&signature_timestamp={ts}` + `X-Signature` |
| Attachment-lar | body-də `messages[-1].content` massivi: `image_url` / `file_url` / `video_url` |
| "System is busy" | SSE daxilində `data.error` (`global_limit` kodu) |
| İmza pəncərəsi | 5 dəqiqə (`ts/300000`); extension 4 dəqiqədən sonra yenidən imzalayır |
| Persist | uğurlu retry-dan sonra `POST /api/v1/chats/{id}` (msg-0..N + real id-lər) |

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
3. Bir attachment əlavə edib mesaj göndərin → ikonkaya klik → vəziyyət kartında
   retry gedişatı görünməlidir.

## Ayarlar

İkonka → **Bütün ayarlar**: maksimum cəhdlər (6), ilkin gecikmə (5s), backoff amili,
imza yeniləmə, persist, avto-yenilə, preview bloku, qaralama, snippetlər (CRUD),
popap açar sözləri, söz sayğacı, backup limiti, qısayollar, bildirişlər, səs,
DOM ehtiyat rejimi + ayarların JSON ixrac/idxalı.

> 📎 Mesajın attachment-larla birlikdə qorunub bərpa edilməsi **həmişə aktivdir** —
> bu əsas funksiya söndürülə bilməz.

## Məxfilik

- Heç bir məlumat kənar serverə getmir: tutulan sorğular yalnız brauzerin
  `chrome.storage.local`-ında saxlanılır.
- Extension yalnız z.ai domenində və alt domenlərində işləyir (`*://*.z.ai/*`).

## Testlər

| Suit | Nəticə | Əhatə |
|---|---|---|
| Unit (Node vm) | **65/65 ✔** | təsnifat, backoff + adaptiv amil, imza cross-implementation, preview prioritetləri, popap qərarları, markdown ixracı, draft köməkçiləri, söz sayğacı |
| Chrome E2E (Playwright + xvfb) | **24 ssenari / 56 yoxlama ✔** | busy→retry (attachment, imza, persist, avto-reload), 429, 400 fatal, axın kəsintisi, dedup, ləğv, preview (3), ayarlar (4), qaralama (3), snippet (2), ixrac, popap (3), ardıcıl retry, dublikat (2), pauza (2), statistika, kopyala (2), bildiriş, söz sayğacı (3), qısayollar (6), tam backup (4) |
| Firefox E2E (Marionette) | **10 yoxlama ✔** | inject (page world), busy→retry, imza, persist, avto-reload, preview (2), popap bağlayıcı, qaralama bərpası |
| addons-linter | **0 error / 0 warning / 0 notice** | AMO qaydalarına uyğun |

Mock server (`test/mock/`) real protokolu təkrarlayır: imza yoxlaması müstəqil
Node crypto implementasiyası ilə, `global_limit` SSE xətası, multipart upload, persist.

## Məhdudiyyətlər / qeydlər

- İmza alqoritmi real web tətbiqindən götürülüb. İmza **açarı** dəyişsə, 4 dəqiqədən
  uzun retry-lər imza xətası verər → FATAL bildiriş (əvvəlki 4 dəqiqəlik replay hələ də işləyir).
- Completion gəlsə WS nəqliyyatına keçsə, capture düşə bilər.
- Captcha / sessiya (401) xətalarına avtomatik retry YOXDUR — yalnız bildiriş.
- z.ai DOM dəyişsə, DOM-a bağlı köməkçilər (preview/popap/qaralama) yenilənməli ola bilər.

## Build

```bash
python3 build.py          # prod → dist/chrome + dist/firefox + dist/zips/*.zip
python3 build.py --test   # E2E üçün (localhost, sürətli backoff)
npm run unit              # 65 unit test
npm run e2e:chrome        # xvfb altında Chrome E2E (24 ssenari)
python3 test/e2e/firefox_spec.py   # Marionette Firefox E2E
npx addons-linter dist/firefox     # AMO linteri
```

Layihə strukturu:

```
src/
  core/classifier.js   — xəta təsnifatı (hər world + Node vm)
  core/backoff.js      — eksponensial + adaptiv gecikmə
  core/sign.js         — X-Signature alqoritmi (HMAC-SHA256 ×2)
  core/preview.js      — PREVIEW GUARD: avto-açılışın bloklanması
  core/popupcloser.js  — POPAP BAĞLAYICI
  core/drafts.js       — qaralama köməkçiləri
  core/mdexport.js     — markdown ixracı
  inject.js            — MAIN world: fetch/XHR yaxalama + SSE skan + retry + persist + dublikat yoxlaması
  content.js           — ISOLATED: vəziyyət maşını, ardıcıl retry, pauza, pill, draft, snippet, sayğaç
  background.js        — badge, bildirişlər, canlı tab, qısayollar
  ff-bootstrap.js      — Firefox: inject.bundle.js script-teqi ilə (WAR)
  popup/               — vəziyyət + tez ayarlar + alətlər (təmiz UI)
  options/             — tam ayarlar səhifəsi (təmiz UI)
  pill.css             — səhifə içi HUD (vəziyyət kartı, snippet, qaralama, sayğaç)
  manifest.chrome.json (MV3), manifest.firefox.json (MV2)
test/
  unit/ mock/ e2e/     — yuxarıdakı cədvəldə
```

## Lisenziya

MIT — bax `LICENSE`.
