#!/usr/bin/env python3
"""better z.ai — build script.

Usage:
    python3 build.py          -> prod build (dist/chrome + dist/firefox + zips)
    python3 build.py --test   -> E2E build (localhost:8907 match, fast backoff)
    python3 build.py --wasm   -> (re)build the Rust core first, then prod build

Important: a single file is produced for the MAIN world
(inject.bundle.js = classifier+sign+[wasm]+inject) — sharing files with the
ISOLATED world is a Chrome dedupe problem (when the same file is in both
groups it only executes in the first world).

WASM core: if src/core/wasm-embedded.js exists (built by
core-wasm/build-wasm.py), it + wasm-loader.js are wired into both worlds
and the manifests. If it does not exist, the build is identical to the
pure-JS one — nothing references the wasm.
"""
import hashlib
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
DIST = ROOT / "dist"
TEST = "--test" in sys.argv

WASM_EMBEDDED = SRC / "core" / "wasm-embedded.js"   # compiled build artifact
WASM_LOADER = SRC / "core" / "wasm-loader.js"
WASM_ENTRY = "core/wasm-embedded.js"                 # manifest js path
WASM_LOADER_ENTRY = "core/wasm-loader.js"

PROD_DEFAULTS = {
    "maxRetries": 6, "initialDelayMs": 5000, "backoffFactor": 2.0,
    "maxDelayMs": 120000, "jitter": 0.25, "retryOnHttpError": True,
    "resign": True, "minResignAgeMs": 240000, "persistAfterRetry": True,
    "autoReload": True, "domFallback": False, "notify": True,
    "blockAutoPreview": True,
    "draftGuard": True, "draftMaxAgeH": 72,
    "snippetsEnabled": True,
    "snippets": [
        {"name": "Short answer", "text": "Please answer briefly and to the point."},
        {"name": "Code explanation", "text": "Explain this code step by step:"}
    ],
    "notifyDone": True, "closePopups": True,
    "popupPatterns": ["peak hours", "currently in peak", "high traffic", "rate limit"],
    "serialRetries": True, "dupGuard": True,
    "shortcutsEnabled": True, "wordCounter": True, "notifySound": False,
    "adaptiveBackoff": True, "backupMaxChats": 50
}
TEST_DEFAULTS = {
    "maxRetries": 4, "initialDelayMs": 2000, "backoffFactor": 1.6,
    "maxDelayMs": 5000, "jitter": 0.1, "retryOnHttpError": True,
    "resign": True, "minResignAgeMs": 300, "persistAfterRetry": True,
    "autoReload": True, "domFallback": False, "notify": True,
    "blockAutoPreview": True,
    "draftGuard": True, "draftMaxAgeH": 72,
    "snippetsEnabled": True,
    "snippets": [
        {"name": "Short answer", "text": "Please answer briefly and to the point."},
        {"name": "Code explanation", "text": "Explain this code step by step:"}
    ],
    "notifyDone": True, "closePopups": True,
    "popupPatterns": ["peak hours", "currently in peak", "high traffic", "rate limit"],
    "serialRetries": True, "dupGuard": True,
    "shortcutsEnabled": True, "wordCounter": True, "notifySound": False,
    "adaptiveBackoff": True, "backupMaxChats": 50
}


def cat(paths):
    return "\n".join(p.read_text(encoding="utf-8") for p in paths) + "\n"


def write_defaults(out_dir: Path) -> None:
    d = TEST_DEFAULTS if TEST else PROD_DEFAULTS
    js = ("/* build output — build.py */\n"
          "(function (r) { r.__zaiExtDefaults = ")
    js += json.dumps(d, ensure_ascii=False)
    js += "; })(typeof self !== 'undefined' ? self : globalThis);\n"
    (out_dir / "core" / "defaults.js").write_text(js, encoding="utf-8")


def build_wasm_first() -> None:
    """--wasm: compile the Rust core and embed it before the extension build."""
    script = ROOT / "core-wasm" / "build-wasm.py"
    if not script.exists():
        print("core-wasm/build-wasm.py not found — skipping wasm build")
        return
    r = subprocess.run([sys.executable, str(script)], cwd=ROOT)
    if r.returncode != 0:
        sys.exit("wasm build failed")


def wire_wasm_into_manifest(m: dict) -> None:
    """Insert the wasm files into the ISOLATED content_scripts group."""
    for cs in m.get("content_scripts", []):
        js = cs.get("js", [])
        if "core/classifier.js" in js:
            i = js.index("core/backoff.js") + 1
            js[i:i] = [WASM_ENTRY, WASM_LOADER_ENTRY]
            break


def build_browser(browser: str) -> dict:
    out = DIST / browser
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    (out / "core").mkdir()
    # ISOLATED world files (NOT shared with MAIN!)
    for f in ["classifier.js", "backoff.js", "drafts.js", "preview.js", "popupcloser.js", "mdexport.js"]:
        shutil.copy2(SRC / "core" / f, out / "core" / f)
    has_wasm = WASM_EMBEDDED.is_file() and WASM_LOADER.is_file()
    if has_wasm:
        # wasm-embedded.js (base64 blob) + wasm-loader.js (patches __zaiExtCore)
        shutil.copy2(WASM_EMBEDDED, out / "core" / "wasm-embedded.js")
        shutil.copy2(WASM_LOADER, out / "core" / "wasm-loader.js")
    write_defaults(out)

    # MAIN world single bundle: classifier + sign + [wasm] + inject
    main_files = [SRC / "core" / "classifier.js", SRC / "core" / "sign.js"]
    if has_wasm:
        main_files += [WASM_EMBEDDED, WASM_LOADER]
    main_files.append(SRC / "inject.js")
    (out / "inject.bundle.js").write_text(cat(main_files), encoding="utf-8")

    for f in ["content.js", "pill.css"]:
        shutil.copy2(SRC / f, out / f)
    if browser == "firefox":
        # MV2: world:MAIN unsupported -> WAR + script-tag bootstrap
        shutil.copy2(SRC / "ff-bootstrap.js", out / "ff-bootstrap.js")
    shutil.copytree(SRC / "popup", out / "popup")
    shutil.copytree(SRC / "options", out / "options")
    shutil.copytree(SRC / "icons", out / "icons")

    # background = defaults + background.js
    bg = (out / "core" / "defaults.js").read_text(encoding="utf-8")
    bg += "\n" + (SRC / "background.js").read_text(encoding="utf-8")
    (out / "background.js").write_text(bg, encoding="utf-8")

    m = json.loads((SRC / f"manifest.{browser}.json").read_text(encoding="utf-8"))
    if TEST:
        for cs in m.get("content_scripts", []):
            # localhost on any port (a port-specific pattern may be rejected by Firefox)
            cs["matches"] = ["http://localhost/*"] + cs["matches"]
    if has_wasm:
        wire_wasm_into_manifest(m)
    (out / "manifest.json").write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")
    return m


def zip_browser(browser: str) -> Path:
    src = DIST / browser
    zdir = DIST / "zips"
    zdir.mkdir(exist_ok=True)
    zpath = zdir / f"better-z.ai-{browser}.zip"
    if zpath.exists():
        zpath.unlink()
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(src.rglob("*")):
            if p.is_file():
                z.write(p, p.relative_to(src))
    return zpath


def main() -> None:
    if "--wasm" in sys.argv:
        build_wasm_first()
    mc = build_browser("chrome")
    mf = build_browser("firefox")
    assert mc["version"] == mf["version"], "manifest versions differ!"
    assert mc["name"] == mf["name"], "manifest names differ!"
    mode = "TEST" if TEST else "PROD"
    wasm = " · WASM core" if WASM_EMBEDDED.is_file() else " · pure JS core"
    print(f"build {mode}{wasm} → dist/chrome, dist/firefox")

    if not TEST:
        for b in ["chrome", "firefox"]:
            zp = zip_browser(b)
            sha = hashlib.sha256(zp.read_bytes()).hexdigest()
            print(f"  {zp.name}  {zp.stat().st_size} bytes  sha256={sha[:16]}…")
        zdir = DIST / "zips"
        lines = []
        for p in sorted(zdir.glob("*.zip")):
            sha = hashlib.sha256(p.read_bytes()).hexdigest()
            lines.append(f"{sha}  {p.name}")
        (zdir / "SHA256SUMS.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
        fx = zdir / "better-z.ai-firefox.zip"
        xpi = zdir / "better-z.ai-firefox.xpi"
        shutil.copy2(fx, xpi)
        print(f"  {xpi.name} (copy)")


if __name__ == "__main__":
    main()
