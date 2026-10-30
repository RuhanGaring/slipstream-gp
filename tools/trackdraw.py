"""Draw the circuits from tools/trackdesign.js output as one PNG contact sheet.
usage: python tools/trackdraw.py design.json OUT.png
Track in white at its real width, start line red, direction arrow, corner numbers with
their radius, the pit lane in blue, a red ring where two parts of the circuit come too close.
"""
import sys, json, math
from PIL import Image, ImageDraw, ImageFont

D = json.load(open(sys.argv[1]))
S = 900
img = Image.new('RGB', (S * min(3, len(D)), S * ((len(D) + 2) // 3)), (24, 26, 30))
dr = ImageDraw.Draw(img)
try:
    font = ImageFont.truetype('arial.ttf', 15); big = ImageFont.truetype('arialbd.ttf', 26)
except OSError:
    font = big = ImageFont.load_default()
for n, t in enumerate(D):
    ox, oy = (n % 3) * S, (n // 3) * S
    xs = [p[0] for p in t['pts']]; ys = [p[1] for p in t['pts']]
    mnx, mxx, mny, mxy = min(xs), max(xs), min(ys), max(ys)
    k = (S - 120) / max(mxx - mnx, mxy - mny)
    P = lambda x, y: (ox + 60 + (x - mnx) * k + ((S - 120) - (mxx - mnx) * k) / 2, oy + 80 + (y - mny) * k + ((S - 160) - (mxy - mny) * k) / 2)
    pts = [P(*p) for p in t['pts']]
    dr.line(pts + [pts[0]], fill=(70, 74, 82), width=max(3, int(t['w'] * k) + 6), joint='curve')
    dr.line(pts + [pts[0]], fill=(235, 236, 240), width=max(2, int(t['w'] * k)), joint='curve')
    for a, b in t['drs']:
        seg = [pts[(i // 2) % len(pts)] for i in range(a, b if b > a else b + t['N'], 2)]
        if len(seg) > 1: dr.line(seg, fill=(43, 214, 107), width=2)
    if t['pit']: dr.line([P(*p) for p in t['pit']], fill=(58, 160, 255), width=2)
    sx, sy, tx, ty = t['start']; a = P(sx, sy)
    dr.line([(a[0] - ty * 14, a[1] + tx * 14), (a[0] + ty * 14, a[1] - tx * 14)], fill=(255, 59, 48), width=4)
    dr.polygon([(a[0] + tx * 26, a[1] + ty * 26), (a[0] + tx * 12 - ty * 7, a[1] + ty * 12 + tx * 7), (a[0] + tx * 12 + ty * 7, a[1] + ty * 12 - tx * 7)], fill=(255, 59, 48))
    for i, (x, y, r) in enumerate(t['apexes']):
        q = P(x, y); dr.text((q[0] + 8, q[1] - 8), f'{i + 1}:{r}', fill=(255, 204, 31), font=font)
    if t['cross']:
        q = P(*t['cross']); dr.ellipse([q[0] - 18, q[1] - 18, q[0] + 18, q[1] + 18], outline=(255, 40, 40), width=3)
    dr.text((ox + 20, oy + 16), f"{t['name']}  {t['L'] / 1000:.3f} km  {len(t['apexes'])} corners", fill=(255, 255, 255), font=big)
img.save(sys.argv[2])
