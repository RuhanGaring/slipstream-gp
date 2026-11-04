"""The same set of views of a circuit every time, for judging graphics between rounds, and a
frame-time measure with the frame cap off.

usage: python tools/gallery.py shots OUTDIR [track ...]
       python tools/gallery.py perf OUTFILE.json [track ...]

shots  A spectated race, paused, with the free camera put at fixed places worked out from the
       track: the pit building, the grandstand, the grass at a corner, the view out across the
       terrain to the far hills, along the straight, above a corner; then a few moving shots.
perf   Chromium with vsync and its frame limit off, the player car on the AI, on the chase and T
       cameras: frames per second, median and 95th percentile frame time, and draw calls and
       triangles, at 1600 x 900 on the High preset. Close other GPU work first.
"""
import os, sys, json, time, pathlib, threading, functools, http.server, socketserver
from playwright.sync_api import sync_playwright

# (GAME_ROOT: another copy of the game, to compare it with this one under the same conditions)
ROOT = pathlib.Path(os.environ.get('GAME_ROOT') or pathlib.Path(__file__).resolve().parent.parent)
mode, target = sys.argv[1], pathlib.Path(sys.argv[2])
TRACKS = sys.argv[3:] or ['kestrel', 'hakone', 'sierra', 'rimal', 'montaurele']
BASE = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']
FREE = BASE + ['--disable-gpu-vsync', '--disable-frame-rate-limit']


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass


srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT)))
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

# The views, worked out in the page from the built track: [name, x, y, z, yaw, pitch, fov]
VIEWS = r"""() => {
  const G = __game.Game, tr = G.race.track, N = tr.N, g = (x, z) => F1.Tracks.groundAt(tr, x, z);
  const yaw = (ax, az, bx, bz) => Math.atan2(bz - az, bx - ax), out = [];
  const at = (i, d) => { const k = ((i % N) + N) % N; return [tr.x[k] + tr.nx[k] * d, tr.y[k] + tr.ny[k] * d, tr.z[k]]; };
  const pit = tr.pit, sd = pit && pit.side > 0 ? 1 : -1;
  const box = pit && pit.boxS ? Math.round(pit.boxS[Math.floor(pit.boxS.length / 2)] / tr.ds) : 0;
  // the pit building: from the far side of the straight, and from along the pit wall
  { const a = at(box, -sd * (tr.hw + 3)), b = at(box, sd * 30); out.push(['pit_across', a[0], a[2] + 1.6, a[1], yaw(a[0], a[1], b[0], b[1]), 0.08, 62]); }
  { const a = at(box - Math.round(70 / tr.ds), sd * (tr.hw + 2)), b = at(box + Math.round(30 / tr.ds), sd * 26); out.push(['pit_along', a[0], a[2] + 1.8, a[1], yaw(a[0], a[1], b[0], b[1]), 0.05, 58]); }
  // the first and the sharpest corners: at driver height at the edge of the road, looking out
  const ap = tr.apexes.slice().sort((p, q) => Math.abs(q.k) - Math.abs(p.k)), c0 = ap[0], c1 = ap[Math.min(2, ap.length - 1)];
  for (const [n, c] of [['corner_a', c0], ['corner_b', c1]]) {
    const s = c.k > 0 ? -1 : 1, a = at(c.i - Math.round(40 / tr.ds), s * (tr.hw + 1)), b = at(c.i + Math.round(20 / tr.ds), 0);
    out.push([n, a[0], a[2] + 1.3, a[1], yaw(a[0], a[1], b[0], b[1]), -0.01, 60]);
  }
  // grass (or whatever is there) at the feet, from beside the track, looking along the verge
  { const i = Math.round(N * 0.33), a = at(i, tr.barr[1][i] + 2.5), b = at(i + Math.round(60 / tr.ds), tr.barr[1][i] + 3); out.push(['verge', a[0], a[2] + 1.5, a[1], yaw(a[0], a[1], b[0], b[1]), -0.09, 55]); }
  // out across the country to the distant hills, four ways round from high on the lap
  let hi = 0; for (let i = 0; i < N; i++) if (tr.z[i] > tr.z[hi]) hi = i;
  const h = at(hi, 0);
  for (let k = 0; k < 4; k++) out.push(['far_' + 'nesw'[k], h[0], h[2] + 7, h[1], k * Math.PI / 2 + 0.4, 0.035, 50]);
  // along the longest straight, at T-cam height
  { const p = at(Math.round(N * 0.02), 0), q = at(Math.round(N * 0.02) + 40, 0); out.push(['straight', p[0], p[2] + 1.15, p[1], yaw(p[0], p[1], q[0], q[1]), 0, 68]); }
  // a broadcast view over the circuit
  { const c = [tr.x[0], tr.y[0]], cx = tr.x.reduce((a, v) => a + v, 0) / N, cz = tr.y.reduce((a, v) => a + v, 0) / N; out.push(['aerial', c[0], tr.z[0] + 90, c[1], yaw(c[0], c[1], cx, cz), -0.2, 62]); }
  return out.map(v => v.map(x => (typeof x === 'number' ? +x.toFixed(3) : x)));
}"""


def open_page(b, track):
    pg = b.new_page(viewport={'width': 1600, 'height': 900})
    logs = []
    pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type == 'error' else None)
    pg.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
    pg.goto(f'http://127.0.0.1:{port}/index.html?t={time.time()}', timeout=120000)
    pg.wait_for_function('window.__game && window.__game.ready', timeout=90000)
    pg.evaluate("t => { __game.Game.raceDefaults = Object.assign(__game.Game.raceDefaults || {}, { laps: 8 }); __game.quick({ flow: { track: t } }); }", track)
    pg.wait_for_function("t => { const G = __game.Game; return G.state === 'race' && G.race && G.race.track && G.race.track.id === t && G.race.phase !== 'lights' && G.race.phase !== 'grid'; }", arg=track, timeout=280000)
    pg.evaluate("() => { const G = __game.Game; G.race.autoPlayer = true; G.hudOn = false; G.settings.tags = false; const h = document.getElementById('hud'); if (h) h.classList.add('off'); }")
    return pg, logs


def snap(pg, path):
    # (with the GPU busy a screenshot can time out: once more, then carry on without that shot)
    for t in range(2):
        try:
            return pg.screenshot(path=str(path), type='jpeg', quality=90, timeout=45000)
        except Exception as e:
            print('  screenshot', path.name, 'failed:', str(e).split(chr(10))[0][:80])


def shots(b, track, out):
    pg, logs = open_page(b, track)
    d = out / track; d.mkdir(parents=True, exist_ok=True)
    time.sleep(10)
    for cam, secs in [('tcam', 3), ('chase', 3)]:
        pg.evaluate('c => { __game.Game.settings.camera = c; }', cam)
        for k in range(secs):
            time.sleep(7)
            snap(pg, d / f'run_{cam}_{k}.jpg')
    views = pg.evaluate(VIEWS)
    # stills with the free camera: the viewer takes over the render, the race carries on
    pg.evaluate("""() => { const G = __game.Game, V = F1.Viewer; G.spectate = true; V.start('spectate', G.race, { director: false, mode: 'free', focusId: G.race.cars[0].id, onExit: () => {} }); V.V.mode = 'free'; V.V.overlay = false; }""")
    time.sleep(0.5)
    for name, x, y, z, yaw, pitch, fov in views:
        pg.evaluate('f => { Object.assign(F1.Viewer.V.free, f); F1.Viewer.V.snap = true; }', dict(x=x, y=y, z=z, yaw=yaw, pitch=pitch, fov=fov))
        time.sleep(2.2)
        snap(pg, d / f'{name}.jpg')
    print(track, len(views), 'views', 'errors', len(logs))
    for l in logs[:5]: print('  ', l[:160])
    pg.close()


def perf(b, track):
    pg, logs = open_page(b, track)
    # (each pass of the post stack resets the renderer's counters, so they are added up per frame)
    pg.evaluate("""() => {
      window.__ft = []; window.__dc = [0, 0]; const r = F1.R3.renderer, o = r.render.bind(r); let c = 0, t3 = 0;
      r.render = (a, b) => { o(a, b); c += r.info.render.calls; t3 += r.info.render.triangles; };
      let t = performance.now();
      const f = () => { const n = performance.now(); window.__ft.push(n - t); t = n; window.__dc = [c, t3]; c = 0; t3 = 0; requestAnimationFrame(f); };
      requestAnimationFrame(f);
    }""")
    time.sleep(8)
    res = {}
    for cam in ['chase', 'tcam']:
        pg.evaluate('c => { __game.Game.settings.camera = c; window.__ft.length = 0; }', cam)
        time.sleep(20)
        a = sorted(pg.evaluate('() => window.__ft.slice(5)'))
        inf = pg.evaluate('() => { const i = F1.R3.renderer.info; return [window.__dc[0], window.__dc[1], i.memory.geometries, i.memory.textures]; }')
        n = len(a)
        res[cam] = {'fps': round(n / (sum(a) / 1000), 1), 'ms50': round(a[n // 2], 2), 'ms95': round(a[int(n * .95)], 2), 'ms99': round(a[int(n * .99)], 2), 'calls': inf[0], 'tris': inf[1], 'geos': inf[2], 'texs': inf[3]}
    res['errors'] = len(logs)
    pg.close()
    return res


with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=FREE if mode == 'perf' else BASE)
    if mode == 'shots':
        target.mkdir(parents=True, exist_ok=True)
        for t in TRACKS: shots(b, t, target)
    else:
        all_ = {}
        for t in TRACKS:
            all_[t] = perf(b, t); print(t, json.dumps(all_[t]))
        target.write_text(json.dumps(all_, indent=1))
    b.close()
