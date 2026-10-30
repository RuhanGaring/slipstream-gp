"""Prepare the CC0 venue textures (ambientCG) for the 3D renderer's buildings.
usage: python tools/assets_venue.py DOWNLOAD_DIR
DOWNLOAD_DIR holds the extracted ambientCG 1K-JPG sets, one folder per asset:
  Facade001 (glass curtain wall), Facade006 (banded office windows),
  Facade002 (glass with lit panels), CorrugatedSteel005 (metal cladding).
Writes assets/venue_*.jpg and embeds them in js/assets/venue.js as data URIs, with the
same key conventions as core.js: albedo, `_n` normal (OpenGL), `_arm` packed
AO / roughness / metalness.
"""
import sys, pathlib, base64, json
from PIL import Image

SRC = pathlib.Path(sys.argv[1])
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets'; OUT.mkdir(exist_ok=True)
JS = ROOT / 'js' / 'assets'

SETS = {
    'glass': 'Facade001',
    'office': 'Facade006',
    'glasslit': 'Facade002',
    'clad': 'CorrugatedSteel005',
}
S = 512
keys = {}
for key, aid in SETS.items():
    d = SRC / aid
    col = Image.open(d / f'{aid}_1K-JPG_Color.jpg').convert('RGB').resize((S, S), Image.LANCZOS)
    col.save(OUT / f'venue_{key}.jpg', quality=86, optimize=True)
    nor = Image.open(d / f'{aid}_1K-JPG_NormalGL.jpg').convert('RGB').resize((S, S), Image.LANCZOS)
    nor.save(OUT / f'venue_{key}_n.jpg', quality=88, optimize=True)
    rough = Image.open(d / f'{aid}_1K-JPG_Roughness.jpg').convert('L').resize((S, S), Image.LANCZOS)
    mp = d / f'{aid}_1K-JPG_Metalness.jpg'
    metal = Image.open(mp).convert('L').resize((S, S), Image.LANCZOS) if mp.exists() else Image.new('L', (S, S), 0)
    ao = Image.new('L', (S, S), 255)
    Image.merge('RGB', (ao, rough, metal)).save(OUT / f'venue_{key}_arm.jpg', quality=88, optimize=True)
    for suf in ('', '_n', '_arm'):
        keys[key + suf] = OUT / f'venue_{key}{suf}.jpg'

def uri(p):
    return 'data:image/jpeg;base64,' + base64.b64encode(p.read_bytes()).decode()

hdr = '// CC0 textures from ambientCG (https://ambientcg.com), prepared by tools/assets_venue.py\n'
data = {k: uri(p) for k, p in keys.items()}
(JS / 'venue.js').write_text(hdr + '(function (G) { const A = G.F1.Assets = G.F1.Assets || {}; Object.assign(A, ' + json.dumps(data) + '); })(window);\n')
print('wrote js/assets/venue.js', sum(len(v) for v in data.values()) // 1024, 'KB')
