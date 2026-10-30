// Roughness of the stored racing lines: lateral wiggles (direction reversals of the
// offset that are not explained by the track) and curvature noise.
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js']);
for (const d of F1.Tracks.DEFS) {
  const tr = F1.Race.getTrack(d.id), N = tr.N, off = tr.line.off, k = tr.line.kap;
  const mc = F1.Raceline.computeLine(tr);
  const stat = (o, kap) => {
    let rev = 0, d2 = 0, kn = 0, prev = 0;
    for (let i = 0; i < N; i++) {
      const s = Math.sign(o[(i + 1) % N] - o[i]);
      if (s && prev && s !== prev && Math.abs(o[(i + 1) % N] - o[i]) > 0.01) rev++;
      if (s) prev = s;
      const dd = o[(i + 1) % N] - 2 * o[i] + o[(i - 1 + N) % N]; d2 += dd * dd;
      // curvature noise: difference from a 10-sample moving average
      let a = 0; for (let q = -5; q <= 5; q++) a += kap[(i + q + N) % N]; kn += Math.abs(kap[i] - a / 11);
    }
    return `reversals ${String(rev).padStart(4)}  roughness ${d2.toFixed(2).padStart(6)}  curvature noise ${(kn / N * 1000).toFixed(3)}`;
  };
  console.log(d.id.padEnd(8), 'optimised:', stat(off, k), ' | min-curvature:', stat(mc.off, mc.kap));
}
