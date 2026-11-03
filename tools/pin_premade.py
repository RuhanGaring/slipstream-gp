"""Freezes the circuit generator for the premade circuits made with it.

A premade circuit is a seed and candidate of js/trackgen2.js, with a racing line and AI limits
learned on exactly that geometry (js/lines.js, js/limits.js). Any later change to the generator
would move the circuit under that data, so the premade ones run on this frozen copy of it:
js/trackgen2-fixed.js, the same code under the name F1.TrackGenFixed.

Run this only when a premade circuit is being rebuilt on purpose, then learn it again:
  python tools/pin_premade.py
  WRITE=1 node tools/learnpar.js <id>
  node tools/premade_preview.js
"""
import pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
src = (ROOT / 'js/trackgen2.js').read_text(encoding='utf-8')
head = """// FROZEN COPY of js/trackgen2.js, made by tools/pin_premade.py. Do not edit: the premade circuits
// in js/tracks.js (def.fixed) are built by this code, and their racing lines and AI limits were
// learned on exactly what it makes. Work on the generator goes in js/trackgen2.js.
//
"""
tail = """  // a premade circuit: one candidate of one seed, under its own id and name
  function premade(def) {
    const f = def.fixed, a = attempt(f.seed, f.style, f.cand);
    if (!a.ok) throw new Error('premade circuit ' + def.id + ' does not build: ' + a.why.join(', '));
    const d = a.res.def, tr = a.res.tr;
    Object.assign(d, { id: def.id, name: def.name, country: def.country, flag: def.flag, blurb: def.blurb });
    delete d.gen;
    tr.id = def.id; tr.name = def.name;
    return tr;
  }
"""
a = '  F1.TrackGen2 = { _city:'
assert src.count(a) == 1
out = head + src.replace(a, tail + '  F1.TrackGenFixed = { premade, _city:')
(ROOT / 'js/trackgen2-fixed.js').write_text(out, encoding='utf-8')
print('wrote js/trackgen2-fixed.js')
