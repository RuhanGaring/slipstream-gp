"""Frame time of a real race, split by where it goes (js/perf.js): a 20-car Legend race with the
player's car on autopilot in the chase camera, the frame cap and vsync off, HUD on.

usage: python tools/perfbench.py OUT.json TRACK [TRACK ...]
  env: GAME_ROOT   another copy of the game to bench (default: this one)
       SECONDS     seconds measured per circuit (default 24, in 4 windows round the lap)
       PRESET      graphics preset (default high); auto quality and dynamic resolution are off
       VW, VH      viewport (default 1920x1080)
       SHOTS       a folder: also saves one paused frame per fixed view round the lap (free
                   camera at driver height), the same views every run, to compare builds by eye
Timings are best compared by running builds alternately: other load on the machine moves the
absolute numbers a lot. Runs one circuit at a time on purpose: two at once would share the GPU
and the CPU and measure each other.
"""
import os, sys, json, time, pathlib, functools, threading, http.server, socketserver
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(os.environ.get('GAME_ROOT') or pathlib.Path(__file__).resolve().parent.parent)
out, tracks = sys.argv[1], sys.argv[2:] or ['kestrel']
SECS = float(os.environ.get('SECONDS', 24))
PRESET = os.environ.get('PRESET', 'high')
W, H = int(os.environ.get('VW', 1920)), int(os.environ.get('VH', 1080))
SHOTS = os.environ.get('SHOTS')
WIN = 4


class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass


srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Q, directory=str(ROOT)))
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
ARGS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
        '--disable-gpu-vsync', '--disable-frame-rate-limit']
T0 = time.time()
steps_total = len(tracks) * (WIN + (8 if SHOTS else 0))
done = 0


def bar(label):
    k = done / steps_total
    el = time.time() - T0
    eta = el / k - el if k > 0 else 0
    print(f'\r[{"#" * int(k * 30):<30}] {k * 100:5.1f}%  ETA {eta:5.0f}s  {label:<40}', end='', flush=True)


START = r"""([t, P]) => {
  localStorage.setItem('slip_seen', 'true');
  const G = __game.Game;
  G.settings.autoQ = false;
  Object.assign(G.settings.gfx, G.GFX_PRESETS[P], { preset: P, drs: false, fpsCap: 0 });
  G.settings.camera = 'chase';
  G.applySettings();
  __game.quick({ flow: { track: t }, race: { laps: 30, difficulty: 4, field: 20, grid: 10 } });
  // (circuit learning before the race is not what is measured)
  setInterval(() => { try { F1.LearnJob && F1.LearnJob.cancel(); } catch (e) {} }, 200);
}"""
SUM = r"""() => {
  const a = F1.Perf.rec || [], n = a.length || 1, o = { frames: a.length };
  for (const k of ['frame', 'cpu', 'sim', 'game', 'scene', 'shadow', 'main', 'post', 'steps', 'calls', 'shCalls', 'tris']) o[k] = a.reduce((s, c) => s + c[k], 0) / n;
  const g = a.filter(c => c.gpu >= 0); o.gpu = g.length ? g.reduce((s, c) => s + c.gpu, 0) / g.length : -1;
  const ft = a.map(c => c.frame).sort((x, y) => x - y); o.p50 = ft[Math.floor(ft.length / 2)] || 0; o.p95 = ft[Math.floor(ft.length * 0.95)] || 0; o.p99 = ft[Math.floor(ft.length * 0.99)] || 0;
  const r = __game.Game.race; o.speed = r.player.speed * 3.6; o.lap = r.player.lapTimes.length; o.cars = r.cars.filter(c => !c.retired).length;
  F1.Perf.rec = [];
  return o;
}"""
VIEWS = r"""n => { const t = __game.Game.race.track, N = t.N, o = []; for (let k = 0; k < n; k++) { const i = Math.floor(N * (k + 0.5) / n), j = (i + 14) % N; o.push({ x: t.x[i], y: t.z[i] + 1.15, z: t.y[i], yaw: Math.atan2(t.y[j] - t.y[i], t.x[j] - t.x[i]), pitch: -0.02, fov: 66 }); } return o; }"""

res = {}
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=ARGS)
    for track in tracks:
        bar(track + ': loading')
        pg = b.new_page(viewport={'width': W, 'height': H})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
        pg.goto(f'http://127.0.0.1:{port}/index.html?t={time.time()}', timeout=120000)
        pg.wait_for_function('window.__game && window.__game.ready', timeout=120000)
        pg.evaluate(START, [track, PRESET])
        pg.wait_for_function("t => { const G = __game.Game; return G.state === 'race' && G.race && G.race.track.id === t && G.race.green; }", arg=track, timeout=400000)
        pg.evaluate("() => { __game.Game.race.autoPlayer = true; F1.Perf.set(true); }")
        time.sleep(5)
        wins = []
        for w in range(WIN):
            bar(f'{track}: window {w + 1}/{WIN}')
            pg.evaluate('() => { F1.Perf.rec = []; }')
            time.sleep(SECS / WIN)
            wins.append(pg.evaluate(SUM))
            done += 1
        n = sum(x['frames'] for x in wins) or 1
        avg = {k: round(sum(x[k] * x['frames'] for x in wins) / n, 3) for k in wins[0] if k not in ('frames', 'lap', 'cars', 'speed')}
        avg['frames'] = n
        avg['fps'] = round(1000 / avg['frame'], 1) if avg['frame'] else 0
        info = pg.evaluate("() => { const s = F1.Perf.snapshot(); return { res: s.res, preset: s.preset, cars: __game.Game.race.cars.length, diff: __game.Game.race.difficulty, threads: navigator.hardwareConcurrency }; }")
        res[track] = {'avg': avg, 'windows': wins, 'info': info, 'errors': errs[:5]}
        if SHOTS:
            d = pathlib.Path(SHOTS); d.mkdir(parents=True, exist_ok=True)
            pg.evaluate("() => { F1.Perf.set(false); const G = __game.Game, V = F1.Viewer; G.spectate = true; V.start('spectate', G.race, { director: false, mode: 'free', focusId: G.race.cars[0].id, onExit: () => {} }); V.V.mode = 'free'; }")
            views = pg.evaluate(VIEWS, 8)
            for k, v in enumerate(views):
                bar(f'{track}: view {k + 1}/8')
                pg.evaluate('f => { Object.assign(F1.Viewer.V.free, f); F1.Viewer.V.snap = true; }', v)
                time.sleep(1.5)
                pg.screenshot(path=str(d / f'{track}_{k}.png'))
                done += 1
        pg.close()
    b.close()
bar('done'); print()
for t, r in res.items():
    a = r['avg']
    print(f"{t:<16} frame {a['frame']:.2f} ms ({a['fps']} fps, p95 {a['p95']:.1f})  cpu {a['cpu']:.2f}  gpu {a['gpu']:.2f} | sim {a['sim']:.2f} ({a['steps']:.1f} st)  game {a['game']:.2f}  scene {a['scene']:.2f}  shadow {a['shadow']:.2f}  main {a['main']:.2f}  post {a['post']:.2f} | draws {a['calls']:.0f} (sh {a['shCalls']:.0f})  tris {a['tris'] / 1e6:.2f} M", flush=True)
    if r['errors']: print('  page errors:', r['errors'])
pathlib.Path(out).write_text(json.dumps(res, indent=1))
