// Finds stretches of a circuit where the stored corner grip sits far below the rest of the lap: a
// sign the coach left that road undertrained, not that the road is slippery. Road surface is the same
// all the way round, so grip this low is the plan's fault. With FIX=<share of the median> it raises
// those stretches and writes js/limits.js. usage: node tools/gripgap.js   FIX=0.9 ONLY=montaurele
const fs = require('fs'), path = require('path');
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'limits.js']);
const L = F1.Limits, st = L.stride, FIX = +process.env.FIX || 0, only = process.env.ONLY ? process.env.ONLY.split(',') : null;
for (const id of Object.keys(L)) {
  if (id === 'stride' || !L[id].sim) continue;
  const a = L[id].sim, s = a.slice().sort((x, y) => x - y), med = s[s.length >> 1], low = a.map(x => x < 0.8 * med), runs = [];
  for (let i = 0; i < a.length; i++) if (low[i] && !low[(i - 1 + a.length) % a.length]) { let n = 0; while (low[(i + n) % a.length] && n < a.length) n++; runs.push(`${i * 10}m+${n * 10}`); }
  console.log(id.padEnd(11), 'median', med.toFixed(2), 'min', s[0].toFixed(2), 'share low', (low.filter(Boolean).length / a.length * 100).toFixed(0) + '%', runs.slice(0, 6).join(' '));
  if (FIX && (!only || only.includes(id))) {
    const f = med * FIX, N = a.length, tgt = a.map(x => Math.max(x, f));
    L[id].sim = tgt.map((x, i) => { let t = 0; for (let q = -2; q <= 2; q++) t += tgt[(i + q + N) % N]; return +(x === a[i] ? a[i] : t / 5).toFixed(4); });
  }
}
if (FIX) {
  const P = path.join(__dirname, '..', 'js', 'limits.js'), head = fs.readFileSync(P, 'utf8').split('G.F1.Limits = ')[0];
  let s = head + 'G.F1.Limits = { stride: ' + st + ',\n';
  for (const id of Object.keys(L)) { if (id === 'stride') continue; s += `    ${/^[a-z]\w*$/i.test(id) ? id : JSON.stringify(id)}: {\n`; for (const k of Object.keys(L[id])) s += `      ${k}: [${Array.from(L[id][k]).join(',')}],\n`; s += '    },\n'; }
  fs.writeFileSync(P, s + "  };\n})(typeof window !== 'undefined' ? window : globalThis);\n");
}
