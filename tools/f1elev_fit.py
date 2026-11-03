"""Fits the realism envelopes of the circuit generator (js/trackgen2.js) to the real F1 elevation
statistics measured by tools/f1elev_prep.py (tools/data/f1_elevation.json).

Each generator style is matched to a group of real circuits:
  city      hillside street circuits: Monaco, Baku, Madring
  park      permanent circuits climbing less than 40 m a lap
  mountain  permanent circuits climbing 40 m or more
  modern    the purpose-built modern venues
Left out: circuits whose profile is dominated by small-scale noise in the elevation data
(buildings, stands or canopy the surface model still carries): Singapore, Mexico City and
Buenos Aires. Monaco's climb is taken from its published figure (42 m), as the data reads its
tunnel at the hotel's roof, and its steepest 100 m is left out for the same reason.

The envelope of each statistic is the group's range, widened by a margin, and the generator only
returns circuits that fall inside it. Writes the block between the <real> markers in
js/trackgen2.js.

usage: python tools/f1elev_fit.py
"""
import json, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent
S = json.loads((ROOT / 'tools' / 'data' / 'f1_elevation.json').read_text())
NOISY = {'sg-2008', 'mx-1962', 'ar-1952'}
PUBLISHED_RANGE = {'mc-1929': 42.0}
# steepest-100 m readings that are artefacts (Monaco's 22 % is the road meeting the hotel roof over
# the tunnel in the data), left out of that one statistic
STEEP_ARTEFACT = {'mc-1929'}
for k, v in PUBLISHED_RANGE.items():
    S[k]['ascent'] = round(S[k]['ascent'] * v / S[k]['range'], 1)
    S[k]['range'] = v

def members(style):
    if style == 'city': return ['mc-1929', 'az-2016', 'es-2026']
    out = []
    for k, s in S.items():
        if k in NOISY: continue
        if style == 'modern' and s['group'] == 'modern': out.append(k)
        if style == 'park' and s['group'] == 'classic' and s['range'] < 40: out.append(k)
        if style == 'mountain' and s['group'] == 'classic' and s['range'] >= 40: out.append(k)
    return out

def env(vals, lo_k, hi_k, lo_add=0.0, hi_add=0.0):
    return [round(min(vals) * lo_k - lo_add, 2), round(max(vals) * hi_k + hi_add, 2)]

REAL = {}
for style in ['city', 'park', 'mountain', 'modern']:
    m = members(style)
    g = [S[k] for k in m]
    REAL[style] = {
        'from': [S[k]['name'] for k in m],
        'range': env([s['range'] for s in g], 0.85, 1.12),
        'g100': env([S[k]['g100'] for k in m if k not in STEEP_ARTEFACT], 0.5, 1.08),
        'share4': env([s['share']['4'] for s in g], 0.6, 1.15, 0, 3),
        'ratio': env([s['ascent'] / max(1, s['range']) for s in g], 0.85, 1.12),
        'climbs': [max(1, min(s['climbs'] for s in g) - 1), max(s['climbs'] for s in g) + 1],
        'crestR': round(min(s['crestR'] for s in g) * 0.85),
    }
    print(style, json.dumps(REAL[style]))

block = '  // <real> (written by tools/f1elev_fit.py from tools/data/f1_elevation.json; do not edit by hand)\n  const REAL = ' + json.dumps(REAL) + ';\n  // </real>'
p = ROOT / 'js' / 'trackgen2.js'
src = p.read_text(encoding='utf-8')
src, n = re.subn(r'  // <real>.*?// </real>', lambda m: block, src, flags=re.S)
if n != 1: raise SystemExit('no <real> block in js/trackgen2.js')
p.write_text(src, encoding='utf-8')
print('wrote the envelopes into js/trackgen2.js')
