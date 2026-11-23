"""The road's normal and roughness maps, rebuilt without the old ones' flaws.
usage: python tools/asphalt_maps.py

The JPEG normal map of the asphalt holds slow tilts across its 2 m tile and the edges of the JPEG's own 8 pixel
blocks (3 cm on the road). Looking down the road they are lost; against a low sun, where a fraction of a degree
decides whether the road mirrors it, they showed as boxy patches. Both maps are made again here from the colour
photo of the same asphalt (which is clean): its fine light and dark, stones and gaps, is the relief, at the
strength the old map's fine part had, and nothing slower than a few centimetres is kept. They go into
js/assets/core.js as lossless images, and out of the GPU-compressed set (tools/ktx_prep.py), whose own 4 pixel
blocks would do the same again. Run after assets_prep.py / ktx_prep.py have been run again.
"""
import base64, io, json, pathlib, re
import numpy as np
from PIL import Image
ROOT = pathlib.Path(__file__).resolve().parent.parent
JS = ROOT / 'js' / 'assets'


def blur(a, s):
    # a gaussian that wraps round (the tile repeats)
    f = np.fft.fftfreq(a.shape[0])[:, None], np.fft.fftfreq(a.shape[1])[None, :]
    return np.real(np.fft.ifft2(np.fft.fft2(a) * np.exp(-2 * (np.pi * s) ** 2 * (f[0] ** 2 + f[1] ** 2))))


lum = np.asarray(Image.open(ROOT / 'assets/asphalt.jpg').convert('L').resize((512, 512), Image.LANCZOS)).astype(float)
fine = blur(lum, 0.55) - blur(lum, 7)  # (a texel is 4 mm: 2 mm to 3 cm kept)
old = np.asarray(Image.open(ROOT / 'assets/asphalt_n.jpg').convert('RGB').resize((512, 512))).astype(float)
gx = (np.roll(fine, -1, 1) - np.roll(fine, 1, 1)) / 2
gy = (np.roll(fine, -1, 0) - np.roll(fine, 1, 0)) / 2
# the old map's own fine strength, measured above its slow part and its blocks
was = np.sqrt(np.mean([(old[:, :, c] - blur(old[:, :, c], 4)).var() for c in (0, 1)])) / 127.5
k = was / np.sqrt((gx.var() + gy.var()) / 2)
nx, ny = -gx * k, gy * k  # (green up, as the photo sets have it)
nx -= nx.mean(); ny -= ny.mean()
nz = np.sqrt(np.clip(1 - nx ** 2 - ny ** 2, 0, 1))
rng = np.random.default_rng(7)  # (half a step of noise, so eight bits leave no contours)
q = lambda a: np.clip(np.round(a * 127.5 + 127.5 + rng.uniform(-0.5, 0.5, a.shape)), 0, 255).astype('uint8')
N = np.dstack([q(nx), q(ny), np.clip(np.round(nz * 127.5 + 127.5), 0, 255).astype('uint8')])

arm = np.asarray(Image.open(ROOT / 'assets/asphalt_arm.jpg').convert('RGB').resize((512, 512), Image.LANCZOS)).astype(float)
h = fine / fine.std()
out = []
for c, sign in ((0, 1), (1, 1)):  # (gaps are darker; a worn stone top is a little smoother than it is round it, but the photo's own sign is kept)
    ch = arm[:, :, c]; hf = ch - blur(ch, 4)
    r = np.sign(np.corrcoef(hf.ravel(), h.ravel())[0, 1]) or sign
    out.append(np.clip(np.round(ch.mean() + r * h * hf.std() + rng.uniform(-0.5, 0.5, ch.shape)), 0, 255).astype('uint8'))
ARM = np.dstack([out[0], out[1], np.full((512, 512), round(arm[:, :, 2].mean()), 'uint8')])
print('normal: strength %.4f (old fine part %.4f), slow part now %.5f, was %.5f' % (nx.std(), was, blur(nx, 12).std(), blur((old[:, :, 0] - old[:, :, 0].mean()) / 127.5, 12).std()))
print('arm means', arm.mean((0, 1)).round(1), '->', ARM.mean((0, 1)).round(1))

HEAD = 'Object.assign(A, '
p = JS / 'core.js'; s = p.read_text(encoding='utf-8'); a = s.index(HEAD) + len(HEAD); b = s.rindex('); })')
data = json.loads(s[a:b])
for key, im in (('asphalt_n', N), ('asphalt_arm', ARM)):
    f = io.BytesIO(); Image.fromarray(im).save(f, 'PNG', optimize=True); png = f.getvalue()
    (ROOT / 'assets' / f'{key}.png').write_bytes(png)
    data[key] = 'data:image/png;base64,' + base64.b64encode(png).decode()
    print(key, len(png) // 1024, 'KB')
p.write_text(s[:a] + json.dumps(data, separators=(', ', ': ')) + s[b:], encoding='utf-8')
# out of the compressed set and its JPEG fallback (which would load over these)
p = JS / 'ktx_index.js'; s = p.read_text(encoding='utf-8')
for key in ('asphalt_n', 'asphalt_arm'): s = re.sub(r'"%s":\{[^}]*\},?' % key, '', s)
p.write_text(s.replace(',}', '}'), encoding='utf-8')
p = JS / 'photos_core.js'; s = p.read_text(encoding='utf-8'); a = s.index(HEAD) + len(HEAD); b = s.rindex('); })')
d = json.loads(s[a:b])
for key in ('asphalt_n', 'asphalt_arm'): d.pop(key, None)
p.write_text(s[:a] + json.dumps(d, separators=(', ', ': ')) + s[b:], encoding='utf-8')
for key in ('asphalt_n', 'asphalt_arm'):
    f = ROOT / 'assets' / 'ktx' / f'{key}.ktx2'
    if f.exists(): f.unlink()
