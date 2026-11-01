# Z.ai Auto-Resend — İş jurnalı

## 2026-11-01 — v1.3.0: "Sürət və nəzarət paketi" (öz təşəbbüsümlə əlavə olunan funksiyalar — davam)

### İstək
> "biraz daha xüsusiyyət əlavə et, aktiv olaraq githubda işlə, göndər" — v1.2.0-dan
> sonra yeni funksiyalar, aktiv Git işi və push.

### Düşüncə mərhələsi (v1.2.0 sessiyasındakı 30 dəq düşüncənin davamı)
- 8 kandidat qiymətləndirildi: qısayollar, tam backup, söz sayğacı, səsli bildiriş,
  adaptiv backoff, diaqnostika ixracı, ayarların sync saxlanması, söhbətdə axtarış.
- **6 seçildi; 2 təxirə salındı:** ayar sync (çoxprofilli merge riski, dəyər/gələn
  fayda nisbəti aşağı) və DOM axtarışı (z.ai DOM dəyişkənliyinə çox həssas).
- Chat siyahısı endpoint-i protokol spec-indən təsdiqləndi: `GET /api/v1/chats/?page=N&type=default`
  → `[{id, title, updated_at}]`, səhifələmə 1..10 / boş səhifə / təkrar ilk id / 300 cap.

### Yeni funksiyalar (6)
1. **⌨️ Klaviatura qısayolları** (`commands` API, Chrome MV3 + Firefox MV2) —
   Alt+R "İndi cəhd et", Alt+P pauza, Alt+E ixrac. Background → alive tab-ə
   CMD_SHORTCUT; content `shortcutsEnabled` deyilsə iqnor edir. Alive-tab ünvanı
   30 s-lik heartbeat ilə təzə saxlanılır.
2. **⤓⤓ Tam backup** (inject `doBackupAll` + content `backupAll`) — chat siyahısı
   (səhifələmə spec-i ilə) + hər chatın detalı → birləşdirilmiş **.md** (içindekilər
   + hər söhbət bölməsi) + orijinal strukturlu **.json**. `backupMaxChats` limiti
   (1..300), progress pill-də, `stats.backups`, `lastBackup` storage-da.
3. **🔤 Söz sayğacı** (content, ISOLATED) — kompozitor dolu olanda sağ altda
   "N söz · M simvol" çipi; `wordCounter` parametri (DOM-dan tam silinir).
   Saf `C.countWords` classifier-də (unit-test olunur).
4. **🔊 "Cavab hazırdır" səsi** — notifyDone halında Web Audio ilə iki notalı
   yumşaq zəng (880→1318 Hz, ~0.5s, səs səviyyəsi 0.12). `notifySound` (standart SÖNÜK).
5. **⏱️ Adaptiv backoff** (`C.congestionMultiplier`, backoff.js) — hər uğursuz
   nəticə gecikməni ×1.5…×3 qədər uzadır (cap ×3), uğurda dərhal sıfırlanır,
   5 dəqiqə "soyuma" var. `adaptiveBackoff` parametri. Retry-After hələ də üstündür.
6. **🧪 Diaqnostika ixracı** (popup) — versiya, parametrlər, statistika, rekord
   xülasəsi (state sayı), son ixrac/backup, jurnal quyruğu → bir JSON faylı.

Plus: options səhifəsində yeni bölmələr (sayğaç / backup limiti / qısayollar +
`kbd` stilləri), popup-da 4 yeni tez açar + 2 yeni alət düyməsi, welcome səhifəsi,
statistikaya `backups` + `shortcutActions` sayğacları.

### Test nəticələri
- Unit **65/65** (yeni: congestionMultiplier ×4, countWords ×3).
- Chrome E2E **24 ssenari / 56 yoxlama — hamısı ✔** (A–T dəyişməz, yeni U/V/W):
  U sayğaç (3), V qısayollar (6: retry-now dərhal, pauza aç/bağla, ixrac,
  söndürülmüş hâl, statistika), W tam backup (4: 2 söhbət, siyahı, jurnal, limit).
- Firefox E2E (Marionette): 0 + FFA1-4 + FFB + FFC + FFD + FFE — hamısı ✔
  (MV2 manifest-ə `commands` əlavəsi zərər vermədi).
- addons-linter **0/0/0**.
- Prod build v1.3.0 → download/zai-autoresend (zip/xpi/SUMS).

### Baza sabitləşdirməsi (v1.2.0 pushundan əvvəl)
Yavaş mühitdə 3 ssenari flaky idi — hamısı deterministik edildi:
- **E**: tətbibin öz yenidən göndərişi `page.evaluate` ilə birbaşa DOM-dan
  (Playwright fill+click gecikməsi 2 s retry ilə yarışırdı).
- **Q**: ilkin gecikmə 8 s-yə qaldırıldı (pauza klikinə vaxt qalır) + try/finally
  ilə pauza/parametr bərpası (qaldıqda S-i zəhərliyirdi).
- **S**: müdafiəçi unpause + maxRetries bərpası try/finally içində.
- **W**: popup jurnalı ~1 s intervalla təzələndiyindən qeyd polling ilə gözlənilir.

### Debug tapıntıları (gələcək üçün)
- Sandbox: Bash aləti çağırışı bitəndə nohup-la başladılan arxa plan prosesləri
  ÖLDÜRÜLÜR — uzun testlər ya foreground, ya da çağırışın öz `sleep` pəncərəsində
  bitməlidir.
- `xvfb-run` xauth tələb edir → birbaşa `Xvfb :99 & DISPLAY=:99` istifadə olundu.
- Playwright lock faylı 1.64.1 həll edir → chromium-1248/firefox-1555 lazımdır
  (`npx playwright install chromium firefox`).
- Normadan kənar ayrılmış mock server stdout-u açıq saxlayanda pipeline qapanmır —
  test öz serverini spawn edirsə cleanup-da öldürməlidir.

## 2026-11-01 — v1.2.0: "Ağıllı köməkçi paketi" (öz təşəbbüsümlə əlavə olunan funksiyalar)

### İstək
> "düşün və özün də funksiyalar əlavə et. ən az 30 dəq düşün, timer ilə 30 dəq
> olduğunu təsdiqlə" — istifadəçi extension-a öz seçimimlə yeni funksiyalar
> əlavə etməyi tapşırdı (timer təsdiqi ilə: başlanğıc 08:55, bitmə ~09:4x).

### Araşdırma → dizayn qərarları (30+ dəq düşüncə mərhələsi)
- Real z.ai problemi təsdiqi: "Currently in peak hours" popapı (limbonux/zai-autocloser
  userscript-i ayrıca mövcuddur) → POPAP BAĞLAYICI funksiyası əsasında götürüldü.
- URL şablonu `chat.z.ai/c/<id>` (AfterChat exporter-dan) → draft açarları və ixrac
  üçün chatId mənbəyi.
- 11 kandidat funksiya qiymətləndirildi, 9-u seçildi; hər biri mövcud arxitekturaya
  (şəbəkə-capture + ISOLATED content) uyğun yerləşdirildi.

### Yeni funksiyalar (9)
1. **📝 Qaralama mühafizəsi** (`core/drafts.js` + content) — kompozitor mətni
   debounce ilə yadda saxlanılır; reload-dan sonra "Bərpa et" bannerı. Capture
   anında draft istehlak olunur (təkrar təklif yoxdur). Maks 20 açar/100KB/72 saat.
2. **🧷 Mesaj xilası** — uğursuz mesajın TAM mətni (`lastUserText`, 200KB-a qədər)
   pill-dəki ⧉ və popup-dakı "Mətni kopyala" ilə panoya.
3. **⚡ Snippet kitabxanası** — kompozitor yanında fab düyməsi + menyu; ayarlar
   səhifəsində CRUD; 2 nümunə şablon standart.
4. **⤓ Söhbətin ixracı** (`core/mdexport.js` + inject doExport) — GET
   /api/v1/chats/{id} → parentId zənciri ilə xronoloji Markdown (.md) yükləmə.
5. **🔔 "Cavab hazırdır"** — tab arxa planda olanda (document.hidden) bildiriş.
6. **🚪 Popap bağlayıcı** (`core/popupcloser.js`) — açar-sözlü (redaktə olunan)
   popapları bağlayır; parol/input formalı dialoqlara HEÇ toxunmur; dövrə qoruyucusu.
7. **⏸ Qlobal pauza** — pill ⏸/▶ + popup; storage `paused` üzərindən, badge '||'.
8. **🎯 Ardıcıl retry** — tick-də eyni anda yalnız 1 retry (sıra qorunur).
9. **🛡️ Dublikat qorunması** — doRetry-dən əvvəl GET chats/{id}: mesaj
   current_user_message_id + done assistant uşağı ilə mövcuddursa → retry ləğv,
   `RESULT success (duplicate_avoided)`, stats.dupAvoided++.

Plus: 📊 Statistika (10 sayğaç, popup xətti + ayarlar paneli + sıfırlama),
💾 ayarların JSON ixrac/idxalı.

### Yeni parametrlər (standart)
draftGuard ✓, draftMaxAgeH 72, snippetsEnabled ✓ (2 nümunə), notifyDone ✓,
closePopups ✓ (patterns: peak hours / currently in peak / pik saat / high traffic /
rate limit), serialRetries ✓, dupGuard ✓.

### Test nəticələri
- Unit **58/58** (yeni: popupcloser 9, mdexport 6, drafts 5).
- Chrome E2E **21 ssenari / 41 yoxlama — 0 regression (A–J dəyişməz), yeni K–T**:
  K qaralama (reload→bərpa→istehlak), L snippet, M ixrac (md tərkibi), N popap
  (3 yoxlama: bağlanır / parametr off açıq qalır / parol toxunulmaz), O ardıcıl
  (pauza ilə deterministik, gap 250–500ms), P dublikat (1 sorğu), Q pauza/davam,
  R statistika (7 sayğaç ≥1), S ⧉ tam mətn clipboard, T bildiriş (jurnal).
- Firefox E2E: 0, FFA1–4, FFB, FFC + **yeni FFD (popap), FFE (qaralama)** — hamısı ✔.
- addons-linter **0/0/0** (banner DOM-API ilə yenidən quruldu — innerHTML
  UNSAFE_VAR_ASSIGNMENT xəbərdarlığı aradan qaldırıldı).
- Prod build v1.2.0 → download/zai-autoresend (zip/xpi/SUMS + 3 screenşot).

### Debug tapıntıları (gələcək üçün)
- Bu sandboxda (xvfb) tab-arxa plana keçmə `document.hidden` vermir və
  CDP `setWebLifecycleState` da effektisizdir → T ssenarisi üçün content-ə
  kiçik QA hook-u (`SET_HIDDEN_OVERRIDE` runtime mesajı) əlavə edildi.
- Chrome world izolyasiyası: page-world `Object.defineProperty(document,'hidden')`
  content world-DƏ GÖRÜNMÜR (expando-lar per-world-dür) — real gizlətmə lazım
  olanda runtime mesajından istifadə et.
- O ssenarisində ilk retry 2 s-də atıldığından yarış yaranırdı → pauza ilə
  deterministikləşdirildi (həm də pauza özü yoxlanıldı).
- pollPill state-ə görə tez match edir (köhnə fatal rekordu) — mətnə görə
  waitForFunction lazım oldu (S).


## 2026-11-01 — v1.1.0: Preview Guard + Ayarlar səhifəsi

### İstək
> "Preview kimi faylların auto açılmasını əngəllə, extensionun ayarlar bölməsi olsun
> və orda default olaraq Preview auto açılmasın, yalnız basılanda açılsın."

### Yeni funksiyalar
1. **Preview Guard** (`core/preview.js`, ISOLATED world) — z.ai-in öz-özünə açdığı
   fayl/şəkil preview pəncərələrini bağlayır; istifadəçi kliklə açdığına toxunmur.
   - Qərar prioritetləri: media-klik → saxla; uğurlu completion+4s → bağla;
     fayl change+2.5s → bağla; klik yoxdur (2.2s) → bağla; əks halda saxla.
   - Bağlama kaskadı: Escape → close düyməsi → backdrop → (son çarə) display:none.
   - Dövrə qoruyucusu: eyni modal 30s-də >5 dəfə açılırsa müdaxilə dayanır.
   - Completion siqnalı content.js RESULT(success) → `PG.noteResult()` ilə.
   - `seen` Map hər skanda yalnız görünən elementləri saxlayır → bağlanıb yenidən
     açılan modal yenidən qiymətləndirilir (v1.1.0-də tapılan bug).
2. **Ayarlar səhifəsi** (`options/`) — `options_ui` (Chrome MV3 + Firefox MV2),
   avto-yadda (debounce 350ms), formada olmayan açarlarla MERGE (popup-dakı
   itən-jitter bug-u da düzəldildi), "Standart ayarlara qaytar".
3. **Popup**: `sBlockPreview` tez açarı + "Ayarlar…" düyməsi (openOptionsPage).

### Standart dəyər
`blockAutoPreview: true` — yəni **preview avtomatik açılmır, yalnız kliklə açılır**
(istifadəçi tələbi kimi). PARAMETRLƏRDƏ SÖNDÜRÜLƏ BİLƏR.

### Test nəticələri
- Unit 38/38 (yeni: 8 preview qərar testi).
- Chrome E2E 10 ssenari / 22 yoxlama — 0 regression (A–F dəyişməz), yeni G/H/I/J.
- Firefox E2E: FFA1-4 + FFB + FFC keçdi. Qeyd: Marionette atom-kliki isTrusted=false
  olduğundan "kliklə açılış qorunur" halı yalnız Chrome-də (H1, etibarlı kliklə) sınanır.
- addons-linter: 0/0/0. Prod build v1.1.0 → download/zai-autoresend (zip/xpi/SUMS +
  ayarlar-sehifesi-v1.1.0.png, popup-v1.1.0.png).

### Debug tapıntıları
- `xvfb-run` xauth tələb edir → sandboxda `Xvfb :99 & DISPLAY=:99 node …` istifadə olundu.
- Playwright lokal 1.64.1 → chromium-1248 / firefox-1555 ayrıca `npx playwright install`.
- Prod build localhost-a inject olmur → screenşot üçün dist manifestinə müvəqqəti
  `http://localhost/*` match əlavə edildi, sonra təmiz prod build bərpa edildi.


## 2026-11-01 — v1.0.0: ilk buraxılış (extension pivotu)

### İstək
> "ən yaxşısı gəl biz extension yaraq, z.ai firefox və chrome üçün. məqsəd system
> is busy vəya başqa hallada attachment silinmədən auto mesajı yenidən göndərmə olsun."

Android (ZaiMobile) işi dayandırıldı; məqsəd eyni qaldı — **mesaj + attachment-lar
itmasın**. Yeni daşıyıcı: brauzer extension-ı (şəbəkə səviyyəsində capture/replay).

### Memarlıq qərarları
1. **Şəbəkə-səviyyəli capture** — DOM bərpası (React state, File obyektləri)
   etibarsızdır; attachment-lar completion body-nin İÇİNDƏDİR → yaxalanan body-ni
   eynilə göndərmək onları qoruyur.
2. **İmza yeniləmə** — X-Signature 5 dəq pəncərəsi (ts/300000); LEGACY_SPEC §5
   alqoritmi (HMAC×2) port edilib, 4 dəq köhnəlikdən sonra retry-lar yenidən imzalanır.
3. **Persist** — z.ai web tətbiqi uğurdan sonra POST /api/v1/chats/{id} yazır
   (client-driven); extension uğurlu retry-dan sonra eyni §7 formasını yazır,
   sonra səhifə avto-yenilənir.
4. **Brauzer fərqləri**:
   - Chrome MV3 `world:"MAIN"` content script — birbaşa page world.
   - Firefox MV3 temp-install-da content script-lər ÜMUMİYYƏTLƏ işləmirdi +
     `world:MAIN` iqnor olunur → **MV2 + web_accessible_resources + script-teq
     bootstrap** (chat.z.ai CSP yoxdur — yoxlanıldı).
   - Chrome `action.*` / Firefox MV2 `browserAction.*` badge API uyğunlaşdırılıb.

### Debug tapıntıları (gələcək üçün)
- Chrome eyni faylı iki world qrupunda paylaşdıranda onu yalnız BİRİNCİ world-də
  icra edir → MAIN world tək bundle (`inject.bundle.js`) oldu.
- Marionette sandbox səhifə JS qloballarını OXMUR — page-world yoxlaması inline
  script + DOM zondası ilə aparılmalı (`probe_page_world`).
- `pagehide`-də dərhal storage flush (save throttle itirməsin deyə).
- Match pattern-lərdə port (`http://localhost:8907/*`) etibarsız ola bilər →
  test build `http://localhost/*` işlədir.

### Testlər
- Unit 30/30 (imza cross-implementation: crypto.subtle ↔ node:crypto).
- Chrome E2E 6/6; Firefox E2E 4/4; addons-linter 0/0.
- Real protokol təsdiqi: prod-fe-1.1.123 bundle-da `X-Signature`,
  `&signature_timestamp=`, `global_limit`, `storage/pfs/files/upload` mövcuddur.

### Açıq məqamlar (real hesabla yoxlanmalı)
- Real hesabda busy xətasının real formaları (E2E-ə güzgülənib).
- İmza açarı dəyişərsə → uzun retry-larda FATAL (4 dəq-yədək replay işləyir).
- WS nəqliyyatına keçid olarsa → jurnalda görünəcək, capture genişləndiriləcək.
