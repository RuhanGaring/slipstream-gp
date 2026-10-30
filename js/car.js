// Vehicle dynamics. A planar chassis (x, y, yaw) carried on a vertical model (heave,
// pitch, roll) over a 3D road surface:
//  - four wheels with their own spin speed and inertia, driven and braked by torques;
//    tyre forces come from longitudinal slip ratio and slip angle through a combined-slip
//    magic formula (normalised slip vector), so traction, braking and cornering share
//    one grip budget and wheelspin and lockups build progressively
//  - suspension: a spring, damper and anti-roll bar at each corner; wheel loads come
//    out of the suspension, so load transfer has its real lag, kerbs and bumps unsettle
//    the car, crests unload it and compressions press it down
//  - ground-effect aero: downforce depends on ride height (with a stall when the floor
//    gets too close), balance moves with pitch, the plank scrapes when it bottoms, and
//    dirty air costs the front more than the rear. Active aero: Z-mode in corners,
//    low-drag X-mode on the straights
//  - 2026 power unit: about 400 kW combustion plus a 350 kW MGU-K fed from a battery,
//    deployment tapering at top speed, harvesting under braking and lift, super-clipping
//    when the battery runs low, and an Overtake mode for extra deployment
//  - clutch-type limited-slip differential, launch clutch, engine inertia in the driveline
//  - carbon brakes with temperature (cold and overheated discs lose bite), brake-by-wire
//    blending friction braking with regeneration on the rear axle
//  - tyres: surface and core temperatures, pressure rising with heat, camber changing
//    with roll, wear, compound, and grip that builds as rubber goes down on the line
//  - gravity along grades and across banking
// Steering for keyboard drivers is limited to the angle that reaches peak tyre slip,
// so tapping A/D gives a usable car without hiding the physics.
(function simModule(G) {
  'use strict';
  (G.F1simMods = G.F1simMods || []).push(simModule); // the learning workers rebuild the sim from these
  const F1 = G.F1;
  const U = F1.U;
  const Tracks = F1.Tracks;
  const SURF = F1.SURF;

  const RHO = 1.225, GRAV = 9.81;

  const SPEC = {
    mass: 768, fuelMax: 40, wb: 3.6, cgFront: 0.455, cgH: 0.30, trackF: 1.62, trackR: 1.56,
    Iz: 1000, Iyy: 1050, Ixx: 260, R: 0.36, len: 5.6, wid: 2.0,
    // aero (Z-mode, cornering); X-mode on straights is lower drag and lower downforce
    ClA: 4.4, aeroBal: 0.46, CdA: 1.12, xModeCl: 0.74, xModeCd: 0.68,
    rh0F: 0.045, rh0R: 0.085, hRef: 0.05, hStall: 0.012, geGain: 0.45,
    // power unit: spec.power is the nominal total used by the speed planner
    power: 750000, iceShare: 0.533, rpmPeak: 11200, rpmLimit: 12300, rpmIdle: 4000,
    battery: 4.0e6, kMax: 350000,
    gears: [17.0, 12.8, 10.35, 8.6, 7.3, 6.2, 5.3, 4.52], rev: 15,
    Ie: 0.07, IwF: 0.9, IwR: 1.15,
    brakeMax: 42000, brakeBias: 0.6,
    // tyres
    mu: 1.78, muLoadK: 0.11, Fz0: 4000, muX: 1.04,
    alphaPk: 0.105, kappaPk: 0.1, shapeC: 1.35, relax: 0.35, muRear: 1.08,
    B: 15.5, C: 1.45, // legacy lateral shape, kept for the speed planner's calibration
    pColdF: 21.5, pColdR: 19.5, pOptF: 25.5, pOptR: 23.5, camberF: -3.2, camberR: -2.0, camberGain: 0.8,
    // suspension (wheel rates, N/m) and anti-roll bars
    kF: 220e3, kR: 190e3, cF: 6500, cR: 6000, arbF: 50e3, arbR: 95e3,
    // differential
    diffPre: 80, diffPower: 0.35, diffCoast: 0.25, diffK: 200,
    lockF: 0.36, // steering lock (front wheel, rad)
    rollF: 0.6,
  };
  // magic-formula shape for the normalised slip: peak 1 at s = 1, about 0.85 when sliding
  const MF_B = Math.tan(Math.PI / (2 * SPEC.shapeC));
  const mf = s => Math.sin(SPEC.shapeC * Math.atan(MF_B * s));

  const SURF_PROPS = [];
  SURF_PROPS[SURF.ASPHALT] = { mu: 1.0, roll: 0.012 };
  SURF_PROPS[SURF.PIT] = { mu: 0.98, roll: 0.012 };
  SURF_PROPS[SURF.KERB] = { mu: 0.9, roll: 0.02, bump: 1 };
  SURF_PROPS[SURF.TARMAC] = { mu: 0.9, roll: 0.016 };
  SURF_PROPS[SURF.GRASS] = { mu: 0.58, roll: 0.07, dirt: 1 };
  SURF_PROPS[SURF.GRAVEL] = { mu: 0.42, roll: 0.42, dirt: 2 };

  const COMPOUNDS = {
    // wl / wq: grip lost as the track gets wet, linearly and quadratically (aquaplaning). A slick
    // is at its best dry and falls apart in the rain; the intermediate is best on a damp track and
    // the full wet in standing water. wet: 1 marks the rain tyres (they wear fast on a dry track).
    S: { id: 'S', name: 'SOFT', color: '#ff2d2d', mu: 1.0, wear: 1.7, topt: 98, warm: 1.25, wl: 0.45, wq: 0.2 },
    M: { id: 'M', name: 'MEDIUM', color: '#ffd400', mu: 0.972, wear: 1.0, topt: 104, warm: 1.0, wl: 0.45, wq: 0.2 },
    H: { id: 'H', name: 'HARD', color: '#f2f2f2', mu: 0.945, wear: 0.58, topt: 110, warm: 0.8, wl: 0.45, wq: 0.2 },
    I: { id: 'I', name: 'INTER', color: '#2bd66b', mu: 0.90, wear: 1.15, topt: 78, warm: 1.1, wl: 0.12, wq: 0.12, wet: 1 },
    W: { id: 'W', name: 'WET', color: '#2b7bff', mu: 0.80, wear: 0.8, topt: 66, warm: 1.1, wl: 0.02, wq: 0.06, wet: 1 },
  };
  // grip multiplier of a compound on a track that is `wet` (0 dry to 1 flooded)
  function wetGrip(cp, wet) { return wet > 0 ? Math.max(0.15, 1 - cp.wl * wet - cp.wq * wet * wet) : 1; }
  // the road surfaces: kerbs and paint turn to ice in the rain, grass and gravel get greasy
  function surfWet(surf, wet) {
    return wet > 0 ? (surf === SURF.KERB ? 1 - 0.3 * wet : surf === SURF.GRASS || surf === SURF.GRAVEL ? 1 - 0.18 * wet : 1 - 0.04 * wet) : 1;
  }

  function makeCar(opts) {
    const spec = Object.assign({}, SPEC, opts.spec || {});
    const lf = spec.wb * (1 - spec.cgFront), lr = spec.wb * spec.cgFront;
    const c = {
      id: opts.id, spec, lf, lr,
      x: 0, y: 0, h: 0, vx: 0, vy: 0, r: 0,
      u: 0, v: 0, speed: 0,
      ax: 0, ay: 0, // filtered body accelerations
      steer: 0, // actual front wheel angle
      ctl: { steer: 0, throttle: 0, brake: 0, steerDirect: null, drs: false },
      gear: 1, rpm: spec.rpmIdle, shiftT: 0, shiftDir: 0, revT: 0,
      assist: Object.assign({ abs: true, tc: 1, autoGear: true, stability: 0, steerAssist: 1, gripMul: 1, tyreSim: true, damage: true }, opts.assist || {}),
      compound: COMPOUNDS[opts.compound || 'M'],
      fuel: opts.fuel != null ? opts.fuel : spec.fuelMax * 0.5,
      wingDmg: 0, // 0..1 front wing damage
      dragMul: 1, dfMul: 1, drsOpen: false, aeroX: false,
      limiter: false, limitSpeed: 80 / 3.6,
      loc: { i: -1, s: 0, d: 0 },
      wheels: [],
      surfMask: 0, onKerb: 0, offTrack: 0, sparks: 0,
      slipLat: 0, slipLong: 0,
      // vertical model (relative to the road plane under the car)
      zh: 0, zhv: 0, pitch: 0, pitchv: 0, roll: 0, rollv: 0, rhF: spec.rh0F, rhR: spec.rh0R, bottoming: 0,
      soc: 0.85, deploy: 0, harvest: 0, overtake: false, tcMod: 1, Fsum: [0, 0],
    };
    const tf = spec.trackF / 2, trr = spec.trackR / 2;
    const pos = [[lf, -tf], [lf, tf], [-lr, -trr], [-lr, trr]]; // FL FR RL RR (x fwd, y right)
    for (let k = 0; k < 4; k++) {
      const front = k < 2;
      c.wheels.push({
        x: pos[k][0], y: pos[k][1], front, Fz: 0, alpha: 0, Fx: 0, Fy: 0, kappa: 0, omega: 0,
        slide: 0, lock: 0, spin: 0, surf: SURF.ASPHALT, temp: 85, tS: 85, tC: 85, wear: 0, wx: 0, wy: 0,
        press: front ? spec.pColdF : spec.pColdR, camber: front ? spec.camberF : spec.camberR,
        brakeT: 300, bmod: 1, comp: 0, road: 0, roadPrev: 0, zw: 0,
      });
    }
    settle(c);
    return c;
  }

  // static equilibrium: spring compressions that hold the car at rest
  function settle(c) {
    const sp = c.spec, m = sp.mass + c.fuel;
    const W = c.wheels;
    for (const w of W) {
      const axle = w.front ? m * GRAV * c.lr / sp.wb : m * GRAV * c.lf / sp.wb;
      w.s0 = axle / 2 / (w.front ? sp.kF : sp.kR);
      w.comp = w.s0; w.Fz = axle / 2;
    }
    c.zh = c.zhv = c.pitch = c.pitchv = c.roll = c.rollv = 0;
  }

  function setTyreTemp(w, t) { w.temp = w.tS = w.tC = t; }
  // wheels rolling at the car's speed (after the car is moved or launched by code)
  function syncWheels(c) { const u = c.vx * Math.cos(c.h) + c.vy * Math.sin(c.h); for (const w of c.wheels) { w.omega = u / c.spec.R; w.kappa = 0; } }

  function place(c, x, y, h) {
    c.x = x; c.y = y; c.h = h; c.vx = c.vy = c.r = 0; c.u = c.v = c.speed = 0;
    c.steer = 0; c.gear = 1; c.rpm = c.spec.rpmIdle; c.ax = c.ay = 0;
    c.loc.i = -1;
    for (const w of c.wheels) { w.alpha = 0; w.slide = w.lock = w.spin = 0; w.omega = 0; w.kappa = 0; w.bmod = 1; }
    settle(c);
  }

  // Combustion engine power fraction vs rpm: broad turbo plateau, falls off near the limiter.
  function powerFrac(rpm, spec) {
    const x = rpm / spec.rpmPeak;
    if (x < 1) return Math.max(0.12, 1 - 1.15 * (1 - x) * (1 - x) - 0.05 * (1 - x));
    return Math.max(0, 1 - 2.2 * (x - 1) * (x - 1));
  }

  function gearRatio(c, gear) { return gear < 0 ? c.spec.rev : c.spec.gears[gear - 1]; }
  // engine rpm the driven wheels imply in a given gear
  function wheelRpm(c, gear) {
    const W = c.wheels, om = Math.abs(W[2].omega + W[3].omega) / 2;
    const vRef = Math.max(om * c.spec.R, Math.abs(c.u) * 0.98);
    return vRef / c.spec.R * gearRatio(c, gear) * 60 / (2 * Math.PI);
  }

  // Grip-limited steering angle at the current speed, for human drivers.
  function steerLimit(c) {
    const sp = c.spec;
    const v = Math.max(4, Math.abs(c.u));
    const down = 0.5 * RHO * sp.ClA * v * v;
    const aMax = sp.mu * c.assist.gripMul * (GRAV + down / (sp.mass + c.fuel));
    const kin = Math.atan(sp.wb * aMax / (v * v));
    const peakAlpha = sp.alphaPk;
    // assisted: stop just short of peak front slip, which keeps the rear planted on a keyboard
    const k = c.assist.stability ? 0.8 : c.assist.steerAssist ? 0.6 : 1.4;
    return Math.min(sp.lockF, kin + peakAlpha * k);
  }

  function shift(c, dir) {
    if (c.shiftT > 0) return;
    if (c.dm && c.dm.stuck) return; // a broken gearbox stays in the gear it has
    const g = c.gear + dir;
    if (g < 1 || g > c.spec.gears.length) return;
    c.gear = g; c.shiftT = 0.045 * (c.dm ? c.dm.shiftK : 1); c.shiftDir = dir;
    if (c.onShift) c.onShift(dir);
  }

  // tyre force for a slip state (combined, normalised slip vector)
  function tyreForce(kappa, tanA, Dx, Dy, sp, out) {
    const sx = kappa / sp.kappaPk, sy = tanA / Math.tan(sp.alphaPk);
    const s = Math.hypot(sx, sy);
    if (s < 1e-6) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
    const f = mf(s);
    out[0] = Dx * f * sx / s;
    out[1] = -Dy * f * sy / s;
    out[2] = s;
    return out;
  }
  const TF = [0, 0, 0], TF2 = [0, 0, 0];

  // One physics step.
  function step(c, tr, dt) {
    const sp = c.spec, a = c.assist, ctl = c.ctl;
    const m = sp.mass + c.fuel;
    if (c.loc.i < 0) Tracks.locate(tr, c.x, c.y, -1, c.loc);
    const ch = Math.cos(c.h), sh = Math.sin(c.h);
    // body-frame velocity
    c.u = c.vx * ch + c.vy * sh;
    c.v = -c.vx * sh + c.vy * ch;
    const speed = c.speed = Math.hypot(c.vx, c.vy);
    const W = c.wheels;

    // --- steering ---
    let target;
    if (ctl.steerDirect != null) target = U.clamp(ctl.steerDirect, -sp.lockF, sp.lockF);
    else target = ctl.steer * steerLimit(c);
    if (a.stability > 0 && speed > 8 && ctl.steerDirect == null) {
      const beta = Math.atan2(c.v, Math.abs(c.u));
      target += beta * 0.7 * a.stability;
    }
    const rate = (Math.abs(target) < Math.abs(c.steer) ? 3.2 : 2.2) * (ctl.steerDirect != null ? 1.6 : 1);
    c.steer = U.approach(c.steer, target, rate * dt);

    // --- gearbox ---
    if (c.shiftT > 0) c.shiftT -= dt;
    let throttle = ctl.throttle, brake = ctl.brake;
    const reversing = c.gear < 0;
    if (a.autoGear && !reversing) {
      const r = wheelRpm(c, c.gear);
      if (r > sp.rpmLimit - 350 && c.gear < sp.gears.length && throttle > 0.1) shift(c, 1);
      else if (c.gear > 1) {
        const down = wheelRpm(c, c.gear - 1);
        const thr = brake > 0.1 ? sp.rpmLimit - 900 : sp.rpmLimit - 2600;
        if (down < thr && r < sp.rpmPeak * 0.83) shift(c, -1);
      }
    }
    if (!reversing && speed < 0.6 && brake > 0.5 && throttle < 0.1) {
      c.revT += dt;
      if (c.revT > 0.45) { c.gear = -1; c.revT = 0; }
    } else if (reversing && speed < 0.6 && throttle > 0.3) {
      c.gear = 1;
    } else if (!(brake > 0.5)) c.revT = 0;
    if (c.gear < 0) { const t = throttle; throttle = brake; brake = t; }
    if (c.limiter && c.u > c.limitSpeed - 0.5) throttle = Math.min(throttle, Math.max(0, (c.limitSpeed - c.u) * 0.4));
    if (c.limiter && c.u > c.limitSpeed + 1) brake = Math.max(brake, 0.3);

    // --- road plane under the car ---
    const i0 = c.loc.i;
    const tx = tr.tx[i0], ty = tr.ty[i0], nx = tr.nx[i0], ny = tr.ny[i0];
    const grade = tr.dz[i0], bank = tr.bank[i0];
    const uT = c.vx * tx + c.vy * ty; // speed along the track

    // --- aero (ground effect on ride height, active aero mode, dirty air) ---
    const q = 0.5 * RHO * speed * speed;
    const xm = c.aeroX && !c.wingDmg ? 1 : 0;
    const hMean = (c.rhF + c.rhR) / 2;
    let ge = 1 + sp.geGain * (1 - U.clamp(hMean / sp.hRef, 0, 2));
    if (hMean < sp.hStall) ge *= U.lerp(0.72, 1, U.clamp(hMean / sp.hStall, 0, 1)); // floor stalls
    const ClA = sp.ClA * (xm ? sp.xModeCl : 1) * ge;
    const down = ClA * q;
    const dirty = 1 - c.dfMul; // wake from a car ahead costs the front more than the rear
    let balF = sp.aeroBal + U.clamp(1.2 * ((c.rhR - c.rhF) - (sp.rh0R - sp.rh0F)), -0.05, 0.05);
    balF = balF * (1 - c.wingDmg * 0.45) - (xm ? 0.03 : 0);
    const D = c.dm; // full damage model (js/damage.js), when it is on
    const wingK = D ? 0 : c.wingDmg;
    const downF = down * balF * (1 - dirty * 1.5) * (1 - wingK * 0.4) * (D ? D.kDownF : 1), downR = down * (1 - balF) * (1 - dirty * 0.55) * (D ? D.kDownR : 1);
    const drag = sp.CdA * (xm ? sp.xModeCd : 1) * (1 + wingK * 0.07) * c.dragMul * q * (D ? D.kDrag : 1);

    // --- suspension: loads from springs, dampers and bars over the road surface ---
    const cs = Math.cos(c.steer), ss = Math.sin(c.steer);
    let mask = 0, kerb = 0, off = 0;
    const roadC = c.zRoad = Tracks.surfZ(tr, i0, c.loc.d);
    for (let k = 0; k < 4; k++) {
      const w = W[k];
      const wxw = c.x + ch * w.x - sh * w.y, wyw = c.y + sh * w.x + ch * w.y;
      w.wx = wxw; w.wy = wyw;
      const along = (wxw - c.x) * tx + (wyw - c.y) * ty;
      const dW = c.loc.d + (wxw - c.x) * nx + (wyw - c.y) * ny;
      w.surf = Tracks.surfaceAt(tr, i0, dW);
      const S = SURF_PROPS[w.surf];
      mask |= 1 << w.surf;
      if (S.bump) kerb++;
      if (w.surf >= SURF.TARMAC && w.surf !== SURF.PIT) off++;
      w.outside = Math.abs(dW) > tr.hw + 0.1 && w.surf !== SURF.PIT ? 1 : 0;
      // road height relative to the plane through the car's contact point
      const h = Tracks.roadZ(tr, i0, along, dW, w.surf, c.loc.s + along);
      const plane = roadC + grade * along + bank * (dW - c.loc.d);
      w.roadPrev = w.road; w.road = h - plane;
    }
    const comp = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const w = W[k];
      const dzBody = c.zh + c.pitch * w.x - c.roll * w.y;
      // the tyre's own compliance and the unsprung mass round off sharp inputs (kerb edges)
      w.roadF = w.roadF == null ? w.road : w.roadF + (w.road - w.roadF) * Math.min(1, dt / 0.012);
      comp[k] = w.s0 - dzBody + w.roadF;
    }
    let FzF = 0, FzR = 0;
    for (let k = 0; k < 4; k++) {
      const w = W[k];
      const bent = D ? D.p[F1.Damage.CORNER[k]] : 0;
      const kS = (w.front ? sp.kF : sp.kR) * (1 - 0.45 * bent), cD = (w.front ? sp.cF : sp.cR) * (1 - 0.5 * bent);
      const rate = (comp[k] - w.comp) / dt;
      const o = k ^ 1; // the other wheel on this axle
      const arb = (w.front ? sp.arbF : sp.arbR) * (comp[k] - comp[o]);
      let F = kS * comp[k] + cD * U.clamp(rate, -3, 3) + arb;
      w.comp = comp[k];
      w.Fz = D && D.wheelOff[k] ? 0 : Math.max(0, F);
      w.zw = w.road; // wheel follows the road (for the renderer)
      if (w.front) FzF += w.Fz; else FzR += w.Fz;
    }
    // ride heights and the plank
    c.rhF = sp.rh0F + c.zh + c.pitch * c.lf;
    c.rhR = sp.rh0R + c.zh - c.pitch * c.lr;
    let floorF = 0;
    const rhMin = Math.min(c.rhF, c.rhR);
    if (rhMin < 0.004) floorF = 2.0e6 * (0.004 - rhMin);
    c.bottoming = floorF > 0 ? Math.min(1, floorF / 20000) : 0;

    // --- driveline: engine, battery, differential ---
    const ratio = gearRatio(c, c.gear);
    const omAxle = (W[2].omega + W[3].omega) / 2;
    const rpmW = Math.abs(omAxle) * ratio * 60 / (2 * Math.PI);
    const g1 = c.gear === 1 || c.gear < 0;
    let rpm = rpmW;
    if (g1) rpm = Math.max(rpmW, sp.rpmIdle + throttle * 5200); // clutch slip at launch
    rpm = Math.max(sp.rpmIdle, rpm);
    const kScale = sp.power / SPEC.power;
    let Pice = 0, Pk = 0;
    const kmh = speed * 3.6;
    if (c.shiftT <= 0 && throttle > 0) {
      Pice = sp.power * sp.iceShare * powerFrac(rpm, sp) * throttle * (D ? D.power : 1);
      if (rpm >= sp.rpmLimit) Pice *= 0.05;
      // MGU-K deployment at full throttle, tapering above 290 km/h (Overtake keeps it to 337)
      const taper = c.overtake ? U.clamp((355 - kmh) / 18, 0, 1) : U.clamp((345 - kmh) / 55, 0, 1);
      // energy management meters deployment against the charge left (Overtake opens it up)
      const budget = c.overtake ? U.clamp((c.soc - 0.03) / 0.1, 0, 1) : U.clamp((c.soc - 0.12) / 0.3, 0, 1);
      if (throttle > 0.85) Pk = sp.kMax * kScale * U.clamp((throttle - 0.85) / 0.15, 0, 1) * taper * budget * (D && D.failed === 'ENGINE' ? 0 : 1);
      // super-clipping: with an almost flat battery the MGU-K harvests at full throttle at speed
      if (c.soc < 0.06 && !c.overtake && kmh > 250) Pk = -90000 * kScale;
    }
    let Tengine = 0;
    if (Pice + Pk !== 0) {
      const omegaE = Math.max(rpm, 3000) * 2 * Math.PI / 60;
      Tengine = (Pice + Pk) / omegaE * ratio * 0.93; // at the axle
    }
    // engine braking and regeneration off the throttle; brake-by-wire regen under braking
    let regenP = 0;
    // (the maps scale lift-off harvesting back in slow and turning phases to keep the rear stable)
    // Regen torque is capped by the MGU-K and fades at low wheel speed; on the rear axle ABS
    // throttles it together with the friction brakes (otherwise regen alone can lock the rears).
    let regenAxleT = 0;
    const omA = Math.abs(omAxle);
    if (throttle < 0.05 && omA > 8) {
      const liftHarvest = 120000 * kScale * U.clamp((kmh - 150) / 80, 0, 1) * U.clamp(1 - Math.abs(c.steer) * 12, 0, 1);
      const want = (brake > 0.05 ? sp.kMax * kScale * Math.min(1, brake * 1.6) : liftHarvest) * (c.soc < 1 ? 1 : 0);
      regenAxleT = Math.min(2600, want / Math.max(30, omA)) * Math.min(W[2].bmod, W[3].bmod) * U.clamp((omA - 8) / 30, 0, 1);
      regenP = regenAxleT * omA;
      Tengine -= (550 * U.clamp(omA / 40, 0, 1) + regenAxleT) * Math.sign(omAxle);
    }
    if (c.gear < 0) Tengine = -Math.abs(Tengine) * 0.35 * (throttle > 0 ? 1 : 0);
    // battery
    // deploying drains the battery; clipping and regeneration charge it at 85 % efficiency
    c.soc = U.clamp(c.soc + (Pk > 0 ? -Pk * dt : -Pk * dt * 0.85) / sp.battery + regenP * dt * 0.85 / sp.battery, 0, 1);
    c.deploy = Pk > 0 ? Pk / sp.kMax : 0; c.harvest = regenP > 0 || Pk < 0 ? 1 : 0;
    // traction control trims engine torque when the rears slip past the peak
    if (a.tc > 0 && Tengine > 0) Tengine *= c.tcMod;
    // limited-slip differential: a clutch pack resists speed difference up to a locking torque
    const Tlock = sp.diffPre + (Tengine >= 0 ? sp.diffPower : sp.diffCoast) * Math.abs(Tengine);
    const Tbias = U.clamp(sp.diffK * (W[2].omega - W[3].omega), -Tlock, Tlock);
    const Tdrive = [0, 0, Tengine / 2 - Tbias, Tengine / 2 + Tbias];
    const Ieng = sp.Ie * ratio * ratio * 0.5 * (c.shiftT > 0 ? 0 : 1);
    c.rpm = U.expDamp(c.rpm, Math.min(sp.rpmLimit + 80, rpm), 25, dt);
    c.throttleOut = throttle;

    // --- brakes (brake-by-wire: rear friction torque tops up what regen does not take) ---
    const brkF = sp.brakeMax * brake;
    const regenT = regenAxleT / 2; // per rear wheel, taken off the friction brake (brake-by-wire)

    // --- tyres ---
    let Fx = 0, Fy = 0, Mz = 0, FxT = 0, FyT = 0;
    let latSlipSum = 0, longSlipSum = 0, gripF = 0, gripR = 0;
    const tyreSim = a.tyreSim;
    const lineOff = tr.line ? tr.line.off[i0] : 0;
    const rub = tr.rubber ? tr.rubber[i0] : 0.6;
    for (let k = 0; k < 4; k++) {
      const w = W[k];
      const S = SURF_PROPS[w.surf];
      const Fz = Math.max(0, w.Fz);
      // grip: load sensitivity, surface, compound, temperature, wear, pressure, camber, rubber
      const wetT = c.wetness || 0;
      let mu = sp.mu * (w.front ? 1 : sp.muRear) * S.mu * (wetT > 0 ? surfWet(w.surf, wetT) : 1) * a.gripMul * (1 - sp.muLoadK * (Math.max(Fz, 60) / sp.Fz0 - 1));
      mu = Math.max(sp.mu * 0.55 * S.mu, mu);
      if (D && D.puncture[k]) mu *= 0.35; // a deflated tyre rolls on its rim edge
      let condF = 1;
      if (tyreSim) {
        const cp = c.compound;
        const dT = w.temp - cp.topt;
        let fT = 1 - 0.00008 * dT * dT;
        if (fT < 0.8) fT = 0.8;
        let fW = 1 - 0.09 * w.wear;
        if (w.wear > 0.7) fW -= 1.4 * (w.wear - 0.7) * (w.wear - 0.7);
        const pOpt = w.front ? sp.pOptF : sp.pOptR;
        const fP = 1 - 0.003 * (w.press - pOpt) * (w.press - pOpt);
        const wg = wetT > 0 ? wetGrip(cp, wetT) : 1;
        condF = cp.mu * fT * fW * Math.max(0.9, fP) * wg;
        mu *= condF;
        if (w.front) gripF += cp.mu * fT * fW * wg; else gripR += cp.mu * fT * fW * wg;
      } else {
        // arcade: the car's tyres are always the right ones, but the road is still slick
        const wa = 1 - 0.24 * wetT;
        mu *= wa;
        if (w.front) gripF += wa; else gripR += wa;
      }
      // rubbered line vs marbles off it
      if (w.surf === SURF.ASPHALT) {
        const dl = Math.abs(c.loc.d - lineOff);
        mu *= dl < 1.8 ? 0.975 + 0.035 * rub : 1 - 0.025 * Math.max(0, rub - 0.4);
      }
      // camber: body roll tilts the wheels; the loaded outside tyre likes about -1 degree
      w.camber = (w.front ? sp.camberF : sp.camberR) + c.roll * 57.3 * sp.camberGain * Math.sign(w.y) + (D ? (D.camber ? D.camber[k] : D.p[F1.Damage.CORNER[k]] * 5 * Math.sign(w.y)) : 0);
      const muY = mu * (1 - 0.006 * (w.camber + 1) * (w.camber + 1));
      const muXc = mu * sp.muX * (1 - 0.004 * w.camber * w.camber);
      const Dy = muY * Fz, Dx = muXc * Fz;

      // contact patch velocity in the wheel frame
      const vxb = c.u - c.r * w.y, vyb = c.v + c.r * w.x;
      let vxw = vxb, vyw = vyb;
      const toe = D ? (D.toe ? D.toe[k] : D.p[F1.Damage.CORNER[k]] * 0.07 * D.toeSign[k]) : 0;
      let cw = cs, sw = ss;
      if (toe) { const ang = (w.front ? c.steer : 0) + toe; cw = Math.cos(ang); sw = Math.sin(ang); }
      if (w.front || toe) { vxw = vxb * cw + vyb * sw; vyw = -vxb * sw + vyb * cw; }
      // slip angle with relaxation length
      const alphaKin = Math.atan2(vyw, Math.max(Math.abs(vxw), 2.5));
      w.alpha += (alphaKin - w.alpha) * Math.min(1, (Math.abs(vxw) + 3) * dt / sp.relax);
      const tanA = Math.tan(U.clamp(w.alpha, -1.3, 1.3));
      const vDen = Math.max(Math.abs(vxw), 3);

      // wheel spin: drive, brake and tyre torques, solved implicitly (stiff at low speed)
      const I = (w.front ? sp.IwF : sp.IwR) + (w.front ? 0 : Ieng);
      const bshare = w.front ? sp.brakeBias / 2 : (1 - sp.brakeBias) / 2;
      const bEff = w.brakeT < 300 ? 0.8 + 0.2 * w.brakeT / 300 : w.brakeT > 1100 ? Math.max(0.55, 1 - (w.brakeT - 1100) / 700) : 1;
      let Tb = brkF * bshare * sp.R * bEff;
      if (!w.front) Tb = Math.max(0, Tb - regenT);
      if (a.abs) Tb *= w.bmod;
      Tb += S.roll * Fz * sp.R * 0.3; // rolling resistance as a drag torque
      const kap0 = (w.omega * sp.R - vxw) / vDen;
      tyreForce(kap0, tanA, Dx, Dy, sp, TF);
      tyreForce(kap0 + 0.004, tanA, Dx, Dy, sp, TF2);
      const slope = Math.max(0, (TF2[0] - TF[0]) / 0.004);
      const denom = I / dt + sp.R * sp.R * slope / vDen;
      const Tnet = Tdrive[k] - sp.R * TF[0];
      let om = w.omega + Tnet / denom;
      // friction brake: can stop the wheel but never spin it backwards
      const dB = Tb / denom;
      if (Math.abs(om) <= dB) om = 0; else om -= Math.sign(om) * dB;
      w.omega = om;
      // forces at the new wheel speed
      w.kappa = (w.omega * sp.R - vxw) / vDen;
      if (Math.abs(vxw) < 0.5 && Math.abs(w.omega) < 1 && Tdrive[k] === 0) w.kappa *= Math.abs(vxw) / 0.5; // parked
      tyreForce(w.kappa, tanA, Dx, Dy, sp, TF);
      let fx = TF[0], fy = TF[1];
      // rolling resistance and dirt drag
      fx -= S.roll * Fz * 0.7 * Math.sign(vxw) * Math.min(1, Math.abs(vxw));
      // ABS and TC controllers act on slip, like the real systems
      const over = w.kappa / sp.kappaPk;
      // ABS as a slip controller: pressure eases off in proportion as the slip approaches the
      // peak, before the wheel overshoots into a lock (rears held shorter, to keep side grip)
      if (brake > 0.05) {
        const lim = w.front ? 0.92 : 0.72, start = lim - 0.15;
        const target = U.clamp(1 - (-over - start) / (lim - start) * 0.6 - Math.max(0, -over - lim) * 3, 0.12, 1);
        w.bmod += (target - w.bmod) * Math.min(1, (target < w.bmod ? 45 : 12) * dt);
      } else w.bmod = Math.min(1, w.bmod + 7 * dt);
      w.lock = U.clamp((-over - 1.05) * 2, 0, 1);
      w.spin = U.clamp((over - 1.05) * 2, 0, 1);
      w.slide = U.clamp((TF[2] - 1.0) * 1.5, 0, 1);
      w.Fx = fx; w.Fy = fy;
      latSlipSum += Math.abs(vyw);
      longSlipSum += Math.abs(w.kappa) * Math.abs(vxw);

      // back to the body frame
      let bx = fx, by = fy;
      if (w.front || toe) { bx = fx * cw - fy * sw; by = fx * sw + fy * cw; }
      Fx += bx; Fy += by;
      FxT += bx; FyT += by;
      Mz += w.x * by - w.y * bx;

      // tyre thermal model: surface heats from slip, core from flexing; they exchange heat
      if (tyreSim) {
        const vSlip = Math.hypot(w.kappa * Math.abs(vxw), vyw);
        const pSlip = Math.hypot(fx, fy) * vSlip;
        const flex = Fz * Math.abs(vxw);
        const warm = w.temp < c.compound.topt ? c.compound.warm : 1;
        const amb = c.ambient || 32;
        w.tS += ((pSlip / 4200 + flex * 5e-6) * warm - (0.035 + 0.0013 * speed) * (w.tS - amb) - 0.9 * (w.tS - w.tC)) * dt;
        w.tC += ((flex * 8e-6) * warm + 0.45 * (w.tS - w.tC) - 0.006 * (w.tC - amb)) * dt;
        w.temp = 0.6 * w.tS + 0.4 * w.tC;
        w.press = (w.front ? sp.pColdF : sp.pColdR) * (w.tC + 273) / 298;
        // rain tyres on a dry track overheat and chew themselves up
        const dryK = c.compound.wet ? 1 + 3.2 * Math.pow(Math.max(0, 1 - (c.wetness || 0) / 0.4), 2) : 1;
        w.wear = Math.min(1, w.wear + pSlip * c.compound.wear * dryK * (c.wearRate || 1) * 3.0e-10 * dt * 60);
      }
      // carbon brakes: heat from braking power, cooled by airflow
      w.brakeT += (Tb * Math.abs(w.omega) / 1100 - (0.5 + 0.07 * speed) * (w.brakeT - 60) * 0.011) * dt;
    }
    // traction control: trim engine torque while the rears are over the slip peak
    const rearOver = Math.max(W[2].kappa, W[3].kappa) / sp.kappaPk;
    if (a.tc > 0 && rearOver > (a.tc > 1 ? 0.85 : 1.0)) c.tcMod = Math.max(0.15, c.tcMod - 12 * dt);
    else c.tcMod = Math.min(1, c.tcMod + 5 * dt);
    // axle slide, weighted by load: a light inside wheel spinning up over a kerb or on exit
    // is not the car sliding; the loaded tyres are what hold it
    const axleSlide = (a2, b2) => (a2.slide * a2.Fz + b2.slide * b2.Fz) / Math.max(1, a2.Fz + b2.Fz);
    c.slideF = axleSlide(W[0], W[1]); c.slideR = axleSlide(W[2], W[3]);
    // lateral saturation of each axle (slip angle over its peak, load weighted) and body slip:
    // these say whether the car is sliding sideways, which is what a driver feels
    const latSat = (a2, b2) => (Math.abs(a2.alpha) * a2.Fz + Math.abs(b2.alpha) * b2.Fz) / Math.max(1, a2.Fz + b2.Fz) / sp.alphaPk;
    c.satF = latSat(W[0], W[1]); c.satR = latSat(W[2], W[3]);
    c.beta = Math.atan2(c.v, Math.max(1, Math.abs(c.u)));
    c.surfMask = mask; c.onKerb = kerb; c.offTrack = off;
    c.grip = Math.min(gripF, gripR) / 2;
    c.slipLat = latSlipSum / 4; c.slipLong = longSlipSum / 4;

    if (D) {
      for (let k = 0; k < 4; k++) {
        if (!D.wheelOff[k]) continue;
        const w = W[k], vxb = c.u - c.r * w.y, vyb = c.v + c.r * w.x, vv = Math.hypot(vxb, vyb);
        if (vv < 0.05) continue;
        const f = 0.55 * m * GRAV * 0.28 * Math.min(1, vv / 2); // the suspension and floor scraping
        const bx = -vxb / vv * f, by = -vyb / vv * f;
        Fx += bx; Fy += by; Mz += w.x * by - w.y * bx;
      }
      Mz += D.pull * downF * 0.12;
    }
    // aero drag, plank friction, gravity along grades and across banking
    if (speed > 0.01) {
      const dragT = drag + floorF * 0.35;
      Fx -= dragT * c.u / speed; Fy -= dragT * c.v / speed;
    }
    const gxW = -GRAV * (grade * tx + bank * nx), gyW = -GRAV * (grade * ty + bank * ny);
    Fx += m * (gxW * ch + gyW * sh); Fy += m * (-gxW * sh + gyW * ch);
    // arcade stability: yaw damping beyond what the steering asks for
    if (a.stability > 0 && speed > 5) {
      const rKin = c.u * Math.tan(c.steer) / sp.wb;
      Mz -= (c.r - rKin) * sp.Iz * 2.4 * a.stability;
    }

    // --- vertical model: heave, pitch and roll on the suspension ---
    const Fs = FzF + FzR + floorF;
    const aRoad = uT * uT * tr.ddz[i0]; // the road curving up (compression) or away (crest)
    c.zhv += ((Fs - m * GRAV - downF - downR - m * aRoad) / m) * dt;
    let pm = 0, rm = 0;
    for (let k = 0; k < 4; k++) { const w = W[k]; pm += w.Fz * w.x; rm -= w.Fz * w.y; }
    pm += floorF * 0.2 + FxT * sp.cgH - downF * c.lf + downR * c.lr;
    rm += -FyT * sp.cgH;
    c.pitchv += (pm / sp.Iyy) * dt;
    c.rollv += (rm / sp.Ixx) * dt;
    c.zh += c.zhv * dt; c.pitch += c.pitchv * dt; c.roll += c.rollv * dt;
    c.zh = U.clamp(c.zh, -0.12, 0.3); c.pitch = U.clamp(c.pitch, -0.08, 0.08); c.roll = U.clamp(c.roll, -0.08, 0.08);

    // --- integrate the plane motion ---
    const axb = Fx / m, ayb = Fy / m;
    c.ax = U.expDamp(c.ax, axb, 12, dt);
    c.ay = U.expDamp(c.ay, ayb, 12, dt);
    const awx = axb * ch - ayb * sh, awy = axb * sh + ayb * ch;
    c.vx += awx * dt; c.vy += awy * dt;
    c.r += Mz / sp.Iz * dt;
    // keep a stopped car stopped
    if (speed < 0.5 && throttle < 0.05) {
      c.vx *= 1 - Math.min(1, 6 * dt); c.vy *= 1 - Math.min(1, 6 * dt); c.r *= 1 - Math.min(1, 6 * dt);
    }
    c.x += c.vx * dt; c.y += c.vy * dt; c.h += c.r * dt;
    if (c.h > Math.PI) c.h -= 2 * Math.PI; else if (c.h < -Math.PI) c.h += 2 * Math.PI;

    // rubber goes down where the cars run
    if (tr.rubber && speed > 20 && Math.abs(c.loc.d - lineOff) < 1.8) tr.rubber[i0] = Math.min(1, tr.rubber[i0] + 0.0009);
    // fuel burn
    if (a.tyreSim) c.fuel = Math.max(0, c.fuel - throttle * 0.026 * (c.fuelRate || 1) * dt);
    Tracks.locate(tr, c.x, c.y, c.loc.i, c.loc);
  }

  F1.Car = { SPEC, COMPOUNDS, SURF_PROPS, makeCar, place, step, shift, steerLimit, powerFrac, setTyreTemp, syncWheels, RHO, GRAV };
})(typeof window !== 'undefined' ? window : globalThis);
