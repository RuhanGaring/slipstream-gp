// Glancing wall hits on the bare soft body: the car slides along a wall at speed v (km/h) and
// angle a (degrees), touching first with the given point. usage: node tools/softglance.js
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'damage.js', 'softbody.js', 'raceline.js', 'ai.js', 'race.js']);
const S = F1.Soft, T = S.template();
for (const [name, x, y] of [['front wing tip', 3.05, -1.0], ['front wheel', 1.96, -1.02], ['sidepod', 0.4, -0.85], ['rear wheel', -1.57, -1.0]]) {
  for (const [kmh, deg] of [[120, 5], [200, 10], [250, 20], [200, 35]]) {
    const v = kmh / 3.6, a = deg * Math.PI / 180, vn = v * Math.sin(a), vt = v * Math.cos(a);
    const s = S.init({});
    S.impact(s, x, y, 0, 1, vn, 0, -vt, 0);
    let n = 0; while (s.awake && n < 2400) { S.step(s, 1 / 240); n++; }
    let nb = 0; for (const b of s.broken) nb += b;
    const gp = T.gname.map((g, i) => [g, s.gp[i]]).filter(([, q]) => q > 0.05).map(([g, q]) => g + ':' + q.toFixed(2)).join(' ');
    console.log(`${name.padEnd(15)} ${kmh} km/h ${String(deg).padStart(2)} deg (vn ${vn.toFixed(1)}): ${gp || '-'} | broken ${nb} lost [${S.lost(s).join(',')}]${s.hubOff.some(q => q) ? ' WHEEL OFF' : ''} | toe ${s.toe.map(q => (q * 57.3).toFixed(0)).join('/')}`);
  }
}
