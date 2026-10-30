"""Calibrate the HDR sky probes (Poly Haven, CC0) for physically based lighting.
usage: python tools/hdr_prep.py DOWNLOAD_DIR

For each venue:
  1. decode the Radiance .hdr (RGBE, RLE scanlines)
  2. find the sun disc, integrate its irradiance and direction, and clip it out of the
     probe so it is not counted twice (the sun becomes the shadow-casting directional light)
  3. normalise so a white Lambertian ground plane has radiance 1.0 under sun + sky,
     which pins mid-grey (albedo 0.18) to 0.18 before exposure
  4. measure the scale between the HDR sky and the 4k tonemapped JPG background so
     the background is shown at the same radiance as the light it casts
  5. downsample to 512 x 256 and embed as RGBE bytes in js/assets/hdr_<id>.js
"""
import sys, pathlib, base64, json, math
import numpy as np
from PIL import Image

SRC = pathlib.Path(sys.argv[1])
ROOT = pathlib.Path(__file__).resolve().parent.parent
SKIES = {'kestrel': 'overcast_soil_puresky', 'varenna': 'citrus_orchard_road_puresky', 'lucerne': 'kloofendal_48d_partly_cloudy_puresky',
         'hakone': 'sunflowers_puresky', 'rimal': 'industrial_sunset_puresky',
         'ileverte': 'kloofendal_38d_partly_cloudy_puresky', 'sierra': 'syferfontein_18d_clear_puresky',
         'bahia': 'qwantani_late_afternoon_puresky', 'nordwald': 'kloppenheim_06_puresky', 'lonestar': 'lonely_road_afternoon_puresky'}
# python tools/hdr_prep.py DOWNLOAD_DIR [venue ...]: only those venues
if len(sys.argv) > 2: SKIES = {k: v for k, v in SKIES.items() if k in sys.argv[2:]}
LUM = np.array([0.2126, 0.7152, 0.0722])
# linear albedo of each venue's surroundings: grass and asphalt, harbour stone, desert sand
GROUND = {'kestrel': (0.07, 0.09, 0.05), 'varenna': (0.08, 0.09, 0.05), 'lucerne': (0.11, 0.11, 0.11),
          'hakone': (0.07, 0.085, 0.05), 'rimal': (0.33, 0.26, 0.18),
          'ileverte': (0.09, 0.1, 0.09), 'sierra': (0.12, 0.11, 0.07), 'bahia': (0.08, 0.09, 0.05),
          'nordwald': (0.05, 0.065, 0.04), 'lonestar': (0.14, 0.12, 0.08)}


def read_hdr(path):
    b = path.read_bytes()
    i = b.index(b'\n\n') + 2
    j = b.index(b'\n', i)
    dims = b[i:j].split()
    H, W = int(dims[1]), int(dims[3])
    p = j + 1
    out = np.zeros((H, W, 4), np.uint8)
    for y in range(H):
        assert b[p] == 2 and b[p + 1] == 2, 'only new-style RLE supported'
        p += 4
        for c in range(4):
            x = 0
            while x < W:
                n = b[p]; p += 1
                if n > 128:
                    n -= 128; out[y, x:x + n, c] = b[p]; p += 1
                else:
                    out[y, x:x + n, c] = np.frombuffer(b, np.uint8, n, p); p += n
                x += n
    e = out[..., 3].astype(np.int32)
    f = np.where(e > 0, np.ldexp(1.0, e - 136), 0.0)
    return out[..., :3].astype(np.float64) * f[..., None]


def to_rgbe(img):
    m = img.max(axis=2)
    e = np.where(m > 1e-32, np.floor(np.log2(np.maximum(m, 1e-32))) + 1, -128)
    sc = np.where(m > 1e-32, np.ldexp(1.0, (-e + 8).astype(np.int32)), 0)
    rgb = np.clip(img * sc[..., None], 0, 255).astype(np.uint8)
    return np.dstack([rgb, np.clip(e + 128, 0, 255).astype(np.uint8)])


for tid, name in SKIES.items():
    img = read_hdr(SRC / f'hdr_{name}.hdr')
    H, W, _ = img.shape
    v = 1 - (np.arange(H) + 0.5) / H                      # 1 at the top row
    el = (v - 0.5) * math.pi
    phi = ((np.arange(W) + 0.5) / W - 0.5) * 2 * math.pi
    dOm = (2 * math.pi / W) * (math.pi / H) * np.cos(el)  # solid angle per pixel, per row
    dirs = np.stack([np.cos(el)[:, None] * np.cos(phi)[None, :], np.repeat(np.sin(el)[:, None], W, 1), np.cos(el)[:, None] * np.sin(phi)[None, :]], -1)
    L = img @ LUM
    upper = (el > 0)[:, None].repeat(W, 1)
    med = np.median(L[upper])
    # sun: pixels far brighter than the sky around them
    T = max(15 * med, np.percentile(L[upper], 99.95))
    mask = (L > T) & upper
    w = (L * mask) * dOm[:, None]
    if w.sum() > 0:
        sd = (dirs * w[..., None]).sum((0, 1)); sd /= np.linalg.norm(sd)
        Esun = (img * (mask * dOm[:, None])[..., None]).sum((0, 1))
        # clip the disc down to the threshold so the probe keeps only the sky
        k = np.where(mask, T / np.maximum(L, 1e-9), 1.0)
        img = img * k[..., None]
        Esun -= (img * (mask * dOm[:, None])[..., None]).sum((0, 1))
    else:
        top = np.unravel_index(np.argmax(np.where(upper, L, 0)), L.shape)
        sd = dirs[top]; Esun = np.zeros(3)
    # horizontal-plane irradiance from the remaining sky
    cosz = np.maximum(dirs[..., 1], 0)
    Esky = (img * (cosz * dOm[:, None])[..., None]).sum((0, 1))
    Etot = Esun * max(sd[1], 0) + Esky
    s = math.pi / float(Etot @ LUM)
    img *= s; Esun *= s
    raw = float(Esun @ LUM)
    # Captures often clip the sun at sunset, and an overcast sky has none. Floors on the
    # direct normal irradiance: a low sun still rakes warm light across everything (about
    # half the sky's horizontal irradiance), and overcast keeps a faint diffuse key so
    # shapes read. The colour comes from the sky glow around the sun direction.
    near = (dirs @ sd) > math.cos(math.radians(6))
    glow = img[near].mean(0) if near.any() else Esky
    glow = glow / max(1e-6, glow @ LUM)
    floor = 1.6 if sd[1] < 0.2 else 0.35
    if Esun @ LUM < floor:
        Esun = Esun + (floor - Esun @ LUM) * (glow if sd[1] < 0.2 else Esky / (Esky @ LUM))
    # background scale: HDR sky radiance vs the sRGB-decoded tonemapped panorama
    ldr = np.asarray(Image.open(ROOT / 'assets' / f'sky_{tid}.jpg').convert('RGB').resize((W, H)), np.float64) / 255
    ldr = np.where(ldr <= 0.04045, ldr / 12.92, ((ldr + 0.055) / 1.055) ** 2.4)
    band = upper & ~mask & (L < T * 0.5)
    bg = float(((img @ LUM)[band]).mean() / max(1e-6, (ldr @ LUM)[band].mean()))
    # horizon radiance for the fog (from the open sky, before the surroundings go in)
    rows = (el > 0.02) & (el < 0.12)
    fog = img[rows].reshape(-1, 3).mean(0)
    # These are "puresky" captures: below the horizon there is only more sky. A real circuit
    # is surrounded by ground, trees and grandstands, and glossy paint at grazing angles
    # reflects them, not bright sky. Put the venue's ground in the lower hemisphere at its
    # albedo (white ground reads 1.0 after normalisation, so radiance = albedo) and fade in
    # a darker band of surroundings over the first 8 degrees above the horizon.
    ground = np.array(GROUND[tid])
    elc = el[:, None, None]
    t = np.clip(elc / math.radians(8), 0, 1); t = t * t * (3 - 2 * t)
    img = np.where(elc < 0, ground, img * (0.35 + 0.65 * t) + ground * (1 - t) * 0.6)
    # downsample to 512 x 256 and flip rows (GL textures start at the bottom row)
    f = max(2, H // 256)
    small = img.reshape(H // f, f, W // f, f, 3).mean((1, 3))[::-1]
    rgbe = to_rgbe(small)
    meta = {'w': W // f, 'h': H // f, 'sun': [round(float(x), 4) for x in sd], 'sunE': [round(float(x), 4) for x in Esun],
            'bg': round(bg, 4), 'fog': [round(float(x), 4) for x in fog]}
    js = ('// Generated by tools/hdr_prep.py from a CC0 Poly Haven HDRI. Do not edit.\n'
          '(function (G) { const A = G.F1.Assets = G.F1.Assets || {}; A["hdr_' + tid + '"] = ' +
          json.dumps(dict(meta, rgbe=base64.b64encode(rgbe.tobytes()).decode())) + '; })(window);\n')
    (ROOT / 'js' / 'assets' / f'hdr_{tid}.js').write_text(js)
    print(tid, 'sun dir', meta['sun'], 'sunE', meta['sunE'], 'lum', round(float(np.array(meta['sunE']) @ LUM), 3),
          'sky', round(float(Esky @ LUM * s), 3), 'bg', meta['bg'], 'fog', meta['fog'], 'mask px', int(mask.sum()), 'raw sun', round(raw, 3), 'T/med', round(T / med, 1))
