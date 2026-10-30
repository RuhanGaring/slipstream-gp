// Steering ramp at constant speed on infinite asphalt: checks handling balance/stability.
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js']);
const tr = require('./flat')(F1);
const vkmh = +process.argv[2] || 200;
const c = F1.Car.makeCar({ id: 0, assist: { abs: true, tc: 1, autoGear: true } });
F1.Car.place(c, 0, 0, 0); c.loc.i = 0;
const v0 = vkmh / 3.6; c.vx = v0; F1.Car.syncWheels(c); c.gear = 7;
const DT = 1 / 240;
let t = 0;
for (let k = 0; k < 240 * 8; k++) {
  t += DT;
  const st = Math.min(0.2, t * 0.012);
  c.ctl.steerDirect = st;
  const err = v0 - c.u;
  c.ctl.throttle = F1.U.clamp(0.3 + err * 0.5, 0, 1); c.ctl.brake = err < -2 ? 0.2 : 0;
  F1.Car.step(c, tr, DT);
  if (k % 48 === 0) {
    const beta = Math.atan2(c.v, c.u) * 57.3;
    console.log(`t ${t.toFixed(1)} steer ${(c.steer*57.3).toFixed(2)} v ${(c.speed*3.6).toFixed(0)} latG ${(c.ay/9.81).toFixed(2)} r ${c.r.toFixed(3)} beta ${beta.toFixed(2)} aF ${(c.wheels[0].alpha*57.3).toFixed(1)}/${(c.wheels[1].alpha*57.3).toFixed(1)} aR ${(c.wheels[2].alpha*57.3).toFixed(1)}/${(c.wheels[3].alpha*57.3).toFixed(1)} Fz ${c.wheels.map(w=>w.Fz.toFixed(0)).join('/')} spin ${c.wheels[2].spin.toFixed(2)}`);
  }
}
