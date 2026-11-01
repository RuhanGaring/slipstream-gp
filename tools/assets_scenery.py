"""Prepare the CC0 scenery textures (ambientCG) for the 3D renderer's fences and buildings.
usage: python tools/assets_scenery.py DOWNLOAD_DIR
DOWNLOAD_DIR holds the extracted ambientCG 1K-JPG sets, one folder per asset:
  Fence003 (chain-link catch fence, with its opacity map),
  Facade018A, Facade019A, Facade020A (mid-rise city fronts: brick, dark concrete, brown),
  Bricks105 (paddock and hospitality walls), Concrete046 (cast concrete for the stands).
Writes assets/scn_*.jpg (the fence as .png, with its opacity in alpha) and embeds them in
js/assets/scenery.js as data URIs, with the same key conventions as core.js: albedo, `_n`
normal (OpenGL), `_arm` packed AO / roughness / metalness.
"""
import sys, pathlib, base64, json
from PIL import Image

SRC = pathlib.Path(sys.argv[1])
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets'; OUT.mkdir(exist_ok=True)
JS = ROOT / 'js' / 'assets'

SETS = {  # key: (asset, size)
    'facA': ('Facade018A', 512), 'facB': ('Facade019A', 512), 'facC': ('Facade020A', 512),
    'brick': ('Bricks105', 512), 'stand': ('Concrete046', 512),
}
keys = {}
def L(d, aid, kind, S):
    p = d / f'{aid}_1K-JPG_{kind}.jpg'
    return Image.open(p).convert('L').resize((S, S), Image.LANCZOS) if p.exists() else None
for key, (aid, S) in SETS.items():
    d = SRC / aid
    Image.open(d / f'{aid}_1K-JPG_Color.jpg').convert('RGB').resize((S, S), Image.LANCZOS).save(OUT / f'scn_{key}.jpg', quality=86, optimize=True)
    Image.open(d / f'{aid}_1K-JPG_NormalGL.jpg').convert('RGB').resize((S, S), Image.LANCZOS).save(OUT / f'scn_{key}_n.jpg', quality=88, optimize=True)
    ao = L(d, aid, 'AmbientOcclusion', S) or Image.new('L', (S, S), 255)
    rough = L(d, aid, 'Roughness', S) or Image.new('L', (S, S), 200)
    metal = L(d, aid, 'Metalness', S) or Image.new('L', (S, S), 0)
    Image.merge('RGB', (ao, rough, metal)).save(OUT / f'scn_{key}_arm.jpg', quality=88, optimize=True)
    for suf in ('', '_n', '_arm'): keys[key + suf] = OUT / f'scn_{key}{suf}.jpg'

# the chain-link: galvanised wire colour, its opacity as alpha (a PNG keeps the mesh crisp)
# (kept at full 1024 and the wire thickened a pixel: thinner, it breaks up into dots on screen)
from PIL import ImageFilter
d, aid, S = SRC / 'Fence003', 'Fence003', 1024
rgb = Image.open(d / f'{aid}_1K-JPG_Color.jpg').convert('RGB').resize((S, S), Image.LANCZOS)
a = Image.open(d / f'{aid}_1K-JPG_Opacity.jpg').convert('L').resize((S, S), Image.LANCZOS).filter(ImageFilter.MaxFilter(3))
la = rgb.convert('L'); la.putalpha(a); la.save(OUT / 'scn_fence.png', optimize=True)  # grey wire: luminance + alpha keeps it small
Image.open(d / f'{aid}_1K-JPG_NormalGL.jpg').convert('RGB').resize((512, 512), Image.LANCZOS).save(OUT / 'scn_fence_n.jpg', quality=88, optimize=True)
keys['fence'] = OUT / 'scn_fence.png'; keys['fence_n'] = OUT / 'scn_fence_n.jpg'

def uri(p):
    mime = 'image/png' if p.suffix == '.png' else 'image/jpeg'
    return f'data:{mime};base64,' + base64.b64encode(p.read_bytes()).decode()
data = {k: uri(p) for k, p in keys.items()}
(JS / 'scenery.js').write_text('// CC0 textures from ambientCG (https://ambientcg.com), prepared by tools/assets_scenery.py\n'
                              '(function (G) { const A = G.F1.Assets = G.F1.Assets || {}; Object.assign(A, ' + json.dumps(data) + '); })(window);\n')
print('wrote', len(keys), 'textures,', round((JS / 'scenery.js').stat().st_size / 1e6, 2), 'MB')
