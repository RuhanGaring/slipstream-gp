"""Drive the game in GPU Chromium and take screenshots.
usage: python tools/play.py OUTDIR step [step ...]
steps:
  wait:SECONDS          real-time wait (the game keeps running)
  key:CODE              tap a key (e.g. Enter, ArrowDown, KeyW)
  down:CODE / up:CODE   hold / release
  shot:NAME             screenshot to OUTDIR/NN_NAME.jpg
  js:EXPR               evaluate and print
  rclick:X,Y / move:X,Y  right click / move the mouse
  log                   print console errors so far
"""
import sys, time, pathlib, threading, functools, http.server, socketserver, os, json
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
steps = sys.argv[2:]
W, H = int(os.environ.get("VW", 1600)), int(os.environ.get("VH", 900))

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
handler = functools.partial(Quiet, directory=str(ROOT))
srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

args = ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"]
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=args)
    pg = b.new_page(viewport={"width": W, "height": H}, device_scale_factor=float(os.environ.get("DPR", 1)))
    logs = []
    pg.on("console", lambda m: logs.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
    pg.on("pageerror", lambda e: logs.append(f"pageerror: {e}"))
    pg.goto(f"http://127.0.0.1:{port}/index.html?t={time.time()}", timeout=120000)
    pg.wait_for_function("window.__game && window.__game.ready", timeout=60000)
    n = 0
    for s in steps:
        kind, _, arg = s.partition(":")
        if kind == "wait":
            time.sleep(float(arg))
        elif kind == "key":
            pg.keyboard.press(arg)
            time.sleep(0.12)
        elif kind == "down":
            pg.keyboard.down(arg)
        elif kind == "up":
            pg.keyboard.up(arg)
        elif kind == "rclick":
            x, y = map(float, arg.split(","))
            pg.mouse.click(x, y, button="right")
        elif kind == "move":
            x, y = map(float, arg.split(","))
            pg.mouse.move(x, y, steps=8)
        elif kind == "shot":
            fn = out / f"{n:02d}_{arg}.jpg"; n += 1
            pg.screenshot(path=str(fn), type="jpeg", quality=88)
            fps = pg.evaluate("__game.perf.fps")
            print(fn.name, "fps", round(fps, 1))
        elif kind == "js":
            print("js>", json.dumps(pg.evaluate(arg))[:2000])
        elif kind == "log":
            for l in logs[-20:]: print(l)
    for l in logs[:30]:
        print(l)
    b.close()
srv.shutdown()
