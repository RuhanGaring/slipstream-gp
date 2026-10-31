// Calibrates the planner's acceleration model (Raceline.accelTable) to the car as it really
// drives: lone AI cars lap every circuit, and wherever the throttle is flat out on a
// straight, the measured longitudinal acceleration (less the slope's share) is binned by
// speed (85th percentile, so the planner errs quick). Prints the ratio real/model per 4 m/s from 0 to 104 m/s, for ACC_CAL in
// js/raceline.js (a ratio, so team cars with more or less power keep their difference).
// usage: node tools/accelcal.js
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js']);
const R = F1.Raceline, BIN = 4, NB = 27;
const sum = Array.from({ length: NB }, () => []);
for (const d of F1.Tracks.DEFS) {
  const race = F1.Race.create({ track: d.id, mode: 'sim', laps: 3, difficulty: 4, team: 0, driver: 0, seed: 7, field: 1 });
  race.cars = [race.player]; race.order = [race.player]; race.autoPlayer = true;
  const c = race.player, tr = race.track;
  let prev = null;
  while (c.lapTimes.length < 3 && race.time < 400) {
    F1.Race.step(race, 1 / 240);
    if (c.lapTimes.length < 1) { prev = null; continue; }
    const i = c.loc.i, ok = c.ctl.throttle > 0.98 && c.ctl.brake === 0 && Math.abs(tr.line.kap[i]) < 1 / 500 && Math.abs(c.beta) < 0.05 && !c.drsOpen && c.dragMul > 0.999;
    if (ok && prev) {
      const a = (c.u - prev.u) * 240 + F1.Car.GRAV * (tr.dz ? tr.dz[i] : 0);
      const b = Math.floor(c.u / BIN);
      if (b < NB) sum[b].push(a);
    }
    prev = ok ? { u: c.u } : null;
  }
}
const model = R.accelTable(F1.Car.SPEC, F1.Car.SPEC.mu * 1.0 * 1.6);
const out = [];
for (let b = 0; b < NB; b++) {
  const s = sum[b].sort((x, y) => x - y), v = b * BIN + BIN / 2;
  // (the 85th percentile: some laps are slowed by a cold tyre or a lift; the planner errs quick)
  const med = s.length > 40 ? s[Math.floor(s.length * 0.85)] : null, m = model[Math.round(v)];
  out.push(med == null ? null : +(med / m).toFixed(3));
  console.log(`v ${String(v).padStart(3)} m/s  n ${String(s.length).padStart(6)}  real ${med == null ? '-' : med.toFixed(2)}  model ${m.toFixed(2)}  ratio ${med == null ? '-' : (med / m).toFixed(3)}`);
}
console.log('ratios', JSON.stringify(out));
