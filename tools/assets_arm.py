"""Embed the driver's arm (suit sleeve and glove) for the cockpit view.
usage: python tools/assets_arm.py POSED_JSON
POSED_JSON is the right arm of the MakeHuman base mesh (CC0, https://github.com/makehumancommunity/makehuman,
data/3dobjs/base.obj with the default skeleton and skin weights), cut from the shoulder to the
fingertips, with its finger bones posed into a grip round a steering-wheel grip and baked in GPU
Chromium with three.js. The skin weights are folded onto five runtime bones (0 shoulder, 1 upper
arm, 2 forearm, 3 forearm twist, 4 hand). Here the race suit and glove are added over the skin:
each vertex gets a zone (0 sleeve, 1 glove, 2 gauntlet cuff, 3 knuckle panel) and is pushed out
along its normal by the cloth's thickness.
Writes js/assets/arm.js as F1.Assets.arm.
"""
import sys, json, math, base64, struct, pathlib
d = json.loads(pathlib.Path(sys.argv[1]).read_text())
P = [d['pos'][i:i + 3] for i in range(0, len(d['pos']), 3)]
T = [d['tri'][i:i + 3] for i in range(0, len(d['tri']), 3)]
W = d['w']
sub = lambda a, b: [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
dot = lambda a, b: a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
cross = lambda a, b: [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
def norm(a):
    l = math.sqrt(dot(a, a)) or 1
    return [a[0] / l, a[1] / l, a[2] / l]
N = [[0, 0, 0] for _ in P]
for a, b, c in T:
    n = cross(sub(P[b], P[a]), sub(P[c], P[a]))
    for v in (a, b, c): N[v] = [N[v][k] + n[k] for k in range(3)]
N = [norm(n) for n in N]
J = d['joints']
wrist, fore2 = J['wrist'], J['fore2']
up_arm = norm(sub(fore2, wrist))  # from the wrist back up the forearm
back = [-x for x in norm(d['hand']['x'])]  # the frame's x is the palm
zone, out = [], []
for i, p in enumerate(P):
    w = W[i]
    along = dot(sub(p, wrist), up_arm)  # metres up the forearm from the wrist
    if w[4] > 0.5 and along < 0.01:
        z = 3 if (dot(N[i], back) > 0.62 and 0.058 < -along < 0.08) else 1
    elif along < 0.075:
        z = 2
    else:
        z = 0
    zone.append(z)
    # cloth over skin: loose Nomex sleeve, a flared gauntlet, a close-fitting glove
    t = {0: 0.011, 1: 0.0025, 2: 0.013 + 0.006 * max(0.0, min(1.0, (0.075 - along) / 0.075)), 3: 0.0035}[z]
    out.append([p[k] + N[i][k] * t for k in range(3)])
f32 = lambda a: base64.b64encode(struct.pack('<%df' % len(a), *a)).decode()
u16 = lambda a: base64.b64encode(struct.pack('<%dH' % len(a), *a)).decode()
u8 = lambda a: base64.b64encode(bytes(a)).decode()
asset = {
    'p': f32([x for p in out for x in p]), 'ix': u16(d['tri']),
    'w': u8([max(0, min(255, round(x * 255))) for w in W for x in w]), 'zone': u8(zone),
    'joints': J, 'hand': d['hand'],
}
root = pathlib.Path(__file__).resolve().parent.parent
hdr = '// Driver arm: MakeHuman base mesh (CC0), posed and dressed by tools/assets_arm.py\n'
(root / 'js' / 'assets' / 'arm.js').write_text(hdr + '(function (G) { const A = G.F1.Assets = G.F1.Assets || {}; A.arm = ' + json.dumps(asset) + '; })(window);\n')
print('wrote js/assets/arm.js', len(P), 'verts', {z: zone.count(z) for z in range(4)})
