"""Textures for the harbour towns of the city circuits (js/r3-city.js).

From CC0 ambientCG sets (https://ambientcg.com): Plaster001 and PaintedPlaster017 (stucco),
RoofingTiles013A (clay roof tiles) and Tiles107 (the tunnel's wall tiles), extracted 1K-JPG sets in
DOWNLOAD_DIR, one folder per asset.

The facades are drawn here over the plaster photographs, the way Riviera apartment blocks look:
tinted stucco, windows with frames and shutters, balconies on some styles, cornices between storeys,
and a separate shopfront ground floor. A facade tile is two storeys by two window bays, 6.4 m
square (a storey and a bay are 3.2 m), at 80 px a metre. Each style has a colour map; they share a
normal map (the plaster's own grain, window reveals and balcony slabs) and a packed AO / roughness /
metalness map (glass is glossy, stucco matte).

Writes assets/city_*.jpg and js/assets/city.js (data URIs, keys as core.js: albedo, `_n`, `_arm`).
usage: python tools/assets_city.py DOWNLOAD_DIR
"""
import sys, json, base64, pathlib, random
from PIL import Image, ImageDraw, ImageFilter, ImageChops

SRC = pathlib.Path(sys.argv[1]); ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets'; OUT.mkdir(exist_ok=True)
S = 512; PX = S / 6.4  # px per metre
random.seed(7)

def img(aid, kind, size=S, mode='RGB'):
    return Image.open(SRC / aid / f'{aid}_1K-JPG_{kind}.jpg').convert(mode).resize((size, size), Image.LANCZOS)

plaster = img('Plaster001', 'Color', mode='L')
plaster_n = img('Plaster001', 'NormalGL')
plaster_r = img('Plaster001', 'Roughness', mode='L')

def tint(gray, rgb, lift=0.0):
    # the plaster's own light and shade, carried in a stucco colour
    # (a sunlit Riviera wall is pale: about 0.85 of its paint colour, the grain a few per cent)
    g = gray.point(lambda v: int(min(255, 218 + (v - 128) * 0.35 + lift)))
    return Image.merge('RGB', [g.point(lambda v, c=c: int(v * c / 255)) for c in rgb])

# styles: wall colour, shutter colour, balcony kind
STYLES = [
    ('A', (244, 234, 210), (74, 110, 78), 'iron'),     # cream, green shutters, wrought-iron balconies
    ('B', (238, 206, 150), (120, 82, 52), None),       # ochre, brown shutters
    ('C', (244, 242, 236), None, 'slab'),              # white modern block, continuous balconies
    ('D', (240, 196, 176), (214, 209, 200), 'iron'),   # salmon pink, light grey shutters
    ('E', (242, 226, 168), (64, 98, 70), 'iron'),      # pale yellow, green shutters
    ('F', (236, 232, 222), (70, 96, 128), None),       # off-white, blue-grey shutters
]

def facade(style):
    key, wall, shut, balc = style
    col = tint(plaster, wall)
    nrm = plaster_n.copy()
    arm_ao = Image.new('L', (S, S), 255); arm_r = plaster_r.point(lambda v: int(180 + v * 0.25)); arm_m = Image.new('L', (S, S), 0)
    dc, dn, da, dr = ImageDraw.Draw(col), ImageDraw.Draw(nrm), ImageDraw.Draw(arm_ao), ImageDraw.Draw(arm_r)
    m = lambda v: int(round(v * PX))
    for st in range(2):          # storeys, from the top of the tile down
        y0 = st * 3.2
        # cornice / floor band
        dc.rectangle([0, m(y0 + 3.05), S, m(y0 + 3.2)], fill=tuple(int(c * 0.86) for c in wall))
        dn.rectangle([0, m(y0 + 3.05), S, m(y0 + 3.12)], fill=(128, 200, 255)); dn.rectangle([0, m(y0 + 3.13), S, m(y0 + 3.2)], fill=(128, 60, 255))
        for bay in range(2):
            cx = bay * 3.2 + 1.6
            wx0, wx1 = cx - 0.62, cx + 0.62
            wy0, wy1 = y0 + 0.75, y0 + 2.65   # window top and bottom (sill 0.55 m above the floor band)
            if balc == 'slab':
                wy0, wx0, wx1 = y0 + 0.55, cx - 1.1, cx + 1.1  # tall glazed doors onto the balcony
            # reveal (shadowed recess) then glass, frame and glazing bars
            dc.rectangle([m(wx0) - 6, m(wy0) - 6, m(wx1) + 6, m(wy1) + 6], fill=tuple(int(c * 0.62) for c in wall))
            sky = (78 + random.randint(-10, 10), 96, 112)
            dc.rectangle([m(wx0), m(wy0), m(wx1), m(wy1)], fill=sky)
            for k in range(m(wy1) - m(wy0)):
                t = k / max(1, m(wy1) - m(wy0))
                dc.line([m(wx0), m(wy0) + k, m(wx1), m(wy0) + k], fill=tuple(int(c * (1.25 - 0.55 * t)) for c in sky))
            dc.rectangle([m(wx0), m(wy0), m(wx1), m(wy1)], outline=(236, 234, 228), width=5)
            dc.line([m(cx), m(wy0), m(cx), m(wy1)], fill=(236, 234, 228), width=4)
            dc.line([m(wx0), m(wy0 + 0.6), m(wx1), m(wy0 + 0.6)], fill=(236, 234, 228), width=3)
            da.rectangle([m(wx0) - 6, m(wy0) - 6, m(wx1) + 6, m(wy1) + 6], fill=150)
            dr.rectangle([m(wx0), m(wy0), m(wx1), m(wy1)], fill=40)
            # the reveal's edges in the normal map: the window sits back in the wall
            dn.rectangle([m(wx0) - 6, m(wy0) - 6, m(wx1) + 6, m(wy0)], fill=(128, 60, 255))
            dn.rectangle([m(wx0) - 6, m(wy1), m(wx1) + 6, m(wy1) + 6], fill=(128, 200, 255))
            dn.rectangle([m(wx0) - 6, m(wy0), m(wx0), m(wy1)], fill=(200, 128, 255))
            dn.rectangle([m(wx1), m(wy0), m(wx1) + 6, m(wy1)], fill=(60, 128, 255))
            dn.rectangle([m(wx0), m(wy0), m(wx1), m(wy1)], fill=(128, 128, 255))
            # shutters folded back either side, slatted
            if shut:
                for sx0 in (wx0 - 0.66, wx1 + 0.04):
                    dc.rectangle([m(sx0), m(wy0), m(sx0 + 0.62), m(wy1)], fill=shut)
                    for k in range(m(wy0) + 4, m(wy1), 7):
                        dc.line([m(sx0) + 3, k, m(sx0 + 0.62) - 3, k], fill=tuple(int(c * 0.72) for c in shut), width=2)
                    dn.rectangle([m(sx0), m(wy0), m(sx0 + 0.62), m(wy1)], fill=(128, 150, 255))
            # balconies
            if balc == 'iron':
                bx0, bx1, by = cx - 1.0, cx + 1.0, wy1
                dc.rectangle([m(bx0), m(by), m(bx1), m(by + 0.14)], fill=tuple(int(c * 0.9) for c in wall))
                dc.rectangle([m(bx0), m(by + 0.14), m(bx1), m(by + 0.4)], fill=tuple(int(c * 0.55) for c in wall))  # shadow under the slab
                for k in range(m(bx0), m(bx1), 9):
                    dc.line([k, m(by - 1.0), k, m(by)], fill=(42, 40, 38), width=2)
                dc.line([m(bx0), m(by - 1.0), m(bx1), m(by - 1.0)], fill=(42, 40, 38), width=4)
                dn.rectangle([m(bx0), m(by), m(bx1), m(by + 0.07)], fill=(128, 230, 255)); dn.rectangle([m(bx0), m(by + 0.07), m(bx1), m(by + 0.14)], fill=(128, 30, 255))
            if balc == 'slab':
                by = y0 + 2.65
                dc.rectangle([0, m(by), S, m(by + 0.2)], fill=(232, 230, 224))
                dc.rectangle([0, m(by + 0.2), S, m(by + 0.5)], fill=tuple(int(c * 0.5) for c in wall))
                dc.rectangle([0, m(by - 1.0), S, m(by)], fill=(150, 170, 178))  # glass balustrade
                dc.line([0, m(by - 1.0), S, m(by - 1.0)], fill=(220, 222, 222), width=4)
                dr.rectangle([0, m(by - 1.0), S, m(by)], fill=60)
                dn.rectangle([0, m(by), S, m(by + 0.1)], fill=(128, 230, 255)); dn.rectangle([0, m(by + 0.1), S, m(by + 0.2)], fill=(128, 30, 255))
    arm = Image.merge('RGB', (arm_ao.filter(ImageFilter.GaussianBlur(3)), arm_r, arm_m))
    return col, nrm, arm

def shopfront():
    # the ground floor: a stone base, shop windows under awnings, the first-floor band above
    col = tint(plaster, (214, 206, 190)); nrm = plaster_n.copy()
    arm = Image.merge('RGB', (Image.new('L', (S, S), 255), plaster_r.point(lambda v: int(190 + v * 0.2)), Image.new('L', (S, S), 0)))
    dc, dn = ImageDraw.Draw(col), ImageDraw.Draw(nrm)
    dar = ImageDraw.Draw(arm)
    m = lambda v: int(round(v * PX))
    awn = [(150, 40, 40), (38, 70, 110), (40, 90, 60), (200, 160, 60)]
    for bay in range(2):
        cx = bay * 3.2 + 1.6
        x0, x1, y0, y1 = cx - 1.35, cx + 1.35, 6.4 - 3.4, 6.4 - 0.15
        dc.rectangle([m(x0), m(y0), m(x1), m(y1)], fill=(40, 46, 52))
        for k in range(m(y1) - m(y0)):
            t = k / max(1, m(y1) - m(y0))
            dc.line([m(x0) + 4, m(y0) + k, m(x1) - 4, m(y0) + k], fill=(int(70 - 30 * t), int(80 - 30 * t), int(88 - 30 * t)))
        dc.rectangle([m(x0), m(y0), m(x1), m(y1)], outline=(30, 30, 32), width=6)
        dar.rectangle([m(x0), m(y0), m(x1), m(y1)], fill=(150, 35, 60))
        a = awn[(bay + random.randint(0, 3)) % 4]
        dc.polygon([(m(x0) - 6, m(y0) - 2), (m(x1) + 6, m(y0) - 2), (m(x1) + 14, m(y0 + 0.7)), (m(x0) - 14, m(y0 + 0.7))], fill=a)
        for k in range(m(x0), m(x1), 18):
            dc.line([k, m(y0) - 2, k + 4, m(y0 + 0.7)], fill=tuple(int(c * 0.8) for c in a), width=6)
        dn.rectangle([m(x0) - 14, m(y0) - 2, m(x1) + 14, m(y0 + 0.7)], fill=(128, 230, 255))
    dc.rectangle([0, m(6.4 - 0.15), S, S], fill=(170, 164, 150))  # stone plinth
    dc.rectangle([0, m(2.6), S, m(2.8)], fill=(200, 192, 176))     # first-floor band
    return col, nrm, arm

def save(im, name, q=86):
    p = OUT / f'city_{name}.jpg'; im.save(p, quality=q, optimize=True); return p

keys = {}
for st in STYLES:
    c, n, a = facade(st)
    keys['fac' + st[0]] = save(c, 'fac' + st[0]); keys['fac' + st[0] + '_n'] = save(n, 'fac' + st[0] + '_n', 88); keys['fac' + st[0] + '_arm'] = save(a, 'fac' + st[0] + '_arm', 88)
c, n, a = shopfront()
keys['shop'] = save(c, 'shop'); keys['shop_n'] = save(n, 'shop_n', 88); keys['shop_arm'] = save(a, 'shop_arm', 88)
# roof tiles and the tunnel's wall tiles: straight from their sets
for key, aid in (('roof', 'RoofingTiles013A'), ('tile', 'Tiles107')):
    keys[key] = save(img(aid, 'Color'), key)
    keys[key + '_n'] = save(img(aid, 'NormalGL'), key + '_n', 88)
    ao = img(aid, 'AmbientOcclusion', mode='L') if (SRC / aid / f'{aid}_1K-JPG_AmbientOcclusion.jpg').exists() else Image.new('L', (S, S), 255)
    keys[key + '_arm'] = save(Image.merge('RGB', (ao, img(aid, 'Roughness', mode='L'), Image.new('L', (S, S), 0))), key + '_arm', 88)
# flat roofs and terraces: the white painted plaster, light
keys['terrace'] = save(tint(img('PaintedPlaster017', 'Color', mode='L'), (214, 208, 198), 20), 'terrace')

def uri(p): return 'data:image/jpeg;base64,' + base64.b64encode(p.read_bytes()).decode()
data = {'city_' + k: uri(p) for k, p in keys.items()}
(ROOT / 'js' / 'assets' / 'city.js').write_text('// Harbour-town textures: CC0 ambientCG sets (Plaster001, PaintedPlaster017, RoofingTiles013A, Tiles107) with facades drawn over them, prepared by tools/assets_city.py\n'
    '(function (G) { const A = G.F1.Assets = G.F1.Assets || {}; Object.assign(A, ' + json.dumps(data) + '); })(window);\n')
print('wrote', len(keys), 'textures,', round((ROOT / 'js' / 'assets' / 'city.js').stat().st_size / 1e6, 2), 'MB')
