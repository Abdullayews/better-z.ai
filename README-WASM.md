# better z.ai — Rust/WASM core (Variant B)

The extension stays a plain Chrome MV3 / Firefox MV2 add-on, but its **core
logic** (signature, backoff, error classification) is now written in **Rust**,
compiled to **WebAssembly** and loaded at `document_start`. The JavaScript
implementations in `src/core/*.js` are kept **as the reference and as a
per-call fallback** — the Rust port is verified against them by a
differential test suite of **1053 recorded vectors**.

```
┌────────────────────────────────────────────────────────────────────┐
│  chat.z.ai tab                                                     │
│                                                                    │
│  MAIN world (inject.bundle.js)          ISOLATED world             │
│  ┌───────────────────────────────┐      ┌───────────────────────┐  │
│  │ classifier.js + sign.js       │      │ classifier.js         │  │
│  │        ↓ (define __zaiExtCore)│      │ backoff.js            │  │
│  │ wasm-embedded.js (base64 blob)│      │   ↓ __zaiExtCore      │  │
│  │        ↓                       │      │ wasm-embedded.js      │  │
│  │ wasm-loader.js  ─── patches ───┼──────┼→ wasm-loader.js       │  │
│  │        ↓                       │      │   ↓                   │  │
│  │ inject.js (fetch/XHR hooks,   │      │ content.js (state     │  │
│  │ SSE scan, retry, persist)     │      │ machine, pill, drafts)│  │
│  └───────────────────────────────┘      └───────────────────────┘  │
│          both talk to the SAME WebAssembly instance?               │
│          No — each world instantiates its own copy (they cannot     │
│          share objects anyway). Same binary, two instances.         │
└────────────────────────────────────────────────────────────────────┘
```

## What moved to Rust

| JS module | Rust module | Notes |
|---|---|---|
| `src/core/sign.js` | `core-wasm/src/sign.rs` | `computeSignature`, `resignUrl`, `formEncode`, `b64Utf8`, `hmacHex` (HMAC-SHA256 ×2) |
| `src/core/backoff.js` | `core-wasm/src/backoff.rs` | `computeDelay`, `applyRetryAfter`, `congestionMultiplier` |
| `src/core/classifier.js` | `core-wasm/src/classifier.rs` | `classifyHttpError`, `classifyBodyText`, `classifyStream`, `extractMessage/Error`, `errText`, `firstLine`, `isHtmlBody`, `countWords` |
| — | `core-wasm/src/dates.rs` | exact `toISOString` / `toUTCString` ports (used by `resignUrl`) |
| — | `core-wasm/src/jsutil.rs` | ECMAScript semantics: JS `\s` class, UTF-16 `slice`, `Math.round/min/max` NaN rules, `ToInt32`, truthiness, `String()` coercion |

DOM-dependent modules (`drafts.js`, `preview.js`, `popupcloser.js`,
`mdexport.js`) and the worlds themselves (`inject.js`, `content.js`,
`background.js`) stay JavaScript — they are glue by nature.

## Why this design

- **Zero-import C-ABI** (`walloc`/`wreset` + `wz_*` exports): no
  wasm-bindgen, no generated glue. The binary is instantiated
  **synchronously** from an inline base64 blob — required because
  `inject.js` hooks `fetch` at `document_start`, before any async callback
  would run, and because the MAIN world cannot `fetch()` a
  `chrome-extension://` URL.
- **Base64-embedded, not a `.wasm` file**: no `web_accessible_resources`
  changes, no URL fetching, works in the MAIN world, the ISOLATED world,
  extension pages and Node (tests) identically.
- **Per-call fallback**: the loader keeps the JS originals
  (`C.__jsImpl`). If WebAssembly is blocked (page CSP — chat.z.ai currently
  sends none, but that can change), the blob is missing, the 4 MiB input
  arena overflows, or a call traps, **that single call** runs the JS
  implementation instead. The extension never breaks because of wasm.
- **chat.z.ai sends no CSP header** (verified) — WebAssembly works in the
  MAIN world today; the fallback covers tomorrow.

## Build

```bash
# once: rustup target add wasm32-unknown-unknown
python3 core-wasm/build-wasm.py    # cargo test + cargo build + embed (base64)
python3 build.py                   # extension build (auto-detects the wasm)
# or both at once:
python3 build.py --wasm
```

`build.py` wires `core/wasm-embedded.js` + `core/wasm-loader.js` into the
ISOLATED `content_scripts` (after `core/backoff.js`) and into the MAIN-world
`inject.bundle.js` (between `sign.js` and `inject.js`) **only when the
embedded blob exists**. Delete `src/core/wasm-embedded.js` and you get the
byte-identical pure-JS build (62 KB zip vs 645 KB with the wasm core).

Artifact sizes (current):

| artifact | size |
|---|---|
| `zai_core_wasm.wasm` (release, `opt-level=z`, LTO, `panic=abort`) | 551 KB |
| `src/core/wasm-embedded.js` (base64) | 803 KB |
| `dist/…/better-z.ai-chrome.zip` (whole extension, wasm build) | 645 KB |
| same, pure-JS build | 62 KB |

## Tests — three layers

| layer | command | what it proves |
|---|---|---|
| 1. vectors recorded from JS | `npm run vectors` | runs the real `src/core/*.js` in a Node vm, records 1053 input→output pairs (`core-wasm/tests/vectors.json`) |
| 2. native Rust | `cd core-wasm && cargo test` | the Rust modules must match every vector (18 differential + 17 unit tests) |
| 3. the shipped artifact | `npm run unit` / `npm run unit:dist` | the actual `.wasm` through the actual `wasm-loader.js` must match every vector again (18 tests), and the built `dist/chrome/inject.bundle.js` must activate the wasm core and agree with the JS reference (1 test) |

Vector categories: signature (window boundaries, UTF-8, emoji, 9 KB
prompts), formEncode, base64, HMAC, firstLine (UTF-16 cut positions),
countWords, isHtmlBody, classifyHttpError (26 statuses × 10 bodies ×
retry flag = 520 cases), classifyBodyText, classifyStream, SSE
extract/errText, computeDelay (352-case grid incl. clamps and `attempt|0`
coercions), applyRetryAfter, congestionMultiplier, resignUrl (dates +
percent-encoding), toISOString/toUTCString (leap years, epoch, pre-1970).

`npm run unit` also keeps all 67 pre-existing tests green — the JS core is
still the reference and still shipped.

## Exactness guarantees and known divergences

The port reproduces ECMAScript semantics where the core depends on them
(see `jsutil.rs`). Verified-equal on all vectors; two theoretical
divergences are documented here:

1. **Lone surrogates**: `firstLine` cuts by UTF-16 units; if the cut lands
   inside a surrogate pair, JS produces a lone surrogate while Rust emits
   U+FFFD. Both render as a broken glyph; no classifier decision depends
   on it. (Vectors deliberately avoid split pairs.)
2. **Number→string for extreme magnitudes**: `String(1e21)` is
   `"1e+21"` in JS; Rust prints `"1000000000000000000000"`. Only reachable
   for non-integer timestamps/HTTP statuses, which the protocol never
   produces.

`Math.pow` vs `f64::powf`: both correctly rounded on the supported
targets for the integer exponents used; the 352-case delay grid verifies
this continuously.

## Future steps

- `wz_scan_payload` — fold the whole per-event SSE payload handling
  (parse + extract + delta/done flags) into one wasm call, removing the
  JSON round-trip on the hot path.
- The pure modules in `core-wasm/src/` are deliberately free of
  browser/wasm assumptions — they are the starting point for a
  standalone Rust proxy/client (the "Variant A" roadmap) without touching
  this extension.
