// Soft-body structure test: hit a bare node-and-beam car (js/softbody.js) at a few places and
// speeds and report how each part deformed, which beams broke and what came off.
// usage: node tools/softtest.js
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'damage.js', 'softbody.js', 'raceline.js', 'ai.js', 'race.js']);
const S = F1.Soft, T = S.template();
console.log(`structure: ${T.n} nodes, ${T.nb} beams`);
const CASES = [
  // name, contact x, y, normal into the car (x, y), closing speeds (km/h), patch
  ['nose head-on', 3.3, 0, -1, 0],
  ['front wing corner', 3.1, -1.0, -0.5, 0.87],
  ['front left wheel side', 1.96, -1.05, 0, 1],
  ['sidepod side', 0.3, -0.85, 0, 1],
  ['rear wing from behind', -2.6, 0, 1, 0],
  ['rear right wheel', -1.6, 1.05, 0, -1],
];
const SPEEDS = (process.env.SPEEDS || '30,80,150,250').split(',').map(Number);
for (const [name, x, y, nx, ny, patch] of CASES) {
  for (const kmh of SPEEDS) {
    const s = S.init({});
    const t0 = process.hrtime.bigint();
    const D = S.impact(s, x, y, nx, ny, kmh / 3.6, patch);
    let steps = 0;
    while (s.awake && steps < 2400) { S.step(s, 1 / 240); steps++; }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    let nb = 0; for (const b of s.broken) nb += b;
    let no = 0; for (const o of s.off) no += o;
    const gp = T.gname.map((g, i) => [g, s.gp[i]]).filter(([, v]) => v > 0.02).map(([g, v]) => g + ':' + v.toFixed(2)).join(' ');
    const toe = s.toe.map(v => (v * 57.3).toFixed(1)).join('/'), cam = s.camber.map(v => v.toFixed(1)).join('/');
    console.log(`${name.padEnd(22)} ${String(kmh).padStart(3)} km/h E ${D == null ? '-' : (D / 1000).toFixed(0) + 'kJ'} absorbed ${(s.energy / 1000).toFixed(0)}kJ | ${gp || 'no damage'} | broken ${nb} off ${no} [${S.lost(s).join(',')}]${s.hubOff.some(v => v) ? ' WHEEL' : ''} | toe ${toe} camber ${cam} | ${steps} steps ${ms.toFixed(1)} ms`);
  }
}
