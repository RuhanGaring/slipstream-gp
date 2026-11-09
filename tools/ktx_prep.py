"""GPU-compressed copies of the photo textures (KTX2, Basis Universal), for the 3D renderer.
usage: python tools/ktx_prep.py PATH_TO_ktx.exe

The JPEG photo textures embedded in js/assets/core.js, city.js and scenery.js move to
js/assets/photos_<bundle>.js (loaded only by a browser that cannot use the KTX2 copies, or
from file://), and each gets assets/ktx/<key>.ktx2:
  colour maps    ETC1S (Basis-LZ), sRGB     about the size of the JPEG, a sixth of the GPU memory
  ARM maps       ETC1S, linear              ambient occlusion, roughness and metal vary slowly
  normal maps    UASTC + Zstandard, linear  ETC1S blocks would show as facets in the lighting
all with a full mip chain, their values taken as they are (--assign-tf: no sRGB to linear
conversion of the maps that hold data), and flipped vertically on the way in (a compressed texture cannot
be flipped at upload, the JPEG ones are). Images with transparency (PNG) stay as they are.
js/assets/ktx_index.js lists the KTX2 files and the fallback bundles for js/r3-textures.js.

Re-run after tools/assets_prep.py, assets_city.py or assets_scenery.py regenerate a bundle:
the photo entries are read from the bundle and from its photos_ file, whichever has them.
Encodes run in parallel, one ktx process per core.
"""
import sys, os, re, json, base64, io, time, pathlib, subprocess, tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from PIL import Image

KTX = sys.argv[1]
ROOT = pathlib.Path(__file__).resolve().parent.parent
JS = ROOT / 'js' / 'assets'
OUT = ROOT / 'assets' / 'ktx'; OUT.mkdir(parents=True, exist_ok=True)
BUNDLES = ['core', 'city', 'scenery']
HEAD = 'Object.assign(A, '


def read_bundle(path):
    s = path.read_text(encoding='utf-8')
    a = s.index(HEAD) + len(HEAD); b = s.rindex('); })')
    return s[:a], json.loads(s[a:b]), s[b:]


photos = {}   # key -> (bundle, data uri)
for name in BUNDLES:
    pre, data, post = read_bundle(JS / f'{name}.js')
    fb = JS / f'photos_{name}.js'
    old = read_bundle(fb)[1] if fb.exists() else {}
    keep = {}
    for k, v in list(data.items()) + list(old.items()):
        if isinstance(v, str) and v.startswith('data:image/jpeg'): photos[k] = (name, v)
        elif k in data: keep[k] = v
    (JS / f'{name}.js').write_text(pre + json.dumps(keep, separators=(', ', ': ')) + post, encoding='utf-8')
    mine = {k: v for k, (b, v) in photos.items() if b == name}
    fb.write_text(f'// The JPEG photo textures of {name}.js, for a browser without KTX2 support (see tools/ktx_prep.py). Generated, do not edit.\n'
                  '(function (G) { const A = G.F1.Assets = G.F1.Assets || {}; ' + HEAD + json.dumps(mine, separators=(', ', ': ')) + '); })(window);\n', encoding='utf-8')


# colour maps seen up close all lap (the road itself): UASTC keeps the grain of the aggregate
SHARP = {'asphalt', 'pitlane'}


def kind(k):
    return 'normal' if k.endswith('_n') else 'linear' if k.endswith('_arm') else 'srgb'


def encode(k, uri):
    im = Image.open(io.BytesIO(base64.b64decode(uri.split(',', 1)[1]))).convert('RGB').transpose(Image.FLIP_TOP_BOTTOM)
    with tempfile.TemporaryDirectory() as td:
        src = pathlib.Path(td) / f'{k}.png'; im.save(src)
        dst = OUT / f'{k}.ktx2'
        if k in SHARP:
            args = ['--format', 'R8G8B8_SRGB', '--assign-tf', 'srgb', '--encode', 'uastc', '--uastc-quality', '2', '--uastc-rdo', '--uastc-rdo-l', '1', '--zstd', '20']
        elif kind(k) == 'srgb':
            args = ['--format', 'R8G8B8_SRGB', '--assign-tf', 'srgb', '--encode', 'basis-lz', '--clevel', '4', '--qlevel', '220']
        elif kind(k) == 'linear':
            args = ['--format', 'R8G8B8_UNORM', '--assign-tf', 'linear', '--encode', 'basis-lz', '--clevel', '4', '--qlevel', '230']
        else:
            args = ['--format', 'R8G8B8_UNORM', '--assign-tf', 'linear', '--encode', 'uastc', '--uastc-quality', '2', '--uastc-rdo', '--uastc-rdo-l', '2', '--zstd', '20']
        r = subprocess.run([KTX, 'create', '--generate-mipmap', '--threads', '1'] + args + [str(src), str(dst)], capture_output=True, text=True)
        if r.returncode: raise RuntimeError(k + ': ' + (r.stderr or r.stdout)[-400:])
    return k, im.size, dst.stat().st_size, len(uri) * 3 // 4


index = {}
t0 = time.time(); n = len(photos); done = 0
with ThreadPoolExecutor(max_workers=max(1, (os.cpu_count() or 4) - 2)) as ex:
    futs = [ex.submit(encode, k, v) for k, (b, v) in photos.items()]
    for f in as_completed(futs):
        k, size, kb, jb = f.result(); done += 1
        index[k] = {'f': f'assets/ktx/{k}.ktx2', 'w': size[0], 'srgb': kind(k) == 'srgb'}
        el = time.time() - t0; eta = el / done * (n - done)
        print(f'[{"#" * int(30 * done / n):<30}] {100 * done // n:3d}%  {done}/{n}  eta {int(eta)}s  {k}: jpeg {jb // 1024} KB, ktx2 {kb // 1024} KB', flush=True)
idx = dict(sorted(index.items()))
(JS / 'ktx_index.js').write_text('// KTX2 copies of the photo textures and the JPEG fallback bundles (tools/ktx_prep.py). Generated, do not edit.\n'
                                 '(function (G) { G.F1.AssetsK = ' + json.dumps(idx, separators=(',', ':')) + '; G.F1.AssetsKFallback = ' + json.dumps([f'js/assets/photos_{b}.js' for b in BUNDLES]) + '; })(window);\n', encoding='utf-8')
tk = sum((OUT / f'{k}.ktx2').stat().st_size for k in index); tj = sum(len(v) * 3 // 4 for b, v in photos.values())
print(f'{len(index)} textures: jpeg {tj / 1048576:.1f} MB, ktx2 {tk / 1048576:.1f} MB')
