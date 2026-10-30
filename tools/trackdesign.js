// Circuit design bench: author a circuit as a surveyor's turtle (straight, turn, radius), close
// the loop exactly, build it with the real track builder and check it the way the circuit
// generator does (room between parts, a real start straight, corner count and variety).
// usage: node tools/trackdesign.js DESIGNS.js OUT.json
//   DESIGNS.js exports [{ id, ..., turtle: [[len, turnDeg, radius], ...], flex: k }]
//   Turns are + right (clockwise on screen). The loop starts on the start line heading east;
//   turn angles must sum to +/-360; the straight before vertex `flex` is stretched so the
//   last vertex comes back level with the start line.
// Prints the vertex list to paste into js/tracks.js and writes OUT.json for tools/trackdraw.py.
const F1 = require('./load')(['util.js', 'tracks.js', 'raceline.js', 'trackgen.js']);
const path = require('path'), fs = require('fs');
const designs = require(path.resolve(process.argv[2]));
const out = [];

function walk(turtle, lens) {
  let x = 0, y = 0, h = 0;
  const v = [];
  turtle.forEach(([len, ang, r], k) => {
    const L = lens[k] != null ? lens[k] : len;
    x += Math.cos(h) * L; y += Math.sin(h) * L;
    v.push([x, y, r]);
    h += ang * Math.PI / 180;
  });
  return v;
}

for (const d of designs) {
  if (d.v) { check(d, d.v.map(p => p.slice()), d.startAt, -d.v[d.v.length - 1][0]); continue; }
  const sum = d.turtle.reduce((s, t) => s + t[1], 0);
  if (Math.abs(Math.abs(sum) - 360) > 1e-6) { console.log(d.id, 'turns sum to', sum); continue; }
  // close: the two flex straights are solved (linear in their lengths) so the last vertex lands
  // `behind` metres before the start line, level with it
  const [fa, fb] = d.flex, want = [-(d.behind || 450), 0];
  const end = lens => { const w = walk(d.turtle, lens); return w[w.length - 1]; };
  const e0 = end({ [fa]: 0, [fb]: 0 }), ea = end({ [fa]: 1000, [fb]: 0 }), eb = end({ [fa]: 0, [fb]: 1000 });
  const A = [[(ea[0] - e0[0]) / 1000, (eb[0] - e0[0]) / 1000], [(ea[1] - e0[1]) / 1000, (eb[1] - e0[1]) / 1000]];
  const rx = want[0] - e0[0], ry = want[1] - e0[1], det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
  const la = (rx * A[1][1] - A[0][1] * ry) / det, lb = (A[0][0] * ry - rx * A[1][0]) / det;
  if (la < 20 || lb < 20) { console.log(d.id, 'flex straights come out', Math.round(la), Math.round(lb), ': reshape'); }
  let v = walk(d.turtle, { [fa]: la, [fb]: lb });
  const last = v[v.length - 1];
  // the start straight: from the last vertex (behind the line) to the first
  const behind = -last[0];
  const startAt = behind / (v[0][0] - last[0]);
  v = v.map(p => [Math.round(p[0]), Math.round(p[1]), p[2]]);
  check(d, v, startAt, behind);
}

function check(d, v, startAt, behind) {
  const def = Object.assign({}, d, { v, startAt: +startAt.toFixed(3) });
  delete def.turtle; delete def.flex;
  let tr, why = 'ok';
  try { tr = F1.Tracks.build(def); } catch (e) { console.log(d.id, 'build failed', e.message); return; }
  // checks (as js/trackgen.js)
  const N = tr.N, ds = tr.ds, clear = d.clear || (d.style === 'street' ? 32 : 48), gap = Math.round(300 / ds);
  let crossAt = -1;
  for (let i = 0; i < N && crossAt < 0; i += 3) tr.hash.near(tr.x[i], tr.y[i], clear, j => {
    let sep = Math.abs(i - j); sep = Math.min(sep, N - sep);
    if (crossAt < 0 && sep >= gap && (tr.x[j] - tr.x[i]) ** 2 + (tr.y[j] - tr.y[i]) ** 2 < clear * clear) crossAt = i;
  });
  if (crossAt >= 0) why = 'parts too close at s=' + Math.round(crossAt * ds);
  let kmax = 0; for (let i = 0; i < N; i++) kmax = Math.max(kmax, Math.abs(tr.kap[i]));
  let gridBad = false;
  for (let s = tr.L - 210; s < tr.L + 60; s += ds) { const i = Math.floor(((s % tr.L) + tr.L) % tr.L / ds) % N; if (Math.abs(tr.kap[i]) > 1 / 900) gridBad = true; }
  let slow = 0, fast = 0;
  for (const ap of tr.apexes) { const R = 1 / Math.abs(ap.k); if (R < 35) slow++; else if (R > (d.style === 'street' ? 45 : 90)) fast++; }
  let longest = 0, run = 0;
  for (let k = 0; k < N * 2; k++) { if (Math.abs(tr.kap[k % N]) < 1 / 700) { run += ds; longest = Math.max(longest, run); } else run = 0; }
  console.log(`${d.id.padEnd(10)} ${(tr.L / 1000).toFixed(3)} km, ${tr.apexes.length} corners (slow ${slow}, fast ${fast}), tightest R ${(1 / kmax).toFixed(0)} m, longest straight ${Math.round(Math.min(longest, tr.L))} m, DRS ${tr.drs.length}, start straight behind line ${Math.round(behind)} m${gridBad ? ' GRID NOT STRAIGHT' : ''} | ${why}`);
  console.log('   v: ' + JSON.stringify(v) + ', startAt: ' + def.startAt);
  const pit = [];
  for (let i = 0; i < N; i += 2) if (!isNaN(tr.pit.off[i])) pit.push([+(tr.x[i] + tr.nx[i] * tr.pit.off[i]).toFixed(1), +(tr.y[i] + tr.ny[i] * tr.pit.off[i]).toFixed(1)]);
  const pts = []; for (let i = 0; i < N; i += 2) pts.push([+tr.x[i].toFixed(1), +tr.y[i].toFixed(1)]);
  out.push({ id: d.id, name: d.name, L: tr.L, w: d.width, pts, pit, apexes: tr.apexes.map(ap => [+tr.x[ap.i].toFixed(1), +tr.y[ap.i].toFixed(1), +(1 / Math.abs(ap.k)).toFixed(0)]),
    drs: tr.drs.map(z => [Math.round(z.act / ds), Math.round(z.end / ds)]), start: [tr.x[0], tr.y[0], tr.tx[0], tr.ty[0]], cross: crossAt >= 0 ? [tr.x[crossAt], tr.y[crossAt]] : null, N });
}
fs.writeFileSync(process.argv[3] || 'design.json', JSON.stringify(out));
