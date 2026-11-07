// The car setup: the same fields, in the same units, as a modern F1 game's setup screen, each one
// wired to the part of the car model it would really change. Nothing here is a bonus or a
// percentage on lap time: wings move downforce and drag, springs and bars move load transfer and
// the aero platform, ride height moves the floor, and the handling comes out of the physics.
// BASE is the car as calibrated (and as the AI drives it): applying BASE changes nothing.
// Only the player's car takes a setup, and only in simulation mode when they switch it on.
(function simModule(G) {
  'use strict';
  (G.F1simMods = G.F1simMods || []).push(simModule); // the learning workers rebuild the sim from these
  const F1 = G.F1;

  // groups as the F1 games lay them out. step is the smallest change the sim can make felt
  const F = (k, name, group, min, max, step, base, unit, dp, desc) => ({ k, name, group, min, max, step, base, unit, dp, desc });
  const FIELDS = [
    F('fw', 'Front wing aero', 'Aerodynamics', 0, 50, 1, 25, '', 0, 'More angle loads the front axle and sharpens the turn-in at speed. Too much against the rear wing and the car snaps out of fast corners.'),
    F('rw', 'Rear wing aero', 'Aerodynamics', 0, 50, 1, 25, '', 0, 'The main trade of the setup: more angle plants the rear in fast corners and costs top speed. The straight-line mode opens the wing, so drag falls but the gap to a low-drag car stays.'),
    F('dOn', 'Differential on throttle', 'Transmission', 10, 100, 5, 50, '%', 0, 'How hard the rear wheels are locked together under power. Higher puts more traction down out of slow corners, but pushes the car wide and snaps it round if the rears let go.'),
    F('dOff', 'Differential off throttle', 'Transmission', 10, 100, 5, 30, '%', 0, 'Locking on a closed throttle. Higher steadies the rear into braking zones and stops the inside wheel locking. Lower lets the car rotate on entry.'),
    F('camF', 'Front camber', 'Suspension geometry', -3.5, -2.5, 0.05, -3.2, '°', 2, 'More negative keeps the loaded front tyre flat in hard cornering, and costs braking grip and front tyre life.'),
    F('camR', 'Rear camber', 'Suspension geometry', -2.2, -0.7, 0.05, -2, '°', 2, 'More negative holds the rear in fast corners. Less negative gives a bigger contact patch for traction and kinder rear tyres.'),
    F('toeF', 'Front toe-out', 'Suspension geometry', 0, 0.5, 0.01, 0.05, '°', 2, 'Toe-out quickens the turn-in, as the loaded outside wheel already points into the corner. Every hundredth scrubs the tyres on the straights, adding heat, wear and drag.'),
    F('toeR', 'Rear toe-in', 'Suspension geometry', 0, 0.5, 0.01, 0.15, '°', 2, 'Toe-in steadies the rear under power and over bumps, and makes the car lazier to rotate. It scrubs too: more heat, wear and drag at the rear.'),
    F('sF', 'Front suspension', 'Suspension', 1, 41, 1, 21, '', 0, 'Spring and damper rate. Stiffer holds the floor at its working height and answers the wheel faster, and rides kerbs and bumps worse. Softer finds grip over rough surfaces.'),
    F('sR', 'Rear suspension', 'Suspension', 1, 41, 1, 21, '', 0, 'Spring and damper rate. Softer at the rear helps traction on exit. Stiffer keeps the rake and the rear ride height steady at speed.'),
    F('arF', 'Front anti-roll bar', 'Suspension', 1, 21, 1, 11, '', 0, 'A stiffer bar shifts cornering load transfer to the front axle: sharper response, then understeer at the limit, and a rougher ride over kerbs on one side.'),
    F('arR', 'Rear anti-roll bar', 'Suspension', 1, 21, 1, 11, '', 0, 'A stiffer bar shifts load transfer to the rear: the car rotates more freely mid-corner and loses traction on exit, with the inside rear unloaded.'),
    F('rhF', 'Front ride height', 'Suspension', 10, 40, 1, 20, ' mm', 0, 'Lower brings the floor closer to the road and makes more downforce, until the plank bottoms and the floor stalls under braking and at top speed.'),
    F('rhR', 'Rear ride height', 'Suspension', 40, 100, 1, 42, ' mm', 0, 'Higher than the front gives rake: the aero balance moves forward and the car turns better, at a cost in drag. Too much and the floor runs out of its working range.'),
    F('bP', 'Brake pressure', 'Brakes', 80, 100, 1, 100, '%', 0, 'Maximum brake line pressure at full pedal. Lower is easier to hold at the limit without assists, and lengthens the stop.'),
    F('bB', 'Front brake bias', 'Brakes', 50, 70, 0.5, 60, '%', 1, 'Share of braking on the front axle. Forward stabilises the car and locks the fronts first. Rearward helps it rotate on the way in and can spin it.'),
    F('pFL', 'Front left tyre pressure', 'Tyres', 22.5, 29.5, 0.1, 24.7, ' psi', 1, 'Pressure on the blanket, before the run. Higher runs cooler and sharper with a smaller contact patch, and loses grip past the window. Lower flexes and heats more.'),
    F('pFR', 'Front right tyre pressure', 'Tyres', 22.5, 29.5, 0.1, 24.7, ' psi', 1, 'Pressure on the blanket, before the run. Higher runs cooler and sharper with a smaller contact patch, and loses grip past the window. Lower flexes and heats more.'),
    F('pRL', 'Rear left tyre pressure', 'Tyres', 20.5, 26.5, 0.1, 22.4, ' psi', 1, 'Pressure on the blanket, before the run. Lower gives a bigger contact patch for traction, and overheats sooner. Higher saves heat and wears the middle of the tread.'),
    F('pRR', 'Rear right tyre pressure', 'Tyres', 20.5, 26.5, 0.1, 22.4, ' psi', 1, 'Pressure on the blanket, before the run. Lower gives a bigger contact patch for traction, and overheats sooner. Higher saves heat and wears the middle of the tread.'),
  ];
  const BASE = Object.fromEntries(FIELDS.map(f => [f.k, f.base]));
  const GROUPS = [...new Set(FIELDS.map(f => f.group))];
  // tyre gas law: the car model's cold pressure is at 25 C, a blanket holds the tyre at 70 C
  const BLANKET = (70 + 273) / 298;
  const DEG = Math.PI / 180;
  const FW_K = 0.0088, RW_K = 0.012; // share of an axle's downforce per click of wing
  const FW_D = 0.002, RW_D = 0.0062; // share of total drag per click

  const PRESETS = {
    balanced: { name: 'Balanced', v: {} },
    low: { name: 'Low downforce', v: { fw: 12, rw: 6, sF: 29, sR: 27, rhF: 17, rhR: 44, camF: -3, camR: -1.6, toeF: 0.02, toeR: 0.1, dOn: 60, dOff: 30, pFL: 25.8, pFR: 25.8, pRL: 23, pRR: 23 } },
    high: { name: 'High downforce', v: { fw: 39, rw: 42, sF: 15, sR: 13, arF: 9, arR: 10, rhF: 24, rhR: 50, camF: -3.4, camR: -2.1, toeF: 0.08, toeR: 0.2, dOn: 45, dOff: 35, bB: 57, pFL: 24.2, pFR: 24.2, pRL: 21.8, pRR: 21.8 } },
    wet: { name: 'Wet', v: { fw: 40, rw: 45, sF: 9, sR: 7, arF: 7, arR: 7, rhF: 30, rhR: 56, camF: -2.8, camR: -1.2, toeF: 0.05, toeR: 0.2, dOn: 35, dOff: 40, bP: 92, bB: 56.5, pFL: 26, pFR: 26, pRL: 23.6, pRR: 23.6 } },
  };

  function clean(s) {
    const o = {};
    for (const f of FIELDS) {
      const v = s && typeof s[f.k] === 'number' && isFinite(s[f.k]) ? s[f.k] : f.base;
      o[f.k] = Math.max(f.min, Math.min(f.max, v));
    }
    return o;
  }
  const expK = (v, base, k) => Math.pow(k, v - base);

  // sp: the car as it comes (Car.SPEC with the team's changes). Returns the spec fields to replace.
  function apply(sp, setup) {
    const s = clean(setup), out = {};
    // Aero: the wings act on their own axles, and each carries its share of the drag
    const clF = sp.ClA * sp.aeroBal * (1 + FW_K * (s.fw - BASE.fw)), clR = sp.ClA * (1 - sp.aeroBal) * (1 + RW_K * (s.rw - BASE.rw));
    out.ClA = clF + clR; out.aeroBal = clF / out.ClA;
    // ride height: millimetres on the base height. Rake past the car's own costs drag
    out.rh0F = sp.rh0F + (s.rhF - BASE.rhF) * 1e-3; out.rh0R = sp.rh0R + (s.rhR - BASE.rhR) * 1e-3;
    const rake = (s.rhR - BASE.rhR) - (s.rhF - BASE.rhF); // mm against the base
    out.CdA = sp.CdA * (1 + FW_D * (s.fw - BASE.fw) + RW_D * (s.rw - BASE.rw) + 0.0009 * rake)
      * (1 + 0.012 * (s.toeF - BASE.toeF) + 0.018 * (s.toeR - BASE.toeR));
    // springs double every 20 clicks either way; dampers follow the square root, keeping the damping ratio
    const kFk = expK(s.sF, BASE.sF, 1.035), kRk = expK(s.sR, BASE.sR, 1.035);
    out.kF = sp.kF * kFk; out.kR = sp.kR * kRk;
    out.cF = sp.cF * Math.sqrt(kFk); out.cR = sp.cR * Math.sqrt(kRk);
    out.arbF = sp.arbF * expK(s.arF, BASE.arF, 1.1); out.arbR = sp.arbR * expK(s.arR, BASE.arR, 1.1);
    // the differential's preload stays; the ramp is the locking per unit of torque
    out.diffPower = sp.diffPower * s.dOn / BASE.dOn; out.diffCoast = sp.diffCoast * s.dOff / BASE.dOff;
    out.camberF = s.camF; out.camberR = s.camR;
    out.toeF = (s.toeF - BASE.toeF) * DEG; out.toeR = (s.toeR - BASE.toeR) * DEG;
    // toe holds the front tyres out of the soft zone a tyre has around zero slip, so the first
    // degrees of lock bite sooner: a small gain on the steering that fades as the lock goes on
    out.toeGain = 0.5 * (s.toeF - BASE.toeF);
    // a tyre run at more camber rides on its inner shoulder: hotter and quicker to wear
    out.wearF = 1 + 0.22 * (BASE.camF - s.camF) + 0.8 * Math.abs(s.toeF - BASE.toeF);
    out.wearR = 1 + 0.22 * (BASE.camR - s.camR) + 0.8 * Math.abs(s.toeR - BASE.toeR);
    out.brakeMax = sp.brakeMax * s.bP / 100; out.brakeBias = s.bB / 100;
    // left and right set apart; the model's window sits at the base hot pressure
    out.pCold = [s.pFL / BLANKET, s.pFR / BLANKET, s.pRL / BLANKET, s.pRR / BLANKET];
    out.pColdF = (s.pFL + s.pFR) / 2 / BLANKET; out.pColdR = (s.pRL + s.pRR) / 2 / BLANKET;
    return out;
  }

  // What the setup comes to, from the car model's own numbers. The top speed is measured on the
  // rig (tools/setuptest.js): the electric deployment tapers away at speed, so a change of drag
  // moves it far less than the cube root it would be on constant power.
  const V_TOP = 337, V_PER_DRAG = 0.44; // km/h, and km/h per percent of drag
  function readout(sp, setup) {
    const o = Object.assign({}, sp, apply(sp, setup)), b = Object.assign({}, sp, apply(sp, BASE));
    const q = 0.5 * 1.225 * Math.pow(250 / 3.6, 2), roll = x => x.kF * x.trackF * x.trackF + x.arbF * x.trackF * x.trackF;
    const rollR = x => x.kR * x.trackR * x.trackR + x.arbR * x.trackR * x.trackR;
    return {
      down: o.ClA * q / 1000, // kN at 250 km/h, at the base ride height
      downPct: (o.ClA / b.ClA - 1) * 100,
      bal: (o.aeroBal + Math.max(-0.05, Math.min(0.05, 1.2 * ((o.rh0R - o.rh0F) - (sp.rh0R - sp.rh0F))))) * 100,
      drag: o.CdA * q / 1000,
      dragPct: (o.CdA / b.CdA - 1) * 100,
      top: V_TOP - V_PER_DRAG * (o.CdA / b.CdA - 1) * 100,
      mech: roll(o) / (roll(o) + rollR(o)) * 100,
      rake: (o.rh0R - o.rh0F) * 1000,
      brake: o.brakeMax / 1000,
      hotF: o.pColdF * (104 + 273) / 298, hotR: o.pColdR * (104 + 273) / 298, optF: sp.pOptF, optR: sp.pOptR,
    };
  }

  F1.Setup = { FIELDS, GROUPS, BASE, PRESETS, clean, apply, readout, preset: id => clean(Object.assign({}, BASE, (PRESETS[id] || PRESETS.balanced).v)) };
})(typeof window !== 'undefined' ? window : globalThis);
