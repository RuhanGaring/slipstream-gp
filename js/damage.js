// Full damage and reliability (the race setting Damage: FULL).
// Every impact lands somewhere on the car: the contact point, in the car's own frame, is
// shared out between the parts near it (front wing halves, nose, the four suspension
// corners, sidepods and their radiators, floor, rear wing, gearbox) by distance, scaled by
// how hard the hit was and how fragile each part is. The damage then changes the car:
//  - wings, nose and floor lose downforce (unevenly, so a half-wing pulls the car to one
//    side) and add drag; a wing past its limit breaks off
//  - a bent corner throws the toe and camber out, softens the spring and drops the ride
//    height; past its limit the wheel comes off and that corner of the car drags the ground
//  - a hard hit on a tyre can puncture it
//  - radiator damage (and running in someone's wake) heats the engine; an engine that
//    runs too hot loses power and then fails; every engine also has a small chance of a
//    random failure, larger when it is hot
//  - gearbox damage slows the shifts and then strands it in gear
// With the node-and-beam structure (js/softbody.js, car.dm.soft) the part figures, the bent
// suspension and the parts that come off are all read from the deformed structure; without
// it the older point-damage model below is used. The renderer reads car.dm.soft (or
// car.dm.hits, dents, on the older model) and car.dm.off, see js/r3-damage.js.
(function simModule(G) {
  'use strict';
  (G.F1simMods = G.F1simMods || []).push(simModule);
  const F1 = G.F1;

  // part: [x forward, y right, height, fragility, radius of influence]
  const PARTS = {
    fwL: [3.1, -0.55, 0.12, 2.4, 0.55], fwR: [3.1, 0.55, 0.12, 2.4, 0.55], nose: [2.4, 0, 0.35, 1.2, 0.5],
    sFL: [1.96, -0.8, 0.36, 1.3, 0.45], sFR: [1.96, 0.8, 0.36, 1.3, 0.45], sRL: [-1.62, -0.76, 0.36, 1.1, 0.45], sRR: [-1.62, 0.76, 0.36, 1.1, 0.45],
    podL: [0.3, -0.6, 0.45, 0.9, 0.7], podR: [0.3, 0.6, 0.45, 0.9, 0.7], floor: [0.3, 0, 0.05, 0.6, 1.4],
    rw: [-2.25, 0, 0.9, 1.5, 0.55], gbox: [-1.9, 0, 0.35, 0.6, 0.5],
  };
  const KEYS = Object.keys(PARTS);
  const CORNER = ['sFL', 'sFR', 'sRL', 'sRR'];

  function mode(c) { return c.assist && c.assist.damage === 'full'; }

  function init(c) {
    const p = {};
    for (const k of KEYS) p[k] = 0;
    c.dm = {
      p, hits: [], off: {}, toeSign: [1, -1, 1, -1], puncture: [0, 0, 0, 0], wheelOff: [false, false, false, false],
      engT: 95, engH: 1, failed: null, rng: (c.id + 1) * 0x9e3779b9 >>> 0,
      // factors read by car.js each step
      kDownF: 1, kDownR: 1, kDrag: 1, pull: 0, power: 1, shiftK: 1, stuck: false, paceK: 1, needsPit: false,
      toe: null, camber: null, soft: null,
    };
    if (F1.Soft) { c.dm.soft = F1.Soft.init(c); c.dm.toe = [0, 0, 0, 0]; c.dm.camber = [0, 0, 0, 0]; }
    return c.dm;
  }
  // mulberry32: fine-grained enough for per-step failure chances of one in millions
  function rand(dm) {
    let t = dm.rng = (dm.rng + 0x6D2B79F5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // An impact at world point (px, py), closing speed vn (m/s) along world normal (nx, ny)
  // pointing into the car. Returns true when something broke off.
  // patch: the size of the contact (m) for a hit by another car; a wall is long and flat
  // (tvx, tvy): the other surface's velocity relative to the car at the contact (world)
  function impact(race, c, px, py, nx, ny, vn, patch, tvx, tvy) {
    if (!mode(c) || !c.dm) return false;
    const dm = c.dm, ch = Math.cos(c.h), sh = Math.sin(c.h);
    const lx = (px - c.x) * ch + (py - c.y) * sh, ly = -(px - c.x) * sh + (py - c.y) * ch;
    if (dm.soft) {
      const dlx = nx * ch + ny * sh, dly = -nx * sh + ny * ch;
      const tlx = (tvx || 0) * ch + (tvy || 0) * sh, tly = -(tvx || 0) * sh + (tvy || 0) * ch;
      const D = F1.Soft.impact(dm.soft, lx, ly, dlx, dly, vn, patch, tlx, tly);
      if (D == null) return false;
      // a hard hit on a tyre can cut it; a very heavy one shakes the power unit loose
      const sev = Math.min(1, Math.max(0, (vn - 2.5) / 30));
      for (let k = 0; k < 4; k++) {
        const P = PARTS[CORNER[k]];
        if ((lx - P[0]) ** 2 + (ly - P[1]) ** 2 < 0.5 * 0.5 && vn > 7 && rand(dm) < sev * 0.7) dm.puncture[k] = 1;
      }
      if (sev > 0.55) dm.engH -= (sev - 0.55) * 1.4;
      return false; // what breaks is found as the structure gives way (in step)
    }
    if (vn < 2.5) return false;
    const sev = Math.pow(Math.min(1, (vn - 2.5) / 30), 1.25); // 0 at a nudge, 1 at a 120 km/h hit
    let broke = false;
    for (const k of KEYS) {
      const P = PARTS[k], d2 = (lx - P[0]) ** 2 + (ly - P[1]) ** 2;
      // a big hit carries through the structure: the further-reaching the harder it was
      const rr = P[4] * (1 + 2.6 * sev);
      const w = Math.exp(-d2 / (rr * rr));
      if (w < 0.03) continue;
      const before = dm.p[k];
      dm.p[k] = Math.min(1, dm.p[k] + sev * P[3] * w * 0.9);
      if (CORNER.includes(k) && dm.p[k] > before + 0.02) {
        const ci = CORNER.indexOf(k);
        // which way the toe goes depends on which way the corner was hit
        dm.toeSign[ci] = Math.sign(ly * (nx * -sh + ny * ch) + 1e-6) || 1;
        // a hard hit on the tyre itself can cut it
        if (sev > 0.25 && rand(dm) < sev * 0.6) dm.puncture[ci] = 1;
      }
    }
    // a very heavy hit shakes the power unit loose too
    if (sev > 0.55) dm.engH -= (sev - 0.55) * 1.4;
    // dents for the renderer: local point, direction (into the car, local frame) and depth
    const dlx = nx * ch + ny * sh, dly = -nx * sh + ny * ch;
    dm.hits.push({ x: lx, y: ly, z: 0.35, dx: dlx, dy: dly, depth: Math.min(0.32, 0.03 + sev * 0.34), r: 0.35 + sev * 0.6 });
    if (dm.hits.length > 24) dm.hits.shift();
    broke = update(race, c, true);
    return broke;
  }

  // recompute the car's factors from the part damage; spawns breakages
  function update(race, c, fromHit) {
    const dm = c.dm, p = dm.p, S = dm.soft;
    let broke = false;
    const breakOff = (key, cond, label) => {
      if (cond && !dm.off[key]) { dm.off[key] = true; broke = true; if (race && fromHit) race.events.push({ type: 'part', car: c, text: label }); }
    };
    if (S) {
      // read everything off the structure
      const gid = F1.Soft.gid;
      for (const k of KEYS) p[k] = S.gp[gid[k]] || 0;
      // (a corner bent further than this is broken: its wheel just flops, see the corner figure)
      for (let k = 0; k < 4; k++) { dm.toe[k] = Math.max(-0.2, Math.min(0.2, S.toe[k])); dm.camber[k] = Math.max(-10, Math.min(10, S.camber[k])); }
      const gone = F1.Soft.lost(S);
      for (const g of gone) breakOff(g, true, F1.Soft.LABEL[g] || g.toUpperCase());
      for (let k = 0; k < 4; k++) if (S.hubOff[k] && !dm.wheelOff[k]) { dm.wheelOff[k] = true; dm.off['wheel' + k] = true; broke = true; if (race && fromHit) race.events.push({ type: 'part', car: c, text: 'WHEEL' }); }
    } else {
      breakOff('fwL', p.fwL > 0.8, 'FRONT WING'); breakOff('fwR', p.fwR > 0.8, 'FRONT WING');
      breakOff('rw', p.rw > 0.85, 'REAR WING');
      for (let k = 0; k < 4; k++) if (p[CORNER[k]] > 0.92 && !dm.wheelOff[k]) { dm.wheelOff[k] = true; dm.off['wheel' + k] = true; broke = true; if (race && fromHit) race.events.push({ type: 'part', car: c, text: 'WHEEL' }); }
    }
    const fwL = dm.off.fwL ? 1 : p.fwL, fwR = dm.off.fwR ? 1 : p.fwR, rw = dm.off.rw ? 1 : p.rw;
    dm.kDownF = Math.max(0.25, 1 - 0.38 * (fwL + fwR) / 2 - 0.12 * p.nose - 0.18 * p.floor);
    dm.kDownR = Math.max(0.25, 1 - 0.55 * rw - 0.22 * p.floor);
    dm.kDrag = 1 + 0.06 * (fwL + fwR) + 0.12 * rw + 0.04 * (p.podL + p.podR) + 0.05 * p.floor;
    dm.pull = (fwR - fwL) * 0.5; // the side with more wing left pushes harder
    dm.shiftK = 1 + p.gbox * 3;
    dm.stuck = p.gbox > 0.92;
    // a rough pace factor for the AI's own target speeds
    dm.paceK = Math.sqrt(Math.min(dm.kDownF, dm.kDownR)) * (1 - 0.15 * Math.max(...CORNER.map(k => p[k]))) * (0.6 + 0.4 * dm.power);
    dm.needsPit = fwL > 0.3 || fwR > 0.3 || dm.puncture.some(v => v > 0);
    c.wingDmg = Math.max(fwL, fwR); // the old single figure, for the HUD and the 2D view
    return broke;
  }

  // per step: engine temperature and reliability, and what breaks on its own
  function step(race, c, dt) {
    if (!mode(c) || !c.dm || c.retired) return;
    const dm = c.dm, p = dm.p;
    // the structure settles after a hit; whatever it lets go of flies off
    if (dm.soft && dm.soft.awake) {
      F1.Soft.step(dm.soft, dt);
      if (update(race, c, true)) race.fx.push({ type: 'break', x: c.x, y: c.y, power: 20, car: c });
    }
    const thr = c.throttleOut || 0, v = c.speed || 0;
    const rad = (p.podL + p.podR) / 2;
    const heat = 0.25 + 1.1 * thr * (c.rpm || 9000) / 12000;
    const cool = (0.022 + 0.0011 * v * (c.dfMul != null ? 0.75 + 0.25 * c.dfMul : 1)) * (1 - 0.55 * rad * rad); // a crushed radiator cools much less
    const amb = c.ambient || 32;
    dm.engT += (heat * 6 - cool * (dm.engT - amb)) * dt;
    if (dm.engT > 132) dm.engH -= (dm.engT - 132) * 0.0016 * dt;
    // random failures: about one engine in five hundred race-minutes, more when hot
    const hz = 3.3e-5 * (1 + Math.max(0, dm.engT - 115) * 0.25) * (race.mode === 'tt' ? 0 : 1);
    if (!dm.failed && rand(dm) < hz * dt) dm.engH = Math.min(dm.engH, 0);
    dm.power = dm.engH > 0.5 ? 1 : Math.max(0, dm.engH * 2) * 0.7 + 0.3 * (dm.engH > 0 ? 1 : 0);
    if (dm.engH <= 0 && !dm.failed) {
      dm.failed = 'ENGINE'; dm.power = 0;
      race.events.push({ type: 'failure', car: c, text: 'ENGINE FAILURE' });
    }
    if (dm.stuck && !dm.failed && v < 3 && c.gear <= 2) { dm.failed = 'GEARBOX'; race.events.push({ type: 'failure', car: c, text: 'GEARBOX FAILURE' }); }
    if (dm.wheelOff.some(x => x) && !dm.failed) dm.failed = 'WHEEL';
  }

  // the pit crew: new wings and tyres, the rest stays as it is
  function repair(c) {
    const dm = c.dm; if (!dm) return;
    dm.p.fwL = dm.p.fwR = dm.p.nose = 0; delete dm.off.fwL; delete dm.off.fwR; delete dm.off.nose;
    if (dm.soft) F1.Soft.repair(dm.soft, ['fwL', 'fwR', 'nose']);
    dm.puncture = [0, 0, 0, 0];
    dm.repaired = (dm.repaired || 0) + 1;
    update(null, c, false);
  }

  F1.Damage = { PARTS, CORNER, init, impact, update, step, repair, mode };
})(typeof window !== 'undefined' ? window : globalThis);
