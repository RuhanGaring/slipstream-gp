// Does each setup field do on the physics rig what it does on a real car? node tools/setuptest.js
// Prints the measured effect of each change against the base car and fails on a wrong direction.
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'setup.js']);
const tr = require('./flat')(F1), { Car, Setup, U } = F1;
const DT = 1 / 240;
function make(setup, v0, assist) {
  const c = Car.makeCar({ id: 0, compound: 'M', fuel: 30, spec: setup ? Setup.apply(Car.SPEC, Object.assign({}, Setup.BASE, setup)) : {}, assist: Object.assign({ abs: true, tc: 1, autoGear: true, tyreSim: true }, assist) });
  c.wheels.forEach(w => Car.setTyreTemp(w, c.compound.topt));
  Car.place(c, 0, 0, 0); c.loc.i = 0; c.vx = v0; Car.syncWheels(c); c.gear = 6; c.ctl.steerDirect = 0;
  return c;
}
const run = (c, t, fn) => { for (let k = 0; k < t / DT; k++) { fn && fn(c, k * DT); Car.step(c, tr, DT); } return c; };

const tops = s => { const c = make(s, 60); c.aeroX = true; c.soc = 1; run(c, 28, q => { q.ctl.throttle = 1; q.ctl.brake = 0; q.soc = 1; q.aeroX = true; }); return c.u * 3.6; };
const lateral = (s, kmh) => {
  const c = make(s, kmh / 3.6), v0 = kmh / 3.6; let best = 0;
  run(c, 10, (q, t) => { q.ctl.steerDirect = Math.min(0.35, t * 0.012); const e = v0 - q.u; q.ctl.throttle = U.clamp(0.3 + e * 0.5, 0, 1); q.ctl.brake = e < -2 ? 0.3 : 0; if (Math.abs(q.u - v0) < 1.5) best = Math.max(best, Math.abs(q.ay)); });
  return best / 9.81;
};
const stop = (s, pedal = 1, assist) => { const c = make(s, 300 / 3.6, assist); let d = 0, t = 0; Car.step(c, tr, DT); while (c.u > 100 / 3.6 && t < 12) { c.ctl.throttle = 0; c.ctl.brake = pedal; Car.step(c, tr, DT); d += c.u * DT; t += DT; } return d; };
const lockup = s => { const c = make(s, 130 / 3.6, { abs: false }); let F = 0, R = 0; run(c, 0.5, (q, t) => { q.ctl.throttle = 0; q.ctl.brake = Math.min(1, 0.25 + t); if (t > 0.1 && t < 0.3) { F = Math.min(F, q.wheels[0].kappa); R = Math.min(R, q.wheels[2].kappa); } }); return [F, R]; };
const floor = s => { const c = make(s, 70); const v = 70; let dn = 0, n = 0, bot = 0; run(c, 6, (q, t) => { const e = v - q.u; q.ctl.throttle = U.clamp(0.3 + e * 0.5, 0, 1); q.ctl.brake = 0; if (t > 3) { dn += q.wheels.reduce((a, w) => a + w.Fz, 0); n++; bot = Math.max(bot, q.bottoming || 0); } }); return [dn / n, bot, c.rhF, c.rhR]; };
const steady = s => { const c = make(s, 42); let r = 0; run(c, 4, (q, t) => { const e = 42 - q.u; q.ctl.throttle = U.clamp(0.3 + e * 0.5, 0, 1); q.ctl.brake = 0; q.ctl.steerDirect = 0.075; if (t > 3) r = Math.abs(q.r); }); return r; };
const turnIn = s => { const c = make(s, 45); let r = 0; run(c, 0.5, (q, t) => { q.ctl.throttle = 0.25; q.ctl.steerDirect = 0.05; if (t > 0.05 && t < 0.2) r = Math.max(r, Math.abs(q.r)); }); return r; };
const scrub = s => { const c = make(s, 60); run(c, 40, (q, t) => { const e = 60 - q.u; q.ctl.throttle = U.clamp(0.3 + e * 0.5, 0, 1); q.ctl.brake = 0; q.ctl.steerDirect = 0.012 * Math.sin(t * 1.3); }); return [(c.wheels[0].wear + c.wheels[1].wear) / 2, (c.wheels[2].wear + c.wheels[3].wear) / 2, c.wheels[0].tS, c.wheels[2].tS]; };
const traction = s => { const c = make(s, 20, { tc: 0, autoGear: false }); c.gear = 3; let spin = 0, n = 0; run(c, 1.2, (q, t) => { q.ctl.throttle = 1; q.ctl.brake = 0; q.ctl.steerDirect = 0.09; if (t > 0.2) { spin += Math.abs(q.wheels[2].omega - q.wheels[3].omega); n++; } }); return [c.u, spin / n]; };
const coast = s => { const c = make(s, 45); let spin = 0, n = 0; run(c, 1.2, (q, t) => { q.ctl.throttle = 0; q.ctl.brake = 0; q.ctl.steerDirect = 0.05; if (t > 0.3) { spin += Math.abs(q.wheels[2].omega - q.wheels[3].omega); n++; } }); return spin / n; };

let bad = 0;
const check = (name, a, b, want) => { const ok = want(a, b); if (!ok) bad++; console.log((ok ? 'ok   ' : 'FAIL ') + name.padEnd(48), (+a).toFixed(3), '->', (+b).toFixed(3)); };
// the base setup must be the base car, exactly
const asIs = Setup.apply(Car.SPEC, Setup.BASE);
for (const k of ['ClA', 'aeroBal', 'CdA', 'kF', 'kR', 'cF', 'cR', 'arbF', 'arbR', 'diffPower', 'diffCoast', 'brakeMax', 'brakeBias', 'rh0F', 'rh0R', 'camberF', 'camberR', 'toeF', 'toeR', 'wearF', 'wearR']) {
  const d = Math.abs(asIs[k] - Car.SPEC[k]) / Math.max(1e-9, Math.abs(Car.SPEC[k]) || 1);
  if (d > 1e-9) { bad++; console.log('FAIL base differs', k, asIs[k], Car.SPEC[k]); }
}
const base = tops(null); console.log('top speed base', base.toFixed(1), 'km/h (F1.Setup V_TOP)');
check('rear wing 25 to 5: top speed up', base, tops({ rw: 5 }), (a, b) => b > a + 4);
check('rear wing 25 to 45: top speed down', base, tops({ rw: 45 }), (a, b) => b < a - 4);
const l0 = lateral(null, 250);
check('both wings up: more lateral g at 250', l0, lateral({ fw: 45, rw: 45 }, 250), (a, b) => b > a);
check('front wing up alone: more lateral g (front limited)', l0, lateral({ fw: 45 }, 250), (a, b) => b > a);
check('both wings down: less lateral g at 250', l0, lateral({ fw: 5, rw: 5 }, 250), (a, b) => b < a);
const st = stop(null);
check('brake pressure 100 to 80: longer stop (full pedal)', st, stop({ bP: 80 }), (a, b) => b > a * 1.02);
const lk = lockup(null), lkF = lockup({ bB: 68 }), lkR = lockup({ bB: 52 });
check('bias forward: fronts lock harder', lk[0], lkF[0], (a, b) => b < a);
check('bias rearward: rears lock harder', lk[1], lkR[1], (a, b) => b < a);
const fl = floor(null), fLow = floor({ rhF: 14, rhR: 40 }), fHigh = floor({ rhF: 38, rhR: 90 });
check('ride height down: more load at 250', fl[0], fLow[0], (a, b) => b > a);
check('ride height up: less load at 250', fl[0], fHigh[0], (a, b) => b < a);
const fSoft = floor({ sF: 1, sR: 1, rhF: 10, rhR: 40 }), fStiff = floor({ sF: 41, sR: 41, rhF: 10, rhR: 40 });
check('softer: floor runs lower at speed (m)', fStiff[2], fSoft[2], (a, b) => b < a);
const t0 = turnIn(null);
check('front toe-out: quicker turn-in', t0, turnIn({ toeF: 0.4 }), (a, b) => b > a);
check('rear toe-in: lazier turn-in', t0, turnIn({ toeR: 0.45 }), (a, b) => b < a);
const r0 = steady(null);
check('stiffer front bar: more understeer', r0, steady({ arF: 21 }), (a, b) => b < a);
check('stiffer rear bar: less understeer', r0, steady({ arR: 21 }), (a, b) => b > a);
const sc = scrub(null), scT = scrub({ toeF: 0.45, toeR: 0.45 }), scC = scrub({ camF: -3.5, camR: -2.2 });
check('toe: front tyres wear faster', sc[0], scT[0], (a, b) => b > a);
check('toe: rear tyres run hotter', sc[3], scT[3], (a, b) => b > a);
check('more camber: front wear up', sc[0], scC[0], (a, b) => b > a);
const tr0 = traction({ dOn: 20 }), tr1 = traction({ dOn: 100 });
check('diff on throttle up: rears held together', tr0[1], tr1[1], (a, b) => b < a);
check('diff off throttle up: rears held on a lift', coast({ dOff: 15 }), coast({ dOff: 90 }), (a, b) => b < a);
const hotP = s => { const c = make(s, 60); return c.wheels.map(w => w.press); };
check('press left only changes that wheel', hotP({ pFL: 27 })[0], hotP(null)[1], (a, b) => a > b + 1 && Math.abs(hotP({ pFL: 27 })[1] - b) < 0.1);
for (const id of Object.keys(Setup.PRESETS)) { const v = Setup.preset(id); console.log('preset', id.padEnd(9), 'top', tops(v).toFixed(1), 'lat@250', lateral(v, 250).toFixed(2), 'read', JSON.stringify(Setup.readout(Car.SPEC, v), (k, x) => (typeof x === 'number' ? +x.toFixed(1) : x))); }
console.log(bad ? bad + ' FAILED' : 'all ok');
process.exit(bad ? 1 : 0);
