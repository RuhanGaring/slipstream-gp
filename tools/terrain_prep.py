"""Real terrain round each venue, from open elevation data.

Fetches the AWS Open Data "Terrain Tiles" (Mapzen terrarium PNGs, s3://elevation-tiles-prod;
SRTM, GMTED, NED, ETOPO1 and other open sources, see CREDITS.md) round a real place chosen for
each venue, and bakes a height grid centred on it: GRID x GRID samples over SPAN metres, heights
in metres relative to the place itself (the circuit sits there), sea as -9999.
Writes js/assets/terrain.js (F1.Assets.terrain: {venue: {span, n, h: base64 Int16}}).

usage: python tools/terrain_prep.py CACHE_DIR      (tiles are cached there)
"""
import sys, math, io, json, base64, pathlib, urllib.request
import numpy as np
from PIL import Image

CACHE = pathlib.Path(sys.argv[1]); CACHE.mkdir(parents=True, exist_ok=True)
ROOT = pathlib.Path(__file__).resolve().parent.parent
Z, GRID, SPAN = 12, 224, 30000.0

# venue: (lat, lon, place) - real places whose relief suits each venue
PLACES = {
    'hakone':   (35.2470, 139.0450, 'Sengokuhara basin, Hakone caldera, Japan'),
    'sierra':   (36.7620, -5.2720, 'Ascari, Serrania de Ronda, Spain'),
    'lucerne':  (43.7340, 7.4200, 'Monaco and the Maritime Alps'),
    'nordwald': (50.3340, 6.9470, 'Nurburgring, Eifel, Germany'),
    'bahia':    (-23.7010, -46.6970, 'Interlagos, Sao Paulo, Brazil'),
    'ileverte': (45.5000, -73.5250, 'Ile Notre-Dame, Montreal, Canada'),
    'kestrel':  (52.0720, -1.0170, 'Silverstone, England'),
    'varenna':  (44.3440, 11.7130, 'Imola, Emilia-Romagna, Italy'),
    'rimal':    (23.1000, 53.7500, 'Liwa dunes, United Arab Emirates'),
    'lonestar': (30.1330, -97.6410, 'Circuit of the Americas, Austin, USA'),
}

def tile(x, y):
    p = CACHE / f'{Z}_{x}_{y}.png'
    if not p.exists():
        url = f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{x}/{y}.png'
        p.write_bytes(urllib.request.urlopen(url, timeout=60).read())
    a = np.asarray(Image.open(p).convert('RGB'), dtype=np.float64)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768   # terrarium decoding, metres

def merc(lat, lon):  # global pixel coordinates at zoom Z
    n = 256 * 2 ** Z
    return (lon + 180) / 360 * n, (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n

out = {}
for venue, (lat, lon, place) in PLACES.items():
    cx, cy = merc(lat, lon)
    mpp = 156543.03392 * math.cos(math.radians(lat)) / 2 ** Z   # metres per pixel here
    half = SPAN / 2 / mpp
    tx0, tx1 = int((cx - half) // 256), int((cx + half) // 256)
    ty0, ty1 = int((cy - half) // 256), int((cy + half) // 256)
    mos = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256))
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            mos[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = tile(tx, ty)
    # sample the grid (bilinear), north up: row j runs south, column i east
    s = (np.arange(GRID) + 0.5) / GRID * 2 * half - half
    px, py = np.meshgrid(cx + s - tx0 * 256, cy + s - ty0 * 256)
    x0, y0 = np.floor(px).astype(int), np.floor(py).astype(int); fx, fy = px - x0, py - y0
    v = lambda yy, xx: mos[np.clip(yy, 0, mos.shape[0] - 1), np.clip(xx, 0, mos.shape[1] - 1)]
    h = (v(y0, x0) * (1 - fx) + v(y0, x0 + 1) * fx) * (1 - fy) + (v(y0 + 1, x0) * (1 - fx) + v(y0 + 1, x0 + 1) * fx) * fy
    sea = h <= 0.5
    c = GRID // 2; base = float(np.median(h[c - 4:c + 4, c - 4:c + 4]))
    rel = np.where(sea, -9999, np.round(h - base)).astype('<i2')
    out[venue] = {'place': place, 'span': SPAN, 'n': GRID, 'h': base64.b64encode(rel.tobytes()).decode()}
    print(f'{venue:9s} {place}: base {base:.0f} m, relief {h.max() - base:.0f} m above, sea {sea.mean() * 100:.0f} %', flush=True)

js = ROOT / 'js' / 'assets' / 'terrain.js'
js.write_text('// Real terrain round each venue: AWS Open Data Terrain Tiles (Mapzen terrarium; SRTM, GMTED, NED, ETOPO1 and others), prepared by tools/terrain_prep.py\n'
              '(function (G) { const A = G.F1.Assets = G.F1.Assets || {}; A.terrain = ' + json.dumps(out) + '; })(window);\n')
print('wrote', js.relative_to(ROOT), round(js.stat().st_size / 1e6, 2), 'MB')
