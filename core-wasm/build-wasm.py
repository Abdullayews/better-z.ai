#!/usr/bin/env python3
"""better z.ai — build the Rust core and embed it as JS.

Usage:
    python3 core-wasm/build-wasm.py            build + embed (release)
    python3 core-wasm/build-wasm.py --no-test  skip cargo test

Steps:
    1. cargo test                       (differential vectors must pass)
    2. cargo build --target wasm32-unknown-unknown --release
    3. base64-embed the .wasm into src/core/wasm-embedded.js:

           self.__zaiExtWasmB64 = "...";

       That file is picked up automatically by build.py (both the MAIN world
       bundle and the ISOLATED content_scripts) and loaded by
       src/core/wasm-loader.js. If the file does not exist, the extension
       builds and runs exactly as before (pure JS core).
"""
import base64
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
WASM = HERE / "target" / "wasm32-unknown-unknown" / "release" / "zai_core_wasm.wasm"
EMBED = HERE.parent / "src" / "core" / "wasm-embedded.js"
CARGO = shutil.which("cargo") or str(Path.home() / ".cargo" / "bin" / "cargo")


def run(cmd, cwd=None):
    print("+", " ".join(cmd))
    r = subprocess.run(cmd, cwd=cwd or HERE)
    if r.returncode != 0:
        sys.exit(f"FAILED (exit {r.returncode}): {' '.join(cmd)}")


def main():
    if "--no-test" not in sys.argv:
        run([CARGO, "test"])

    run([CARGO, "build", "--target", "wasm32-unknown-unknown", "--release"])
    if not WASM.exists():
        sys.exit(f"wasm artifact not found: {WASM}")

    blob = base64.b64encode(WASM.read_bytes()).decode("ascii")
    # 76-char chunks in an ARRAY LITERAL + join — a flat structure that both
    # JS engines and addons-linter parse without deep-expression recursion
    # (a long '+' concatenation chain blows the linter's parser stack).
    lines = [blob[i:i + 76] for i in range(0, len(blob), 76)]
    js = (
        "/* Build output of core-wasm/build-wasm.py — do not edit.\n"
        " * zai-core-wasm (Rust) compiled to WebAssembly, base64-embedded so it\n"
        " * can be instantiated synchronously in any context without fetching a\n"
        " * .wasm URL (works in the MAIN world, where chrome.runtime.getURL is\n"
        " * unavailable, and needs no web_accessible_resources entry).\n"
        " * Regenerate with: python3 core-wasm/build-wasm.py\n"
        " * Delete this file to fall back to the pure-JS core. */\n"
        "(function (root) {\n"
        "  root.__zaiExtWasmB64 = [\n"
        + ",\n".join("    '" + ln + "'" for ln in lines)
        + "\n  ].join('');\n"
        "})(typeof self !== 'undefined' ? self : globalThis);\n"
    )
    EMBED.write_text(js, encoding="utf-8")
    print(f"embedded {WASM.stat().st_size} bytes wasm -> {EMBED}")
    print(f"  {EMBED.stat().st_size} bytes of JS (base64 overhead x1.33)")


if __name__ == "__main__":
    main()
