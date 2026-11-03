"""Real elevation statistics of F1 circuits, to calibrate the circuit generator (js/trackgen2.js).

Circuit centrelines: bacinger/f1-circuits (MIT, https://github.com/bacinger/f1-circuits).
Heights: AWS Open Data Terrain Tiles (Mapzen terrarium, zoom 14: about 6 to 10 m per pixel;
SRTM, 3DEP, EU-DEM and national lidar where available, see CREDITS.md).

Each circuit is resampled every 5 m, its height read from the tiles (bilinear), and the profile
cleaned of buildings and tree canopy (a 100 m morphological opening) and smoothed over 30 m. From that come the statistics the generator is matched against: climb, total ascent
per lap, the steepest sustained gradient over 100 m and over 200 m, how much of the lap is
steeper than 2, 4, 6 and 8 %, how many separate climbs a lap has, the gradient in corners and on
straights, the sharpest crest and dip (vertical radius over 100 m), and how the height change
splits between big features (wavelengths over a kilometre) and small undulations.

usage: python tools/f1elev_prep.py GEOJSON TILE_CACHE_DIR
writes tools/data/f1_elevation.json (stats) and lab/f1ref.js (stats and 10 m profiles for the lab)
"""
import sys, math, json, io, pathlib, urllib.request
import numpy as np
from PIL import Image

GEO = pathlib.Path(sys.argv[1]); CACHE = pathlib.Path(sys.argv[2]); CACHE.mkdir(parents=True, exist_ok=True)
ROOT = pathlib.Path(__file__).resolve().parent.parent
Z = 14

# the generator style each circuit calibrates (street circuits, the classic permanent circuits
# split by how hilly they are, and the purpose-built modern venues)
GROUP = {
    'city': ['mc-1929', 'sg-2008', 'az-2016', 'sa-2021', 'us-2023', 'us-2022', 'au-1953', 'ca-1978', 'es-2026', 'ru-2014'],
    'modern': ['bh-2002', 'cn-2004', 'ae-2009', 'my-1999', 'qa-2004', 'us-2012', 'tr-2005', 'fr-1969'],
    'classic': ['gb-1948', 'it-1922', 'be-1925', 'jp-1962', 'at-1969', 'hu-1986', 'es-1991', 'it-1953', 'nl-1948', 'br-1940', 'mx-1962',
                'de-1932', 'de-1927', 'it-1914', 'pt-2008', 'fr-1960', 'pt-1972', 'za-1961', 'us-1956', 'br-1977', 'ar-1952', 'us-1909'],
}

def tile(x, y):
    p = CACHE / f'{Z}_{x}_{y}.png'
    if not p.exists():
        url = f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{x}/{y}.png'
        p.write_bytes(urllib.request.urlopen(url, timeout=60).read())
    a = np.asarray(Image.open(p).convert('RGB'), dtype=np.float64)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768

def merc(lat, lon):
    n = 256 * 2 ** Z
    return (lon + 180) / 360 * n, (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n

def gauss_loop(a, sig):
    n = len(a); R = int(sig * 3) + 1
    k = np.exp(-0.5 * (np.arange(-R, R + 1) / sig) ** 2); k /= k.sum()
    ext = np.concatenate([a[-R:], a, a[:R]])
    return np.convolve(ext, k, mode='valid')

def resample_loop(pts, ds):
    pts = np.asarray(pts, dtype=np.float64)
    if np.hypot(*(pts[0] - pts[-1])) > 1e-6: pts = np.vstack([pts, pts[:1]])
    seg = np.hypot(*np.diff(pts, axis=0).T); cum = np.concatenate([[0], np.cumsum(seg)])
    L = cum[-1]; m = int(round(L / ds)); s = np.arange(m) * L / m
    return np.stack([np.interp(s, cum, pts[:, 0]), np.interp(s, cum, pts[:, 1])], 1), L

feats = json.load(open(GEO, encoding='utf-8'))['features']
out, ref = {}, {}
group_of = {cid: g for g, ids in GROUP.items() for cid in ids}
for f in feats:
    p = f['properties']; cid = p['id']
    if cid not in group_of: continue
    lonlat = np.asarray(f['geometry']['coordinates'], dtype=np.float64)
    lat0 = lonlat[:, 1].mean(); lon0 = lonlat[:, 0].mean()
    # local metres (x east, y north)
    kx = 111320 * math.cos(math.radians(lat0)); ky = 110540
    xy = np.stack([(lonlat[:, 0] - lon0) * kx, (lonlat[:, 1] - lat0) * ky], 1)
    P, L = resample_loop(xy, 5.0)
    # tile mosaic over the circuit
    lats = P[:, 1] / ky + lat0; lons = P[:, 0] / kx + lon0
    px, py = zip(*[merc(a, b) for a, b in zip(lats, lons)]); px = np.array(px); py = np.array(py)
    tx0, tx1 = int(px.min() // 256), int(px.max() // 256); ty0, ty1 = int(py.min() // 256), int(py.max() // 256)
    mos = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256))
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            mos[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = tile(tx, ty)
    gx = px - tx0 * 256 - 0.5; gy = py - ty0 * 256 - 0.5
    x0 = np.floor(gx).astype(int); y0 = np.floor(gy).astype(int); fx = gx - x0; fy = gy - y0
    v = lambda yy, xx: mos[np.clip(yy, 0, mos.shape[0] - 1), np.clip(xx, 0, mos.shape[1] - 1)]
    h = (v(y0, x0) * (1 - fx) + v(y0, x0 + 1) * fx) * (1 - fy) + (v(y0 + 1, x0) * (1 - fx) + v(y0 + 1, x0 + 1) * fx) * fy
    ds = 5.0
    # the elevation data is a surface model in places: buildings and tree canopy stand on it as
    # short raised blocks. A morphological opening (the running minimum, then the running maximum,
    # over 100 m) removes raised blocks shorter than that and leaves the ground's own hills
    # (always far longer) alone
    w = int(100 / ds / 2)
    ext = np.concatenate([h[-w:], h, h[:w]])
    mn = np.array([ext[i:i + 2 * w + 1].min() for i in range(len(h))])
    ext = np.concatenate([mn[-w:], mn, mn[:w]])
    h = np.array([ext[i:i + 2 * w + 1].max() for i in range(len(h))])
    z = gauss_loop(h, 30 / ds)
    n = len(z)
    rng = float(z.max() - z.min())
    dz = np.diff(np.concatenate([z, z[:1]]))
    ascent = float(dz[dz > 0].sum())
    def grade(win):
        w = int(win / ds / 2)
        return (np.roll(z, -w) - np.roll(z, w)) / (2 * w * ds)
    g100, g200 = grade(100), grade(200)
    share = {str(t): float((np.abs(g100) > t / 100).mean()) for t in (2, 4, 6, 8)}
    # separate climbs: rises of at least 4 m between dips (hysteresis)
    climbs, lo, state = 0, z[0], 'down'
    zz = np.concatenate([z, z])
    hi = zz[0]
    for val in zz:
        if state == 'down':
            lo = min(lo, val)
            if val - lo > 4: state = 'up'; hi = val; climbs += 1
        else:
            hi = max(hi, val)
            if hi - val > 4: state = 'down'; lo = val
    climbs = max(1, round(climbs / 2))
    # horizontal curvature (smoothed line) to split corners from straights
    xs = gauss_loop(P[:, 0], 15 / ds); ys = gauss_loop(P[:, 1], 15 / ds)
    hd = np.unwrap(np.arctan2(np.roll(ys, -1) - np.roll(ys, 1), np.roll(xs, -1) - np.roll(xs, 1)))
    kap = np.abs(np.diff(np.concatenate([hd, hd[:1] + (hd[-1] - hd[0] + (hd[1] - hd[0]))]))) / ds
    kap = np.abs((np.roll(hd, -1) - np.roll(hd, 1) + np.pi) % (2 * np.pi) - np.pi) / (2 * ds)
    corner = kap > 1 / 150
    gc = float(np.abs(g100[corner]).mean()) if corner.any() else 0.0
    gs = float(np.abs(g100[~corner]).mean()) if (~corner).any() else 0.0
    # vertical radius over 100 m (crest: negative curvature)
    z100 = gauss_loop(h, 50 / ds)
    zpp = (np.roll(z100, -10) - 2 * z100 + np.roll(z100, 10)) / (50 ** 2)
    crestR = float(1 / max(1e-6, -zpp.min())); sagR = float(1 / max(1e-6, zpp.max()))
    # how the height change splits: features longer than 1 km against shorter undulation
    big = gauss_loop(h, 250 / ds)
    big_std = float(np.std(big)); small_std = float(np.std(z - big))
    st = {
        'name': p['Name'], 'group': group_of[cid], 'L': round(L), 'Lofficial': p.get('length'),
        'range': round(rng, 1), 'ascent': round(ascent, 1), 'g100': round(float(np.abs(g100).max()) * 100, 1), 'g200': round(float(np.abs(g200).max()) * 100, 1),
        'share': {k: round(v * 100, 1) for k, v in share.items()}, 'climbs': climbs, 'gCorner': round(gc * 100, 2), 'gStraight': round(gs * 100, 2),
        'crestR': round(crestR), 'sagR': round(sagR), 'bigStd': round(big_std, 2), 'smallStd': round(small_std, 2),
    }
    out[cid] = st
    prof = z[::2] - z.min()  # 10 m steps
    ref[cid] = dict(st, profile=[round(float(x), 1) for x in prof])
    print(f"{cid:8s} {group_of[cid]:7s} {p['Name'][:34]:34s} L {L:5.0f}/{p.get('length')}  range {rng:5.1f}  ascent {ascent:5.0f}  g100 {st['g100']:4.1f}  g200 {st['g200']:4.1f}  >4% {st['share']['4']:4.1f}  climbs {climbs}  crestR {crestR:6.0f}  big/small {big_std:4.1f}/{small_std:3.1f}", flush=True)

(ROOT / 'tools' / 'data').mkdir(exist_ok=True)
(ROOT / 'tools' / 'data' / 'f1_elevation.json').write_text(json.dumps(out, indent=1))
(ROOT / 'lab' / 'f1ref.js').write_text('// Real F1 circuit elevation profiles and statistics (tools/f1elev_prep.py): centrelines from bacinger/f1-circuits (MIT), heights from AWS Open Data Terrain Tiles\nwindow.F1REF = ' + json.dumps(ref) + ';\n')
print('wrote', len(out), 'circuits')
