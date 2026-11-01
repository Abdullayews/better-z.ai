# better z.ai

**A Chrome and Firefox extension for z.ai** — automatically resends your message
**together with its attachments** on *"system is busy"* and other submission errors.

> The core problem: when a message fails on chat.z.ai, the composer is cleared and the
> **attachments are deleted** — the user has to re-upload everything. This extension intercepts
> a **complete copy of that request** (the attachments live inside the body) and retries the
> failure with automatic backoff — the attachments are never lost.

Works only on **the z.ai domain and all its subdomains** (including chat.z.ai).

---

## Features

| Feature | What it does |
|---|---|
| 🔁 Auto-resend | "system is busy" (global_limit), 429, WAF block, network interruption → retried with exponential backoff (the signature is renewed automatically) |
| 🖼️ Preview guard | File/image previews do not open on their own — they open only on click (default: on) |
| 📝 Draft protection | The text you type is saved automatically; a "Restore" prompt appears after a reload |
| 🧷 Message rescue | The full text of a failed message is copied to the clipboard in one click |
| ⚡ Snippet library | Templates you use often — a ⚡ button next to the composer, CRUD in settings |
| ⤓ Chat export | The current chat as Markdown (.md) |
| ⤓⤓ Full backup | ALL chats in one click: merged .md + structured .json |
| 🔔 "Response is ready" | A notification when the tab is in the background (optional sound) |
| 🚪 Popup closer | Popups like "Currently in peak hours" are closed automatically (password dialogs are untouched) |
| ⏸ Global pause | Stop / resume all automatic retries |
| 🎯 Serial retries | Only one message is resent at a time; the queue is never broken |
| 🛡️ Duplicate guard | Server history is checked before a retry — if the message has already arrived, it is not sent twice |
| ⌨️ Shortcuts | **Alt+R** retry now · **Alt+P** pause · **Alt+E** export |
| 🔤 Word counter | A live "N words · M chars" next to the composer |
| ⏱️ Adaptive backoff | With repeated "busy" responses the waits gradually lengthen (max ×3) and reset on success |

## How it works

```
[z.ai page]                                  [extension]
      │  POST /api/v2/chat/completions  ──►  interception (fetch wrapper, MAIN world)
      │  (body: message + attachments)       │
      │                                      ├─ SSE stream is parsed:
      ◄─ error ──────────────────────────────┤   • global_limit/"busy"   → RETRY
                                             │   • 429 + Retry-After     → RETRY (delay is honored)
                                             │   • WAF block (HTML)      → RETRY
                                             │   • stream break (no [DONE]) → RETRY
                                             │   • 400/401/signature → FATAL (no auto-retry)
                                             │   • captcha required → fast retry (1 s, same body)
                                             │
                                             ├─ RETRY: same body + same headers;
                                             │   if the signature is older than 4 min →
                                             │   X-Signature is recomputed (HMAC-SHA256)
                                             │
                                             └─ on success: POST /api/v1/chats/{id} (persist)
                                                            + the page reloads automatically → your message appears
```

Technical details (based on a spec reverse-engineered from the real web app):

| Part | Explanation |
|---|---|
| Completion request | `POST /api/v2/chat/completions?...&signature_timestamp={ts}` + `X-Signature` |
| Attachments | the `messages[-1].content` array in the body: `image_url` / `file_url` / `video_url` |
| "System is busy" | `data.error` inside the SSE stream (`global_limit` code) |
| Signature window | 5 minutes (`ts/300000`); the extension re-signs after 4 minutes |
| Persist | after a successful retry: `POST /api/v1/chats/{id}` (msg-0..N + real ids) |

## Installation

### Chrome (and Chromium-based browsers: Edge/Brave)
1. Open `chrome://extensions`, enable **Developer mode** in the top right.
2. **Load unpacked** → select the `dist/chrome` folder (or extract the zip first).

### Firefox
1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on** → any file inside `dist/firefox` (e.g. `manifest.json`).
   *(for a permanent install: a signed .xpi from [AMO](https://addons.mozilla.org) or the Developer Edition)*

### Verification (30 seconds)
1. Open [chat.z.ai](https://chat.z.ai) and log in.
2. In the console (F12): `window.__zaiExtInject` → `true`
3. Add an attachment and send a message → click the icon → the status card should show
   the retry progress.

## Settings

Icon → **All settings**: maximum attempts (6), initial delay (5s), backoff factor,
signature renewal, persist, auto-reload, preview guard, drafts, snippets (CRUD),
popup keywords, word counter, backup limit, shortcuts, notifications, sound,
DOM fallback + JSON export/import of the settings.

> 📎 Protecting and restoring the message together with its attachments is **always on** —
> this core feature cannot be disabled.

## Privacy

- No data goes to an external server: the captured requests are stored only in the
  browser's `chrome.storage.local`.
- The extension runs only on the z.ai domain and its subdomains (`*://*.z.ai/*`).

## Tests

| Suite | Result | Coverage |
|---|---|---|
| Unit (Node vm) | **67/67 ✔** | classification (incl. captcha fast-retry), backoff + adaptive factor, cross-implementation signature, preview priorities, popup decisions, markdown export, draft helpers, word counter |
| Chrome E2E (Playwright + xvfb) | **25 scenarios / 61 checks ✔** | busy→retry (attachment, signature, persist, auto-reload), 429, 400 fatal, stream break, dedup, cancel, preview (3), settings (4), drafts (3), snippet (2), export, popup (3), serial retries, duplicate (2), pause (2), statistics, copy (2), notification, word counter (3), shortcuts (6), full backup (4), captcha fast-retry (5) |
| Firefox E2E (Marionette) | **10 checks ✔** | inject (page world), busy→retry, signature, persist, auto-reload, preview (2), popup closer, draft restore |
| addons-linter | **0 error / 0 warning / 0 notice** | compliant with AMO rules |

The mock server (`test/mock/`) reproduces the real protocol: signature verification via an
independent Node crypto implementation, the `global_limit` SSE error, multipart upload, persist.

## Limitations / notes

- The signature algorithm is taken from the real web app. If the signature **key** changes, retries
  longer than 4 minutes fail with a signature error → FATAL notification (the previous 4-minute replay still works).
- If completions switch to the WS transport, the capture may break.
- Session (401) errors get NO automatic retries — only a notification. Captcha errors
  (FRONTEND_CAPTCHA_REQUIRED) are the exception: a fast automatic retry runs after
  1 second and replays the original body — attachments included, files are never lost.
- If z.ai changes its DOM, the DOM-dependent helpers (preview/popup/drafts) may need an update.

## Build

```bash
python3 build.py          # prod → dist/chrome + dist/firefox + dist/zips/*.zip
python3 build.py --test   # for E2E (localhost, fast backoff)
npm run unit              # 67 unit tests
npm run e2e:chrome        # Chrome E2E under xvfb (25 scenarios)
python3 test/e2e/firefox_spec.py   # Marionette Firefox E2E
npx addons-linter dist/firefox     # AMO linter
```

Project structure:

```
src/
  core/classifier.js   — error classification (every world + Node vm)
  core/backoff.js      — exponential + adaptive delay
  core/sign.js         — X-Signature algorithm (HMAC-SHA256 ×2)
  core/preview.js      — PREVIEW GUARD: blocking auto-open
  core/popupcloser.js  — POPUP CLOSER
  core/drafts.js       — draft helpers
  core/mdexport.js     — markdown export
  inject.js            — MAIN world: fetch/XHR interception + SSE scan + retry + persist + duplicate check
  content.js           — ISOLATED: state machine, serial retries, pause, pill, drafts, snippets, counter
  background.js        — badge, notifications, live tab, shortcuts
  ff-bootstrap.js      — Firefox: inject.bundle.js via a script tag (WAR)
  popup/               — status + quick settings + tools (clean UI)
  options/             — full settings page (clean UI)
  pill.css             — in-page HUD (status card, snippets, drafts, counter)
  manifest.chrome.json (MV3), manifest.firefox.json (MV2)
test/
  unit/ mock/ e2e/     — see the table above
```

## License

MIT — see `LICENSE`.
