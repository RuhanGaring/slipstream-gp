const F1 = require('./load')(['util.js', 'tracks.js', 'car.js']);
const tr = require('./flat')(F1);
for (const tc of [0, 1, 2]) {
  const c = F1.Car.makeCar({ id: 0, assist: { abs: true, tc, autoGear: true, tyreSim: true } });
  F1.Car.place(c, 0, 0, 0); c.loc.i = 0;
  const DT = 1 / 240; let t = 0; const marks = {};
  for (let k = 0; k < 240 * 20; k++) {
    t += DT; c.ctl.throttle = 1; c.ctl.steerDirect = 0;
    F1.Car.step(c, tr, DT);
    for (const v of [100, 200, 300]) if (!marks[v] && c.speed * 3.6 >= v) marks[v] = t.toFixed(2);
    if (k % 240 === 0 && k < 240 * 4) console.log(' t', t.toFixed(1), 'v', (c.speed * 3.6).toFixed(0), 'g', c.gear, 'rpm', c.rpm.toFixed(0), 'spin', c.wheels[2].spin.toFixed(2), 'temp', c.wheels[2].temp.toFixed(0));
  }
  console.log('tc', tc, '0-100', marks[100], '0-200', marks[200], '0-300', marks[300], 'vmax', (c.speed * 3.6).toFixed(0));
}
