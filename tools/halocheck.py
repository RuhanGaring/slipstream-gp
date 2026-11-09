"""Regression check for the pale outline round a car against its shadow on the road.

It came back twice: first from reading the half-size AO plainly (fixed by the depth-aware
upsample in the composite), then from the AO and TAA histories, which follow the camera only:
in the chase camera the car stays put on screen while the road slides under it, so the road
beside the car took the car's own unshadowed value from the frame before. Each history now
keeps its depth and drops a carried-over value from a different surface (js/r3-post.js).

The check races in the chase and T cameras with window.__aoProbe on (js/r3-post.js aoProbe):
each frame it counts road pixels whose carried-over occlusion is far brighter than the frame's
own. It also saves a crop round the player's car for the eye. Run it after any change to the
post stack, the car's ground shading or the shadows.

usage: python tools/halocheck.py OUTDIR [track ...]      exit code 1 on a failure
       PRESET=ultra python tools/halocheck.py ...      on a graphics preset (default: High with
                                                         post, TAA and AO forced on)
"""
import os, sys, time, json, pathlib, threading, functools, http.server, socketserver
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
tracks = sys.argv[2:] or ['kestrel', 'montaurele']
PRESET = os.environ.get('PRESET', '')
LIMIT = 0.001  # share of road pixels allowed to carry a ghost value: the bug measured 0.28% in the T camera, the fix 0.05%


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass


srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT)))
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
fails = 0
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'])
    for track in tracks:
        pg = b.new_page(viewport={'width': 1600, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(str(e)))
        pg.goto(f'http://127.0.0.1:{port}/index.html?t={time.time()}', timeout=120000)
        pg.wait_for_function('window.__game && window.__game.ready', timeout=120000)
        pg.evaluate("([t, P]) => { localStorage.setItem('slip_seen','true'); const G = __game.Game; G.settings.autoQ = false; Object.assign(G.settings.gfx, P ? Object.assign({}, G.GFX_PRESETS[P], { preset: P }) : { post: true, taa: true, ssao: true }); G.applySettings(); __game.quick({ flow: { track: t }, race: { laps: 8 } }); }", [track, PRESET])
        pg.wait_for_function("t => { const G = __game.Game; return G.state === 'race' && G.race.track.id === t && G.race.green; }", arg=track, timeout=280000)
        pg.evaluate("() => { const G = __game.Game; G.race.autoPlayer = true; G.hudOn = false; document.getElementById('hud').classList.add('off'); }")
        time.sleep(8)
        for cam in ['chase', 'tcam']:
            pg.evaluate("c => { __game.Game.settings.camera = c; }", cam)
            time.sleep(2)
            pg.evaluate("() => { window.__aoProbeOut = []; window.__aoProbe = true; }")
            time.sleep(4)
            r = pg.evaluate("() => { window.__aoProbe = false; const a = window.__aoProbeOut || []; const s = a.map(x => x[0]).sort((p, q) => p - q), avg = k => a.length ? a.reduce((p, x) => p + x[k], 0) / a.length : 0; return [a.length, avg(0), s.length ? s[Math.floor(s.length * 0.95)] : 0, __game.Game.race.player.speed, avg(2), avg(3)]; }")
            frames, mean, p95, speed, mc, mt = r
            # both buffers must read back real values (a failed read gives zeros and a false pass)
            sane = mc > 0.2 and mt > 0.2 and abs(mt - mc) < 0.15
            ok = frames > 10 and mean < LIMIT and speed > 8 and sane  # (moving: 29 km/h and up, a hairpin counts)
            if not sane: print(f'  probe read failed: mean AO this frame {mc:.3f}, carried over {mt:.3f}')
            fails += not ok
            print(f"{'PASS' if ok else 'FAIL'} {track} {cam}: ghost share mean {mean * 100:.3f}%  p95 {p95 * 100:.3f}%  over {frames} frames at {speed * 3.6:.0f} km/h (limit {LIMIT * 100:.1f}%)", flush=True)
            # a crop round the player's car (screen centre, lower half) for the eye
            pg.screenshot(path=str(out / f'{track}_{cam}.png'), clip={'x': 500, 'y': 420, 'width': 600, 'height': 360})
        if logs: print('  page errors:', logs[:3]); fails += 1
        pg.close()
    b.close()
print('ALL PASSED' if not fails else f'{fails} FAILED')
sys.exit(1 if fails else 0)
