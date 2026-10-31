"""A car's own hand pose on its steering wheel, found by a contact simulation on real finger bones.

The driver's glove (js/assets/arm.js) is the MakeHuman base mesh's arm (CC0) posed once round a
round bar. This tool re-poses it on the base mesh's own skeleton (tools/data/makehuman_arm.json:
the rest mesh, the bones' heads and the artist's skin weights): every finger has its knuckle,
middle and end joint, each phalanx is a bone, and the skin follows by linear blend skinning, so
the glove bends at its joints and keeps its lengths. The cloth goes back on as
tools/assets_arm.py puts it on (pushed out along the normals by its thickness).

The simulation runs against the car's real steering wheel: its triangles, taken from the game in
GPU Chromium and put in the hand's frame, made into a signed distance field (the surface
voxelized at 1 mm, the outside flood-filled from the box's border, the rest solid, so a mesh that
is not watertight still has an inside).
  1. The palm settles onto the handle: the shortest push that leaves the palm and every finger's
     root clear of it (the glove was posed round a thinner bar than most handles).
  2. The thumb takes the curl (about its own axis, as the game's thumbBend) nearest the one aimed
     through the thumb hole that keeps it clear.
  3. Each finger comes to rest where its joints' pull toward a relaxed grip (springs on every
     joint toward 55 to 64, 65 and 40 degrees) balances the handle's push (stiff contact springs
     on every glove vertex closer than 0.4 mm), within the joints' natural range: a coarse search,
     then Powell's method.
Writes js/assets/handpose.js (F1.Assets.handPose): per car the posed, dressed glove, the thumb's
curl and the hand's settle; js/r3-car.js uses them for that car.

usage: python tools/handgrip.py CAR [CAR ...]      (e.g. w17)
"""
import sys, json, base64, re, time, functools, http.server, socketserver, threading, pathlib
import numpy as np
from scipy import ndimage
from scipy.optimize import minimize

ROOT = pathlib.Path(__file__).resolve().parent.parent

# ---------- the rig ----------
raw = json.loads((ROOT / 'tools' / 'data' / 'makehuman_arm.json').read_text())
arm = json.loads(re.search(r'A\.arm = (\{.*\});', (ROOT / 'js' / 'assets' / 'arm.js').read_text()).group(1))
P0 = np.array(raw['pos']) * 0.1  # MakeHuman decimetres to metres
TRI = np.array(raw['tri']).reshape(-1, 3)
NAMES = [b['name'][:-2] for b in raw['bones']]
IDX = {n: i for i, n in enumerate(NAMES)}
HEAD = np.array([b['head'] for b in raw['bones']]) * 0.1
W = np.zeros((len(P0), len(NAMES)))
for i, ws in enumerate(raw['w']):
    for bi, x in ws: W[i, bi] = x
W /= W.sum(1, keepdims=True)
def _u8(s): return np.frombuffer(base64.b64decode(s), np.uint8)
W5 = _u8(arm['w']).reshape(-1, 5)       # the game's five runtime bones (4 = hand)
ZONE = _u8(arm['zone'])                  # 0 sleeve, 1 glove, 2 gauntlet, 3 knuckle panel
FB = {f: [IDX[f'finger{f}-{s}'] for s in (1, 2, 3)] for f in range(2, 6)}
TB = [IDX['finger1-1'], IDX['finger1-2'], IDX['finger1-3']]
FW = sum(W[:, b] for f in FB for b in FB[f])  # each vertex's weight on the four fingers
# fingers flex about the knuckle line (index to little), as the original pose did
K = HEAD[IDX['finger5-1']] - HEAD[IDX['finger2-1']]; K /= np.linalg.norm(K)
ORIG = {f: [55.0 + 3.0 * (f - 2), 65.0, 40.0] for f in range(2, 6)}  # the pose arm.js was baked in

def rotm(axis, deg):
    a = np.radians(deg); x, y, z = axis; c, s = np.cos(a), np.sin(a); C = 1 - c
    return np.array([[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
                     [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
                     [z * x * C - y * s, z * y * C + x * s, c + z * z * C]])

def skin(ang, P=None):
    """ang: finger (2..5) -> [knuckle, middle, end] flexion in degrees. The posed mesh, metres."""
    P = P0 if P is None else P
    out = np.zeros_like(P); moved = np.zeros(len(NAMES), bool)
    for f in range(2, 6):
        Rc, tc = np.eye(3), np.zeros(3)
        for s, b in enumerate(FB[f]):
            hp = Rc @ HEAD[b] + tc                 # the joint, where its parent has carried it
            Rc = rotm(-K, ang[f][s]) @ Rc; tc = hp - Rc @ HEAD[b]
            w = W[:, b]; m = w > 0
            out[m] += w[m, None] * (P[m] @ Rc.T + tc); moved[b] = True
    return out + P * W[:, ~moved].sum(1)[:, None]

def normals(P):
    N = np.zeros_like(P); a, b, c = P[TRI[:, 0]], P[TRI[:, 1]], P[TRI[:, 2]]; n = np.cross(b - a, c - a)
    for k in range(3): np.add.at(N, TRI[:, k], n)
    return N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)

J, H = arm['joints'], arm['hand']
def dress(P):
    """the suit and glove over the skin, as tools/assets_arm.py"""
    wrist, fore2 = np.array(J['wrist']), np.array(J['fore2']); up = (fore2 - wrist) / np.linalg.norm(fore2 - wrist)
    along = (P - wrist) @ up
    t = np.select([ZONE == 0, ZONE == 1, ZONE == 3], [0.011, 0.0025, 0.0035], 0.013 + 0.006 * np.clip((0.075 - along) / 0.075, 0, 1))
    return P + normals(P) * t[:, None]

# the game's rest hand frame (r3-car.js armData: A.car . RF0inv)
SCALE = 1.12
def toCar(P): return np.stack([P[:, 2], P[:, 1], -P[:, 0]], 1) * SCALE
def dirCar(v): v = np.array([v[2], v[1], -v[0]]); return v / np.linalg.norm(v)
X0 = dirCar(H['x']); Y0 = dirCar(H['y']); Y0 -= X0 * (Y0 @ X0); Y0 /= np.linalg.norm(Y0)
RF = np.stack([X0, Y0, np.cross(X0, Y0)], 1); C0 = toCar(np.array([H['c']]))[0]
def toHand(P): return (toCar(P) - C0) @ RF

def smooth(x, a, b): t = np.clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)
TH_ROOT, TH_TIP = np.array([0.012, 0.008, 0.008]), np.array([0.02, 0, 0.072])
def thumb_bend(V, T):
    """r3-car.js thumbBend, the fingers left alone"""
    ax = TH_TIP - TH_ROOT; L = np.linalg.norm(ax); ax = ax / L
    d = V - TH_ROOT; t = d @ ax / L; r = np.linalg.norm(d - np.outer(d @ ax, ax), axis=1)
    k = smooth(t, 0.12, 0.6) * (1 - smooth(r, 0.011, 0.017)); k[(W5[:, 4] < 100) | (FW >= 0.5)] = 0
    out = V.copy(); axis = np.array(T[:3], float); axis /= np.linalg.norm(axis)
    for i in np.nonzero(k > 0)[0]: out[i] = TH_ROOT + rotm(axis, np.degrees(T[3] * k[i])) @ (V[i] - TH_ROOT)
    return out

# ---------- the wheel as a signed distance field ----------
class SDF:
    """signed distance to the wheel (+ outside, - inside) on a 1 mm grid, read trilinearly"""
    def __init__(self, Wt, lo, hi, h=0.001):
        self.lo = np.array(lo, float); self.h = h; n = np.ceil((np.array(hi) - self.lo) / h).astype(int) + 1; self.n = n
        occ = np.zeros(n, bool)
        for T in np.array_split(Wt, max(1, len(Wt) // 2000)):
            a, b, c = T[:, 0], T[:, 1], T[:, 2]
            L = np.maximum(np.linalg.norm(b - a, axis=1), np.maximum(np.linalg.norm(c - a, axis=1), np.linalg.norm(c - b, axis=1)))
            k = np.ceil(L / (h * 0.5)).astype(int) + 1
            for kk in np.unique(k):
                s = k == kk; u, v = np.meshgrid(np.linspace(0, 1, kk), np.linspace(0, 1, kk)); m = (u + v) <= 1; u, v = u[m], v[m]
                P = a[s, None] + (b[s] - a[s])[:, None] * u[None, :, None] + (c[s] - a[s])[:, None] * v[None, :, None]
                I = np.floor((P.reshape(-1, 3) - self.lo) / h + 0.5).astype(int); I = I[((I >= 0) & (I < n)).all(1)]
                occ[I[:, 0], I[:, 1], I[:, 2]] = True
        occ = ndimage.binary_dilation(occ)
        lab, _ = ndimage.label(~occ)
        border = np.unique(np.concatenate([x.ravel() for x in (lab[0], lab[-1], lab[:, 0], lab[:, -1], lab[:, :, 0], lab[:, :, -1])]))
        solid = ~np.isin(lab, border[border > 0])
        self.d = np.where(solid, -ndimage.distance_transform_edt(solid) * h + h / 2, ndimage.distance_transform_edt(~solid) * h - h / 2).astype(np.float32)
    def __call__(self, P):
        g = (P - self.lo) / self.h; i0 = np.clip(np.floor(g).astype(int), 0, self.n - 2); f = np.clip(g - i0, 0, 1); out = 0
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
                    out = out + w * self.d[i0[:, 0] + dx, i0[:, 1] + dy, i0[:, 2] + dz]
        return out

# ---------- the car's wheel, from the game ----------
DUMP = r"""(id) => {
  const team = F1.Data.TEAMS.find(t => t.car === id), MD = F1.R3Car.model(team);
  const car = F1.R3Car.makeCar(team, team.drivers[0][3], 'M'), ck = car.userData.cockpit;
  F1.R3Car.setLod(car, 0, true); car.updateMatrixWorld(true);
  ck.steer = null; F1.R3Car.updateCockpit(car, 0); ck.pivot.updateMatrix(); ck.spin.updateMatrix();
  const toWheel = new THREE.Matrix4().multiplyMatrices(ck.pivot.matrix, ck.spin.matrix).invert();
  const W = [];
  for (const p of MD.swParts) { const P = p.G.attributes.position, ix = p.G.index.array; for (let t = 0; t < ix.length; t++) W.push(P.getX(ix[t]), P.getY(ix[t]), P.getZ(ix[t])); }
  // the hand frame in the wheel's, from palm vertices no pose moves: rest and placed positions
  const A = F1.R3Car.armData(), arm = ck.arms.find(x => x.sd > 0), P = arm.mesh.geometry.attributes.position, v = new THREE.Vector3(), g = new THREE.Vector3();
  const pairs = [];
  for (let i = 0; i < A.n; i++) {
    if (A.w[i * 5 + 4] < 255) continue;
    v.set(A.car[i * 3], A.car[i * 3 + 1], A.car[i * 3 + 2]).applyMatrix4(A.RF0inv);
    g.fromBufferAttribute(P, i).applyMatrix4(A.RF0inv);
    if (v.distanceTo(g) > 1e-6) continue;
    const s = new THREE.Vector3().fromBufferAttribute(P, i); arm.mesh.applyBoneTransform(i, s); s.applyMatrix4(toWheel);
    pairs.push(v.x, v.y, v.z, s.x, s.y, s.z);
  }
  return { W, pairs, thumb: MD.thumb };
}"""

def wheel_in_hand(car, settle_old):
    from playwright.sync_api import sync_playwright
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), functools.partial(Q, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
        pg = b.new_page(viewport={"width": 640, "height": 360})
        pg.goto(f"http://127.0.0.1:{srv.server_address[1]}/index.html", timeout=300000)
        pg.wait_for_function("window.__game && window.__game.ready", timeout=300000)
        pg.evaluate("__game.Game.paused = true")
        d = pg.evaluate(DUMP, car)
        b.close()
    srv.shutdown()
    pr = np.array(d['pairs']).reshape(-1, 6); A, B = pr[:, :3], pr[:, 3:]
    ca, cb = A.mean(0), B.mean(0)
    U, _, Vt = np.linalg.svd((A - ca).T @ (B - cb)); D = np.diag([1, 1, np.sign(np.linalg.det(Vt.T @ U.T))])
    R = Vt.T @ D @ U.T; t = cb - R @ ca
    Wt = (np.array(d['W']).reshape(-1, 3, 3) - t) @ R
    # a pose already in the game has settled the hand: measure from the unsettled hand
    Rs, ts = np.array(settle_old['rot']).T, np.array(settle_old['off'])
    return Wt @ Rs.T + ts, d['thumb']

# ---------- the simulation ----------
REL = {f: [55.0 + 3 * (f - 2), 65.0, 40.0] for f in range(2, 6)}  # the relaxed grip the joints pull toward
def simulate(car, settle_old):
    t0 = time.time()
    Wt, T0 = wheel_in_hand(car, settle_old)
    PD = dress(P0)  # the dressed rest glove: skinning it is the posed glove dressed, near enough to search with
    lo, hi = toHand(PD).min(0) - 0.05, toHand(PD).max(0) + 0.05
    c = Wt.mean(1); sdf = SDF(Wt[((c > lo - 0.03) & (c < hi + 0.03)).all(1)], lo, hi)
    dom = np.argmax(W, 1); glove = ZONE != 0; allf = sum(FB.values(), [])
    palm = np.nonzero(glove & ~np.isin(dom, allf + TB) & (W5[:, 4] >= 100))[0]
    thumb = np.nonzero(glove & np.isin(dom, TB))[0]
    roots = np.nonzero(glove & (FW > 0.02) & ~np.isin(dom, allf))[0]
    links = {f: np.nonzero(glove & np.isin(dom, FB[f]))[0] for f in FB}
    open_ = {f: [0.0, 0.0, 0.0] for f in FB}
    V0 = toHand(skin(open_, PD)); clear = np.r_[palm, roots]
    # 1. settle: the shortest push that clears palm and finger roots (of those, the one kindest to the thumb)
    k = np.arange(4000) + 0.5; phi = np.arccos(1 - 2 * k / 4000); th = np.pi * (1 + 5 ** 0.5) * k
    dirs = np.stack([np.cos(th) * np.sin(phi), np.sin(th) * np.sin(phi), np.cos(phi)], 1)
    thumb0 = thumb_bend(V0, T0)[thumb]; off = np.zeros(3)
    if sdf(V0[clear]).min() < 0.0004:
        for r in np.arange(0.0005, 0.04, 0.0005):
            ok = [d for d in dirs if sdf(V0[clear] + d * r).min() >= 0.0004]
            if ok: off = max(ok, key=lambda d: sdf(thumb0 + d * r).min()) * r; break
    print(f'{car}: hand settles {np.linalg.norm(off) * 1000:.1f} mm {np.round(off * 1000, 1)} (hand frame)', flush=True)
    # 2. the thumb's curl: clear of the wheel, nearest the aimed one
    cands = [(a, sdf(thumb_bend(V0, [*T0[:3], a])[thumb] + off).min()) for a in np.arange(-0.3, 1.3, 0.01)]
    ok = [a for a, d in cands if d >= 0.0003]
    ta = float(min(ok, key=lambda a: abs(a - T0[3])) if ok else max(cands, key=lambda x: x[1])[0])
    print(f'  thumb curl {ta:.2f} (aimed {T0[3]:.2f})', flush=True)
    # 3. each finger at rest between its joint springs and the handle's contact springs
    ang = dict(open_)
    for f in FB:
        def pos(q): a = dict(open_); a[f] = list(q); return toHand(skin(a, PD))[links[f]] + off
        def energy(q):
            pen = np.clip(0.0004 - sdf(pos(q)), 0, None)
            return 4e9 * (pen ** 2).sum() + 0.01 * ((np.array(q) - REL[f]) ** 2).sum()
        g = min(((energy([m, p, e]), [m, p, e]) for m in range(0, 91, 10) for p in range(0, 111, 10) for e in range(0, 81, 10)), key=lambda x: x[0])
        r = minimize(energy, g[1], method='Powell', bounds=[(0, 90), (0, 110), (0, 80)], options={'xtol': 0.05, 'maxiter': 4000})
        ang[f] = [round(float(x), 2) for x in r.x]
        d = sdf(pos(r.x))
        print(f'  finger {f}: knuckle {ang[f][0]:.1f}, middle {ang[f][1]:.1f}, end {ang[f][2]:.1f} degrees; deepest {max(0, -d.min()) * 1000:.2f} mm', flush=True)
    V = thumb_bend(toHand(dress(skin(ang))), [*T0[:3], ta]) + off; d = sdf(V[glove])
    print(f'  glove vertices inside the wheel: {int((d < 0).sum())}, deepest {max(0, -d.min()) * 1000:.2f} mm  ({time.time() - t0:.0f} s)', flush=True)
    return {'fingers': ang, 'thumb': ta, 'off': off.tolist(), 'rot': np.eye(3).tolist()}

if __name__ == '__main__':
    out = ROOT / 'js' / 'assets' / 'handpose.js'
    old = {}
    if out.exists():
        m = re.search(r'A\.handPose = (\{.*\});', out.read_text())
        if m: old = json.loads(m.group(1))['cars']
    cars = dict(old)
    for car in sys.argv[1:]:
        o = old.get(car, {}); r = simulate(car, {'rot': o.get('rot', np.eye(3).tolist()), 'off': o.get('off', [0, 0, 0])})
        P = dress(skin(r['fingers'])).astype('<f4')
        cars[car] = {'p': base64.b64encode(P.tobytes()).decode(), 'thumb': round(r['thumb'], 4), 'off': [round(x, 5) for x in r['off']],
                     'rot': r['rot'], 'fingers': {str(f): v for f, v in r['fingers'].items()}}
    asset = {'fing': base64.b64encode((FW >= 0.5).astype(np.uint8).tobytes()).decode(), 'cars': cars}
    out.write_text('// Hand poses per car: the glove re-posed on its MakeHuman finger bones by tools/handgrip.py\n'
                   '(function (G) { const A = G.F1.Assets = G.F1.Assets || {}; A.handPose = ' + json.dumps(asset) + '; })(window);\n')
    print('wrote', out.relative_to(ROOT), out.stat().st_size, 'bytes')
