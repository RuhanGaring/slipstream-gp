"""Bake the hand poses made in tools/handeditor.html into the game.

Reads tools/data/handposes.json (or the file given), poses the glove on its MakeHuman bones exactly
as the editor does (each bone turned by its saved rotation about its own joint, the skin following
by linear blend skinning, the suit and glove pushed out along the normals), and writes each car's
pose into js/assets/handpose.js (F1.Assets.handPose): the posed, dressed glove, the hand's move
(off, rot) and the thumb's curl: none when the editor posed the thumb on its own bones, or the game's own
curl toward the thumb hole when the file gives one ("thumb").  Cars not in
the file keep the pose they had.

usage: python tools/handbake.py [handposes.json]
"""
import sys, json, re, base64, pathlib
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'tools' / 'data' / 'handposes.json'
OUT = ROOT / 'js' / 'assets' / 'handpose.js'

raw = json.loads((ROOT / 'tools' / 'data' / 'makehuman_arm.json').read_text())
arm = json.loads(re.search(r'A\.arm = (\{.*\});', (ROOT / 'js' / 'assets' / 'arm.js').read_text()).group(1))
P0 = np.array(raw['pos'], float).reshape(-1, 3) * 0.1
TRI = np.array(raw['tri']).reshape(-1, 3)
NAMES = [b['name'][:-2] for b in raw['bones']]
IDX = {n: i for i, n in enumerate(NAMES)}
HEAD = np.array([b['head'] for b in raw['bones']]) * 0.1
PAR = [IDX.get(b['parent'][:-2], -1) for b in raw['bones']]
W = np.zeros((len(P0), len(NAMES)))
for i, ws in enumerate(raw['w']):
    for bi, x in ws: W[i, bi] = x
W /= W.sum(1, keepdims=True)
ZONE = np.frombuffer(base64.b64decode(arm['zone']), np.uint8)
FW = sum(W[:, IDX[f'finger{f}-{s}']] for f in range(2, 6) for s in (1, 2, 3))

def quat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])

def skin(rots):
    """rots: bone name -> quaternion [x, y, z, w], each bone's turn about its joint in its parent's frame"""
    R, t = [None] * len(NAMES), [None] * len(NAMES)
    for i in range(len(NAMES)):   # parents come before their children in the rig
        q = quat(rots.get(NAMES[i], [0, 0, 0, 1]))
        if PAR[i] < 0: R[i], t[i] = q, HEAD[i].copy()
        else: R[i], t[i] = R[PAR[i]] @ q, R[PAR[i]] @ (HEAD[i] - HEAD[PAR[i]]) + t[PAR[i]]
    out = np.zeros_like(P0)
    for i in range(len(NAMES)):
        m = W[:, i] > 0
        out[m] += W[m, i, None] * ((P0[m] - HEAD[i]) @ R[i].T + t[i])
    return out

def dress(P):
    """the suit and glove over the skin, as tools/assets_arm.py"""
    N = np.zeros_like(P); a, b, c = P[TRI[:, 0]], P[TRI[:, 1]], P[TRI[:, 2]]; n = np.cross(b - a, c - a)
    for k in range(3): np.add.at(N, TRI[:, k], n)
    N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)
    J = arm['joints']; wrist, fore2 = np.array(J['wrist']), np.array(J['fore2']); up = (fore2 - wrist) / np.linalg.norm(fore2 - wrist)
    along = (P - wrist) @ up
    t = np.select([ZONE == 0, ZONE == 1, ZONE == 3], [0.011, 0.0025, 0.0035], 0.013 + 0.006 * np.clip((0.075 - along) / 0.075, 0, 1))
    return P + N * t[:, None]

if __name__ == '__main__':
    assert all(PAR[i] < i for i in range(len(NAMES))), 'rig bones out of order'
    poses = json.loads(SRC.read_text())['cars']
    cars = {}
    if OUT.exists():
        m = re.search(r'A\.handPose = (\{.*\});', OUT.read_text())
        if m: cars = json.loads(m.group(1))['cars']
    for car, p in poses.items():
        P = dress(skin(p.get('bones', {}))).astype('<f4')
        Rs = quat(p['settle']['q'])
        cars[car] = {'p': base64.b64encode(P.tobytes()).decode(), 'thumb': round(float(p.get('thumb', 0)), 4), 'off': [round(float(x), 6) for x in p['settle']['p']],
                     'rot': [[round(float(x), 6) for x in Rs[:, k]] for k in range(3)], 'source': 'handeditor'}
        print(f'{car}: baked, hand moved {np.linalg.norm(p["settle"]["p"]) * 1000:.1f} mm, {len(p.get("bones", {}))} joints turned')
    asset = {'fing': base64.b64encode((FW >= 0.5).astype(np.uint8).tobytes()).decode(), 'cars': cars}
    OUT.write_text('// Hand poses per car: the glove re-posed on its MakeHuman finger bones (tools/handeditor.html, tools/handbake.py)\n'
                   '(function (G) { const A = G.F1.Assets = G.F1.Assets || {}; A.handPose = ' + json.dumps(asset) + '; })(window);\n')
    print('wrote', OUT.relative_to(ROOT), OUT.stat().st_size, 'bytes')
