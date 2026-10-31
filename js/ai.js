// AI drivers. Each AI follows the racing line with a pure-pursuit steering law and
// targets its own speed profile (built from its team's car and its pace). On top
// of that a small planner decides when to follow, attack (picks a side, preferring
// the inside of the next corner), defend (one move to the inside before a braking
// zone), give room to a car alongside, and drive the pit lane.
// The same pit-lane routine doubles as the player's pit autopilot.
(function simModule(G) {
  'use strict';
  (G.F1simMods = G.F1simMods || []).push(simModule); // the learning workers rebuild the sim from these
  const F1 = G.F1;
  const U = F1.U;
  const Tracks = F1.Tracks;

  // The driving technique's constants, tuned over many circuits (tools/drivetune.js):
  // steering lookahead, slip and yaw compensation, how hard and how early to brake, how the
  // pedal is bled off into the corner, how fast the throttle goes back on.
  // (tuned 2026-10-31 on 8 circuits until 80 tries in a row found nothing faster; 0.2 to
  // 1.5% quicker on 6 circuits it never saw, with no more offs or track-limit breaches)
  const P = {
    look0: 6.364, lookV: 0.2455, slipComp: 0.001863, yawDamp: 0.05257, frontCap: 0.105,
    aCap0: 33.24, aCapV: 0.0047, brkOn: 0.7192, brkFull: 0.9499, errBrk: 0.22, bleed: 2.878,
    trailOn: 0.25, trailA: 1.2, trailB: 1.163, thr0: 0.2568, thrErr: 0.5, rearThr: 1.4,
    thrRamp: 1.997, thrLoad: 0.2654, leadT: 0.09159,
  };

  function makeBrain(car, prof, opts) {
    return {
      prof, pace: opts.pace || 1, aggr: opts.aggr == null ? 0.6 : opts.aggr,
      rng: U.rng(opts.seed || 1),
      bias: 0, mode: 'race', side: 0, passT: 0, defended: -1,
      ahead: null, gapAhead: 1e9, behind: null, gapBehind: 1e9, alongside: null,
      senseT: 0, react: opts.react || 0.25, startT: 0,
      stuckT: 0, noise: 1, noiseT: 0,
      pit: null, // {phase, box, serviceT}
    };
  }

  // forward distance along the lap from car a to car b (centre to centre)
  function relS(tr, a, b) {
    let d = b.loc.s - a.loc.s;
    if (d > tr.L / 2) d -= tr.L; else if (d < -tr.L / 2) d += tr.L;
    return d;
  }

  function nextCornerSign(tr, i, range) {
    const n = Math.round(range / tr.ds);
    let acc = 0;
    for (let k = 4; k < n; k++) acc += tr.line.kap[(i + k) % tr.N] * (1 - k / n);
    return Math.abs(acc) < 0.02 ? 0 : Math.sign(acc);
  }

  function sense(race, car) {
    const b = car.brain, tr = race.track;
    b.ahead = null; b.gapAhead = 1e9; b.behind = null; b.gapBehind = 1e9; b.alongside = null;
    b.near = b.near || [];
    b.near.length = 0;
    let along = 1e9;
    for (const o of race.cars) {
      if (o === car || o.retired || o.ghostT > 0) continue;
      if (o.inLane !== car.inLane && !isNaN(tr.pit.wall[o.loc.i])) continue; // the pit wall separates us
      const ds = relS(tr, car, o);
      if (ds < -30 || ds > 110) continue;
      b.near.push(o);
      if (ds > 0 && ds < b.gapAhead) { b.gapAhead = ds; b.ahead = o; }
      if (ds < 0 && -ds < b.gapBehind) { b.gapBehind = -ds; b.behind = o; }
      if (Math.abs(ds) < 7.5 && Math.abs(o.loc.d - car.loc.d) < 4.8 && Math.abs(ds) < along) { along = Math.abs(ds); b.alongside = o; }
    }
  }

  // Distance until we must start braking for the next corner.
  function brakeRoom(tr, car) {
    const z = upcomingZone(tr, car.loc.s, 600);
    if (!z) return { room: 1e9, z: null };
    const d = Tracks.fwd(tr, car.loc.s, z.s0);
    return { room: d, z };
  }

  function laneFree(b, car, lat, exclude, ahead) {
    for (let k = 0; k < b.near.length; k++) {
      const o = b.near[k];
      if (o === exclude) continue;
      const ds = b.nds[k];
      if (ds > -7 && ds < ahead && Math.abs(o.loc.d - lat) < 2.7) return false;
    }
    return true;
  }

  // The planner outputs a lateral corridor [lo, hi] (absolute offsets from the
  // centreline). The driver follows the racing line clamped into that corridor.
  function plan(race, car, dt) {
    const b = car.brain, tr = race.track, i = car.loc.i;
    const lineOff = tr.line.off[i];
    const lim = tr.hw - 1.25; // where another car's lane may be aimed for when passing
    // the corridor reaches out as far as the racing line does over the next stretch, so the
    // line is never trimmed where it uses a kerb (see Raceline.lineLimits), while a car
    // squeezed by another is not pushed past the asphalt where there is no kerb
    let lo = -lim, hi = lim;
    for (let q = 0, n = Math.round(60 / tr.ds); q <= n; q += 2) { const o = tr.line.off[(i + q) % tr.N]; if (o > hi) hi = o; else if (o < lo) lo = o; }
    const v = Math.max(0, car.u);
    const sinceStart = race.time - race.startTime;
    const br = brakeRoom(tr, car);
    const SEP = 3.35;
    // refresh longitudinal distances to the cars we are tracking
    b.nds = b.nds || [];
    for (let k = 0; k < b.near.length; k++) b.nds[k] = relS(tr, car, b.near[k]);
    const dsOf = o => { const k = b.near.indexOf(o); return k < 0 ? relS(tr, car, o) : b.nds[k]; };

    // attack. On a straight that runs to a braking zone, a car catching another first sits
    // in its tow (straight behind it, closing up), then pulls out late enough to keep the
    // tow's speed and early enough to be alongside before the braking point. Elsewhere a
    // pass is only tried with a real run on the car ahead. The side: the inside of the next
    // corner; the outside only out of the braking zone and when it pays, either because the
    // corner after bends the other way (the outside of one is the inside of the next) or
    // because the run is so big the car will be past before the turn-in.
    b.coolT = Math.max(0, (b.coolT || 0) - dt);
    if ((b.mode === 'race' || b.mode === 'tow') && sinceStart > 1.5 && !b.coolT) {
      let o = null, ods = 1e9;
      for (let k = 0; k < b.near.length; k++) {
        const c = b.near[k], ds = b.nds[k];
        if (ds > 0 && ds < 45 && Math.abs(c.loc.d - car.loc.d) < 2.6 && ds < ods) { o = c; ods = ds; }
      }
      if (b.mode === 'tow' && b.target !== o) { b.mode = 'race'; b.target = null; }
      if (o) {
        const closing = v - o.speed;
        const theirProf = o.brain ? o.brain.prof[i] : o.speed;
        const fasterPace = b.prof[i] > theirProf + 0.4;
        // flat out all the way to the braking zone (or no braking zone in range at all): kinks
        // taken flat count as straight
        let straight = true;
        for (let q = 0; straight && q * tr.ds < Math.min(br.room, 400); q += 2) if (Math.abs(tr.line.kap[(i + q) % tr.N]) > 1 / 300 || tr.brk[(i + q) % tr.N]) straight = false;
        const braking = br.room < v * v / (2 * 38) + 30 || tr.brk[i];
        let go = false;
        if (straight && !braking && (closing > -1 || fasterPace)) {
          // into the tow; pull out when the rest of the straight is just enough to get by
          if (b.mode !== 'tow') { b.mode = 'tow'; b.target = o; }
          // the run it will really have once out of the tow: most of the closing speed, plus DRS
          const gain = ods + 2, run = Math.max(0, closing) * 0.8 + (car.drsOpen ? 2.5 : 0);
          const travel = run > 0.1 ? v * gain / run : 1e9;
          // out when the remaining straight just covers it; right on the gearbox it has to go
          // anyway (or lift), and then aims to be overlapped down the inside by the braking point
          // (from further back the tow is still doing its work, so it waits for the last moment)
          go = (run > 0.6 && travel < br.room - 15 && (ods < 12 || travel > br.room - 90)) || ods - car.spec.len < 1.2 || (br.room > 1e8 && ods < 10 && run > 0.5);
          if (!go && br.room < 70) { b.mode = 'race'; b.target = null; b.coolT = 1; } // ran out of straight
        } else if (b.mode === 'tow') { b.mode = 'race'; b.target = null; }
        else {
          // through the twisty parts: any real run on the car ahead
          go = ods < 30 && (closing > 1.0 || (fasterPace && ods < 14));
        }
        if (go) {
          const inside = nextCornerSign(tr, i, 260) || (lineOff > 0 ? -1 : 1);
          const after = nextCornerSign(tr, (i + Math.round(260 / tr.ds)) % tr.N, 260);
          const latIn = o.loc.d + inside * SEP, latOut = o.loc.d - inside * SEP;
          const okIn = Math.abs(latIn) < lim && laneFree(b, car, latIn, o, ods + 25);
          const pays = after === -inside || closing > 5 || br.room > 1e8;
          const okOut = !braking && pays && b.aggr > 0.35 && Math.abs(latOut) < lim && laneFree(b, car, latOut, o, ods + 25);
          b.side = okIn ? inside : okOut ? -inside : 0;
          // set passes up on the approach: never ask for a big sidestep mid-corner
          const midCorner = Math.abs(tr.line.kap[i]) > 1 / 250;
          if (b.side && midCorner && Math.abs((b.side === inside ? latIn : latOut) - car.loc.d) > 2.5) b.side = 0;
          if (b.side) { b.mode = 'pass'; b.passT = 0; b.target = o; b.passDs = ods; b.inside = inside; b.flipped = false; }
        }
      }
      else if (b.mode === 'tow') { b.mode = 'race'; b.target = null; }
    }
    if (b.mode === 'tow') {
      // straight behind the car ahead, for the most tow
      const o = b.target, t = U.clamp(o.loc.d, -lim, lim);
      lo = Math.max(lo, t - 0.8); hi = Math.min(hi, t + 0.8);
    }
    if (b.mode === 'pass') {
      const o = b.target;
      b.passT += dt;
      const ds = o ? dsOf(o) : -99;
      let lat = o ? o.loc.d + b.side * SEP : 0;
      const needBrake = v * v / (2 * 38) * (1 - (br.z ? br.z.vOut * br.z.vOut / Math.max(1, v * v) : 1));
      // a run that has died: back in line rather than sitting out of the tow
      const stalled = b.passT > 2.5 && ds > b.passDs + 2;
      // the door shut on this side (the car ahead moved across to cover it): switch to the
      // other side if that one is open and there is still road before the braking point
      if (o && !b.flipped && ds > 3 && (Math.abs(lat) > lim + 0.3 || !laneFree(b, car, lat, o, Math.max(5, ds + 8))) && br.room > needBrake + 60) {
        const lat2 = o.loc.d - b.side * SEP;
        if (Math.abs(lat2) < lim && laneFree(b, car, lat2, o, ds + 25)) { b.side = -b.side; b.flipped = true; b.passT = Math.min(b.passT, 4); lat = lat2; }
      }
      // into the braking zone: overlapped down the inside the move is on (the car ahead must
      // leave room); otherwise not far enough up to stay there
      const late = br.room < needBrake + 15 && ds > (b.side === b.inside ? 4.5 : 2.5);
      if (!o || ds < -7 || ds > 45 || b.passT > 9 || Math.abs(lat) > lim + 0.3 || late || stalled || !laneFree(b, car, lat, o, Math.max(5, ds + 8))) {
        if (o && ds > -7) b.coolT = 1.5; // not past: no fresh lunge straight away
        b.mode = 'race'; b.target = null;
      } else if (b.side > 0) lo = Math.max(lo, Math.min(lim, lat));
      else hi = Math.min(hi, Math.max(-lim, lat));
    }
    // defend: one move to the inside when someone is close before a braking zone
    if (b.mode === 'race' && b.behind && b.gapBehind < 16 && b.aggr > 0.3 && sinceStart > 4) {
      const z = br.z;
      // only on a true straight that runs all the way to the braking zone
      let onStraight = br.room < 300;
      for (let q = 0; onStraight && q * tr.ds < br.room; q += 2) if (Math.abs(tr.line.kap[(i + q) % tr.N]) > 1 / 700) onStraight = false;
      if (z && onStraight && br.room < 300 && br.room > 90 && b.defended !== z.s0 && b.behind.speed > v - 2) {
        // inside of the corner this braking zone feeds
        const apex = Math.floor(((z.s1 + 10) % tr.L) / tr.ds);
        let k = 0;
        for (let q = -15; q <= 15; q++) k += tr.line.kap[(apex + q + tr.N) % tr.N];
        b.defended = z.s0;
        if (Math.abs(k) > 0.002) { b.mode = 'defend'; b.defSide = Math.sign(k); b.defZone = z; b.defLat = null; }
      }
    }
    // cover: an attacker with a run who pulls out of the tow gets the door shut on the side
    // he picked, once, while he is still behind (moving across a car already alongside is a crash)
    if (b.mode === 'race' && b.behind && b.aggr > 0.3 && sinceStart > 4 && br.z && b.defended !== br.z.s0) {
      const a = b.behind, rel = a.loc.d - car.loc.d;
      if (b.gapBehind > car.spec.len + 1.5 && b.gapBehind < 14 && Math.abs(rel) > 1.5 && a.speed > v + 0.5 && br.room > 60 && br.room < 450) {
        b.defended = br.z.s0;
        b.mode = 'defend'; b.defSide = Math.sign(rel); b.defZone = br.z; b.defLat = U.clamp(a.loc.d, -lim, lim);
      }
    }
    if (b.mode === 'defend') {
      if (b.alongside && Math.sign(b.alongside.loc.d - car.loc.d) === b.defSide) b.mode = 'race';
      else if (b.defLat != null) { lo = Math.max(lo, b.defLat - 0.8); hi = Math.min(hi, b.defLat + 0.8); }
      else if (b.defSide > 0) lo = Math.max(lo, tr.hw - 3.4); else hi = Math.min(hi, -(tr.hw - 3.4));
      // hold the inside until the braking point, then drive the corner normally
      const toZone = Tracks.fwd(tr, car.loc.s, b.defZone.s0);
      let bend = false;
      for (let q = 0; q < Math.round(40 / tr.ds); q += 2) if (Math.abs(tr.line.kap[(i + q) % tr.N]) > 1 / 600) bend = true;
      if (toZone > tr.L - 40 || toZone < 25 || bend) b.mode = 'race';
    }
    // the run to the first corner: hold the grid lane, then fan out
    if (sinceStart < 8 && car.gridD != null) {
      const w = sinceStart < 4 ? 0.8 : 0.8 + (sinceStart - 4) * 2;
      lo = Math.max(lo, car.gridD - w); hi = Math.min(hi, car.gridD + w);
    }
    // just out of the pits: ease across to the racing line instead of diving for it
    if (b.mergeLat != null) {
      const target = U.clamp(lineOff, lo, hi);
      // always aim a little across from where the car really is, never far away
      b.mergeLat = car.loc.d + U.clamp(target - car.loc.d, -1.5, 1.5);
      if (Math.abs(car.loc.d - target) < 0.4) b.mergeLat = null;
      else {
        lo = Math.max(lo, b.mergeLat - 0.6); hi = Math.min(hi, b.mergeLat + 0.6);
        if (lo > hi) lo = hi = b.mergeLat;
        b.mode = 'race';
        b.lo = lo; b.hi = hi; b.squeezed = false;
        b.desired = U.clamp(lineOff, lo, hi); b.bias = b.desired - lineOff;
        return;
      }
    }
    // keep a car's width plus margin to anyone alongside
    b.squeezed = false;
    for (let k = 0; k < b.near.length; k++) {
      const o = b.near[k];
      if (Math.abs(b.nds[k]) > 7.5) continue;
      const dd = o.loc.d - car.loc.d;
      if (Math.abs(dd) > 4.8) continue;
      if (dd > 0) hi = Math.min(hi, o.loc.d - SEP); else lo = Math.max(lo, o.loc.d + SEP);
    }
    if (lo > hi) { const m = (lo + hi) / 2; lo = hi = U.clamp(m, -lim, lim); b.squeezed = true; }
    // the lane can only move so fast: no decision may yank the car across the track
    const lrate = 5 * dt;
    b.loS = b.loS == null ? lo : (lo > b.loS ? Math.min(lo, b.loS + lrate) : lo);
    b.hiS = b.hiS == null ? hi : (hi < b.hiS ? Math.max(hi, b.hiS - lrate) : hi);
    lo = b.loS; hi = b.hiS;
    if (lo > hi) { const m = (lo + hi) / 2; lo = hi = m; }
    b.lo = lo; b.hi = hi;
    b.desired = U.clamp(lineOff, lo, hi);
    b.bias = b.desired - lineOff;
  }

  function upcomingZone(tr, s, range) {
    let best = null, bd = 1e9;
    for (const z of tr.brakeZones) {
      const d = Tracks.fwd(tr, s, z.s0);
      if (d < range && d < bd) { bd = d; best = z; }
    }
    return best;
  }

  // Steering + pedals toward lateral offset `lat` and speed `vt`.
  function control(race, car, latAt, vt, dt) {
    const tr = race.track, b = car.brain;
    const v = Math.max(0, car.u);
    const look = P.look0 + v * P.lookV;
    const i = car.loc.i;
    const j = (i + Math.round(look / tr.ds)) % tr.N;
    let lat = latAt(j);
    // moving off or back onto the line happens progressively: a driver drifts across a
    // straight over a second or two instead of flinging the car 10 m sideways at 250 km/h.
    // Following the line itself is never limited, only the change in distance from it
    if (b && !b.pit && Math.abs(car.loc.d) < tr.hw + 1) {
      const e0 = car.loc.d - tr.line.off[i], e = lat - tr.line.off[j];
      const maxShift = 0.4 + 5 * look / Math.max(8, v);
      lat = tr.line.off[j] + U.clamp(e, e0 - maxShift, e0 + maxShift);
    }
    const px = tr.x[j] + tr.nx[j] * lat, py = tr.y[j] + tr.ny[j] * lat;
    const dx = px - car.x, dy = py - car.y;
    const ch = Math.cos(car.h), sh = Math.sin(car.h);
    const bx = dx * ch + dy * sh, by = -dx * sh + dy * ch;
    const L2 = Math.max(1, bx * bx + by * by);
    const kap = 2 * by / L2;
    let delta = Math.atan(car.spec.wb * kap);
    // slip compensation: lateral acceleration needs extra front slip angle
    delta += kap * v * v * P.slipComp;
    // yaw-rate damping
    delta += (v * kap - car.r) * P.yawDamp;
    // a driver keeps the front tyres near peak slip instead of winding on more lock
    if (v > 8) {
      const betaF = Math.atan2(car.v + car.r * car.lf, Math.max(1, car.u));
      const cap = P.frontCap;
      delta = U.clamp(delta, betaF - cap, betaF + cap);
    }
    const behind = bx < 0;
    if (behind) delta = Math.sign(by) * car.spec.lockF; // target behind us: full lock
    car.ctl.steerDirect = delta;
    if (behind || Math.abs(car.v) > 4 && car.speed < 25) vt = Math.min(vt, 8); // spun: pick it up gently

    const u = car.u;
    const err = vt - u;
    if (err < -0.4 && car.brain && car.brain.closeFollow) { car.ctl.throttle = 0; car.ctl.brake = U.clamp(-err * 0.3, 0.1, 1); return; }
    // the rear is stepping out when its tyres pass their lateral peak (TC handles plain wheelspin)
    const rearSlide = car.satR != null ? U.clamp((car.satR - 1.1) * 1.6, 0, 1) : Math.max(car.wheels[2].slide, car.wheels[3].slide);
    // Braking technique: stay flat until the decel the corner demands approaches what
    // the car can do, then hit the brakes hard in a straight line. As speed bleeds off
    // the demand falls, so the pedal comes off progressively into the apex (trail
    // braking) while the steering takes over the grip.
    let aCap = (P.aCap0 + P.aCapV * u * u) * Math.min(1, 820 / (car.spec.mass + car.fuel));
    if (car.wetness > 0.02) aCap *= Math.min(1, (car.grip == null ? 0.972 : car.grip) / 0.972); // wet brakes bite less
    const aReq = b && b.aReq != null ? b.aReq : 0;
    let thr = 0, brk = 0;
    if (aReq > P.brkOn * aCap) brk = U.clamp(aReq / (P.brkFull * aCap), 0, 1);
    else if (err < -1.2) brk = U.clamp(-err * P.errBrk, 0, 1);
    // once on the brakes, stay on them and bleed the pedal off (no on/off chatter): the
    // tyres now build slip progressively, so a held, smoothly released pedal is quicker
    if (b) {
      const held = b.brkPrev || 0;
      if (brk < held && err < 0) brk = Math.max(brk, held - P.bleed * dt);
      // trail braking: the pedal comes off as the cornering load builds, so the tyres
      // always have side grip left for the turn
      const lat0 = Math.abs(car.ay) / aCap;
      if (lat0 > P.trailOn) brk = Math.min(brk, Math.max(0, P.trailA - lat0 * P.trailB));
      // understeer: the fronts are at their peak and the car is still running wide toward
      // the outside edge. Wind no more throttle in; if the edge is close, a touch of brake
      // loads the nose and scrubs speed so the radius tightens
      b.under = 0;
      if (car.satF != null && car.satF > 0.95 && v > 12) {
        const dNow = car.loc.d;
        const dRate = b.dPrev == null ? 0 : (dNow - b.dPrev) / dt;
        b.dRate = b.dRate == null ? dRate : b.dRate + (dRate - b.dRate) * Math.min(1, dt * 20);
        const kl = tr.line.kap[i];
        if (Math.abs(kl) > 1 / 300) {
          const out = -Math.sign(kl);
          const room = tr.hw - 0.9 - dNow * out, toward = b.dRate * out;
          if (toward > 0.3) {
            const tEdge = Math.max(0, room) / toward;
            if (tEdge < 1.1) { b.under = U.clamp((1.1 - tEdge) * 0.8, 0.12, 0.55); brk = Math.max(brk, b.under); }
          }
        }
      }
      b.dPrev = car.loc.d;
      // the rear is going on the brakes: come off the pedal so it can grip again
      if (rearSlide > 0.3) brk *= Math.max(0.25, 1 - (rearSlide - 0.3) * 1.2);
      b.brkPrev = brk;
    }
    if (brk > 0) thr = 0;
    else if (err > 0) thr = U.clamp(P.thr0 + err * P.thrErr + u * 0.006, 0, 1);
    else if (err > -1.2) thr = U.clamp(0.25 + err * 0.25, 0, 1);
    // throttle technique: squeeze it on while the car is still loaded in the corner
    // the rear is stepping out: get off the throttle and let the steering catch it
    if (rearSlide > 0.3) thr *= Math.max(0, 1 - (rearSlide - 0.3) * P.rearThr);
    // pushing at the front: more throttle would only push it wider
    if (b && car.satF != null && car.satF > 0.97 && b.thrPrev != null) thr = Math.min(thr, b.thrPrev * 0.97);
    const latLoad = Math.abs(car.ay) / (aCap * 0.95);
    if (b && latLoad > P.thrLoad) {
      b.thrPrev = b.thrPrev == null ? thr : b.thrPrev;
      thr = Math.max(0, Math.min(thr, b.thrPrev + Math.max(0.8, P.thrRamp + 4 * (1 - latLoad)) * dt));
    }
    if (b) b.thrPrev = thr;
    car.ctl.throttle = thr; car.ctl.brake = brk;
  }

  function profAt(b, tr, s) {
    const f = ((s % tr.L) + tr.L) % tr.L / tr.ds;
    const i = Math.floor(f) % tr.N;
    return b.prof[i];
  }

  // ---- pit lane driving (AI and player autopilot) ----
  function pitDrive(race, car, dt) {
    const tr = race.track, b = car.brain, pit = tr.pit, p = b.pit;
    b.aReq = 0; // pit speeds come from the lane logic, not the racing-line brake planner
    const s = car.loc.s;
    const box = pit.boxS[car.team.idx];
    const toLimit = Tracks.fwd(tr, s, pit.limitIn);
    const inLimit = Tracks.inRange(tr, s, pit.limitIn, pit.limitOut);
    const workLat = i => (isNaN(pit.off[i]) ? pit.side * (tr.hw - 2) : pit.off[i] + pit.side * 2.6);
    const laneLat = i => (isNaN(pit.off[i]) ? pit.side * (tr.hw - 2) : pit.off[i] - pit.side * 1.8);
    let vt;
    if (p.phase === 'in') {
      vt = toLimit < 400 && !inLimit ? Math.sqrt(pit.limit ** 2 + 2 * 9 * toLimit) : pit.limit;
      if (!inLimit && toLimit > 400) vt = profAt(b, tr, s);
      car.limiter = inLimit;
      const toBox = Tracks.fwd(tr, s, box);
      if (inLimit && toBox < 60 && !p.served) {
        vt = Math.min(vt, Math.sqrt(2 * 4.5 * Math.max(0, toBox - 0.5)));
        control(race, car, toBox < 45 ? workLat : laneLat, vt, dt);
        if (toBox < 1.6 || (toBox > tr.L - 3)) {
          p.phase = 'stop'; p.serviceT = p.service;
          car.vx = car.vy = 0; car.r = 0;
        }
        return;
      }
      control(race, car, laneLat, vt, dt);
      if (p.served && !Tracks.inRange(tr, s, pit.limitIn, pit.limitOut) && Tracks.fwd(tr, pit.limitOut, s) < 300) p.phase = 'out';
    } else if (p.phase === 'stop') {
      car.ctl.throttle = 0; car.ctl.brake = 1; car.ctl.steerDirect = 0;
      car.vx *= 0.8; car.vy *= 0.8;
      p.serviceT -= dt;
      if (p.serviceT <= 0) {
        race.servicePit(car);
        p.served = true; p.phase = 'in';
      }
    } else if (p.phase === 'out') {
      car.limiter = false;
      let vt = profAt(b, tr, s) * 0.9;
      // do not drive into the path of a car already on the racing line
      const toEnd = Tracks.fwd(tr, s, pit.sOut);
      if (toEnd < 160 && toEnd > 5) {
        for (const o of race.cars) {
          if (o === car || o.inPit || o.ghostT > 0) continue;
          const ds = relS(tr, car, o);
          if (ds > -60 && ds < 8 && Math.abs(o.loc.d - car.loc.d) < 4.5 && o.speed > car.speed) vt = Math.min(vt, Math.max(12, o.speed - 25));
        }
      }
      control(race, car, i => (isNaN(pit.off[i]) ? tr.line.off[i] : pit.off[i]), vt, dt);
      if (isNaN(pit.off[car.loc.i])) { b.pit = null; car.inPit = false; b.bias = car.loc.d - tr.line.off[car.loc.i]; b.mergeLat = car.loc.d; }
    }
  }

  function drive(race, car, dt) {
    const b = car.brain, tr = race.track;
    car.ctl.steer = 0;
    // pre-start: hold on the brakes with launch revs
    if (!race.green) {
      car.ctl.steerDirect = 0; car.ctl.brake = 1; car.ctl.throttle = race.lightsOn > 0 ? 0.55 : 0;
      return;
    }
    if (race.time < race.startTime + b.react) { car.ctl.brake = 1; car.ctl.throttle = race.mode === 'tt' ? 0 : 0.6; car.ctl.steerDirect = 0; return; }

    if (car.incident) { F1.Race.incidentDrive(race, car, dt, control); return; }
    if (b.pit && b.pit.phase !== 'approach') { pitDrive(race, car, dt); return; }

    b.senseT -= dt;
    if (b.senseT <= 0) { b.senseT = 1 / 30; sense(race, car); }
    plan(race, car, dt);

    const i = car.loc.i;
    const v = Math.max(0, car.u);
    // per-lap braking noise: small variations so AI lap times are not identical
    b.noiseT -= dt;
    if (b.noiseT <= 0) { b.noiseT = 2 + b.rng() * 3; b.noise = 1 + (b.rng() - 0.5) * 0.012 * (1.4 - b.aggr); }
    const leadIdx = (i + Math.round((v * P.leadT + 2) / tr.ds)) % tr.N;
    let vt = b.prof[leadIdx] * b.noise;
    // off-line penalty in corners, and a slower car with a damaged front wing
    const kl = Math.abs(tr.line.kap[leadIdx]);
    const cornerK = Math.min(1, kl * 60);
    const dev = Math.max(Math.abs(b.bias), Math.abs(car.loc.d - tr.line.off[leadIdx]));
    vt *= 1 - Math.min(0.22, dev * cornerK * 0.035);
    if (car.dm) { if (tr.brk[leadIdx] || kl > 1 / 500) vt *= car.dm.paceK; }
    else vt *= 1 - car.wingDmg * 0.3 * Math.max(cornerK, tr.brk[leadIdx] ? 0.8 : 0);
    // racing in traffic: nobody drives qualifying limits with a car inches away
    if (((b.ahead && b.gapAhead < 40) || b.alongside) && (tr.brk[leadIdx] || kl > 1 / 500)) vt *= 0.985;
    // fuel load: a heavier car brakes later and corners slower than the reference
    // (limits are learned at 20 kg); the AI adjusts its marks as the fuel burns off
    const mass = car.spec.mass + car.fuel;
    if (mass > 822 && (tr.brk[leadIdx] || kl > 1 / 500)) vt *= Math.pow(820 / mass, 0.45);
    // worn tyres past the cliff: nurse them, there is far less grip than the numbers say
    {
      const wr = Math.max(car.wheels[0].wear, car.wheels[1].wear, car.wheels[2].wear, car.wheels[3].wear);
      if (wr > 0.5 && (tr.brk[leadIdx] || kl > 1 / 500)) vt *= 1 - Math.min(0.15, (wr - 0.5) * 0.3);
    }
    // tyre saving: a slightly earlier lift and gentler corner speed when told to manage
    if (b.manage && b.manage < 1 && (tr.brk[leadIdx] || kl > 1 / 500)) vt *= b.manage;
    // drive to the conditions: tyre temperature / wear and dirty air cost grip
    if (tr.brk[leadIdx] || kl > 1 / 500) {
      const gf = (car.grip == null ? 0.972 : car.grip) / 0.972 * (1 - (1 - car.dfMul) * 0.5);
      if (gf < 1) vt *= Math.sqrt(gf);
      if (car.wetness > 0.05) vt *= 1 - 0.2 * Math.min(1, car.wetness * 1.2); // a careful margin on a slippery road
    }
    // running out of road on the exit: lift
    const kNow = tr.line.kap[i];
    // (past where the line itself goes: it may use the exit kerb on purpose)
    if (Math.abs(kNow) > 1 / 400 && Math.sign(car.loc.d) === -Math.sign(kNow) && Math.abs(car.loc.d) > Math.max(tr.hw - 0.4, Math.abs(tr.line.off[i]) + 0.35)) vt = Math.min(vt, v * 0.96);

    // follow / avoid: the nearest car ahead that sits in our lane (now or where we are heading)
    if (b.near) {
      const myLat = car.loc.d, planLat = b.desired == null ? myLat : b.desired;
      let blk = null, bds = 1e9;
      for (let k = 0; k < b.near.length; k++) {
        const o = b.near[k], ds = b.nds[k];
        if (ds <= 0 || ds > 80) continue;
        // where our own line takes us by the time we get there: a car beside our lane
        // now is in it if the line swings across before we reach it
        const there = ds < 40 ? U.clamp(tr.line.off[o.loc.i], b.lo == null ? -tr.hw : b.lo, b.hi == null ? tr.hw : b.hi) : planLat;
        if ((Math.abs(o.loc.d - myLat) < 2.35 || Math.abs(o.loc.d - planLat) < 2.35 || Math.abs(o.loc.d - there) < 2.35) && ds < bds) { blk = o; bds = ds; }
      }
      if (blk) {
        const gap = bds - car.spec.len;
        // more room into a braking zone: dirty air costs braking grip and the car ahead may brake early
        const nearBrake = tr.brk[i] || tr.brk[(i + Math.round(60 / tr.ds)) % tr.N];
        // (sitting in a tow on a straight, a driver closes right up to the gearbox)
        const want = b.mode === 'tow' && blk === b.target && !nearBrake ? 1.2 + 0.03 * v : 1.5 + 0.09 * v + (nearBrake ? 0.08 * v : 0);
        const closing = v - blk.speed;
        if (blk.ctl.brake > 0.25 && gap < want + 25) vt = Math.min(vt, blk.speed + Math.max(0, gap - want) * 0.5);
        // (in a tow the run is the point: it may close right up before easing off)
        const towing = b.mode === 'tow' && blk === b.target && !nearBrake;
        if (closing > 0) {
          const need = closing * closing / (2 * Math.max(0.5, gap - want));
          if (need > (towing ? 9 : 3)) vt = Math.min(vt, blk.speed - 0.3);
        }
        if (gap < want) vt = Math.min(vt, blk.speed - (want - gap) * 1.2);
        b.closeFollow = gap < want + 6;
        // stop-distance check including the leader's own deceleration
        const room = Math.max(0.3, gap - 1.0);
        const aLead = Math.max(0, -(blk.ax || 0));
        const aReq = closing > 0 ? closing * closing / (2 * room) + aLead * 0.9 : (gap < want ? aLead : 0);
        const aMax = (14 + 0.0045 * v * v) * 0.85;
        b.followBrake = aReq > 0.35 * aMax ? U.clamp(aReq / aMax * 1.15, 0, 1) : 0;
      } else { b.closeFollow = false; b.followBrake = 0; }
      // alongside into a corner: the car behind on the outside lifts
      const al = b.alongside;
      const alds = al ? relS(tr, car, al) : 0;
      if (al && (alds > 0.5 || b.squeezed && alds > -1)) {
        const inside = nextCornerSign(tr, i, 120);
        if (inside && Math.sign(car.loc.d - al.loc.d) === -inside) vt = Math.min(vt, al.speed - 0.5);
      }
    }
    // a broken front wing cannot wait for the strategy call: box at the next entry
    if (race.sim && !car.isPlayer && car.wingDmg > 0.3 && !b.pit && !car.finished) {
      b.pit = { phase: 'approach', service: 2.4 + b.rng() * 0.6, served: false };
      car.pitPlan = { compound: car.compound.id };
    }
    // pit approach: get over to the pit side before the entry
    const lo = b.lo == null ? -tr.hw : b.lo, hi = b.hi == null ? tr.hw : b.hi;
    let latFn = j => U.clamp(tr.line.off[j], lo, hi);
    if (b.pit && b.pit.phase === 'approach') {
      const d = Tracks.fwd(tr, car.loc.s, tr.pit.sIn);
      if (d < 260) latFn = j => (isNaN(tr.pit.off[j]) ? tr.pit.side * (tr.hw - 1.8) : tr.pit.off[j]);
      if (!isNaN(tr.pit.off[i]) && Tracks.fwd(tr, tr.pit.sIn, car.loc.s) < 150 && Math.abs(car.loc.d - tr.pit.off[i]) < tr.pit.lane / 2 + 1) {
        b.pit.phase = 'in'; car.inPit = true; b.mode = 'race';
      }
    }
    // recovering from an off: slow down until we are back on the asphalt
    if (Math.abs(car.loc.d) > tr.hw + 1.2 && !car.inPit) vt = Math.min(vt, 30);
    // look down the road for the hardest braking this approach needs (same modifiers
    // as the target speed: pace noise, line offset, damage, tyre condition)
    {
      const scale = vt / Math.max(1, b.prof[leadIdx]);
      const horizon = v * v / (car.wetness > 0.02 ? 24 * Math.min(1, (car.grip == null ? 0.972 : car.grip) / 0.972) : 24) + 15;
      let aReq = 0;
      const lat = car.loc.d;
      let offRun = 0;
      for (let d = 4; d < horizon; d += 4) {
        const j = (i + Math.round(d / tr.ds)) % tr.N;
        let vj = b.prof[j] * Math.min(scale, 1.02);
        // still off the racing line when we get there? that corner is slower: brake earlier.
        // The worst gap on the way in counts, not just the one at the corner: a car that
        // skipped the swing out to the far side arrives on the line but pointing the wrong
        // way, on a much tighter radius
        offRun = Math.max(offRun, Math.abs(lat - tr.line.off[j]));
        const offj = offRun * (1 - 0.5 * d / horizon);
        if (offj > 1) vj *= 1 - Math.min(0.22, offj * Math.min(1, Math.abs(tr.line.kap[j]) * 60) * 0.035);
        if (v > vj) { const a = (v * v - vj * vj) / (2 * d); if (a > aReq) aReq = a; }
      }
      b.aReq = aReq;
    }
    // safety car queue: never faster than the cap that keeps us off the car in front
    if (car.scCap != null && !car.inPit) vt = Math.min(vt, car.scCap);
    control(race, car, latFn, vt, dt);
    if (b.followBrake > 0) {
      // emergency braking for the car ahead, eased if the rear is already stepping out
      const rs = car.satR != null ? U.clamp((car.satR - 1.1) * 1.6, 0, 1) : 0;
      car.ctl.brake = Math.max(car.ctl.brake, b.followBrake * (rs > 0.3 ? Math.max(0.4, 1 - (rs - 0.3)) : 1)); car.ctl.throttle = 0;
    }

    // stuck detection
    const head = Math.atan2(tr.ty[i], tr.tx[i]);
    const wrongWay = Math.abs(U.wrapAngle(car.h - head)) > 1.9;
    // lost = well off the circuit (not merely far from the racing line: on a wide straight a
    // car passing on the other side is 12 m from it and perfectly fine)
    const lost = Math.abs(car.loc.d) > tr.hw + 4;
    if ((car.speed < 2.5 || wrongWay || lost) && !car.finished) b.stuckT += dt; else b.stuckT = Math.max(0, b.stuckT - dt);
    // a car stopped on the racing line is a hazard: clear it quickly
    const onLine = Math.abs(car.loc.d) < tr.hw;
    if (b.stuckT > (car.speed < 1.5 && onLine ? 1.2 : 3)) { race.recover(car); b.stuckT = 0; }
  }

  F1.AI = { P, makeBrain, drive, pitDrive, sense, relS, upcomingZone };
})(typeof window !== 'undefined' ? window : globalThis);
