"""Where the driver's gloves pass through the steering wheel, per car.

Boots the game in GPU Chromium, builds each team's car, poses its cockpit (wheel straight and
turned), and tests every glove triangle against every steering-wheel triangle for a real
crossing (triangle-triangle intersection, a spatial grid keeps it quick). Prints, per car and
steering angle, how many glove triangles clip, split into thumb, fingers and palm/back, and how
far into the wheel the deepest one goes. With an output folder it also renders each right hand
with the clipping triangles in red.

usage: python tools/handclip.py [OUTDIR] [team,team,...]
   env: OPEN=k  open the fists by k for this run (G.__fingerOpen); THUMB='[x,y,z,a]' thumb bend
        OFFSET='[x,y,z]' shift the grip point (OFFSET='[0.3,0,0]' is the self-test: nothing may clip)
        SEARCH=1  for each team, try shifts of the grip point and list the best: fewest glove
                  triangles crossing the wheel for most in contact with it; SIZES='[1,1.2]' also
                  tries widening the fist round the bar
"""
import sys, os, json, base64, time, functools, http.server, socketserver, threading, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] != '-' else None
TEAMS = [int(t) for t in sys.argv[2].split(',')] if len(sys.argv) > 2 else None
if OUT: OUT.mkdir(parents=True, exist_ok=True)

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT)))
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

JS = r"""([ti, steers, shoot]) => {
  const team = F1.Data.TEAMS[ti], MD = F1.R3Car.model(team);
  const car = F1.R3Car.makeCar(team, team.drivers[0][3], 'M'), ck = car.userData.cockpit;
  F1.R3Car.setLod(car, 0, true); car.updateMatrixWorld(true);
  const V = THREE.Vector3;
  // ---- the wheel's triangles in the wheel's frame (they turn with it: the hands do too) ----
  const W = [];
  for (const p of MD.swParts) {
    const P = p.G.attributes.position, ix = p.G.index.array;
    for (let t = 0; t < ix.length; t += 3) W.push(new V().fromBufferAttribute(P, ix[t]), new V().fromBufferAttribute(P, ix[t + 1]), new V().fromBufferAttribute(P, ix[t + 2]));
  }
  const CELL = 0.01, grid = new Map(), key = (i, j, k) => i + ',' + j + ',' + k;
  for (let t = 0; t < W.length; t += 3) {
    const a = W[t], b = W[t + 1], c = W[t + 2];
    const i0 = Math.floor(Math.min(a.x, b.x, c.x) / CELL), i1 = Math.floor(Math.max(a.x, b.x, c.x) / CELL);
    const j0 = Math.floor(Math.min(a.y, b.y, c.y) / CELL), j1 = Math.floor(Math.max(a.y, b.y, c.y) / CELL);
    const k0 = Math.floor(Math.min(a.z, b.z, c.z) / CELL), k1 = Math.floor(Math.max(a.z, b.z, c.z) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) { const q = key(i, j, k); let l = grid.get(q); if (!l) grid.set(q, l = []); l.push(t); }
  }
  // ---- segment-triangle crossing (Moller-Trumbore); two triangles cross if an edge of one
  // pierces the other ----
  const e1 = new V(), e2 = new V(), pv = new V(), tv = new V(), qv = new V(), dir = new V();
  function segTri(p0, p1, a, b, c) {
    dir.subVectors(p1, p0); e1.subVectors(b, a); e2.subVectors(c, a); pv.crossVectors(dir, e2);
    const det = e1.dot(pv); if (Math.abs(det) < 1e-12) return false;
    const inv = 1 / det; tv.subVectors(p0, a); const u = tv.dot(pv) * inv; if (u < 0 || u > 1) return false;
    qv.crossVectors(tv, e1); const v = dir.dot(qv) * inv; if (v < 0 || u + v > 1) return false;
    const t = e2.dot(qv) * inv; return t >= 0 && t <= 1;
  }
  const triTri = (a, b, c, d, e, f) => segTri(a, b, d, e, f) || segTri(b, c, d, e, f) || segTri(c, a, d, e, f) || segTri(d, e, a, b, c) || segTri(e, f, a, b, c) || segTri(f, d, a, b, c);
  // ---- the glove: which triangles are thumb, fingers, palm (rest hand frame, as thumbBend and
  // fingerOpen pick them) ----
  const A = F1.R3Car.armData(), root = new V(0.012, 0.008, 0.008), tax = new V(0.008, -0.008, 0.064), TL = tax.length(); tax.normalize();
  const part = new Int8Array(A.n).fill(-1), v0 = new V(), d0 = new V();
  for (let i = 0; i < A.n; i++) {
    if (A.zone[i] !== 1 && A.zone[i] !== 3) continue; // glove and knuckle panel
    v0.set(A.car[i * 3], A.car[i * 3 + 1], A.car[i * 3 + 2]).applyMatrix4(A.RF0inv); d0.subVectors(v0, root);
    const t = d0.dot(tax) / TL, r = d0.clone().addScaledVector(tax, -d0.dot(tax)).length();
    if (A.w[i * 5 + 4] >= 100 && t > 0.05 && r < 0.02) part[i] = 0;          // thumb
    else if (Math.abs(Math.atan2(v0.y, -v0.x)) > 1.2 && Math.hypot(v0.x, v0.y) < 0.07) part[i] = 1; // fingers, round the grip
    else part[i] = 2;                                                      // palm and back of the hand
  }
  const NAMES = ['thumb', 'fingers', 'palm'];
  // OFFSET (env): shift the grip point, for a self-test (30 cm out: nothing may clip)
  if (window.__gripOff) ck.grip = ck.grip.map((g, i) => g + (window.__gripOff[i] || 0));
  const results = [], shots = [];
  let gloveTris = 0; { const ix = ck.arms[0].mesh.geometry.index.array; for (let t = 0; t < ix.length; t += 3) if (part[ix[t]] >= 0 && part[ix[t + 1]] >= 0 && part[ix[t + 2]] >= 0) gloveTris++; }
  for (const steer of steers) {
    ck.steer = null; F1.R3Car.updateCockpit(car, steer); ck.pivot.updateMatrix(); ck.spin.updateMatrix();
    const toWheel = new THREE.Matrix4().multiplyMatrices(ck.pivot.matrix, ck.spin.matrix).invert();
    const res = { steer, tris: [0, 0, 0], deep: 0 }, hit = [];
    for (const arm of ck.arms) {
      const g = arm.mesh.geometry, P = g.attributes.position, ix = g.index.array, n = P.count;
      const S = new Array(n);
      const pos = new V();
      // skinned, in the wheel's frame; the left hand's x mirrored onto the right
      for (let i = 0; i < n; i++) { if (part[i] < 0) continue; arm.mesh.applyBoneTransform(i, pos.fromBufferAttribute(P, i)); S[i] = pos.clone().applyMatrix4(toWheel); }
      const flags = arm.sd > 0 ? new Uint8Array(ix.length / 3) : null;
      for (let t = 0; t < ix.length; t += 3) {
        const ia = ix[t], ib = ix[t + 1], ic = ix[t + 2];
        if (part[ia] < 0 || part[ib] < 0 || part[ic] < 0) continue;
        const a = S[ia], b = S[ib], c = S[ic];
        const i0 = Math.floor(Math.min(a.x, b.x, c.x) / CELL), i1 = Math.floor(Math.max(a.x, b.x, c.x) / CELL);
        const j0 = Math.floor(Math.min(a.y, b.y, c.y) / CELL), j1 = Math.floor(Math.max(a.y, b.y, c.y) / CELL);
        const k0 = Math.floor(Math.min(a.z, b.z, c.z) / CELL), k1 = Math.floor(Math.max(a.z, b.z, c.z) / CELL);
        let crossed = false; const seen = new Set();
        for (let i = i0; i <= i1 && !crossed; i++) for (let j = j0; j <= j1 && !crossed; j++) for (let k = k0; k <= k1 && !crossed; k++) {
          const l = grid.get(key(i, j, k)); if (!l) continue;
          for (const w of l) { if (seen.has(w)) continue; seen.add(w); if (triTri(a, b, c, W[w], W[w + 1], W[w + 2])) { crossed = true; break; } }
        }
        if (crossed) { res.tris[part[ia]]++; if (flags) flags[t / 3] = 1; }
      }
      if (flags) hit.push(flags);
    }
    res.total = res.tris[0] + res.tris[1] + res.tris[2];
    res.by = Object.fromEntries(NAMES.map((nm, i) => [nm, res.tris[i]]));
    delete res.tris;
    results.push(res);
    // ---- the right hand with its clipping triangles in red, from behind it and from above ----
    if (shoot && steer === steers[0]) {
      const R = F1.R3.renderer, sc = new THREE.Scene(); sc.background = new THREE.Color(0x9aa6b8);
      sc.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2.4)); const dl = new THREE.DirectionalLight(0xffffff, 2); dl.position.set(-2, 2, 1); sc.add(dl);
      car.userData.lodGroups.forEach(g => g.visible = false); car.userData.wheels.forEach(w => w.visible = false); if (car.userData.far) car.userData.far.visible = false;
      ck.helmet.forEach(m => m.visible = false); ck.group.children.forEach(ch => { if (ch !== ck.pivot && !ch.isSkinnedMesh) ch.visible = false; });
      const right = ck.arms.find(x => x.sd > 0), g = right.mesh.geometry, ix = g.index.array, col = new Float32Array(g.attributes.position.count * 3).fill(0.32);
      hit[0].forEach((h, t) => { if (h) for (let k = 0; k < 3; k++) { const v = ix[t * 3 + k]; col[v * 3] = 1; col[v * 3 + 1] = 0.05; col[v * 3 + 2] = 0.05; } });
      const gg = g.clone(); gg.setAttribute('color', new THREE.BufferAttribute(col, 3));
      right.mesh.geometry = gg; right.mesh.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
      ck.arms.filter(x => x.sd < 0).forEach(x => { x.mesh.visible = false; });
      sc.add(car); car.updateMatrixWorld(true);
      const cam = new THREE.PerspectiveCamera(30, 16 / 9, 0.01, 20);
      for (const [e, l] of [[[0.6, 0.76, 0.2], [0.85, 0.68, 0.13]], [[0.85, 0.95, 0.15], [0.85, 0.68, 0.13]], [[1.12, 0.73, 0.17], [0.85, 0.68, 0.13]]]) {
        cam.position.set(...e); cam.lookAt(...l); cam.updateMatrixWorld(); R.setRenderTarget(null); R.render(sc, cam); shots.push(R.domElement.toDataURL('image/jpeg', 0.85));
      }
    }
  }
  return { car: team.car, results, shots, glove: gloveTris, wheel: W.length / 3 };
}"""

SEARCH_JS = r"""([ti]) => {
  const team = F1.Data.TEAMS[ti], car = F1.R3Car.makeCar(team, team.drivers[0][3], 'M'), ck = car.userData.cockpit, MD = F1.R3Car.model(team);
  F1.R3Car.setLod(car, 0, true); car.updateMatrixWorld(true);
  const V = THREE.Vector3, W = [];
  for (const p of MD.swParts) { const P = p.G.attributes.position, ix = p.G.index.array; for (let t = 0; t < ix.length; t += 3) W.push(new V().fromBufferAttribute(P, ix[t]), new V().fromBufferAttribute(P, ix[t + 1]), new V().fromBufferAttribute(P, ix[t + 2])); }
  const CELL = 0.008, grid = new Map(), key = (i, j, k) => i + ',' + j + ',' + k;
  for (let t = 0; t < W.length; t += 3) { const a = W[t], b = W[t + 1], c = W[t + 2];
    for (let i = Math.floor(Math.min(a.x, b.x, c.x) / CELL); i <= Math.floor(Math.max(a.x, b.x, c.x) / CELL); i++) for (let j = Math.floor(Math.min(a.y, b.y, c.y) / CELL); j <= Math.floor(Math.max(a.y, b.y, c.y) / CELL); j++) for (let k = Math.floor(Math.min(a.z, b.z, c.z) / CELL); k <= Math.floor(Math.max(a.z, b.z, c.z) / CELL); k++) { const q = key(i, j, k); let l = grid.get(q); if (!l) grid.set(q, l = []); l.push(t); } }
  const e1 = new V(), e2 = new V(), pv = new V(), tv = new V(), qv = new V(), dir = new V();
  function segTri(p0, p1, a, b, c) { dir.subVectors(p1, p0); e1.subVectors(b, a); e2.subVectors(c, a); pv.crossVectors(dir, e2); const det = e1.dot(pv); if (Math.abs(det) < 1e-12) return false; const inv = 1 / det; tv.subVectors(p0, a); const u = tv.dot(pv) * inv; if (u < 0 || u > 1) return false; qv.crossVectors(tv, e1); const v = dir.dot(qv) * inv; if (v < 0 || u + v > 1) return false; const t = e2.dot(qv) * inv; return t >= 0 && t <= 1; }
  const triTri = (a, b, c, d, e, f) => segTri(a, b, d, e, f) || segTri(b, c, d, e, f) || segTri(c, a, d, e, f) || segTri(d, e, a, b, c) || segTri(e, f, a, b, c) || segTri(f, d, a, b, c);
  const arm = ck.arms.find(x => x.sd > 0), g = arm.mesh.geometry, P = g.attributes.position, ix = g.index.array, col = g.attributes.color;
  const glove = new Uint8Array(P.count); for (let i = 0; i < P.count; i++) glove[i] = col.getY(i) > 0.5 || col.getZ(i) > 0.5 ? 1 : 0;
  const g0 = ck.grip.slice(), S = new Array(P.count), pos = new V();
  const evalAt = (off, k) => {
    ck.grip = [g0[0] + off[0], g0[1] + off[1], g0[2] + off[2], k || g0[3] || 1]; ck.steer = null; F1.R3Car.updateCockpit(car, 0); ck.pivot.updateMatrix(); ck.spin.updateMatrix();
    const toWheel = new THREE.Matrix4().multiplyMatrices(ck.pivot.matrix, ck.spin.matrix).invert();
    for (let i = 0; i < P.count; i++) if (glove[i]) { arm.mesh.applyBoneTransform(i, pos.fromBufferAttribute(P, i)); S[i] = (S[i] || new V()).copy(pos).applyMatrix4(toWheel); }
    let cross = 0, near = 0;
    for (let t = 0; t < ix.length; t += 3) {
      const ia = ix[t], ib = ix[t + 1], ic = ix[t + 2]; if (!glove[ia] || !glove[ib] || !glove[ic]) continue;
      const a = S[ia], b = S[ib], c = S[ic]; let isNear = false, crossed = false; const seen = new Set();
      for (let i = Math.floor(Math.min(a.x, b.x, c.x) / CELL); i <= Math.floor(Math.max(a.x, b.x, c.x) / CELL) && !crossed; i++) for (let j = Math.floor(Math.min(a.y, b.y, c.y) / CELL); j <= Math.floor(Math.max(a.y, b.y, c.y) / CELL) && !crossed; j++) for (let k = Math.floor(Math.min(a.z, b.z, c.z) / CELL); k <= Math.floor(Math.max(a.z, b.z, c.z) / CELL) && !crossed; k++) {
        const l = grid.get(key(i, j, k)); if (!l) continue; isNear = true;
        for (const w of l) { if (seen.has(w)) continue; seen.add(w); if (triTri(a, b, c, W[w], W[w + 1], W[w + 2])) { crossed = true; break; } }
      }
      if (crossed) cross++; if (isNear) near++;
    }
    return [cross, near];
  };
  const base = evalAt([0, 0, 0]), res = [];
  for (const k of (window.__sizes || [1])) for (let dx = -0.02; dx <= 0.0201; dx += 0.005) for (let dz = -0.03; dz <= 0.0301; dz += 0.005) for (const dy of [-0.01, 0, 0.01]) {
    const [cross, near] = evalAt([dx, dy, dz], k);
    // fewest crossings, but a hand must keep hold: at least 80 per cent of the triangles it had near the wheel
    if (near >= 0.8 * base[1]) res.push([cross, near, +dx.toFixed(3), dy, +dz.toFixed(3), k]);
  }
  ck.grip = g0;
  res.sort((p1, p2) => p1[0] - p2[0] || p2[1] - p1[1]);
  return { car: team.car, open: window.__fingerOpen != null ? window.__fingerOpen : 'car default', base, best: res.slice(0, 5) };
}"""

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
    pg = b.new_page(viewport={"width": 1280, "height": 720})
    pg.goto(f"http://127.0.0.1:{port}/index.html", timeout=300000)
    pg.wait_for_function("window.__game && window.__game.ready", timeout=300000)
    pg.evaluate("__game.Game.paused = true")
    # the arms were built (and their geometry cached) at boot: rebuild them with the overrides
    if os.environ.get('OPEN'): pg.evaluate('window.__fingerOpen = ' + os.environ['OPEN'])
    if os.environ.get('THUMB'): pg.evaluate('window.__thumb = ' + os.environ['THUMB'])
    if os.environ.get('OPEN') or os.environ.get('THUMB'): pg.evaluate('F1.R3Car.rebuildArms()')
    if os.environ.get('OFFSET'): pg.evaluate('window.__gripOff = ' + os.environ['OFFSET'])
    if os.environ.get('SIZES'): pg.evaluate('window.__sizes = ' + os.environ['SIZES'])
    teams = TEAMS if TEAMS is not None else [0, 1, 2, 3, 4, 5, 6, 8, 9]
    if os.environ.get('SEARCH'):
        for ti in teams: print(json.dumps(pg.evaluate(SEARCH_JS, [ti])))
        teams = []
    for ti in teams:
        r = pg.evaluate(JS, [ti, [0, 0.25, -0.25], bool(OUT)])
        line = ' | '.join(f"steer {x['steer']:+.2f}: {x['total']:3d} ({', '.join(f'{k} {v}' for k, v in x['by'].items())})" for x in r['results'])
        print(f"{r['car']:6s} {line}   [glove tris {r['glove']}, wheel tris {r['wheel']}]")
        for i, s in enumerate(r['shots']):
            (OUT / f"{r['car']}_{i}.jpg").write_bytes(base64.b64decode(s.split(',')[1]))
    b.close()
srv.shutdown()
