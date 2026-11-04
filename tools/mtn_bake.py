#!/usr/bin/env python3
"""Bakes the mountain detail map: a tiling landform eroded by water, run once offline.

A heightfield of ridged noise is carved by simulated rainfall (stream-power incision on a
torus, so the result tiles), which leaves the branching gullies and spurs that a noise
function cannot make. What is stored per texel:

  R, G  the surface slope (dh/dx, dh/dy), encoded around 0.5
  B     the place in the drainage basin: 1 down a gully, 0.5 on the open slope, 0 on a spur

Bilinear filtering of these stored slopes gives smooth shading, where taking screen-space
slopes of a filtered height map gives a facet per texel. The workers run one per tile
quadrant of the noise, then the erosion runs as vectorised passes.

Writes assets-src/mtn_erosion.png (R,G slope, B drainage, A height), then js/assets/mtn.js as
F1.Assets.mtn (lossless WebP, R,G slope and B the place in the basin).
Usage: python tools/mtn_bake.py [size]; python tools/mtn_bake.py encode (only the last step)
"""
import base64, io, json, pathlib, sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np
from scipy import ndimage as ndi
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent


def periodic_noise(n, cells, seed):
    """Value noise that tiles: a random lattice interpolated with wrapping."""
    rng = np.random.default_rng(seed)
    lat = rng.random((cells, cells)).astype(np.float32)
    zoom = np.arange(n, dtype=np.float32) / n * cells
    i0 = np.floor(zoom).astype(int); f = zoom - i0; f = f * f * f * (f * (f * 6 - 15) + 10)
    i1 = (i0 + 1) % cells; i0 %= cells
    a = lat[np.ix_(i0, i0)]; b = lat[np.ix_(i0, i1)]; c = lat[np.ix_(i1, i0)]; d = lat[np.ix_(i1, i1)]
    fx = f[None, :]; fy = f[:, None]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def octave(args):
    n, o, seed = args
    return periodic_noise(n, 6 * 2 ** o, seed + o * 31)


def base_land(n, seed, pool):
    """Ridged multifractal, domain-warped so the ridges do not line up with the grid."""
    octs = list(pool.map(octave, [(n, o, seed) for o in range(7)]))
    warp = list(pool.map(octave, [(n, 0, seed + 500), (n, 0, seed + 900), (n, 2, seed + 700), (n, 2, seed + 1100)]))
    wx = (warp[0] - 0.5) * 0.22 * n + (warp[2] - 0.5) * 0.06 * n
    wy = (warp[1] - 0.5) * 0.22 * n + (warp[3] - 0.5) * 0.06 * n
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    h = np.zeros((n, n), np.float32); amp = 1.0; weight = np.ones((n, n), np.float32)
    for k, o in enumerate(octs):
        o = ndi.map_coordinates(o, [(yy + wy) % n, (xx + wx) % n], order=1, mode='wrap')
        r = 1 - np.abs(2 * o - 1); r = r * r
        h += r * amp * weight
        weight = np.clip(r * 1.8, 0, 1); amp *= 0.52
    return h / h.max()


# the eight neighbours, as (dy, dx, distance)
NB = [(-1, -1, 1.414), (-1, 0, 1), (-1, 1, 1.414), (0, -1, 1), (0, 1, 1), (1, -1, 1.414), (1, 0, 1), (1, 1, 1.414)]


def receivers(h):
    """Each cell's steepest downhill neighbour on the torus (itself in a pit)."""
    n = h.shape[0]
    slopes = np.stack([(h - np.roll(h, (-dy, -dx), (0, 1))) / d for dy, dx, d in NB])
    best = slopes.argmax(0); steep = slopes.max(0)
    yy, xx = np.mgrid[0:n, 0:n]
    dys = np.array([b[0] for b in NB])[best]; dxs = np.array([b[1] for b in NB])[best]
    dist = np.array([b[2] for b in NB])[best]
    ry = (yy + dys) % n; rx = (xx + dxs) % n
    pit = steep <= 0
    ry[pit] = yy[pit]; rx[pit] = xx[pit]
    return ry, rx, np.maximum(steep, 0), dist


def drainage(h, ry, rx):
    """Water through each cell: rain on it plus all it receives, highest cells first."""
    n = h.shape[0]
    order = np.argsort(h.ravel())[::-1]
    area = np.ones(n * n, np.float64)
    rec = (ry.ravel() * n + rx.ravel())
    # an array-at-a-time accumulation would need the tree depth in passes; one sweep is exact
    a = area.tolist(); r = rec.tolist()
    for i in order.tolist():
        j = r[i]
        if j != i: a[j] += a[i]
    return np.array(a, np.float32).reshape(n, n)


def erode(u, seed, steps=340):
    """Stream power incision under uplift: dh/dt = U(x) - K A^0.5 S, with hillslope creep.

    The land rises out of almost flat ground at a rate given by the massif map, so water cuts
    the whole relief and every slope ends up belonging to a drainage basin.
    """
    n = u.shape[0]
    rng = np.random.default_rng(seed)
    h = rng.random((n, n)) * 0.5
    rate = (0.25 + 0.75 * u) * 0.11 * n / 1024
    for s in range(steps):
        ry, rx, steep, dist = receivers(h)
        a = drainage(h, ry, rx)
        cut = 0.018 * np.power(a, 0.5) * steep
        cut = np.minimum(cut, np.maximum(0, (h - h[ry, rx]) * 0.85))
        h = h - cut + rate
        lap = (np.roll(h, 1, 0) + np.roll(h, -1, 0) + np.roll(h, 1, 1) + np.roll(h, -1, 1) - 4 * h)
        over = np.clip(steep - 0.9, 0, 1)
        h += lap * (0.035 + 0.2 * over)
        if s % 40 == 0: print('  step', s, 'range', round(float(h.max() - h.min()), 1), flush=True)
    return h, a


def main():
    if sys.argv[1:] == ['encode']: return encode(Image.open(ROOT / 'assets-src' / 'mtn_erosion.png'))
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 1024
    with ProcessPoolExecutor(max_workers=8) as pool:
        h = base_land(n, 41, pool)
    h, a = erode(ndi.gaussian_filter(h, n / 200, mode='wrap'), 41)
    # slopes on the torus, in units where a 45 degree face reads as 1
    gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) / 2
    gy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) / 2
    scale = float(np.percentile(np.abs(np.concatenate([gx.ravel(), gy.ravel()])), 99.7))
    gx = np.clip(gx / scale, -1, 1); gy = np.clip(gy / scale, -1, 1)
    flow = np.log(a) / np.log(a.max())
    flow = np.clip((flow - np.percentile(flow, 55)) / (np.percentile(flow, 99.7) - np.percentile(flow, 55)), 0, 1)
    flow = ndi.gaussian_filter(flow, 0.7, mode='wrap')
    hn = (h - h.min()) / (h.max() - h.min())
    im = Image.fromarray((np.stack([gx * 0.5 + 0.5, gy * 0.5 + 0.5, flow, hn], -1) * 255 + 0.5).astype(np.uint8), 'RGBA')
    (ROOT / 'assets-src').mkdir(exist_ok=True)
    im.save(ROOT / 'assets-src' / 'mtn_erosion.png')
    encode(im)


def encode(im):
    """R,G slope; B the place in the basin: 1 down a gully, .5 on the open slope, 0 on a spur."""
    a = np.asarray(im).astype(np.float32) / 255
    flow, hn = a[..., 2], a[..., 3]
    crest = hn - ndi.gaussian_filter(hn, 22, mode='wrap')
    crest = np.clip(crest / np.percentile(np.abs(crest), 98), 0, 1)
    rgb = np.stack([a[..., 0], a[..., 1], 0.5 + 0.5 * flow - 0.5 * crest * (1 - flow)], -1)
    out = Image.fromarray((np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGB')
    b = io.BytesIO(); out.save(b, 'WEBP', lossless=True, method=6)
    print('webp bytes', b.tell())
    uri = 'data:image/webp;base64,' + base64.b64encode(b.getvalue()).decode()
    (ROOT / 'js' / 'assets' / 'mtn.js').write_text(
        '// Baked by tools/mtn_bake.py: a tiling eroded landform (R,G slope, B place in the basin).\n'
        '(function (G) { const A = G.F1.Assets = G.F1.Assets || {}; A.mtn = ' + json.dumps(uri) + '; })(typeof window !== "undefined" ? window : globalThis);\n')


if __name__ == '__main__':
    main()
