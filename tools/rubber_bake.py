#!/usr/bin/env python3
"""Bakes the rubber laid on a circuit: many cars' separate tyre tracks, as a tiling texture.

Each track is a pair of thin lines 1.6 m apart wandering across the road in lazy curves, clustered
round the racing line, fading in and out along the lap. The asphalt shader used to work all of this
out for every pixel (sixteen tracks, each with its own noise); read from here it is one lookup.

Rows run across the road (20 m wide, centred on the racing line), columns along it (512 m, tiling).
Writes js/assets/rubber.js as F1.Assets.rubber (lossless grey WebP).
Usage: python tools/rubber_bake.py
"""
import base64, io, json, pathlib
import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
W, H, TILE, ROAD = 1024, 256, 512.0, 20.0
rng = np.random.default_rng(29)
X = np.arange(W) / W * TILE
Y = (np.arange(H) / H - 0.5) * ROAD
out = np.zeros((H, W), np.float32)


def wave(cycles):
    """A slow wander that tiles over the texture's length."""
    return np.sin(X / TILE * 2 * np.pi * cycles + rng.random() * 6.283)


for k in range(26):
    h1, h2, h5 = rng.random(3)
    off = (h1 + h2 - 1) * 4.2 + wave(rng.integers(1, 6)) * (0.5 + 1.5 * h5) + wave(rng.integers(5, 16)) * 0.35
    seg = np.clip((wave(rng.integers(2, 9)) + wave(rng.integers(5, 19)) * 0.6 + 0.4) / 0.5, 0, 1)
    seg = seg * seg * (3 - 2 * seg)
    amp = 0.22 + 0.4 * rng.random()
    dd = Y[:, None] - off[None, :]
    tr = np.maximum(np.exp(-(dd - 0.8) ** 2 / 0.022), np.exp(-(dd + 0.8) ** 2 / 0.022))
    out += tr * seg[None, :] * amp

out = np.clip(out / 1.6, 0, 1)
im = Image.fromarray((out * 255 + 0.5).astype(np.uint8), 'L')
b = io.BytesIO(); im.save(b, 'WEBP', lossless=True, method=6)
print('webp bytes', b.tell())
uri = 'data:image/webp;base64,' + base64.b64encode(b.getvalue()).decode()
(ROOT / 'js' / 'assets' / 'rubber.js').write_text(
    '// Baked by tools/rubber_bake.py: tyre tracks across the road (20 m) along the lap (512 m).\n'
    '(function (G) { const A = G.F1.Assets = G.F1.Assets || {}; A.rubber = ' + json.dumps(uri) + '; })(typeof window !== "undefined" ? window : globalThis);\n')
