// Trains the grip model (js/gripmodel.js) on learned circuits: gradient-boosted regression
// trees from racing-line features to the learned grip multiplier, one model per handling
// mode. Training data: every learned circuit in DIR (OUT files of tools/learnpar.js, named
// <id>.json) plus the hand-made circuits' stored lines and limits. Circuits whose id
// matches HOLD (a regex) are kept out of training and only scored. Trees are added until
// the score on a validation share of the training circuits stops improving.
// usage: node tools/gripfit.js DIR [HOLD]     (WRITE=1 stores js/gripmodel-data.js)
const fs = require('fs'), path = require('path');
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'gripmodel.js']);
const R = F1.Raceline, GM = F1.GripModel, NF = GM.NF;
const DIR = process.argv[2], HOLD = new RegExp(process.argv[3] || '^gen-\\d*[05]$');
const SUB = 3; // every third sample (neighbours are nearly identical)

const expand = (a, st, N) => Float64Array.from({ length: N }, (_, i) => { const f = i / st, k = Math.floor(f) % a.length, t = f - Math.floor(f); return a[k] + (a[(k + 1) % a.length] - a[k]) * t; });

// one circuit: features on its learned line, and the learned grip of both modes
function circuit(id, line, limits) {
  const tr = F1.Tracks.build(F1.Tracks.byId(id));
  R.applyLine(tr, line ? R.lineFromOffsets(tr, expand(line, 2, tr.N)) : R.computeLine(tr));
  const X = GM.features(tr), rows = [];
  const y = { sim: expand(limits.sim, 5, tr.N), arcade: expand(limits.arcade, 5, tr.N) };
  for (let i = 0; i < tr.N; i += SUB) rows.push(i);
  return { id, X, y, rows };
}
const data = [];
for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.json'))) {
  const o = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  data.push(circuit(o.id, o.line, o.limits));
}
for (const d of F1.Tracks.DEFS) if (F1.Limits[d.id] && F1.Lines[d.id]) data.push(circuit(d.id, F1.Lines[d.id], F1.Limits[d.id]));
const hold = data.filter(c => HOLD.test(c.id)), train = data.filter(c => !HOLD.test(c.id));
const val = train.filter((c, k) => k % 6 === 5), fit = train.filter((c, k) => k % 6 !== 5);
console.log(`${data.length} circuits: fit ${fit.length}, validation ${val.length}, held out ${hold.length}`);

function table(cs, kind) {
  let n = 0; for (const c of cs) n += c.rows.length;
  const X = new Float32Array(n * NF), y = new Float64Array(n);
  let r = 0;
  for (const c of cs) for (const i of c.rows) { X.set(c.X.subarray(i * NF, i * NF + NF), r * NF); y[r] = c.y[kind][i]; r++; }
  return { X, y, n };
}

// histogram split search over 48 quantile cuts per feature
function cuts(T) {
  const C = [];
  for (let f = 0; f < NF; f++) {
    const v = []; for (let r = 0; r < T.n; r++) v.push(T.X[r * NF + f]);
    v.sort((a, b) => a - b);
    const c = new Set(); for (let q = 1; q < 48; q++) c.add(v[Math.floor(q / 48 * v.length)]);
    C.push(Float64Array.from([...c].sort((a, b) => a - b)));
  }
  return C;
}
function binOf(C, f, x) { const c = C[f]; let lo = 0, hi = c.length; while (lo < hi) { const m = (lo + hi) >> 1; if (x <= c[m]) hi = m; else lo = m + 1; } return lo; }

function growTree(T, B, C, res, depth, minLeaf) {
  const nodes = [];
  const grow = (idx, d) => {
    const me = nodes.length; nodes.push(null);
    let S = 0; for (const r of idx) S += res[r];
    const leaf = () => { nodes[me] = [-1, S / idx.length, 0, 0]; return me; };
    if (d >= depth || idx.length < 2 * minLeaf) return leaf();
    let best = null;
    for (let f = 0; f < NF; f++) {
      const nb = C[f].length + 1, hs = new Float64Array(nb), hn = new Float64Array(nb);
      for (const r of idx) { const b = B[r * NF + f]; hs[b] += res[r]; hn[b]++; }
      let sl = 0, nl = 0;
      for (let b = 0; b < nb - 1; b++) {
        sl += hs[b]; nl += hn[b];
        const nr = idx.length - nl;
        if (nl < minLeaf || nr < minLeaf) continue;
        const gain = sl * sl / nl + (S - sl) * (S - sl) / nr - S * S / idx.length;
        if (!best || gain > best.gain) best = { gain, f, b };
      }
    }
    if (!best || best.gain <= 1e-9) return leaf();
    const L = [], Rr = [];
    for (const r of idx) (B[r * NF + best.f] <= best.b ? L : Rr).push(r);
    const thr = C[best.f][best.b];
    const li = grow(L, d + 1), ri = grow(Rr, d + 1);
    nodes[me] = [best.f, thr, li, ri];
    return me;
  };
  const all = []; for (let r = 0; r < T.n; r++) all.push(r);
  grow(all, 0);
  return Float64Array.from(nodes.flat());
}

// root mean square error (the trees fit squared error, so they are scored the same way)
function mae(model, T) { let e = 0; for (let r = 0; r < T.n; r++) e += (GM.predictRow(model, T.X.subarray(r * NF, r * NF + NF)) - T.y[r]) ** 2; return Math.sqrt(e / T.n); }

const out = {};
for (const kind of ['sim', 'arcade']) {
  const T = table(fit, kind), V = table(val, kind), H = table(hold, kind);
  const C = cuts(T), B = new Uint8Array(T.n * NF);
  for (let r = 0; r < T.n; r++) for (let f = 0; f < NF; f++) B[r * NF + f] = binOf(C, f, T.X[r * NF + f]);
  let base = 0; for (let r = 0; r < T.n; r++) base += T.y[r]; base /= T.n;
  const model = { base, rate: 0.08, trees: [] }, pred = new Float64Array(T.n).fill(base), res = new Float64Array(T.n);
  const flat = { base, rate: 0, trees: [] };
  let bestV = mae(model, V), bestK = 0, since = 0;
  console.log(`${kind}: constant ${base.toFixed(3)}  RMSE fit ${mae(flat, T).toFixed(4)} val ${bestV.toFixed(4)} held ${mae(flat, H).toFixed(4)}`);
  // keep adding trees until the validation circuits stop getting better
  while (since < 40 && model.trees.length < 1500) {
    for (let r = 0; r < T.n; r++) res[r] = T.y[r] - pred[r];
    const t = growTree(T, B, C, res, 4, 60);
    model.trees.push(t);
    for (let r = 0; r < T.n; r++) pred[r] += model.rate * GM.runTree(t, T.X.subarray(r * NF, r * NF + NF));
    const v = mae(model, V);
    if (v < bestV - 1e-5) { bestV = v; bestK = model.trees.length; since = 0; } else since++;
    if (model.trees.length % 50 === 0) console.log(`  ${model.trees.length} trees  val RMSE ${v.toFixed(4)}`);
  }
  model.trees.length = bestK;
  console.log(`${kind}: ${bestK} trees  RMSE fit ${mae(model, T).toFixed(4)} val ${bestV.toFixed(4)} held ${mae(model, H).toFixed(4)}`);
  out[kind] = { base: +base.toFixed(5), rate: model.rate, scale: 1, trees: model.trees.map(t => Array.from(t, x => +x.toFixed(5))) };
}
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(out));
if (process.env.WRITE) {
  const js = '// Generated by tools/gripfit.js: the grip model\'s trees (see js/gripmodel.js). Do not edit by hand.\n' +
    '(function (G) {\n  G.F1 = G.F1 || {};\n  G.F1.GripModelData = ' + JSON.stringify(out) + ';\n})(typeof window !== \'undefined\' ? window : globalThis);\n';
  fs.writeFileSync(path.join(__dirname, '..', 'js', 'gripmodel-data.js'), js);
  console.log('wrote js/gripmodel-data.js');
}
