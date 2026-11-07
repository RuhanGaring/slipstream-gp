// Does the AI brake too early? For each stop on a flying Legend lap: where the guide says brake, where
// the AI really does, how long it took, and how long the same stop takes the car at full pedal
// in a straight line (the limit). usage: node tools/brakecheck.js <track>
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js']);
const id = process.argv[2] || 'kestrel', DT = 1 / 240;
const race = F1.Race.create({ track: id, mode: 'tt', laps: 9, difficulty: 4, team: 0, driver: 0, seed: 7, field: 1, spectate: true, assists: {} });
race.autoPlayer = true;
const c = race.player, tr = race.track;
const hold = () => { for (const w of c.wheels) w.wear = 0; c.fuel = 10; };
let g = 0, n = 0;
while (c.lapTimes.length < 3 && g++ < 240 * 400) { hold(); tr.rubber.fill(0.6); F1.Race.step(race, DT); race.fx.length = 0; }
const log = []; let cur = null; const wait = c.lapTimes.length;
while (c.lapTimes.length === wait && g++ < 240 * 900) {
  hold(); F1.Race.step(race, DT); race.fx.length = 0;
  const b = c.ctl.brake, u = c.u, s = c.loc.s;
  if (b > 0.08 && !cur) cur = { s0: s, v0: u, vMin: u, peak: 0, ped: 0, pedS: 0, n: 0, sMin: s, sLast: s, coast: 0 };
  if (cur) {
    if (b > 0.08) { cur.sLast = s; cur.ped += b; cur.n++; cur.peak = Math.max(cur.peak, b); cur.a = Math.max(cur.a || 0, -c.ax || 0); }
    if (u < cur.vMin) { cur.vMin = u; cur.sMin = s; }
    if (b <= 0.08 && (s - cur.sLast + tr.L) % tr.L > 25) { if (cur.v0 - cur.vMin > 8) log.push(cur); cur = null; }
  }
}
// the limit: same stop, straight line, full pedal, same fuel
const flat = (() => { const q = F1; return q; })();
const tr2 = require('./flat')(F1); // (only the physics rig below uses this from here on)
const limit = (v0, v1) => {
  const k = F1.Car.makeCar({ id: 0, compound: 'M', fuel: 10, assist: { abs: true, tc: 1, autoGear: true, tyreSim: true } });
  k.wheels.forEach(w => F1.Car.setTyreTemp(w, k.compound.topt)); F1.Car.place(k, 0, 0, 0); k.loc.i = 0; k.vx = v0; F1.Car.syncWheels(k); k.gear = 7;
  F1.Car.step(k, tr2, DT); let d = 0, t = 0;
  while (k.u > v1 && t < 12) { k.ctl.throttle = 0; k.ctl.brake = 1; F1.Car.step(k, tr2, DT); d += k.u * DT; t += DT; }
  return d;
};
const marks = F1.Raceline.cornerMarks(tr, tr.line, tr.prof), L = tr.L;
console.log('s_on   v_in  v_min  ai_dist  limit  extra  pedal  guide_vs_ai');
for (const e of log) {
  const d = (e.sMin - e.s0 + L) % L, lim = limit(e.v0, e.vMin);
  let gd = null; for (const m of marks) if (m.brake >= 0) { const gs = m.brake * tr.ds, x = (e.s0 - gs + L * 1.5) % L - L / 2; if (gd == null || Math.abs(x) < Math.abs(gd)) gd = x; }
  console.log(e.s0.toFixed(0).padStart(5), (e.v0 * 3.6).toFixed(0).padStart(5), (e.vMin * 3.6).toFixed(0).padStart(5), d.toFixed(0).padStart(7), lim.toFixed(0).padStart(6), (d - lim).toFixed(0).padStart(6), (e.ped / e.n).toFixed(2).padStart(6), (gd == null ? '-' : gd.toFixed(0)).padStart(8));
}
console.log('lap', c.lastLap.toFixed(3));
