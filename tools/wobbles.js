// Lists small lateral wobbles in the racing line: a swing one way then back,
// under 1.5 m, within 80 m. Real racing lines do not do that.
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js']);
for (const d of F1.Tracks.DEFS) {
  const tr = F1.Race.getTrack(d.id), N = tr.N, o = tr.line.off, ds = tr.ds;
  // extrema with 0.15 m hysteresis
  const ext = []; let dir = 0, lastI = 0;
  for (let i = 1; i < N; i++) {
    if (dir >= 0 && o[i] < o[lastI] - 0.15) { if (dir > 0) ext.push(lastI); dir = -1; lastI = i; }
    else if (dir <= 0 && o[i] > o[lastI] + 0.15) { if (dir < 0) ext.push(lastI); dir = 1; lastI = i; }
    else if ((dir >= 0 && o[i] > o[lastI]) || (dir <= 0 && o[i] < o[lastI])) lastI = i;
  }
  const wob = [];
  for (let n = 1; n < ext.length - 1; n++) {
    const a = ext[n - 1], b = ext[n], c = ext[n + 1];
    const amp = Math.min(Math.abs(o[b] - o[a]), Math.abs(o[c] - o[b]));
    if (amp < 1.5 && (c - a) * ds < 80) {
      const kmax = Math.max(...Array.from({ length: c - a }, (_, q) => Math.abs(tr.kap[a + q])));
      wob.push(`${(b * ds).toFixed(0)}m(${amp.toFixed(2)}m,${kmax < 1 / 600 ? 'straight' : 'corner'})`);
    }
  }
  console.log(d.id.padEnd(8), wob.length, 'wobbles:', wob.join(' '));
}
