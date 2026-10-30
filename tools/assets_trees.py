"""Embed baked tree impostors (8-view colour + normal atlases) for the 3D renderer.
usage: python tools/assets_trees.py OUT_DIR [OUT_DIR ...]
Each OUT_DIR is the output of the impostor baker: <name>_color.webp, <name>_normal.webp and
meta.json (H, W in metres; 4x2 views). The baker renders CC0 Poly Haven models
(island_tree_01, island_tree_02, tree_small_02, fir_sapling_medium, quiver_tree_01) in GPU
Chromium with three.js: unlit albedo darkened by depth into the crown, and view-space normals.
Writes js/assets/trees.js with F1.Assets.trees = { name: { H, W, color, normal } }.
"""
import sys, io, json, base64, pathlib
from PIL import Image

KEEP = {'broad1', 'broad2', 'broad4', 'fir_0', 'fir_1', 'fir_2', 'quiver'}
ROOT = pathlib.Path(__file__).resolve().parent.parent

def webp(im, q):
    b = io.BytesIO(); im.save(b, 'WEBP', quality=q, method=6)
    return 'data:image/webp;base64,' + base64.b64encode(b.getvalue()).decode()

out = {}
for d in map(pathlib.Path, sys.argv[1:]):
    for m in json.loads((d / 'meta.json').read_text()):
        n = m['name']
        if n not in KEEP: continue
        col = Image.open(d / f'{n}_color.webp').convert('RGBA')
        nor = Image.open(d / f'{n}_normal.webp').convert('RGB')
        # normals carry less detail than the albedo: half resolution is plenty
        nor = nor.resize((nor.width // 2, nor.height // 2), Image.LANCZOS)
        out[n] = {'H': round(m['H'], 3), 'W': round(m['W'], 3), 'color': webp(col, 82), 'normal': webp(nor, 80)}
        print(n, len(out[n]['color']) // 1024, 'KB +', len(out[n]['normal']) // 1024, 'KB')

hdr = '// Tree impostors baked from CC0 Poly Haven models (https://polyhaven.com), see tools/assets_trees.py\n'
(ROOT / 'js' / 'assets' / 'trees.js').write_text(hdr + '(function (G) { const A = G.F1.Assets = G.F1.Assets || {}; A.trees = ' + json.dumps(out) + '; })(window);\n')
print('wrote js/assets/trees.js', sum(len(v['color']) + len(v['normal']) for v in out.values()) // 1024, 'KB')
