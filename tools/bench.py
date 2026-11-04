"""The same frames every time, to compare builds: python tools/bench.py OUT.json TRACK [view count]

A race runs with the free camera put at fixed places round the lap at driver height, the frame cap
off and any AI learning cancelled. For each view: wall time per frame, JavaScript time inside the
renderer, GPU time from timer queries, draw calls and triangles. Set GAME_ROOT to bench another copy.
Close other GPU work first; run builds alternately and compare, one run proves little.
"""
import os, sys, json, time, pathlib, functools, threading, http.server, socketserver
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(os.environ.get('GAME_ROOT') or pathlib.Path(__file__).resolve().parent.parent)
out, track = sys.argv[1], sys.argv[2]
NV = int(sys.argv[3]) if len(sys.argv) > 3 else 8


class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass


srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Q, directory=str(ROOT)))
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
ARGS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--disable-gpu-vsync', '--disable-frame-rate-limit']
HOOK = r"""() => {
  const G = __game.Game, R = F1.R3, r = R.renderer, gl = r.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  try { F1.LearnJob && F1.LearnJob.cancel(); } catch (e) {}
  G.race.autoPlayer = true; G.hudOn = false; G.settings.tags = false;
  const M = window.__m = { ft: [], js: [], gpu: [], calls: 0, tris: 0, c: 0, t: 0 };
  const o = r.render.bind(r);
  r.render = (a, b) => { o(a, b); M.c += r.info.render.calls; M.t += r.info.render.triangles; };
  const pending = [], rd = R.render;
  R.render = p => {
    const t0 = performance.now(), q = ext && !pending.length ? gl.createQuery() : null;
    if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    rd(p);
    if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(q); }
    M.js.push(performance.now() - t0);
  };
  let t = performance.now();
  const f = () => {
    const n = performance.now(); M.ft.push(n - t); t = n; M.calls = M.c; M.tris = M.t; M.c = M.t = 0;
    if (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const q = pending.shift(), bad = gl.getParameter(ext.GPU_DISJOINT_EXT);
      if (!bad) M.gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
    }
    requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
}"""
FREE = r"""() => { const G = __game.Game, V = F1.Viewer; G.spectate = true; V.start('spectate', G.race, { director: false, mode: 'free', focusId: G.race.cars[0].id, onExit: () => {} }); V.V.mode = 'free'; }"""
VIEWS = r"""n => { const t = __game.Game.race.track, N = t.N, o = []; for (let k = 0; k < n; k++) { const i = Math.floor(N * (k + 0.5) / n), j = (i + 14) % N; o.push({ x: t.x[i], y: t.z[i] + 1.15, z: t.y[i], yaw: Math.atan2(t.y[j] - t.y[i], t.x[j] - t.x[i]), pitch: -0.02, fov: 66 }); } return o; }"""

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=ARGS)
    pg = b.new_page(viewport={'width': 1600, 'height': 900})
    pg.on('pageerror', lambda e: print('pageerror', str(e)[:200]))
    pg.goto(f'http://127.0.0.1:{port}/index.html?t={time.time()}', timeout=120000)
    pg.wait_for_function('window.__game && window.__game.ready', timeout=90000)
    pg.evaluate("t => { __game.Game.raceDefaults = Object.assign(__game.Game.raceDefaults || {}, { laps: 30 }); __game.quick({ flow: { track: t } }); setInterval(() => { try { F1.LearnJob && F1.LearnJob.cancel(); } catch (e) {} }, 200); }", track)
    pg.wait_for_function("t => { const G = __game.Game; return G.state === 'race' && G.race && G.race.track && G.race.track.id === t && G.race.phase !== 'lights' && G.race.phase !== 'grid'; }", arg=track, timeout=280000)
    pg.evaluate(HOOK)
    pg.evaluate(FREE)
    time.sleep(6)
    res, views = [], pg.evaluate(VIEWS, NV)
    for k, v in enumerate(views):
        pg.evaluate('f => { Object.assign(F1.Viewer.V.free, f); F1.Viewer.V.snap = true; }', v)
        time.sleep(1.2)
        pg.evaluate('() => { const m = window.__m; m.ft.length = m.js.length = m.gpu.length = 0; }')
        time.sleep(3.2)
        m = pg.evaluate('() => { const m = window.__m; return { ft: m.ft.slice(), js: m.js.slice(), gpu: m.gpu.slice(), calls: m.calls, tris: m.tris }; }')
        avg = lambda a: round(sum(a) / max(1, len(a)), 2)
        ft = sorted(m['ft'])
        res.append({'ms': avg(m['ft']), 'p95': round(ft[int(len(ft) * .95)], 1) if ft else 0, 'js': avg(m['js']), 'gpu': avg(m['gpu']), 'calls': m['calls'], 'tris': m['tris']})
    b.close()
tot = lambda k: round(sum(r[k] for r in res) / len(res), 2)
summary = {'ms': tot('ms'), 'fps': round(1000 / tot('ms'), 1), 'p95': tot('p95'), 'js': tot('js'), 'gpu': tot('gpu'), 'calls': round(tot('calls')), 'tris': round(tot('tris'))}
print(json.dumps(summary))
pathlib.Path(out).write_text(json.dumps({'summary': summary, 'views': res}, indent=1))
