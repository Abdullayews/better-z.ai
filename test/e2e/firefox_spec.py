#!/usr/bin/env python3
"""Z.ai Auto-Resend — Firefox E2E (Marionette vasitəsilə).

Playwright Firefox-da extension yükləməyi dəstəkləmir; ona görə Marionette
(gecko daxili protokolu) + Addon.install(temp) istifadə edirik.

Gedış: python3 test/e2e/firefox_spec.py
Tələb: npx playwright install firefox  +  pip install marionette_driver
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
    raise RuntimeError("mock server başlamadı")


def find_firefox():
    cache = Path.home() / ".cache" / "ms-playwright"
    cands = sorted(cache.glob("firefox-*/firefox/firefox"), key=lambda p: p.name, reverse=True)
    for c in cands:
        if c.exists():
            return str(c)
    raise RuntimeError("firefox tapılmadı: npx playwright install firefox")


def probe_page_world(client):
    """Marionette sandbox səhifə qloballarını OXA bilmir — ona görə
    inline script (page world) ilə DOM-a nəticə yazırıq."""
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
        raise RuntimeError("marionette bağlanmadı")
    print("marionette: bağlı")

    addon_id = Addons(client).install(str(DIST_FF), temp=True)
    print("addon quraşdırıldı:", addon_id)

    failures = 0
    try:
        # Ssenari 0: inject (page world zondası ilə — Marionette sandbox qlobal oxuya bilmir)
        client.navigate(BASE + "/")
        time.sleep(1.5)
        pw = probe_page_world(client)
        if 'inject=true' not in pw:
            raise AssertionError("MAIN world inject olunmadı: " + pw)
        print("  ✔ 0 inject (MAIN world) aktiv —", pw)

        # Ssenari FF-A: busy → avto-retry (attachment ilə)
        http("POST", BASE + "/_ctl", {"script": ["busy", "sse_ok"], "resetPersist": True})
        http("DELETE", BASE + "/_log")
        client.navigate(BASE + "/")
        time.sleep(1.2)

        # Marionette send_keys görünən element tələb edir — input-u açırıq
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
            raise AssertionError("chip görünmədi (upload alınmadı)")

        comp = client.find_element(By.ID, "composer")
        comp.send_keys("Salam firefox testi")
        client.find_element(By.ID, "send").click()

        deadline = time.time() + 10
        while time.time() < deadline:
            if client.execute_script("return !!document.querySelector('#messages .err')", []):
                break
            time.sleep(0.3)
        else:
            raise AssertionError("tətbiqdə busy xətası görünmədi")

        pain = client.execute_script("return document.getElementById('composer').value === '' && document.querySelectorAll('#chips .chip').length === 0", [])
        if not pain:
            raise AssertionError("z.ai davranışı təkrarlanmadı (composer/chips silinmədi)")
        print("  ✔ FFA1 tətbiqdə xəta + attachment-lar silindi")

        deadline = time.time() + 30
        log = None
        while time.time() < deadline:
            log = http("GET", BASE + "/_log")
            if len(log["requests"]) >= 2:
                break
            time.sleep(0.4)
        if len(log["requests"]) < 2:
            raise AssertionError("retry gəlmədi (requests=%d)" % len(log["requests"]))
        r0, r1 = log["requests"][0], log["requests"][1]
        if not (r0["sigOk"] and r1["sigOk"]):
            raise AssertionError("imza yoxlaması keçilmədi: %s" % (r1.get("why"),))
        if json.dumps(r0["body"], sort_keys=True) != json.dumps(r1["body"], sort_keys=True):
            raise AssertionError("retry body fərqlidir")
        last = r1["body"]["messages"][-1]["content"]
        if not any(p.get("type") == "image_url" for p in last):
            raise AssertionError("retry body-də attachment yoxdur")
        if r1["headers"]["x-signature"] == r0["headers"]["x-signature"]:
            raise AssertionError("imza yenilənmədi")
        if not (r1["query"]["timestamp"] > r0["query"]["timestamp"]):
            raise AssertionError("timestamp artmadı")
        print("  ✔ FFA2 retry: eyni body + attachment, imza yeniləndi")

        deadline = time.time() + 20
        while time.time() < deadline:
            log = http("GET", BASE + "/_log")
            if len(log["persists"]) >= 1:
                break
            time.sleep(0.4)
        if len(log["persists"]) < 1:
            raise AssertionError("persist yoxdur")
        chat = log["persists"][-1]["chat"]
        if chat["history"]["currentId"] != r0["body"]["id"]:
            raise AssertionError("persist currentId uyğunsuz")
        entries = list(chat["history"]["messages"].values())
        assistant = [m for m in entries if m.get("role") == "assistant"]
        if not assistant or "Salam! Bu avtomatik" not in str(assistant[-1]["content"]):
            raise AssertionError("persist-də cavab yoxdur")
        print("  ✔ FFA3 persist yazıldı (attachment + cavab)")

        # avto-reload → uğur görünür
        deadline = time.time() + 20
        while time.time() < deadline:
            ok_page = client.execute_script("var t=document.body.innerText||''; return t.indexOf('Salam! Bu avtomatik')>=0 && !document.querySelector('#messages .err')", [])
            if ok_page:
                break
            time.sleep(0.4)
        if not ok_page:
            raise AssertionError("avto-reload sonrası uğur görünmədi")
        print("  ✔ FFA4 səhifə avtomatik yeniləndi — uğur görünür")

        # Ssenari FF-B: PREVIEW GUARD — uğurdan sonra öz-özünə açılan
        # preview bağlanmalıdır (blockAutoPreview standart olaraq aktivdir)
        def inject_page_js(js):
            """Səhifə world-də JS icra et (inline script — sandbox qlobalları oxuya bilmir)."""
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
        comp.send_keys("preview ff testi")
        client.find_element(By.ID, "send").click()
        st = {}
        deadline = time.time() + 12
        while time.time() < deadline:
            st = read_mock_preview()
            if st.get("openedBy") == "auto" and st.get("open") is False and st.get("closedBy"):
                break
            time.sleep(0.3)
        if not (st.get("openedBy") == "auto" and st.get("open") is False and st.get("closedBy")):
            raise AssertionError("avtomatik preview bloklanmadı: %s" % (st,))
        print("  ✔ FFB uğurdan sonra avtomatik preview bağlandı (%s)" % st.get("closedBy"))

        # FF-C: heç bir klik/fayl əlavəsi OLMADAN, completion pəncərəsi də
        # bitdikdən sonra öz-özünə açılan preview bağlanmalıdır.
        # (Qeyd: "chip kliklə açılır və açıq qalır" halı Chrome E2E H1-də
        #  ETİBARLI kliklə yoxlanılır — Marionette-in atom-kliki isTrusted=false
        #  olduğundan burada sınana bilmir; məntiq eyni content script-dir.)
        inject_page_js("window.__mockAutoPreview = false;")
        time.sleep(4.6)  # FFB completion pəncərəsi (4s) bitsin
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
            raise AssertionError("kliksiz avtomatik preview bloklanmadı: %s" % (st,))
        print("  ✔ FFC klik/pəncərəsiz öz-özünə açılan preview də bağlandı (%s)" % st.get("closedBy"))

        # Ssenari FF-D (v1.2.0): POPAP BAĞLAYICI — "peak hours" popapı
        # öz-özünə açılanda avtomatik bağlanmalıdır (parol dialoqu yoxlanılmır —
        # Chrome N3-də etibarlı kliklə; Marionette atom-kliki eyni məntiqi işlədir).
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
            raise AssertionError("peak hours popapı bağlanmadı")
        print("  ✔ FFD 'Currently in peak hours' popapı avtomatik bağlandı")

        # Ssenari FF-E (v1.2.0): QARALAMA MÜHAFİZƏSİ — reload-dan sonra
        # yazılmış mətn "Bərpa et" ilə geri qaytarılmalıdır
        comp = client.find_element(By.ID, "composer")
        comp.send_keys("FF qaralama testi 42")
        time.sleep(1.8)  # debounce 800ms + save
        client.navigate(BASE + "/")
        time.sleep(2.4)
        banner = client.execute_script("return !!document.querySelector('.zai-ext-draft')", [])
        if not banner:
            raise AssertionError("qaralama bannerı görünmədi")
        client.execute_script(
            "document.querySelector('.zai-ext-draft button[data-a=restore]').click();", [])
        time.sleep(0.8)
        val = client.execute_script("return document.getElementById('composer').value", [])
        if val != "FF qaralama testi 42":
            raise AssertionError("qaralama bərpa olunmadı: %r" % val)
        print("  ✔ FFE qaralama reload sonrası bərpa olundu")

        print("HƏMİSİ KEÇDİ ✔ (Firefox)")
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
