#!/usr/bin/env python3
"""Bakes the English parkland oak: an impostor grown here, as none of the scanned trees is one.

A broad dome of leaf clusters on a short thick trunk, splatted to eight side views (a colour atlas
and a view-space normal atlas, the layout js/r3-trees.js reads). Light is left to the game's shader;
the colour only darkens with depth into the crown, the way a real crown shades itself.

Writes js/assets/trees_oak.js, adding oak_0 and oak_1 to F1.Assets.trees.
Usage: python tools/tree_bake.py
"""
import base64, io, json, pathlib
from concurrent.futures import ProcessPoolExecutor
import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
TILE = 1024   # drawn at this size, halved at the end for soft edges
W_M, H_M = 27.0, 21.5


def model(seed):
    """Leaf points: position, outward normal, shade; and limb segments."""
    g = np.random.default_rng(seed)
    a, b, cy = 10.2, 8.2, 12.0
    n = 130
    # clusters on the dome, a lumpy outline; a few inside to fill it
    u = g.random(n) * 2 * np.pi
    v = np.arccos(g.random(n) * 1.4 - 0.45)
    shell = 0.6 + 0.42 * g.random(n)
    cx = np.stack([np.sin(v) * np.cos(u) * a * shell, cy + np.cos(v) * b * shell, np.sin(v) * np.sin(u) * a * shell], 1)
    cr = 1.9 + g.random(n) ** 2 * 2.7
    pts, nor, shade = [], [], []
    for c, r in zip(cx, cr):
        m = 1100
        d = g.normal(size=(m, 3)); d /= np.linalg.norm(d, axis=1, keepdims=True)
        p = c + d * r * (0.74 + 0.26 * g.random((m, 1)))
        out = p - np.array([0, cy - 2.5, 0]); out /= np.linalg.norm(out, axis=1, keepdims=True)
        nn = d * 0.55 + out * 0.75 + g.normal(size=(m, 3)) * 0.22
        nn /= np.linalg.norm(nn, axis=1, keepdims=True)
        rad = np.sqrt((p[:, 0] / a) ** 2 + ((p[:, 1] - cy) / b) ** 2 + (p[:, 2] / a) ** 2)
        # each lump is lit from above and shades itself below; the crown darkens toward its base
        # and its heart, and the lumps' undersides leave dark hollows between them
        lump = np.clip(0.42 + 0.62 * (d[:, 1] * 0.8 + (d * out).sum(1) * 0.45), 0.1, 1.0)
        base = np.clip((p[:, 1] - 4.5) / 11, 0.3, 1.0)
        heart = np.clip((rad - 0.35) / 0.5, 0.25, 1.0)
        sh = lump * (0.35 + 0.65 * base) * heart
        pts.append(p); nor.append(nn); shade.append(sh)
    limbs = []
    limbs.append(((0, 0, 0), (0.2, 5.6, 0.1), 0.86, 0.6))
    for k in range(7):
        h = g.random() * 6.283
        r0 = 3.5 + g.random() * 3.5
        limbs.append(((0.2, 5.6 + g.random() * 1.2, 0.1), (np.cos(h) * r0, 11 + g.random() * 3, np.sin(h) * r0), 0.3, 0.09))
    return np.concatenate(pts), np.concatenate(nor), np.concatenate(shade), limbs, g.random(n), np.repeat(np.arange(n), 1100)


def view(args):
    seed, k = args
    pts, nor, shade, limbs, tint, idx = model(seed)
    A = k * np.pi / 4
    right = np.array([np.sin(A), 0, -np.cos(A)]); toward = np.array([np.cos(A), 0, np.sin(A)])
    col = np.zeros((TILE, TILE, 4), np.float32); nrm = np.zeros((TILE, TILE, 3), np.float32)
    nrm[..., 2] = 1
    px = lambda p: ((p @ right / W_M + 0.5) * TILE, (1 - p[..., 1] / H_M) * TILE)
    # limbs first: a trunk with bark, behind the leaves
    for a, b, r0, r1 in limbs:
        a, b = np.array(a, float), np.array(b, float)
        for t in np.linspace(0, 1, 260):
            p = a + (b - a) * t; r = r0 + (r1 - r0) * t
            x, y = px(p); rp = max(1.2, r / W_M * TILE)
            x0, x1, y0, y1 = int(x - rp), int(x + rp) + 1, int(y - rp), int(y + rp) + 1
            yy, xx = np.ogrid[max(0, y0):min(TILE, y1), max(0, x0):min(TILE, x1)]
            m = (xx - x) ** 2 + (yy - y) ** 2 <= rp * rp
            s = col[max(0, y0):min(TILE, y1), max(0, x0):min(TILE, x1)]
            nx = np.broadcast_to((xx - x) / rp, m.shape)
            bark = 0.72 + 0.16 * np.sin(xx * 0.31 + yy * 0.05) + 0.12 * np.sin(xx * 0.83 - yy * 0.13)
            s[m] = np.stack(np.broadcast_arrays(0.085 * bark, 0.066 * bark, 0.05 * bark, np.ones_like(bark)), -1)[m]
            n = nrm[max(0, y0):min(TILE, y1), max(0, x0):min(TILE, x1)]
            n[m] = np.stack(np.broadcast_arrays(nx, np.zeros_like(nx), np.sqrt(np.clip(1 - nx * nx, 0, 1))), -1)[m]
    # leaves, far to near, each a small splat
    d = pts @ toward
    o = np.argsort(d)
    x, y = px(pts[o]); ix = x.astype(np.int32); iy = y.astype(np.int32)
    g0 = np.array([0.135, 0.205, 0.07]); g1 = np.array([0.235, 0.325, 0.1]); g2 = np.array([0.17, 0.26, 0.055])
    t = tint[idx[o]][:, None]
    leaf = g0 * (1 - t) + g1 * t
    leaf = leaf * (0.82 + 0.36 * np.random.default_rng(seed + k).random((len(o), 1))) * 0.7 + g2 * 0.3
    leaf = leaf * shade[o][:, None]
    N = nor[o]
    nv = np.stack([N @ right, N[:, 1], N @ toward], 1)
    stamp = [(a, b) for a in range(-4, 5) for b in range(-4, 5) if a * a + b * b <= 15]
    for a, b in stamp:
        ok = (iy + b >= 0) & (iy + b < TILE) & (ix + a >= 0) & (ix + a < TILE)
        col[iy[ok] + b, ix[ok] + a, :3] = leaf[ok]; col[iy[ok] + b, ix[ok] + a, 3] = 1
        nrm[iy[ok] + b, ix[ok] + a] = nv[ok]
    return k, col, nrm


def atlas(seed, pool):
    c = np.zeros((TILE * 2, TILE * 4, 4), np.float32); n = np.zeros((TILE * 2, TILE * 4, 3), np.float32)
    for k, col, nrm in pool.map(view, [(seed, k) for k in range(8)]):
        i, j = k % 4, k // 4
        c[j * TILE:(j + 1) * TILE, i * TILE:(i + 1) * TILE] = col
        n[j * TILE:(j + 1) * TILE, i * TILE:(i + 1) * TILE] = nrm
    # colour stays in display space; colour under empty pixels spreads so mips do not fringe dark
    rgb = np.clip(c[..., :3], 0, 1) ** (1 / 2.2)
    a = c[..., 3]
    im = Image.fromarray((np.dstack([rgb, a]) * 255).astype(np.uint8), 'RGBA').resize((TILE * 2, TILE), Image.BOX)
    arr = np.array(im).astype(np.float32); alpha = arr[..., 3:4] / 255
    from scipy import ndimage as ndi
    fill = ndi.gaussian_filter(arr[..., :3] * alpha, (6, 6, 0)) / np.maximum(ndi.gaussian_filter(alpha, (6, 6, 0)), 1e-3)
    arr[..., :3] = arr[..., :3] * (alpha > 0.5) + fill * (alpha <= 0.5)
    col = Image.fromarray(arr.astype(np.uint8), 'RGBA')
    nor = Image.fromarray(((n * 0.5 + 0.5).clip(0, 1) * 255).astype(np.uint8), 'RGB').resize((TILE, TILE // 2), Image.BOX)
    return col, nor


def uri(im, q):
    b = io.BytesIO(); im.save(b, 'WEBP', quality=q, method=6, exact=True)
    return 'data:image/webp;base64,' + base64.b64encode(b.getvalue()).decode()


if __name__ == '__main__':
    out = {}
    with ProcessPoolExecutor(max_workers=8) as pool:
        for s in [0, 1]:
            col, nor = atlas(71 + s * 13, pool)
            out[f'oak_{s}'] = {'H': H_M, 'W': W_M, 'color': uri(col, 82), 'normal': uri(nor, 80)}
            print(f'oak_{s}', len(out[f'oak_{s}']['color']) // 1024, 'KB +', len(out[f'oak_{s}']['normal']) // 1024, 'KB')
            if s == 0: col.save(ROOT / 'assets-src' / 'oak_atlas.png')
    (ROOT / 'js' / 'assets' / 'trees_oak.js').write_text(
        '// Baked by tools/tree_bake.py: English parkland oaks as eight-view impostors.\n'
        '(function (G) { const A = G.F1.Assets = G.F1.Assets || {}; A.trees = Object.assign(A.trees || {}, ' + json.dumps(out) + '); })(window);\n')
