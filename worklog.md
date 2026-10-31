# Z.ai Auto-Resend — İş jurnalı

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
