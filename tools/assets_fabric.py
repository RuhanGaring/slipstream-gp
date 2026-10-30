"""Pack the driver's cloth relief maps into one texture for the cockpit arms.
usage: python tools/assets_fabric.py DOWNLOAD_DIR
DOWNLOAD_DIR holds the ambientCG (CC0, https://ambientcg.com) 1K-JPG sets Fabric066 (the
race suit's fine Nomex weave), Fabric061 (the glove backs' tight knit) and Leather039 (the
palms' suede). Their displacement maps become one RGB height texture (R suit, G knit,
B suede), a 5 cm tile in the shader; the suit weave is tiled twice for its finer thread.
Writes js/assets/fabric.js as F1.Assets.fabric.
"""
import sys, pathlib, io, base64
from PIL import Image, ImageOps
SRC = pathlib.Path(sys.argv[1]); ROOT = pathlib.Path(__file__).resolve().parent.parent
N = 1024
def disp(name, tiles):
    im = Image.open(SRC / name / f'{name}_1K-JPG_Displacement.jpg').convert('L')
    im = ImageOps.autocontrast(im, cutoff=1).resize((N // tiles, N // tiles), Image.LANCZOS)
    out = Image.new('L', (N, N))
    for x in range(tiles):
        for y in range(tiles): out.paste(im, (x * N // tiles, y * N // tiles))
    return out
img = Image.merge('RGB', (disp('Fabric066', 2), disp('Fabric061', 1), disp('Leather039', 1)))
buf = io.BytesIO(); img.save(buf, 'JPEG', quality=92)
uri = 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()
(ROOT / 'js' / 'assets' / 'fabric.js').write_text(
    '// Cloth relief for the driver arms: ambientCG Fabric066, Fabric061, Leather039 (CC0), packed by tools/assets_fabric.py\n'
    "(function (G) { const A = G.F1.Assets = G.F1.Assets || {}; A.fabric = " + repr(uri).replace("'", '"') + '; })(typeof window !== "undefined" ? window : globalThis);\n')
print('wrote js/assets/fabric.js', len(uri) // 1024, 'KB')
