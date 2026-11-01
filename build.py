#!/usr/bin/env python3
"""better z.ai — build script.

Usage:
    python3 build.py          -> prod build (dist/chrome + dist/firefox + zips)
    python3 build.py --test   -> E2E build (localhost:8907 match, fast backoff)

Important: a single file is produced for the MAIN world
(inject.bundle.js = classifier+sign+inject) — sharing files with the
ISOLATED world is a Chrome dedupe problem (when the same file is in both
groups it only executes in the first world).
"""
import hashlib
import json
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
DIST = ROOT / "dist"
TEST = "--test" in sys.argv

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
    js = ("/* auto-generated — build.py */\n"
          "(function (r) { r.__zaiExtDefaults = ")
    js += json.dumps(d, ensure_ascii=False)
    js += "; })(typeof self !== 'undefined' ? self : globalThis);\n"
    (out_dir / "core" / "defaults.js").write_text(js, encoding="utf-8")


def build_browser(browser: str) -> dict:
    out = DIST / browser
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    (out / "core").mkdir()
    # ISOLATED world files (NOT shared with MAIN!)
    for f in ["classifier.js", "backoff.js", "drafts.js", "preview.js", "popupcloser.js", "mdexport.js"]:
        shutil.copy2(SRC / "core" / f, out / "core" / f)
    write_defaults(out)

    # MAIN world single bundle: classifier + sign + inject
    (out / "inject.bundle.js").write_text(
        cat([SRC / "core" / "classifier.js", SRC / "core" / "sign.js", SRC / "inject.js"]),
        encoding="utf-8"
    )

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
    mc = build_browser("chrome")
    mf = build_browser("firefox")
    assert mc["version"] == mf["version"], "manifest versions differ!"
    assert mc["name"] == mf["name"], "manifest names differ!"
    mode = "TEST" if TEST else "PROD"
    print(f"build {mode} → dist/chrome, dist/firefox")

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
