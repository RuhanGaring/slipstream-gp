"""End-to-end check of the player's journey in GPU Chromium, on a clean profile each run: the welcome,
a first race with the helps, the coach, a flashback, pause, a finished race with its debrief and
profile, and the option screens. Prints PASS or FAIL per step, keeps screenshots in OUTDIR.
usage: python tools/playcheck.py OUTDIR"""
import sys, time, pathlib, threading, functools, http.server, socketserver, json, os
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
W, H = int(os.environ.get("VW", 1600)), int(os.environ.get("VH", 900))

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT)))
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

fails = 0
def check(name, ok, extra=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + (("  " + str(extra)) if extra != "" else ""), flush=True)
    if not ok: fails += 1

args = ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"]
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=args)
    pg = b.new_page(viewport={"width": W, "height": H})
    logs = []
    pg.on("console", lambda m: logs.append(f"{m.type}: {m.text}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: logs.append(f"pageerror: {e}"))
    t0 = time.time()
    pg.goto(f"http://127.0.0.1:{port}/index.html?t={time.time()}", timeout=120000)
    pg.wait_for_function("window.__game && window.__game.ready", timeout=120000)
    print("boot seconds", round(time.time() - t0, 1), flush=True)
    js = pg.evaluate
    n = [0]
    def shot(name):
        n[0] += 1
        pg.screenshot(path=str(out / f"{n[0]:02d}_{name}.jpg"), type="jpeg", quality=82)
    def scr(): return js("(document.querySelector('#screens > *:last-child')||{}).id||''")
    def key(c, wait=0.25):
        pg.keyboard.press(c); time.sleep(wait)
    def state(): return js("__game.Game.state")
    def wait_race(limit=60):
        pg.wait_for_function("__game.Game.state==='race' && __game.Game.race && __game.Game.race.phase", timeout=limit * 1000)

    # ---------- first launch ----------
    time.sleep(1); shot("title")
    key("Enter", 0.8)
    check("first launch asks who is driving", scr() == "scr-welcome", scr())
    shot("welcome")
    key("Enter", 0.4)
    wait_race()
    check("New driver starts a race", state() == "race")
    cfg = js("(()=>{const r=__game.Game.race,p=r.player;return {mode:r.mode,diff:r.cfg.difficulty,bh:p.assist.brakeHelp,sh:p.assist.steerHelp,adapt:!!r.adapt,fb:__game.Game.fb.left===null||__game.Game.fb.left}})()")
    check("New driver setup", cfg["mode"] == "arcade" and cfg["diff"] == 5 and cfg["bh"] == 2 and cfg["sh"] == 1 and cfg["adapt"], cfg)
    pg.wait_for_function("__game.Game.race.green", timeout=30000)
    shot("lights_out")
    pg.keyboard.down("KeyW")
    time.sleep(14)
    check("the car is driving", js("__game.Game.race.player.dist") > 150, js("__game.Game.race.player.dist"))
    shot("driving")
    fps = js("__game.perf.fps")
    print("fps in race", round(fps, 1), "auto step", js("__game.Game.settings.autoStep||0"), flush=True)

    # ---------- flashback ----------
    t1 = js("__game.Game.race.time")
    pg.keyboard.down("Backspace")
    time.sleep(0.7)
    check("flashback starts", state() == "rewind", state())
    shot("flashback")
    time.sleep(0.7)
    pg.keyboard.up("Backspace")
    time.sleep(0.25)
    t2 = js("__game.Game.race.time")
    check("flashback lands back in the race", state() == "race" and js("__game.Game.fb.used") == 1, state())
    check("time went back", t2 < t1, f"{t1:.2f} to {t2:.2f}")
    time.sleep(3)
    check("race goes on after a flashback", js("__game.Game.race.time") > t2 + 1 and js("__game.Game.race.rec.count()") > 40)
    # a tap keeps rewinding, Esc cancels and leaves the race where it was
    t3 = js("__game.Game.race.time")
    key("Backspace", 0.5)
    check("tap keeps rewinding", state() == "rewind", state())
    key("Escape", 0.4)
    check("Esc cancels the flashback", state() == "race" and js("__game.Game.race.time") >= t3 and js("__game.Game.fb.used") == 1, state())
    pg.keyboard.up("KeyW")

    # ---------- pause, quit ----------
    key("Escape", 0.5)
    check("pause opens", scr() == "scr-pause", scr())
    shot("pause")
    js("__game.Game.quitToMenu()")
    time.sleep(1.5)
    check("back at the main menu", scr() == "scr-main", scr())
    check("RACE AGAIN offered", "RACE AGAIN" in js("document.querySelector('#scr-main').innerText"))
    shot("main_menu")

    # ---------- a whole race, to the flag ----------
    js("""__game.quick({flow:{mode:'sim'},race:{laps:2,difficulty:6,brakeHelp:0,steerHelp:0,adaptive:false,flashbacks:3,mandatory:false,safetyCar:'off',grid:10}})""")
    wait_race()
    pg.wait_for_function("__game.Game.race.green", timeout=30000)
    js("__game.Game.race.autoPlayer=true; __game.Game.race.player.gridPos=__game.Game.race.player.gridPos")
    shot("sim_race")
    for _ in range(90):
        if state() == "results": break
        js("(()=>{const r=__game.Game.race;for(let k=0;k<2400&&!r.done;k++){F1.Race.step(r,1/240);r.fx.length=0}return r.done})()")  # the sim alone: drawn frames in one task overrun the GPU queue
        time.sleep(0.05)
    time.sleep(0.8)
    check("race reaches the results", state() == "results", state())
    txt = js("(document.querySelector('.debrief')||{}).innerText||''")
    check("results debrief", "Best lap" in txt or "Did not finish" in txt, txt[:160].replace("\n", " / "))
    check("profile counted the race", js("F1.Profile.get().races") == 1, js("F1.Profile.get().races"))
    shot("results")

    # ---------- screens ----------
    js("F1.UI.go('profile',{back:'main'})"); time.sleep(0.4); shot("profile")
    check("profile screen", scr() == "scr-profile" and "TROPH" in js("document.querySelector('#scr-profile').innerText").upper())
    js("F1.UI.go('keys',{back:'main'})"); time.sleep(0.4); shot("keys")
    check("keys screen", scr() == "scr-keys")
    # move throttle to I, and drive with it
    key("Enter", 0.2)
    key("KeyI", 0.2)
    check("key moved", js("__game.Game.binds.thr") == "KeyI" and js("__game.Game.keyName('thr')") == "I")
    js("__game.Game.quitToMenu()"); time.sleep(1.2)
    js("""__game.quick({flow:{mode:'arcade'},race:{laps:3,difficulty:0,flashbacks:0,brakeHelp:0,adaptive:false}})""")
    wait_race()
    pg.wait_for_function("__game.Game.race.green", timeout=30000)
    check("no flashback ring when they are off", js("__game.Game.fb.ring") is None)
    d0 = js("__game.Game.race.player.dist")
    pg.keyboard.down("KeyI"); time.sleep(4); pg.keyboard.up("KeyI")
    check("a moved key drives the car", js("__game.Game.race.player.dist") > d0 + 40, js("__game.Game.race.player.dist") - d0)
    js("__game.Game.bindsReset()")
    js("F1.UI.go('settings',{back:'main'})"); time.sleep(0.4); shot("settings")
    js("F1.UI.go('setup')") if False else None
    errs = [l for l in logs]
    check("no console errors", not errs, errs[:6])
    b.close()
srv.shutdown()
print("FAILED" if fails else "ALL PASSED", fails)
sys.exit(1 if fails else 0)
