// Layout statistics of real F1 circuits (corners per km, city-block turns, hairpins, straights,
// sweeping curves, how grid-like and how elongated), measured with TrackGen2.layoutStats, the same
// function the generator's layout check uses. Writes tools/data/f1_layout.json, and the envelope
// the city style must fall in (Monaco's figures, widened) into the <layout> block of
// js/trackgen2.js: the city style follows Monaco's way of laying out a lap, not its shape.
// usage: node tools/f1layout_prep.js GEOJSON   (bacinger/f1-circuits, MIT)
const fs = require('fs'), path = require('path');
const load = require('./load');
const F1 = load(['util.js', 'tracks.js', 'trackgen.js', 'trackgen2.js']);
const geo = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = {};
for (const f of geo.features) {
  const c = f.geometry.coordinates, lat0 = c.reduce((s, p) => s + p[1], 0) / c.length, lon0 = c.reduce((s, p) => s + p[0], 0) / c.length;
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  let xs = c.map(p => (p[0] - lon0) * kx), ys = c.map(p => -(p[1] - lat0) * ky);
  // drop the closing point when the line repeats its start
  if (Math.hypot(xs[0] - xs[xs.length - 1], ys[0] - ys[ys.length - 1]) < 1) { xs = xs.slice(0, -1); ys = ys.slice(0, -1); }
  const st = F1.TrackGen2.layoutStats(xs, ys);
  out[f.properties.id] = Object.assign({ name: f.properties.Name, spacing: Math.round(st.L / xs.length) }, Object.fromEntries(Object.entries(st).map(([k, v]) => [k, Math.round(v * 1000) / 1000])));
  const s = out[f.properties.id];
  console.log(`${f.properties.id.padEnd(8)} ${f.properties.Name.slice(0, 30).padEnd(30)} sp ${String(s.spacing).padStart(3)}  cpk ${s.cpk.toFixed(2)}  sq ${s.square.toFixed(2)}  hp ${s.hairpins}  longest ${Math.round(s.longest)}  long ${s.long}  sweep ${s.sweep.toFixed(2)}  bendy ${s.bendy.toFixed(2)}  grid ${s.grid.toFixed(2)}  aspect ${s.aspect.toFixed(2)}`);
}
fs.writeFileSync(path.join(__dirname, 'data', 'f1_layout.json'), JSON.stringify(out, null, 1));

// the city style's envelope, from Monaco
const m = out['mc-1929'];
const LAYOUT = { city: {
  from: m.name,
  cpk: [+(m.cpk * 0.75).toFixed(2), +(m.cpk * 1.3).toFixed(2)],
  square: [0, +Math.max(0.55, m.square + 0.25).toFixed(2)],
  hairpins: [1, 3],
  sweep: [+(m.sweep * 0.55).toFixed(2), +(m.sweep * 1.5).toFixed(2)],
  bendy: [+(m.bendy * 0.6).toFixed(2), +(m.bendy * 1.45).toFixed(2)],
  grid: [0, +Math.min(0.92, m.grid + 0.2).toFixed(2)],
  aspect: [+(m.aspect * 0.55).toFixed(2), +(m.aspect * 1.7).toFixed(2)],
} };
console.log('city layout envelope', JSON.stringify(LAYOUT.city));
const tg = path.join(__dirname, '..', 'js', 'trackgen2.js');
let src = fs.readFileSync(tg, 'utf8');
const block = '  // <layout> (written by tools/f1layout_prep.js from the real centrelines; do not edit by hand)\n  const LAYOUT = ' + JSON.stringify(LAYOUT) + ';\n  // </layout>';
const next = src.replace(/  \/\/ <layout>[\s\S]*?\/\/ <\/layout>/, block);
if (next === src) throw new Error('no <layout> block in js/trackgen2.js');
fs.writeFileSync(tg, next);
