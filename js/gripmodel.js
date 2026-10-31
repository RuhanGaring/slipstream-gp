// How much grip the AI can use on a circuit it has never driven. The per-circuit learning
// (js/learncore.js) finds, corner by corner, how hard a car can really be driven, but on a
// brand-new circuit that takes a while. This model predicts the same grip map straight from
// the shape of the circuit: it was trained (tools/gripfit.js) on the learned grip of many
// generated circuits, from features of each point of the racing line (corner speed, what
// comes next, chicanes, crests, banking, kerbs, width). The trees are in js/gripmodel-data.js.
(function simModule(G) {
  'use strict';
  (G.F1simMods = G.F1simMods || []).push(simModule); // the learning workers rebuild the sim from these
  const F1 = G.F1;

  const NF = 14;
  // features of every sample of the circuit's current racing line
  function features(tr) {
    const R = F1.Raceline, N = tr.N, ds = tr.ds, line = tr.line;
    const v = R.speedProfile(tr, line, F1.Car.SPEC, { pace: 1 });
    const at = (a, i) => a[((i % N) + N) % N];
    const m = n => Math.max(1, Math.round(n / ds));
    const out = new Float32Array(N * NF);
    // running minimum of the speed over a window, both ways
    const w40 = m(40), w60 = m(60), w150 = m(150), w20 = m(20), w5 = m(5);
    for (let i = 0; i < N; i++) {
      let vmin = 1e9, vAhead = 1e9, flips = 0, last = 0;
      for (let q = -w40; q <= w60; q++) vmin = Math.min(vmin, at(v, i + q));
      for (let q = 0; q <= w150; q++) vAhead = Math.min(vAhead, at(v, i + q));
      for (let q = -w60; q <= w60; q += 2) {
        const k = at(line.kap, i + q), s = Math.abs(k) > 1 / 300 ? Math.sign(k) : 0;
        if (s && last && s !== last) flips++;
        if (s) last = s;
      }
      const off = line.off[i], kap = line.kap[i];
      const f = out.subarray(i * NF, i * NF + NF);
      f[0] = v[i];
      f[1] = vmin;
      f[2] = v[i] - vAhead;
      f[3] = Math.abs(kap) * 1000;
      f[4] = Math.abs(at(line.kap, i + w20) - at(line.kap, i - w20)) * 1000;
      f[5] = flips;
      f[6] = tr.ddz ? tr.ddz[i] * 1000 : 0;
      f[7] = tr.bank ? -tr.bank[i] * Math.sign(kap) : 0;
      f[8] = tr.dz ? tr.dz[i] : 0;
      f[9] = 1 - R.kerbGrip(tr, i, off, kap);
      f[10] = tr.def && tr.def.style === 'street' ? 1 : 0;
      f[11] = (at(v, i + w5) - at(v, i - w5)) / (2 * w5 * ds);
      f[12] = tr.hw;
      f[13] = tr.hw - Math.abs(off);
    }
    return out;
  }

  // a forest of small regression trees, each a flat array of nodes:
  // [feature, threshold, left, right] for a split, [-1, value] for a leaf
  function runTree(t, x) {
    let n = 0;
    while (t[n * 4] >= 0) n = x[t[n * 4]] <= t[n * 4 + 1] ? t[n * 4 + 2] : t[n * 4 + 3];
    return t[n * 4 + 1];
  }
  function predictRow(model, x) {
    let y = model.base;
    for (const t of model.trees) y += model.rate * runTree(t, x);
    return y;
  }
  // predicted grip multiplier per sample for one handling mode ('sim' or 'arcade'), or null
  // when there is no model; smoothed a little along the lap, as the learned maps are
  function predict(tr, kind) {
    const D = F1.GripModelData && F1.GripModelData[kind];
    if (!D) return null;
    const N = tr.N, X = features(tr), raw = new Float64Array(N), g = new Float64Array(N);
    for (let i = 0; i < N; i++) raw[i] = predictRow(D, X.subarray(i * NF, i * NF + NF));
    const W = Math.max(1, Math.round(10 / tr.ds));
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let q = -W; q <= W; q++) s += raw[(i + q + N) % N];
      g[i] = Math.max(0.8, Math.min(1.4, s / (2 * W + 1) * (D.scale || 1)));
    }
    return g;
  }

  F1.GripModel = { NF, features, predict, predictRow, runTree };
})(typeof window !== 'undefined' ? window : globalThis);
