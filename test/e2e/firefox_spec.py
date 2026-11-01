#!/usr/bin/env python3
"""better z.ai — Firefox E2E (via Marionette).

Playwright does not support loading extensions in Firefox; that is why we use
Marionette (gecko's built-in protocol) + Addon.install(temp).

Run: python3 test/e2e/firefox_spec.py
Requires: npx playwright install firefox  +  pip install marionette_driver
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DIST_FF = ROOT / "dist" / "firefox"
ART = ROOT / "test" / ".artifacts"
BASE = "http://localhost:8907"

PNG = b"\x89PNG\r\n\x1a\n" + b"MOCKFILE" * 4


def http(method, url, body=None):
    req = urllib.request.Request(url, method=method)
    req.add_header("content-type", "application/json")
    data = json.dumps(body).encode() if body is not None else None
    with urllib.request.urlopen(req, data=data, timeout=10) as r:
        return json.loads(r.read().decode())


def wait_server():
    for _ in range(80):
        try:
            http("GET", BASE + "/_log")
            return None
        except Exception:
            p = subprocess.Popen(["node", str(ROOT / "test" / "mock" / "server.js")])
            time.sleep(0.6)
            try:
                http("GET", BASE + "/_log")
                return p
            except Exception:
                continue
    raise RuntimeError("mock server failed to start")


def find_firefox():
    cache = Path.home() / ".cache" / "ms-playwright"
    cands = sorted(cache.glob("firefox-*/firefox/firefox"), key=lambda p: p.name, reverse=True)
    for c in cands:
        if c.exists():
            return str(c)
    raise RuntimeError("firefox not found: npx playwright install firefox")


def probe_page_world(client):
    """The Marionette sandbox cannot READ page globals — so we write
    the result into the DOM via an inline script (page world)."""
    client.execute_script(
        "var s=document.createElement('script');"
        "s.textContent=\"var d=document.getElementById('pw-probe');"
        "if(!d){d=document.createElement('div');d.id='pw-probe';"
        "(document.body||document.documentElement).appendChild(d);};"
        "d.textContent='inject='+(window.__zaiExtInject===true)+'|core='+(typeof window.__zaiExtCore)+'|pill='+!!document.querySelector('.zai-ext-pill');\";"
        "document.documentElement.appendChild(s);", [])
    time.sleep(0.4)
    return client.execute_script("return (document.getElementById('pw-probe')||{}).textContent || ''", [])


def main():
    from marionette_driver import By
    from marionette_driver.marionette import Marionette
    from marionette_driver.addons import Addons

    server_proc = wait_server()
    ART.mkdir(exist_ok=True)
    up = ART / "upload.png"
    up.write_bytes(PNG)

    ff = find_firefox()
    print("firefox:", ff)
    proc = subprocess.Popen([ff, "-headless", "-marionette", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    client = None
    for _ in range(60):
        try:
            client = Marionette(host="127.0.0.1", port=2828)
            client.start_session()
            break
        except Exception:
            time.sleep(0.5)
    if client is None:
        proc.kill()
        raise RuntimeError("marionette did not connect")
    print("marionette: connected")

    addon_id = Addons(client).install(str(DIST_FF), temp=True)
    print("addon installed:", addon_id)

    failures = 0
    try:
        # Scenario 0: inject (probed in the page world — the Marionette sandbox cannot read globals)
        client.navigate(BASE + "/")
        time.sleep(1.5)
        pw = probe_page_world(client)
        if 'inject=true' not in pw:
            raise AssertionError("MAIN world was not injected: " + pw)
        print("  ✔ 0 inject (MAIN world) active —", pw)

        # Scenario FF-A: busy -> auto-retry (with an attachment)
        http("POST", BASE + "/_ctl", {"script": ["busy", "sse_ok"], "resetPersist": True})
        http("DELETE", BASE + "/_log")
        client.navigate(BASE + "/")
        time.sleep(1.2)

        # Marionette send_keys needs a visible element — unhide the input
        client.execute_script("document.getElementById('fileInput').style.display='block'; document.getElementById('fileInput').style.opacity='0';", [])
        fi = client.find_element(By.ID, "fileInput")
        fi.send_keys(str(up))
        client.execute_script("document.getElementById('fileInput').style.display='none';", [])
        deadline = time.time() + 8
        while time.time() < deadline:
            if client.execute_script("return document.querySelectorAll('#chips .chip').length", []) >= 1:
                break
            time.sleep(0.3)
        else:
            raise AssertionError("the chip did not appear (upload failed)")

        comp = client.find_element(By.ID, "composer")
        comp.send_keys("Hello firefox test")
        client.find_element(By.ID, "send").click()

        deadline = time.time() + 10
        while time.time() < deadline:
            if client.execute_script("return !!document.querySelector('#messages .err')", []):
                break
            time.sleep(0.3)
        else:
            raise AssertionError("the busy error did not appear in the app")

        pain = client.execute_script("return document.getElementById('composer').value === '' && document.querySelectorAll('#chips .chip').length === 0", [])
        if not pain:
            raise AssertionError("z.ai behavior not reproduced (composer/chips were not cleared)")
        print("  ✔ FFA1 error in the app + attachments deleted")

        deadline = time.time() + 30
        log = None
        while time.time() < deadline:
            log = http("GET", BASE + "/_log")
            if len(log["requests"]) >= 2:
                break
            time.sleep(0.4)
        if len(log["requests"]) < 2:
            raise AssertionError("no retry (requests=%d)" % len(log["requests"]))
        r0, r1 = log["requests"][0], log["requests"][1]
        if not (r0["sigOk"] and r1["sigOk"]):
            raise AssertionError("signature check failed: %s" % (r1.get("why"),))
        if json.dumps(r0["body"], sort_keys=True) != json.dumps(r1["body"], sort_keys=True):
            raise AssertionError("the retry body differs")
        last = r1["body"]["messages"][-1]["content"]
        if not any(p.get("type") == "image_url" for p in last):
            raise AssertionError("no attachment in the retry body")
        if r1["headers"]["x-signature"] == r0["headers"]["x-signature"]:
            raise AssertionError("the signature was not refreshed")
        if not (r1["query"]["timestamp"] > r0["query"]["timestamp"]):
            raise AssertionError("timestamp did not increase")
        print("  ✔ FFA2 retry: same body + attachment, signature refreshed")

        deadline = time.time() + 20
        while time.time() < deadline:
            log = http("GET", BASE + "/_log")
            if len(log["persists"]) >= 1:
                break
            time.sleep(0.4)
        if len(log["persists"]) < 1:
            raise AssertionError("no persist")
        chat = log["persists"][-1]["chat"]
        if chat["history"]["currentId"] != r0["body"]["id"]:
            raise AssertionError("persist currentId mismatch")
        entries = list(chat["history"]["messages"].values())
        assistant = [m for m in entries if m.get("role") == "assistant"]
        if not assistant or "Hello! This is an automatic" not in str(assistant[-1]["content"]):
            raise AssertionError("no response in persist")
        print("  ✔ FFA3 persist written (attachment + response)")

        # auto-reload -> success becomes visible
        deadline = time.time() + 20
        while time.time() < deadline:
            ok_page = client.execute_script("var t=document.body.innerText||''; return t.indexOf('Hello! This is an automatic')>=0 && !document.querySelector('#messages .err')", [])
            if ok_page:
                break
            time.sleep(0.4)
        if not ok_page:
            raise AssertionError("success did not appear after the auto-reload")
        print("  ✔ FFA4 the page reloaded automatically — success is visible")

        # Scenario FF-B: PREVIEW GUARD — the preview that opens itself after
        # success must be closed (blockAutoPreview is on by default)
        def inject_page_js(js):
            """Run JS in the page world (inline script — the sandbox cannot read globals)."""
            client.execute_script(
                "var s=document.createElement('script');s.textContent=" + json.dumps(js) + ";"
                "(document.head||document.documentElement).appendChild(s);"
                "s.remove();", [])

        def read_mock_preview():
            inject_page_js(
                "var d=document.getElementById('mp-probe');"
                "if(!d){d=document.createElement('div');d.id='mp-probe';d.style.display='none';"
                "(document.body||document.documentElement).appendChild(d);}"
                "d.setAttribute('data-json', JSON.stringify(window.__mockPreview||{}));")
            raw = client.execute_script(
                "return (document.getElementById('mp-probe')||{}).getAttribute('data-json')||''", [])
            try:
                return json.loads(raw) if raw else {}
            except Exception:
                return {}

        http("POST", BASE + "/_ctl", {"script": ["sse_ok"], "resetPersist": False})
        inject_page_js("window.__mockAutoPreview = true;")
        comp = client.find_element(By.ID, "composer")
        comp.send_keys("preview ff test")
        client.find_element(By.ID, "send").click()
        st = {}
        deadline = time.time() + 12
        while time.time() < deadline:
            st = read_mock_preview()
            if st.get("openedBy") == "auto" and st.get("open") is False and st.get("closedBy"):
                break
            time.sleep(0.3)
        if not (st.get("openedBy") == "auto" and st.get("open") is False and st.get("closedBy")):
            raise AssertionError("the automatic preview was not blocked: %s" % (st,))
        print("  ✔ FFB the automatic preview after success was closed (%s)" % st.get("closedBy"))

        # FF-C: with NO click and NO file add, a preview that opens itself even
        # after the completion window must be closed.
        # (Note: the "chip click opens and stays open" case is verified in Chrome
        #  E2E H1 with a TRUSTED click — Marionette's atom-click is isTrusted=false
        #  so it cannot be tested here; the logic is the same content script.)
        inject_page_js("window.__mockAutoPreview = false;")
        time.sleep(4.6)  # let the FFB completion window (4s) expire
        inject_page_js(
            "document.getElementById('previewModal').classList.add('open');"
            "window.__mockPreview.opens += 1;"
            "window.__mockPreview.open = true;"
            "window.__mockPreview.openedBy = 'auto2';"
            "window.__mockPreview.closedBy = null;")
        st = {}
        deadline = time.time() + 8
        while time.time() < deadline:
            st = read_mock_preview()
            if st.get("openedBy") == "auto2" and st.get("open") is False and st.get("closedBy"):
                break
            time.sleep(0.3)
        if not (st.get("openedBy") == "auto2" and st.get("open") is False and st.get("closedBy")):
            raise AssertionError("the click-less automatic preview was not blocked: %s" % (st,))
        print("  ✔ FFC a preview that opened itself with no click/window was closed too (%s)" % st.get("closedBy"))

        # Scenario FF-D: POPUP CLOSER — the "peak hours" popup must be closed
        # automatically when it opens on its own (the password dialog is not tested
        # here — it is covered in Chrome N3; Marionette's atom-click uses the same logic).
        http("POST", BASE + "/_ctl", {"script": ["sse_ok"], "resetPersist": False})
        inject_page_js("window.__mockPeakOpen && window.__mockPeakOpen();")
        deadline = time.time() + 8
        closed = False
        while time.time() < deadline:
            vis = client.execute_script(
                "return (function(){var m=document.getElementById('peakModal');"
                "return !!m && m.classList.contains('open') && getComputedStyle(m).display!=='none';})()", [])
            if not vis:
                closed = True
                break
            time.sleep(0.3)
        if not closed:
            raise AssertionError("the peak hours popup was not closed")
        print("  ✔ FFD the 'Currently in peak hours' popup was closed automatically")

        # Scenario FF-E: DRAFT GUARD — after a reload the typed
        # text must be restored via "Restore"
        comp = client.find_element(By.ID, "composer")
        comp.send_keys("FF draft test 42")
        time.sleep(1.8)  # debounce 800ms + save
        client.navigate(BASE + "/")
        time.sleep(2.4)
        banner = client.execute_script("return !!document.querySelector('.zai-ext-draft')", [])
        if not banner:
            raise AssertionError("the draft banner did not appear")
        client.execute_script(
            "document.querySelector('.zai-ext-draft button[data-a=restore]').click();", [])
        time.sleep(0.8)
        val = client.execute_script("return document.getElementById('composer').value", [])
        if val != "FF draft test 42":
            raise AssertionError("the draft was not restored: %r" % val)
        print("  ✔ FFE the draft was restored after the reload")

        print("ALL PASSED ✔ (Firefox)")
    except Exception as e:
        failures += 1
        print("  ✘", e)
    finally:
        try:
            client.close()
        except Exception:
            pass
        proc.kill()
        if server_proc:
            server_proc.kill()
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
