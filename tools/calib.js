// Max steady lateral g vs speed (slip-capped steering ramp), vs the profile formula.
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js']);
const tr = require('./flat')(F1);
const comp = process.argv[2] || 'M';
for (const kmh of [60, 100, 150, 200, 250, 300]) {
  const c = F1.Car.makeCar({ id: 0, compound: comp, assist: { abs: true, tc: 1, autoGear: true, tyreSim: true } });
  c.wheels.forEach(w => F1.Car.setTyreTemp(w, c.compound.topt));
  F1.Car.place(c, 0, 0, 0); c.loc.i = 0;
  const v0 = kmh / 3.6; c.vx = v0; F1.Car.syncWheels(c); c.gear = 3;
  const DT = 1 / 240;
  let best = 0, t = 0;
  for (let k = 0; k < 240 * 10; k++) {
    t += DT;
    c.ctl.steerDirect = Math.min(0.35, t * (kmh < 120 ? 0.04 : 0.012));
    const err = v0 - c.u;
    c.ctl.throttle = F1.U.clamp(0.3 + err * 0.5, 0, 1); c.ctl.brake = err < -2 ? 0.3 : 0;
    F1.Car.step(c, tr, DT);
    if (Math.abs(c.u - v0) < 1.5) best = Math.max(best, c.ay);
  }
  const m = 820, kA = 0.5 * 1.225 * 4.6 / m;
  const formula = 1.78 * (9.81 + kA * v0 * v0);
  console.log(kmh, 'maxG', (best / 9.81).toFixed(2), 'formula(mu=1.78)', (formula / 9.81).toFixed(2), 'ratio', (best / formula).toFixed(3));
}
