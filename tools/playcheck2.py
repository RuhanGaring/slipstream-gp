"""Second end-to-end check, on a clean profile: career from the first round through contract offers
into a second season, the daily race, the time trial summary, the safety car holding the player,
track limit strikes, flags, a phone in simulation. Screenshots in OUTDIR.
usage: python tools/playcheck2.py OUTDIR"""
import sys, time, pathlib, threading, functools, http.server, socketserver, os
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
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
    pg = b.new_page(viewport={"width": 1600, "height": 900})
    logs = []
    pg.on("console", lambda m: logs.append(f"{m.type}: {m.text}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: logs.append(f"pageerror: {e}"))
    pg.goto(f"http://127.0.0.1:{port}/index.html?t={time.time()}", timeout=120000)
    pg.wait_for_function("window.__game && window.__game.ready", timeout=120000)
    js = pg.evaluate
    js("localStorage.setItem('slip_seen','true')")
    n = [0]
    def shot(name):
        n[0] += 1
        pg.screenshot(path=str(out / f"{n[0]:02d}_{name}.jpg"), type="jpeg", quality=82)
    def scr(): return js("(document.querySelector('#screens > *:last-child')||{}).id||''")
    def key(c, wait=0.3):
        pg.keyboard.press(c); time.sleep(wait)
    def state(): return js("__game.Game.state")
    def to_green():
        pg.wait_for_function("__game.Game.state==='race' && __game.Game.race && __game.Game.race.green", timeout=90000)
    def to_flag():
        # (the sim alone, not __game.tick: hundreds of drawn frames in one task overrun the GPU queue)
        js("__game.Game.race.autoPlayer=true")
        for _ in range(200):
            if state() == "results": return
            js("(()=>{const r=__game.Game.race;for(let k=0;k<2400&&!r.done;k++){F1.Race.step(r,1/240);r.fx.length=0}return r.done})()")
            time.sleep(0.05)
        print("no flag, state", state())

    # ---------- career ----------
    js("F1.Game.raceDefaults.laps=2; F1.Game.raceDefaults.safetyCar='off'; F1.Game.raceDefaults.mandatory=false")
    js("F1.Game.careerStart()"); time.sleep(0.6)
    check("career opens at handling", scr() == "scr-mode", scr())
    key("Enter", 0.5)
    check("career goes straight to setup", scr() == "scr-setup", scr())
    shot("career_setup")
    js("F1.Game.startFromFlow()")
    to_green()
    check("career driver is at the slowest team", js("__game.Game.race.player.team.id") == "aurex", js("__game.Game.race.player.team.id"))
    time.sleep(0.5); shot("career_race")
    to_flag(); time.sleep(0.6)
    check("career race ends", state() == "results", state())
    js("F1.Game.champContinue()"); time.sleep(0.5)
    check("standings show the target", "Team target" in js("document.querySelector('#scr-standings').innerText"))
    shot("career_standings")
    # the last round, then the offers
    js("(()=>{const G=F1.Game,c=G.champ;c.round=F1.Tracks.DEFS.length-2;c.career.rep=120;return 1})()")
    js("F1.Game.champNext()")
    to_green(); to_flag(); time.sleep(0.6)
    js("F1.Game.champContinue()"); time.sleep(0.5)
    check("final standings offer contracts", "CONTRACT OFFERS" in js("document.querySelector('#scr-standings').innerText").upper())
    js("F1.UI.go('offers')"); time.sleep(0.5)
    shot("offers")
    check("offers include better teams", js("F1.Game.careerOffers().length") >= 2, js("F1.Game.careerOffers()"))
    # quitting here keeps the career
    js("__game.Game.quitToMenu()"); time.sleep(1.5)
    check("main menu continues the career", "CONTINUE CAREER" in js("document.querySelector('#scr-main').innerText"))
    js("F1.Game.champResume('career')"); time.sleep(0.6)
    check("resume returns to the offers", scr() == "scr-offers", scr())
    key("Enter", 0.4)
    to_green()
    check("season two with the new team", js("F1.Game.champ.career.season") == 2 and js("__game.Game.race.player.team.id") != "aurex", js("__game.Game.race.player.team.id"))
    js("__game.Game.quitToMenu()"); time.sleep(1.5)
    # a new championship has its own save: the career is still there afterwards
    js("F1.Game.flow={kind:'champ',mode:'arcade',team:2,driver:0}; F1.Game.startFromFlow()")
    to_green()
    js("__game.Game.quitToMenu()"); time.sleep(1.5)
    menu = js("document.querySelector('#scr-main').innerText")
    check("career survives a new championship", "CONTINUE CAREER" in menu and "CONTINUE CHAMPIONSHIP" in menu, menu[:160])
    check("career save is still season two", js("F1.Game.champSaved('career').career.season") == 2)

    # ---------- daily ----------
    d = js("F1.Game.daily()")
    check("daily picks a circuit", bool(d.get("track")), d)
    js("F1.Game.runDaily()")
    pg.wait_for_function("!!document.querySelector('#scr-loading .ld-session')", timeout=30000)
    check("daily loading screen says so", "DAILY RACE" in js("document.querySelector('#scr-loading .ld-session').innerText"))
    to_green()
    check("daily race settings apply", js("__game.Game.race.track.id") == d["track"] and js("__game.Game.race.laps") == d["laps"], js("__game.Game.race.laps"))
    check("daily leaves the player's own laps alone", js("F1.Game.raceDefaults.laps") == 2)
    check("daily runs in the day's car", js("__game.Game.race.player.team.id") == js(f"F1.Data.TEAMS[{d['team']}].id"), js("__game.Game.race.player.team.id"))
    to_flag(); time.sleep(0.6)
    check("daily scored", js("F1.Profile.get().streak") >= 1, js("F1.Profile.get().streak"))
    shot("daily_results")
    js("__game.Game.quitToMenu()"); time.sleep(1.5)
    shot("main_menu")

    # ---------- safety car holds the player ----------
    js("__game.quick({flow:{mode:'sim'},race:{laps:6,difficulty:0,safetyCar:'always',brakeHelp:0,steerHelp:0,flashbacks:5,mandatory:false,grid:1}})")
    to_green()
    js("(()=>{const r=__game.Game.race;r.sc.at=3;return 1})()")
    pg.keyboard.down("KeyW")
    pg.wait_for_function("__game.Game.race.sc.state==='deployed'", timeout=60000)
    time.sleep(1)
    shot("safety_car")
    check("flag banner on show", "SAFETY CAR" in js("document.getElementById('h-flag').textContent"), js("document.getElementById('h-flag').textContent"))
    time.sleep(12)
    pen = js("__game.Game.race.player.penalty")
    check("flat out behind the safety car earns no penalty", pen == 0, pen)
    pg.keyboard.up("KeyW")

    # ---------- track limits: one strike for one trip ----------
    js("__game.Game.quitToMenu()"); time.sleep(1.5)
    js("__game.quick({flow:{mode:'sim'},race:{laps:6,difficulty:0,safetyCar:'off',mandatory:false,grid:1}})")
    to_green()
    js("""(()=>{const r=__game.Game.race,p=r.player,t=r.track,i=p.loc.i,o=-(t.pit.side||1)*(t.hw+7);F1.Car.place(p,t.x[i]+t.nx[i]*o,t.y[i]+t.ny[i]*o,p.h);for(let k=0;k<4800;k++){p.ctl.throttle=0;p.ctl.brake=0;F1.Race.step(r,1/240);r.fx.length=0}return p.warnings})()""")
    check("one strike for one long trip off the track", js("__game.Game.race.player.warnings") == 1, js("__game.Game.race.player.warnings"))

    # ---------- time trial summary ----------
    js("__game.Game.quitToMenu()"); time.sleep(1.5)
    js("__game.quick({flow:{mode:'arcade',kind:'tt'}})"); js("__game.Game.flow.kind='tt'")
    time.sleep(0.5)
    to_green()
    js("__game.Game.race.autoPlayer=true")
    for _ in range(8):
        js("(()=>{const r=__game.Game.race;for(let k=0;k<4800;k++){F1.Race.step(r,1/240);r.fx.length=0}return 1})()")
        time.sleep(0.05)
    key("Escape", 0.6)
    js("F1.UI.go('ttend',{race:__game.Game.race})"); time.sleep(0.5)
    shot("tt_end")
    check("time trial summary", scr() == "scr-ttend", scr())
    errs = list(logs)
    check("no console errors", not errs, errs[:6])
    b.close()
srv.shutdown()
print("FAILED" if fails else "ALL PASSED", fails)
sys.exit(1 if fails else 0)
