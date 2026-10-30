"""Prepare the CC0 photo assets (Poly Haven, ambientCG) for the 3D renderer.
usage: python tools/assets_prep.py DOWNLOAD_DIR
Resizes textures, composes foliage cluster cards from leaf atlases, downscales the
sky panoramas, writes them to assets/, then embeds them as data URIs in
js/assets/*.js so the game keeps working from file:// (WebGL refuses file:// images).
"""
import sys, pathlib, random, base64, io, json
from PIL import Image, ImageEnhance, ImageOps

SRC = pathlib.Path(sys.argv[1])
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets'; OUT.mkdir(exist_ok=True)
JS = ROOT / 'js' / 'assets'; JS.mkdir(exist_ok=True)

def jpg(src, name, size, q=86, tint=None):
    im = Image.open(SRC / src).convert('RGB')
    if size: im = im.resize((size, size), Image.LANCZOS)
    im.save(OUT / name, quality=q, optimize=True)

TEX = [
    ('asphalt_track_Diffuse.jpg', 'asphalt.jpg', 1024), ('asphalt_track_nor_gl.jpg', 'asphalt_n.jpg', 512),
    ('asphalt_pit_lane_Diffuse.jpg', 'pitlane.jpg', 512),
    ('gravel_floor_02_Diffuse.jpg', 'gravel.jpg', 1024), ('gravel_floor_02_nor_gl.jpg', 'gravel_n.jpg', 512),
    ('concrete_wall_008_Diffuse.jpg', 'concrete.jpg', 512),
    ('coast_sand_01_Diffuse.jpg', 'sand.jpg', 1024), ('pavement_02_Diffuse.jpg', 'pavement.jpg', 1024),
    ('Grass001_1K-JPG_Color.jpg', 'grass.jpg', 1024), ('Grass001_1K-JPG_NormalGL.jpg', 'grass_n.jpg', 512),
    ('fir_tree_01_bark_diff.jpg', 'bark.jpg', 256),
]
# PBR companions: Poly Haven 'arm' maps pack AO (R), roughness (G), metalness (B), which is
# exactly the channel layout three.js reads for aoMap / roughnessMap / metalnessMap.
TEX += [
    ('asphalt_track_arm.jpg', 'asphalt_arm.jpg', 1024),
    ('asphalt_pit_lane_arm.jpg', 'pitlane_arm.jpg', 512), ('asphalt_pit_lane_nor_gl.jpg', 'pitlane_n.jpg', 512),
    ('gravel_floor_02_arm.jpg', 'gravel_arm.jpg', 512),
    ('concrete_wall_008_arm.jpg', 'concrete_arm.jpg', 512), ('concrete_wall_008_nor_gl.jpg', 'concrete_n.jpg', 512),
    ('coast_sand_01_arm.jpg', 'sand_arm.jpg', 512), ('coast_sand_01_nor_gl.jpg', 'sand_n.jpg', 512),
    ('pavement_02_arm.jpg', 'pavement_arm.jpg', 512), ('pavement_02_nor_gl.jpg', 'pavement_n.jpg', 512),
    ('painted_concrete_arm.jpg', 'kerb_arm.jpg', 512), ('painted_concrete_nor_gl.jpg', 'kerb_n.jpg', 512),
    ('metal_plate_Diffuse.jpg', 'metal.jpg', 512), ('metal_plate_arm.jpg', 'metal_arm.jpg', 512), ('metal_plate_nor_gl.jpg', 'metal_n.jpg', 512),
    ('Rubber004_1K-JPG_Color.jpg', 'rubber.jpg', 512), ('Rubber004_1K-JPG_NormalGL.jpg', 'rubber_n.jpg', 512),
]
for a, b, s in TEX: jpg(a, b, s)

def arm(ao, rough, name, size=512, metal=0):
    r = Image.open(SRC / ao).convert('L').resize((size, size)) if ao else Image.new('L', (size, size), 255)
    g = Image.open(SRC / rough).convert('L').resize((size, size))
    Image.merge('RGB', (r, g, Image.new('L', (size, size), metal))).save(OUT / name, quality=88)
arm('Grass001_1K-JPG_AmbientOcclusion.jpg', 'Grass001_1K-JPG_Roughness.jpg', 'grass_arm.jpg')
arm(None, 'Rubber004_1K-JPG_Roughness.jpg', 'rubber_arm.jpg')

# Riviera facade: painted plaster with a 4 x 4 grid of windows (3.5 m bays and floors).
# Glass is dark and glossy in the ARM map so it mirrors the sky; plaster stays matte.
def facade():
    S = 1024
    pd = Image.open(SRC / 'painted_plaster_wall_Diffuse.jpg').convert('RGB').resize((512, 512))
    pa = Image.open(SRC / 'painted_plaster_wall_arm.jpg').convert('RGB').resize((512, 512))
    pn = Image.open(SRC / 'painted_plaster_wall_nor_gl.jpg').convert('RGB').resize((512, 512))
    pd = ImageEnhance.Color(ImageOps.autocontrast(pd, cutoff=1)).enhance(0.35)
    pd = Image.blend(pd, Image.new('RGB', pd.size, (240, 236, 228)), 0.78)
    d, a, n = (Image.new('RGB', (S, S)) for _ in range(3))
    for x in (0, 512):
        for y in (0, 512):
            d.paste(pd, (x, y)); a.paste(pa, (x, y)); n.paste(pn, (x, y))
    from PIL import ImageDraw
    dd, ad, nd = ImageDraw.Draw(d), ImageDraw.Draw(a), ImageDraw.Draw(n)
    rnd = random.Random(9)
    for bx in range(4):
        for fy in range(4):
            x0, y0 = bx * 256 + 83, fy * 256 + 50
            w, h = 90, 150
            # stone surround, recess shadow, glass, mullion
            dd.rectangle([x0 - 10, y0 - 10, x0 + w + 10, y0 + h + 14], fill=(236, 232, 222))
            ad.rectangle([x0 - 10, y0 - 10, x0 + w + 10, y0 + h + 14], fill=(255, 150, 0))
            dd.rectangle([x0, y0, x0 + w, y0 + h], fill=(28, 34, 40))
            ad.rectangle([x0, y0, x0 + w, y0 + h], fill=(255, 14, 0))
            nd.rectangle([x0, y0, x0 + w, y0 + h], fill=(128, 128, 255))
            nd.rectangle([x0, y0, x0 + 3, y0 + h], fill=(60, 128, 230)); nd.rectangle([x0 + w - 3, y0, x0 + w, y0 + h], fill=(196, 128, 230))
            nd.rectangle([x0, y0, x0 + w, y0 + 3], fill=(128, 196, 230))
            dd.rectangle([x0 + w // 2 - 2, y0, x0 + w // 2 + 2, y0 + h], fill=(210, 206, 196))
            ad.rectangle([x0 + w // 2 - 2, y0, x0 + w // 2 + 2, y0 + h], fill=(255, 120, 0))
            # some shutters open beside the window, some closed over it
            sc = (61, 88, 64) if rnd.random() < 0.6 else (122, 84, 52)
            if rnd.random() < 0.3:
                dd.rectangle([x0, y0, x0 + w, y0 + h], fill=sc); ad.rectangle([x0, y0, x0 + w, y0 + h], fill=(220, 165, 0))
                for k in range(y0 + 6, y0 + h, 9): dd.line([x0 + 2, k, x0 + w - 2, k], fill=tuple(int(c * 0.7) for c in sc), width=2)
            else:
                for sx in (x0 - 52, x0 + w + 8):
                    dd.rectangle([sx, y0, sx + 44, y0 + h], fill=sc); ad.rectangle([sx, y0, sx + 44, y0 + h], fill=(220, 165, 0))
                    for k in range(y0 + 6, y0 + h, 9): dd.line([sx + 2, k, sx + 42, k], fill=tuple(int(c * 0.7) for c in sc), width=2)
            # balcony slab with rail on alternate floors
            if fy % 2 == 0:
                dd.rectangle([x0 - 30, y0 + h + 14, x0 + w + 30, y0 + h + 22], fill=(200, 196, 188))
                for k in range(x0 - 28, x0 + w + 30, 8): dd.line([k, y0 + h - 18, k, y0 + h + 14], fill=(40, 42, 44), width=2)
                dd.line([x0 - 30, y0 + h - 18, x0 + w + 30, y0 + h - 18], fill=(40, 42, 44), width=3)
                ad.rectangle([x0 - 30, y0 + h - 18, x0 + w + 30, y0 + h + 14], fill=(255, 90, 160))
    d.save(OUT / 'facade.jpg', quality=86); a.save(OUT / 'facade_arm.jpg', quality=88); n.save(OUT / 'facade_n.jpg', quality=88)
facade()

# ---- foliage cluster cards: leaves scattered into a soft, irregular canopy blob ----
def sprites(diff, alpha, region=(0, 0, 1, 1), min_px=40):
    c = Image.open(SRC / diff).convert('RGB'); a = Image.open(SRC / alpha).convert('L')
    W, H = c.size
    box = (int(region[0] * W), int(region[1] * H), int(region[2] * W), int(region[3] * H))
    c = c.crop(box); a = a.crop(box)
    # connected blobs via a coarse grid flood fill on the alpha
    small = a.resize((a.width // 4, a.height // 4))
    px = small.load(); w, h = small.size
    seen = set(); out = []
    for y in range(h):
        for x in range(w):
            if (x, y) in seen or px[x, y] < 128: continue
            st = [(x, y)]; seen.add((x, y)); xs = []; ys = []
            while st:
                u, v = st.pop(); xs.append(u); ys.append(v)
                for du, dv in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    p = (u + du, v + dv)
                    if 0 <= p[0] < w and 0 <= p[1] < h and p not in seen and px[p] >= 128:
                        seen.add(p); st.append(p)
            bb = (min(xs) * 4, min(ys) * 4, max(xs) * 4 + 4, max(ys) * 4 + 4)
            if bb[2] - bb[0] < min_px and bb[3] - bb[1] < min_px: continue
            rgba = c.crop(bb).convert('RGBA'); rgba.putalpha(a.crop(bb))
            out.append(rgba)
    return out

def card(leaves, name, n, size=512, shape='round', seed=1, leaf_px=(46, 84), hue=1.0):
    rnd = random.Random(seed)
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    cx = cy = size / 2
    for k in range(n):
        f = k / n  # back to front: inner/darker first
        for _ in range(30):
            x, y = rnd.uniform(0, size), rnd.uniform(0, size)
            if shape == 'round':
                r = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 / (size * 0.47)
                edge = 0.78 + 0.22 * rnd.random()
                if r < edge: break
            else:  # conifer: triangle, point up
                t = y / size
                if abs(x - cx) < t * size * 0.46 + 6: break
        lf = rnd.choice(leaves)
        s = rnd.uniform(*leaf_px) / max(lf.size)
        lf = lf.resize((max(2, int(lf.width * s)), max(2, int(lf.height * s))), Image.LANCZOS)
        lf = lf.rotate(rnd.uniform(0, 360), expand=True, resample=Image.BICUBIC)
        br = 0.55 + 0.6 * f + rnd.uniform(-0.08, 0.08)
        rgb = ImageEnhance.Brightness(lf.convert('RGB')).enhance(br * hue)
        lf2 = rgb.convert('RGBA'); lf2.putalpha(lf.getchannel('A'))
        img.alpha_composite(lf2, (int(x - lf.width / 2), int(y - lf.height / 2)))
    img.save(OUT / name, optimize=True)

broad = sprites('island_tree_01_leaves_diff.jpg', 'island_tree_01_leaves_alpha.jpg')
small = sprites('tree_small_02_leaves_diff.jpg', 'tree_small_02_leaves_alpha.jpg', (0, 0, 0.62, 1), 24)
twigs = sprites('fir_tree_01_twig_diff.jpg', 'fir_tree_01_twig_alpha.jpg', (0.27, 0, 1, 0.8), 30)
print('sprites', len(broad), len(small), len(twigs))
card(broad + small, 'leaves.png', 900, seed=3, leaf_px=(34, 62))
card(twigs, 'conifer.png', 520, shape='tri', seed=5, leaf_px=(70, 130))

# ---- skies: equirect panoramas, 4096 x 2048 ----
SKIES = {'kestrel': 'overcast_soil_puresky', 'varenna': 'citrus_orchard_road_puresky', 'lucerne': 'kloofendal_48d_partly_cloudy_puresky',
         'hakone': 'sunflowers_puresky', 'rimal': 'industrial_sunset_puresky'}
for tid, a in SKIES.items():
    im = Image.open(SRC / f'sky_{a}.jpg').convert('RGB').resize((4096, 2048), Image.LANCZOS)
    im.save(OUT / f'sky_{tid}.jpg', quality=82, optimize=True)

# ---- embed ----
def uri(p):
    mime = 'image/png' if p.suffix == '.png' else 'image/jpeg'
    return f'data:{mime};base64,' + base64.b64encode(p.read_bytes()).decode()
core = {p.stem: uri(p) for p in sorted(OUT.iterdir()) if not p.stem.startswith('sky_')}
hdr = '// Generated by tools/assets_prep.py from CC0 assets (Poly Haven, ambientCG). Do not edit.\n'
(JS / 'core.js').write_text(hdr + '(function (G) { const A = G.F1.Assets = G.F1.Assets || {}; Object.assign(A, ' + json.dumps(core) + '); })(window);\n')
for tid in SKIES:
    (JS / f'sky_{tid}.js').write_text(hdr + '(function (G) { const A = G.F1.Assets = G.F1.Assets || {}; A["sky_' + tid + '"] = ' + json.dumps(uri(OUT / f'sky_{tid}.jpg')) + '; if (A.onSky) A.onSky("' + tid + '"); })(window);\n')
for p in sorted(OUT.iterdir()): print(p.name, p.stat().st_size // 1024, 'KB')
