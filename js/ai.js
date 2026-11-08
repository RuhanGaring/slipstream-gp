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
    // wet track: the share of the tyres' grip the plan uses, a margin on top, and how far in from
    // the edge (metres, at full wet) the car keeps (tuned on heavy-rain races: recoveries 151 to 22)
    wetK: 0.82, wetMargin: 0.05, wetEdge: 0.6,
    // racecraft margins, tuned on full 20-car races (tools/racetune.js)
    mpc: 0, mpcTrig: 60, mpcCorner: 3.5, mpcCare: 1.6, mpcKeep: 1.5, mpcPass: 8, hitK: 0.5, trafK: 0.975, lap1K: 0.97, lap1T: 35, lap1Gap: 2.2, gapV: 0.12, gapBrk: 0.14, trafBrk: 1,
    dirtyK: 0.5, // how much of the downforce lost in dirty air the corner speed allows for
    // live grip reading: on, tyre load that counts as past the limit, metres off line that count as
    // running wide, load below which there is grip to spare, the step down and up, the limits
    live: 1, gripHot: 1.12, gripWide: 2, gripRoom: 0.92, gripDn: 0.008, gripUp: 0.004, gripMin: 0.95, gripMax: 1.04,
  };

  // Reading the grip. A driver does not trust a stored plan: each time through a corner they feel how
  // close the tyres came to letting go, and take that into the next lap. Here each car keeps a speed
  // factor per corner, for this car on these tyres with this fuel on this track today. A corner taken
  // with the tyres past their peak, a slide or a run wide brings it down at once; one taken with grip
  // to spare lets it creep up. Traffic teaches nothing: a car in dirty air or fighting is not
  // showing what the tyres have. The better the driver, the finer the feel.
  function cornerMap(tr) {
    if (tr.aiCorners) return tr.aiCorners;
    const M = new Int16Array(tr.N).fill(-1), cs = F1.Raceline.cornersOf(tr), back = Math.round(70 / tr.ds);
    cs.forEach((c, k) => { for (let q = c.startQ - back; q <= c.endQ; q++) M[(c.st + q + tr.N * 2) % tr.N] = k; });
    M.n = cs.length;
    return (tr.aiCorners = M);
  }
  function readGrip(car, b, tr, i) {
    const M = cornerMap(tr), c = M[i];
    if (!b.gripK) { b.gripK = new Float32Array(M.n).fill(1); b.gripC = -1; }
    if (c !== b.gripC) {
      if (b.gripC >= 0 && !b.gripDirty) {
        const k = b.gripC, hot = b.gripPk > P.gripHot || b.gripWide > P.gripWide, q = 0.5 + 0.5 * (b.style ? b.style.skill : 1);
        if (hot) b.gripK[k] = Math.max(P.gripMin, b.gripK[k] * (1 - P.gripDn));
        else if (b.gripPk < P.gripRoom) b.gripK[k] = Math.min(P.gripMax, b.gripK[k] * (1 + P.gripUp * q));
      }
      b.gripC = c; b.gripPk = 0; b.gripWide = 0; b.gripDirty = false;
    }
    if (c >= 0) {
      b.gripPk = Math.max(b.gripPk, car.satF || 0, (car.satR || 0) * 0.82);
      b.gripWide = Math.max(b.gripWide, Math.abs(car.loc.d - tr.line.off[i]));
      if ((b.ahead && b.gapAhead < 30) || b.alongside || b.mode !== 'race') b.gripDirty = true;
    }
  }
  const gripAt = (b, tr, j) => { if (!P.live || !b.gripK) return 1; const c = cornerMap(tr)[j]; return c >= 0 ? b.gripK[c] : 1; };

  // How a driver differs from the plan. The plan is the fastest lap the car can do (tools/coach.js),
  // and driving it alone every car would brake at the same metre and hold the same line. A driver
  // has habits: where to brake, whether slow corners or fast ones suit them, how long they will sit
  // behind a car before trying something, how hard they defend. They have a rhythm from lap to lap
  // and now and then get one wrong, more often under pressure. skill is 0
  // to 1: the better the driver, the closer to the plan and the less often they miss it.
  function styleOf(b, skill, aggr) {
    const r = b.rng, g = () => r() + r() + r() - 1.5, nerve = U.clamp(aggr * (0.75 + r() * 0.5), 0, 1.2);
    return {
      skill, nerve,
      brk: U.clamp(1 + g() * 0.03 * (1.3 - skill), 0.95, 1.04),       // share of P.brkOn: over 1 is later
      brkVar: 0.04 - 0.025 * skill,                                   // corner to corner
      lat: 0.85 - 0.35 * skill,                                       // metres off the line, on a straight
      slow: 1 + g() * 0.008 * (1.2 - skill), fast: 1 + g() * 0.008 * (1.2 - skill), // corner speed by kind of corner
      rhythm: 0.005 * (1.25 - skill),                                 // lap to lap
      err: 0.002 + 0.045 * (1 - skill) ** 1.6,                        // a stop that goes wrong
      defP: 0.4 + 0.5 * U.clamp(nerve, 0, 1),                         // chance of covering a given corner
      latK: 0, a: null, b: null, c: 1, s: 0, lap: -1, form: 1,
    };
  }
  // one corner gone wrong, chosen as the car arrives: nothing the driver chose, and nothing they cannot
  // recover from in the next hundred metres
  function misjudge(race, car, b, z) {
    const st = b.style, r = b.rng(), tr = race.track;
    if (r < 0.34) { b.hot = 1.03 + b.rng() * 0.05 * (1.3 - st.skill); b.hotS = (z.s1 + 25) % tr.L; } // in too hot: locks up, runs wide
    else if (r < 0.58) b.brkK *= 0.84 + b.rng() * 0.06;       // early: the car ahead draws away
    else if (r < 0.8) {                                        // misses the apex
      const sg = nextCornerSign(tr, Math.floor(z.s1 / tr.ds) % tr.N, 60) || nextCornerSign(tr, car.loc.i, 300);
      b.wide = -sg * (1.4 + b.rng() * 1.4 * (1.2 - st.skill)); b.wideA = (z.s1 - 40 + tr.L) % tr.L;
    } else b.cutS = (z.s1 + 15) % tr.L;                        // too much throttle on the way out
  }
  // a car's own line: smooth drift either side of the racing line, closing the lap, tight in corners
  // where the road decides and looser between them
  function styleLine(tr, b) {
    const st = b.style, N = tr.N, r = b.rng;
    if (!tr.styleEnv) {
      tr.styleEnv = new Float32Array(N);
      const w = Math.round(22 / tr.ds);
      for (let i = 0; i < N; i++) { let k = 0; for (let q = -w; q <= w; q += 2) k = Math.max(k, Math.abs(tr.line.kap[(i + q + N) % N])); tr.styleEnv[i] = 1 - 0.58 * Math.min(1, k * 45); }
    }
    const wave = () => {
      const a = new Float32Array(N), n = 3;
      for (let k = 0; k < n; k++) {
        const m = Math.max(2, Math.round(tr.L / (130 + r() * 300))), ph = r() * 6.283, w = (2 * Math.PI * m) / N, amp = 1 / Math.sqrt(n);
        for (let i = 0; i < N; i++) a[i] += amp * Math.sin(w * i + ph);
      }
      for (let i = 0; i < N; i++) a[i] *= st.lat * tr.styleEnv[i];
      return a;
    };
    st.a = wave(); st.b = wave();
  }
  const styleAt = (b, j) => { const st = b.style; return st.a[j] * st.c + st.b[j] * st.s; };

  function makeBrain(car, prof, opts) {
    const b = {
      prof, pace: opts.pace || 1, aggr: opts.aggr == null ? 0.6 : opts.aggr,
      rng: U.rng(opts.seed || 1),
      bias: 0, mode: 'race', side: 0, passT: 0, defended: -1,
      ahead: null, gapAhead: 1e9, behind: null, gapBehind: 1e9, alongside: null,
      senseT: 0, react: opts.react || 0.25, startT: 0,
      stuckT: 0, noise: 1, noiseT: 0,
      pit: null, // {phase, box, serviceT}
      brkK: 1, zoneK: null,
    };
    if (opts.skill != null) b.style = styleOf(b, opts.skill, b.aggr);
    return b;
  }

  // How fast a car can lap as it is now: its speed plan's average (time-weighted, so the
  // harmonic mean), less what damage costs it. Used to tell a car too slow to race from a rival.
  function paceOf(c) {
    const p = c.brain && c.brain.prof;
    if (!p) return 0;
    if (p.hm == null) { let s = 0; for (let k = 0; k < p.length; k++) s += 1 / Math.max(5, p[k]); p.hm = p.length / s; }
    return p.hm * (c.dm ? c.dm.paceK : 1 - (c.wingDmg || 0) * 0.3);
  }

  // Whether a car here can still turn into the pit lane: on the open stretch after the entry
  // line, or already on the lane's side of the pit wall. A car that missed the opening and called
  // itself in further on steered into the end of the wall and stuck there on full throttle.
  function canJoinLane(tr, c) {
    const past = Tracks.fwd(tr, tr.pit.sIn, c.loc.s);
    if (past < pitOpen(tr)) return true;
    const pw = tr.pit.wall[c.loc.i];
    return !isNaN(pw) && c.loc.d * tr.pit.side > pw + 0.5;
  }

  // The way into the pit lane, as a speed plan for a car on its way in: the lane swings off the
  // track (Sierra's moves 14 m sideways in 110 m), and on that curve a car still at its braking-
  // board speed spun and sat in the entry backwards. The car's path in is the racing line, eased
  // across to the pit side over the straight before the entry (pitW), then the lane. Along the
  // lane its curvature meets a cornering limit with no help from downforce (PIT_LAT); before the
  // entry only the extra turning of the crossing counts (the racing line's own corners are the
  // plan's), at a gentle PIT_ACROSS sideways; then braked back from there at PIT_DEC. drive()
  // brakes for it ahead of time like any corner: applied on the spot, it braked a car in the middle
  // of the esses before. (The crossing used to be judged from the racing line's distance to the
  // pit side at every point, as if the car never moved over before it: that held a car to 80 km/h
  // at the entry line already on the pit side, two seconds a stop.)
  const PIT_LAT = 9, PIT_DEC = 11, PIT_ACROSS = 7, PIT_VMIN = 12;
  const REJOIN = 0.15; // (sideways per metre ahead, rejoining from off the road: about 8 degrees)
  // The straight before the pit entry, where a car crosses to the pit side. Only the straight: a
  // car that headed for the pit side a fixed 120 m out went across the grass when those 120 m
  // began in a fast chicane (gen-777: nearly every in-lap reset there).
  const PIT_RUN_MIN = 40;
  function pitRun(tr) {
    if (tr.pit.run == null) {
      let run = 0, kk = Math.floor(tr.pit.sIn / tr.ds);
      while (run < 260 && Math.abs(tr.line.kap[((kk % tr.N) + tr.N) % tr.N]) < 1 / 200) { run += tr.ds; kk--; }
      tr.pit.run = Math.max(PIT_RUN_MIN, run);
    }
    return tr.pit.run;
  }
  const ease01 = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
  // how far over to the pit side a car on its way in is at point j: none at the start of the run,
  // all of it at the entry and along the lane. Eased in and out: a car that snapped across the
  // moment the run began, still turning out of the corner before it, spun (Lucerne).
  function pitW(tr, j) {
    const s = j * tr.ds, past = Tracks.fwd(tr, tr.pit.sIn, s);
    if (past < tr.pit.len) return 1;
    return ease01(1 - Tracks.fwd(tr, s, tr.pit.sIn) / pitRun(tr));
  }
  const pitTarget = (tr, j) => { const o = tr.pit.off[j]; return isNaN(o) ? tr.pit.side * (tr.hw - 1.8) : o; };
  function pitLaneV(tr) {
    const pit = tr.pit;
    if (pit.vLane) return pit.vLane;
    const N = tr.N, ds = tr.ds, v = new Float32Array(N).fill(1e3);
    const i0 = Math.floor(pit.sIn / ds), i1 = Math.floor(pit.limitIn / ds), span = ((i1 - i0 + N) % N) + 2;
    const back = Math.round(pitRun(tr) / ds);
    const path = Float64Array.from(tr.line.off), W = new Float64Array(N);
    for (let k = -back; k <= span; k++) {
      const j = (i0 + k + N) % N, w = pitW(tr, j);
      W[j] = w; path[j] = tr.line.off[j] + (pitTarget(tr, j) - tr.line.off[j]) * w;
    }
    const kp = F1.Raceline.lineFromOffsets(tr, path).kap;
    for (let k = -back; k <= span; k++) {
      const j = (i0 + k + N) % N;
      if (k >= 0) v[j] = Math.max(pit.limit, Math.min(1e3, Math.sqrt(PIT_LAT / Math.max(Math.abs(kp[j]), 1e-5))));
      else if (W[j] > 0.01) v[j] = Math.max(PIT_VMIN, Math.min(1e3, Math.sqrt(PIT_ACROSS / Math.max(Math.abs(kp[j] - tr.line.kap[j]), 1e-5))));
    }
    // braked back from each point (and on to 400 m before the entry)
    for (let k = span; k > -Math.round(400 / ds); k--) {
      const j = (i0 + k + N) % N, n = (j + 1) % N;
      v[j] = Math.min(v[j], Math.sqrt(v[n] * v[n] + 2 * PIT_DEC * ds));
    }
    return (pit.vLane = v);
  }

  // overheated rear tyres are eased in curves the plan takes above this share of its grip
  // (Nordwald's spins came at 0.67 to 0.94; most of Varenna's flat curves run under 0.6)
  const HOT_LOAD = 0.35;
  const loadAt = (prof, i) => (prof && prof.load ? prof.load[i] : 1);

  // How far past the pit entry line the lane can still be joined: up to a little before the wall
  // between lane and track begins. A car that has not merged by then carries on round the lap.
  function pitOpen(tr) {
    if (tr.pit.openU == null) {
      let u = 0;
      while (u < 300) { const i = Math.floor(((tr.pit.sIn + u) % tr.L) / tr.ds) % tr.N; if (!isNaN(tr.pit.wall[i])) break; u += tr.ds; }
      tr.pit.openU = Math.max(0, Math.min(150, u - 15));
    }
    return tr.pit.openU;
  }
  // is car o letting car c by? (never assumed of a player who is driving)
  const yieldsTo = (race, o, c) => !!(o.brain && o.brain.yield === c && !(o.isPlayer && !race.autoPlayer && !o.brain.pit));

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
      if (ds < -30 || ds > (o.speed < 40 ? 280 : 110)) continue;
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

  // Where the car may be across the road at each point: over a kerb in the corners, all four
  // wheels on the asphalt everywhere else (Raceline.lineLimits). A stored line that strays
  // past it is pulled back in as it is driven. A kerb is worth its reach only at a kerb-worthy
  // speed: through a chicane taken fast (the road's radius is tight, the line's is not) the car
  // drifts half a metre to a metre wide of its line, and from the kerb's outer edge that is all four
  // wheels off and the lap deleted (two fast chicanes on a generated circuit did it every lap). So
  // the reach onto a kerb shrinks from all of it at 150 km/h until, by 230, the car aims 0.4 m
  // inside the white line: a full metre of drift still leaves the inner wheels on the asphalt.
  // (Not on the hand-made circuits: their coached lines already keep a wheel on at speed, and
  // trimming them only cost time.)
  function edgeOf(tr) {
    if (tr.aiEdge && tr.aiEdge.line === tr.line) return tr.aiEdge;
    const E = F1.Raceline.lineLimits(tr), coached = F1.Limits && F1.Limits[tr.id] && F1.Limits[tr.id].simB;
    let v = null;
    // (speeds from the Arcade plan, the quicker of the two, with its extra grip)
    if (!coached) try { v = F1.Raceline.speedProfile(tr, tr.line, F1.Car.SPEC, F1.Race.planOpts(tr, false, 1.12)); } catch (e) { v = tr.prof || null; }
    if (v) for (let i = 0; i < tr.N; i++) {
      const kmh = v[i] * 3.6;
      if (kmh <= KERB_V0) continue;
      const cap = tr.hw + 0.45 - KERB_TRIM * Math.min(1, (kmh - KERB_V0) / (KERB_V1 - KERB_V0));
      if (E.L[i] > cap) E.L[i] = cap;
      if (E.R[i] > cap) E.R[i] = cap;
    }
    E.line = tr.line;
    return (tr.aiEdge = E);
  }
  const KERB_V0 = 150, KERB_V1 = 230; // km/h
  const KERB_TRIM = 0.85; // m taken off the kerb reach by KERB_V1 (0.5 still lost laps at 1 m of drift)

  // Looking ahead. In traffic a driver tries a handful of lanes and two speeds, each run forward
  // a few seconds on a simple model of the car against where the cars nearby will be, and takes
  // the one that scores best: road covered, places gained, and contact all but ruled out. Passing,
  // covering, tucking into a tow and backing out are not separate rules: they are what comes out.
  // Cars with nobody near skip it, and each car thinks a few times a second, on its own beat.
  const MPC_N = 12, MPC_DT = 0.2, MPC_R = 6;
  const mpcS = new Float64Array(MPC_R * (MPC_N + 1)), mpcD = new Float64Array(MPC_R), mpcS0 = new Float64Array(MPC_R), mpcL = new Float64Array(14);
  function predict(race, car, b, lim, v, cur) {
    const tr = race.track, N = tr.N, i = car.loc.i, ds = tr.ds, off = tr.line.off, kap = tr.line.kap;
    let n = 0;
    for (let k = 0; k < b.near.length && n < MPC_R; k++) {
      const o = b.near[k], g = b.nds[k];
      if (g < -22 || g > 70 || o.inPit || o.incident) continue;
      // where this car will be: on its own plan from its own speed, in its own lane
      const pr = o.brain && o.brain.prof, row = n * (MPC_N + 1);
      let so = g, vo = Math.max(0, o.speed);
      mpcS[row] = so; mpcS0[n] = g;
      for (let t = 1; t <= MPC_N; t++) {
        const q = (o.loc.i + Math.round((so - g) / ds)) % N, pv = pr ? pr[q] : vo;
        vo += U.clamp(pv - vo, -35 * MPC_DT, 9 * MPC_DT); so += vo * MPC_DT; mpcS[row + t] = so;
      }
      mpcD[n] = o.brain && o.brain.desired != null ? 0.5 * (o.loc.d + o.brain.desired) : o.loc.d;
      n++;
    }
    if (!n) { b.mpcL = null; b.mpcK = 1; return; }
    const lead = (i + Math.round(v * 1.2 / ds)) % N, line = off[lead], E = edgeOf(tr);
    // (into a corner the road decides: a lane far off the line there runs out of grip and road)
    let bend = false;
    for (let q = 0, n2 = Math.round((v * 2 + 30) / ds); q < n2 && !bend; q += 3) if (Math.abs(kap[(i + q) % N]) > 1 / 180) bend = true;
    let m = 0;
    const add = x => { if (bend) x = U.clamp(x, line - P.mpcCorner, line + P.mpcCorner); x = U.clamp(E.clamp(lead, x), -lim, lim); for (let q = 0; q < m; q++) if (Math.abs(mpcL[q] - x) < 0.5) return; if (m < 14) mpcL[m++] = x; };
    if (cur != null) add(cur);
    if (P.mpc !== 3) { add(line); add(car.loc.d); }
    if (P.mpc !== 3) for (let r = 0; r < n; r++) { const g = mpcS0[r]; if (g > -12) { add(mpcD[r] + 3.35); add(mpcD[r] - 3.35); } if (g > 8) add(mpcD[r]); else if (g < -8) add(mpcD[r]); }
    const st = b.style, nerve = st ? U.clamp(st.nerve, 0, 1) : 0.5, care = P.mpcCare * (1.25 - 0.5 * nerve);
    let best = 1e18, bL = line, bK = 1, riskCur = 0;
    for (let c = 0; c < m; c++) for (let kk = 1; kk >= (P.mpc === 3 ? 0.9 : 0.965); kk -= 0.035) {
      const L = mpcL[c];
      let sv = 0, d = car.loc.d, vv = v, cost = 0.25 * Math.abs(L - car.loc.d), w = 1, risk = 0;
      if (b.mpcL != null && Math.abs(L - b.mpcL) < 0.6) cost -= P.mpcKeep;
      if (kk < 1) cost += 0.6;
      for (let t = 1; t <= MPC_N; t++) {
        const q = (i + Math.round(sv / ds)) % N, tight = Math.abs(kap[q]);
        let pv = b.prof[q] * kk * (tight > 1 / 200 ? 1 - 0.012 * Math.abs(d - off[q]) : 1);
        for (let r = 0; r < n; r++) {
          const gap = mpcS[r * (MPC_N + 1) + t] - sv, dl = Math.abs(mpcD[r] - d);
          if (gap > 7 && gap < 45 && dl < 1.5 && tight < 1 / 400) pv *= 1.03; // the tow
          if (Math.abs(gap) < 6.2) { if (dl < 2.15) { cost += 320 * w * care; risk += 320 * w * care; } else if (dl < 2.8) cost += 7 * w * care; }
        }
        vv += U.clamp(pv - vv, -35 * MPC_DT, 9 * MPC_DT);
        sv += vv * MPC_DT;
        d += U.clamp(L - d, -4.5 * MPC_DT, 4.5 * MPC_DT);
        w *= 0.94;
      }
      if (c === 0 && kk === 1) riskCur = risk;
      cost -= sv;
      for (let r = 0; r < n; r++) if (mpcS0[r] > 0 && sv > mpcS[r * (MPC_N + 1) + MPC_N] + 1) cost -= P.mpcPass * (0.5 + nerve);
      cost += 0.35 * Math.abs(d - off[(i + Math.round(sv / ds)) % N]);
      if (cost < best) { best = cost; bL = L; bK = kk; }
    }
    // (as a guard over the racing rules it only steps in when the way they chose ends in contact)
    if (P.mpc >= 2 && riskCur < P.mpcTrig) { b.mpcL = null; b.mpcK = 1; return; }
    b.mpcL = P.mpc === 3 ? null : bL; b.mpcK = bK;
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
    const LL = edgeOf(tr);
    for (let q = 0, n = Math.round(60 / tr.ds); q <= n; q += 2) { const j = (i + q) % tr.N, o = LL.clamp(j, tr.line.off[j]); if (o > hi) hi = o; else if (o < lo) lo = o; }
    // in the wet, off the painted kerbs (near ice) and a metre clear of the edge: the car runs
    // wide on less grip, and a wheel on the grass or in the gravel there is a spin
    if (car.wetness > 0.05) {
      const wl = tr.hw - 0.55 - P.wetEdge * Math.min(1, car.wetness * 1.5);
      lo = Math.max(lo, -wl); hi = Math.min(hi, wl);
    }
    const v = Math.max(0, car.u);
    const sinceStart = race.time - race.startTime;
    const br = brakeRoom(tr, car);
    // a new braking zone: where this driver goes for the pedal this time
    if (b.style && br.z !== b.zoneK) {
      b.zoneK = br.z;
      const g = b.rng() + b.rng() + b.rng() - 1.5, st = b.style;
      b.brkK = U.clamp(st.brk * (1 + g * st.brkVar), 0.92, 1.08);
      // pressure: someone on the gearbox, someone to catch, tired tyres, a wet road
      const tight = (b.gapBehind < 25 ? 0.7 : 0) + (b.gapAhead < 25 ? 0.5 : 0);
      const wr = Math.max(car.wheels[0].wear, car.wheels[2].wear);
      if (br.z && sinceStart > 6 && b.rng() < st.err * (1 + tight + wr * 1.5 + Math.min(1, car.wetness) * 2)) misjudge(race, car, b, br.z);
    }
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
    if (P.mpc !== 1 && (b.mode === 'race' || b.mode === 'tow') && sinceStart > 1.5 && !b.coolT) {
      let o = null, ods = 1e9;
      for (let k = 0; k < b.near.length; k++) {
        const c = b.near[k], ds = b.nds[k];
        if (ds > 0 && ds < 45 && Math.abs(c.loc.d - car.loc.d) < 2.6 && ds < ods) { o = c; ods = ds; }
      }
      if (b.mode === 'tow' && b.target !== o) { b.mode = 'race'; b.target = null; }
      if (o) {
        const yields = yieldsTo(race, o, car);
        const closing = v - o.speed;
        const theirProf = o.brain ? Math.min(o.brain.prof[i], o.speed + 3) : o.speed;
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
          // through the twisty parts: any real run on the car ahead. The longer a driver has
          // been stuck behind, and the braver they are, the smaller the run they will go on
          const st = b.style, urge = st ? st.nerve + Math.min(0.45, (b.stuckBehind || 0) / 25) : 0.55;
          go = ods < 30 && (closing > Math.max(0.35, 1.5 - urge) || (fasterPace && ods < 14));
        }
        // (waved through: no run needed, only road)
        if (yields && !braking) go = true;
        if (go) {
          const pitting = o.brain && o.brain.pit, inside = pitting ? -tr.pit.side : yields && o.brain.yieldSide ? -o.brain.yieldSide : nextCornerSign(tr, i, 260) || (lineOff > 0 ? -1 : 1);
          const after = nextCornerSign(tr, (i + Math.round(260 / tr.ds)) % tr.N, 260);
          const latIn = o.loc.d + inside * SEP, latOut = o.loc.d - inside * SEP;
          const okIn = Math.abs(latIn) < lim && laneFree(b, car, latIn, o, ods + 25);
          const pays = after === -inside || closing > 5 || br.room > 1e8;
          const okOut = !braking && (pays || yields) && (b.aggr > 0.35 || yields) && Math.abs(latOut) < lim && laneFree(b, car, latOut, o, ods + 25);
          b.side = okIn ? inside : okOut ? -inside : 0;
          // set passes up on the approach: never ask for a big sidestep mid-corner
          const midCorner = Math.abs(tr.line.kap[i]) > 1 / 250;
          if (b.side && midCorner && Math.abs((b.side === inside ? latIn : latOut) - car.loc.d) > 2.5) b.side = 0;
          if (b.side) {
            b.mode = 'pass'; b.passT = 0; b.target = o; b.passDs = ods; b.inside = inside; b.flipped = false; b.feint = 0;
            // a dummy: show him one side down a long straight, then go the other way
            if (b.style && straight && okIn && ods > 7 && br.room > 170 && Math.abs(latOut) < lim && laneFree(b, car, latOut, o, ods + 25) && b.rng() < 0.3 * b.style.nerve) { b.side = -inside; b.feint = 0.35 + b.rng() * 0.3; }
          }
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
      const yields = o && yieldsTo(race, o, car);
      let lat = o ? o.loc.d + b.side * SEP : 0;
      const needBrake = v * v / (2 * 38) * (1 - (br.z ? br.z.vOut * br.z.vOut / Math.max(1, v * v) : 1));
      // a run that has died: back in line rather than sitting out of the tow
      const stalled = !yields && b.passT > 2.5 && ds > b.passDs + 2;
      if (b.feint > 0 && (b.feint -= dt) <= 0) {
        const lat2 = o ? o.loc.d - b.side * SEP : 0;
        if (o && Math.abs(lat2) < lim && laneFree(b, car, lat2, o, ds + 25)) { b.side = -b.side; b.flipped = true; lat = lat2; }
      }
      // up the inside into the stop: this is where a driver leaves it late, as far as they dare
      if (b.style && b.side === b.inside && ds < 9) b.brkK = Math.max(b.brkK, U.clamp(b.style.brk * (1 + 0.05 * b.style.nerve), 0.95, 1.08));
      // the door shut on this side (the car ahead moved across to cover it): switch to the
      // other side if that one is open and there is still road before the braking point
      if (o && !b.flipped && ds > 3 && (Math.abs(lat) > lim + 0.3 || !laneFree(b, car, lat, o, Math.max(5, ds + 8))) && br.room > needBrake + 60) {
        const lat2 = o.loc.d - b.side * SEP;
        if (Math.abs(lat2) < lim && laneFree(b, car, lat2, o, ds + 25)) { b.side = -b.side; b.flipped = true; b.passT = Math.min(b.passT, 4); lat = lat2; }
      }
      // into the braking zone: overlapped down the inside the move is on (the car ahead must
      // leave room); otherwise not far enough up to stay there
      // (a car letting us by is slower into the corner as well: alongside, the move is on)
      const late = br.room < needBrake + 15 && ds > (yields ? 6 : b.side === b.inside ? 4.5 : 2.5);
      if (!o || ds < -7 || ds > 45 || b.passT > (yields ? 14 : 9) || Math.abs(lat) > lim + 0.3 || late || stalled || !laneFree(b, car, lat, o, Math.max(5, ds + 8))) {
        if (o && ds > -7) b.coolT = 1.5; // not past: no fresh lunge straight away
        b.mode = 'race'; b.target = null;
      } else if (b.side > 0) lo = Math.max(lo, Math.min(lim, lat));
      else hi = Math.min(hi, Math.max(-lim, lat));
    }
    // Letting a faster car by. A car about to be lapped (blue flags), or one too slow to race (damage,
    // or far off the pace of the car behind), does not fight: on a straight it moves off the line to
    // the side the faster car is not on and lifts once it is alongside, so the pass is done before the
    // next braking zone instead of a queue forming behind it. In the corners it drives its own line.
    // (Not on the way into the pits: that car is moving over anyway.)
    {
      const fb = b.behind;
      let y = null;
      if (fb && b.gapBehind < 70 && sinceStart > 8 && !car.inPit && !b.pit && !fb.inPit && !fb.finished && !car.finished && !(race.sc && race.sc.state !== 'none')) {
        const lapping = fb.dist > car.dist + tr.L * 0.5;
        const slower = fb.isPlayer && !race.autoPlayer
          ? car.bestLap && fb.bestLap && fb.bestLap < car.bestLap * 0.95
          : paceOf(car) < paceOf(fb) * 0.95;
        if (lapping || slower) y = fb;
      }
      if (y !== b.yield) { b.yield = y; b.yieldSide = y ? (Math.abs(y.loc.d - car.loc.d) > 1 ? -Math.sign(y.loc.d - car.loc.d) : -(Math.sign(lineOff) || 1)) : 0; }
      b.yieldLift = false;
      if (y) {
        if (b.mode === 'defend') b.mode = 'race';
        // a much faster car closing in: never drift across into its path (in a corner or out of
        // one, where the line would take this car back over), only away from it
        const yds0 = relS(tr, car, y), cl = y.speed - car.speed;
        if (yds0 > -70 && yds0 < 4 && cl > 6) {
          if (y.loc.d > car.loc.d) hi = Math.min(hi, Math.max(lo, car.loc.d + 0.15)); else lo = Math.max(lo, Math.min(hi, car.loc.d - 0.15));
        }
        let straightNow = true;
        for (let q = 0; straightNow && q * tr.ds < 70; q += 2) if (Math.abs(tr.line.kap[(i + q) % tr.N]) > 1 / 400) straightNow = false;
        if (straightNow && br.room > 40) {
          const yl = b.yieldSide * Math.max(1.2, tr.hw - 2.4);
          // (only into a lane nobody else is using or about to use)
          let free = true;
          for (let k = 0; k < b.near.length && free; k++) { const o = b.near[k]; if (o !== y && b.nds[k] > -30 && b.nds[k] < 20 && Math.abs(o.loc.d - yl) < 3) free = false; }
          if (free) { if (b.yieldSide > 0) lo = Math.max(lo, Math.min(hi, yl - 0.6)); else hi = Math.min(hi, Math.max(lo, yl + 0.6)); }
          // (the lift once it is beside, not while it is still lined up behind)
          b.yieldLift = yds0 > -12 && yds0 < 6 && Math.abs(y.loc.d - car.loc.d) > 1.2;
        }
      }
    }
    // defend: one move to the inside when someone is close before a braking zone
    if (P.mpc !== 1 && b.mode === 'race' && b.behind && !b.yield && b.gapBehind < 16 && b.aggr > 0.3 && sinceStart > 4) {
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
        if (Math.abs(k) > 0.002 && (!b.style || b.rng() < b.style.defP)) { b.mode = 'defend'; b.defSide = Math.sign(k); b.defZone = z; b.defLat = null; }
      }
    }
    // cover: an attacker with a run who pulls out of the tow gets the door shut on the side
    // he picked, once, while he is still behind (moving across a car already alongside is a crash)
    if (P.mpc !== 1 && b.mode === 'race' && b.behind && !b.yield && b.aggr > 0.3 && sinceStart > 4 && br.z && b.defended !== br.z.s0) {
      const a = b.behind, rel = a.loc.d - car.loc.d;
      if (b.gapBehind > car.spec.len + 1.5 && b.gapBehind < 14 && Math.abs(rel) > 1.5 && a.speed > v + 0.5 && br.room > 60 && br.room < 450) {
        b.defended = br.z.s0;
        if (!b.style || b.rng() < b.style.defP) { b.mode = 'defend'; b.defSide = Math.sign(rel); b.defZone = br.z; b.defLat = U.clamp(a.loc.d, -lim, lim); }
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
    // A car stopped or crawling on the road ahead: pick the side with more road and take it, at the
    // distance a car needs to do that at this speed. Nothing else above may veto this: no run is
    // needed to go round a parked car, and waiting behind it is how a whole field stops.
    b.hazard = null;
    {
      const reach = v * v / 40 + 30;
      let hz = null, hzd = 1e9;
      for (let k = 0; k < b.near.length; k++) { const o = b.near[k], ds = b.nds[k]; if (ds > 0 && ds < reach && ds < hzd && (o.speed < 20 || v > o.speed + 18) && v > o.speed + 4 && !o.inPit) { hz = o; hzd = ds; } }
      if (hz) {
        const E = edgeOf(tr), j = hz.loc.i, rR = E.R[j] - hz.loc.d, rL = hz.loc.d + E.L[j], sg = rR >= rL ? 1 : -1, room = Math.max(rR, rL);
        if (room > 2.4) {
          b.hazard = hz;
          if (b.mode === 'tow' || b.mode === 'pass') { b.mode = 'race'; b.target = null; }
          const lat = hz.loc.d + sg * Math.min(room - 0.2, 3);
          if (sg > 0) { lo = Math.max(lo, Math.min(lat, hi)); hi = Math.max(hi, lat); } else { hi = Math.min(hi, Math.max(lat, lo)); lo = Math.min(lo, lat); }
        }
      }
    }
    // looking ahead in traffic (see predict)
    b.mpcK = b.mpcK || 1;
    if (P.mpc && b.style && !b.hazard && sinceStart > 2 && !(b.pit && b.pit.phase === 'approach')) {
      b.mpcT = (b.mpcT == null ? b.rng() * MPC_DT : b.mpcT) - dt;
      if (b.mpcT <= 0) { b.mpcT = MPC_DT * (1 + (1 - b.style.skill) * 0.8); predict(race, car, b, lim, v, P.mpc >= 2 ? U.clamp(edgeOf(tr).clamp(i, lineOff), lo, hi) : null); }
      if (b.mpcL != null) { lo = Math.max(lo, Math.min(hi, b.mpcL - 0.5)); hi = Math.min(hi, Math.max(lo, b.mpcL + 0.5)); }
    } else { b.mpcL = null; b.mpcK = 1; }
    // keep a car's width plus margin to anyone alongside
    b.squeezed = false;
    for (let k = 0; k < b.near.length; k++) {
      const o = b.near[k];
      if (Math.abs(b.nds[k]) > 7.5) continue;
      const dd = o.loc.d - car.loc.d;
      if (Math.abs(dd) > 4.8) continue;
      if (dd > 0) hi = Math.min(hi, o.loc.d - SEP); else lo = Math.max(lo, o.loc.d + SEP);
    }
    // never past the edge of the road here, whoever is alongside: a squeezed car lifts (below)
    // rather than being pushed onto the grass
    { const E = edgeOf(tr); lo = Math.max(lo, -E.L[i]); hi = Math.min(hi, E.R[i]); }
    if (lo > hi) { const m = (lo + hi) / 2; lo = hi = U.clamp(m, -lim, lim); b.squeezed = true; }
    // the lane can only move so fast: no decision may yank the car across the track
    const lrate = 5 * dt;
    b.loS = b.loS == null ? lo : (lo > b.loS ? Math.min(lo, b.loS + lrate) : lo);
    b.hiS = b.hiS == null ? hi : (hi < b.hiS ? Math.max(hi, b.hiS - lrate) : hi);
    lo = b.loS; hi = b.hiS;
    if (lo > hi) { const m = (lo + hi) / 2; lo = hi = m; }
    b.lo = lo; b.hi = hi;
    b.desired = U.clamp(edgeOf(tr).clamp(i, lineOff), lo, hi);
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
    // (a car on its way to the pits too, until its last run to the entry: half the resets at
    // Bahia were cars on an in-lap)
    const toPit = b && b.pit && b.pit.phase === 'approach' && !car.inPit ? Tracks.fwd(tr, car.loc.s, tr.pit.sIn) : -1;
    if (b && (!b.pit || toPit > pitRun(tr) + 40) && Math.abs(car.loc.d) < tr.hw + 1) {
      const e0 = car.loc.d - tr.line.off[i], e = lat - tr.line.off[j];
      const maxShift = 0.4 + 5 * look / Math.max(8, v);
      lat = tr.line.off[j] + U.clamp(e, e0 - maxShift, e0 + maxShift);
    }
    // back onto the road from the grass at a shallow angle, not straight for the line: on the
    // low grip out there a sharp turn back is a spin into the traffic
    if (b && !car.inPit && Math.abs(car.loc.d) >= tr.hw + 1) lat = car.loc.d + U.clamp(lat - car.loc.d, -REJOIN * look, REJOIN * look);
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
    if (aReq > P.brkOn * (b ? b.brkK * (b.gapAhead < 40 ? P.trafBrk : 1) : 1) * aCap) brk = U.clamp(aReq / (P.brkFull * aCap), 0, 1);
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
    // wheelspin: a bad launch, or a boot full of throttle on the way out of a corner
    if (b && b.thrCutT > 0) { b.thrCutT -= dt; thr *= 0.55; }
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
    // A car at rest or facing backwards on its way in or out, spun by a touch on the entry road say.
    // drive() never runs for it, so without this it sits there for good and the field, which queues
    // behind a stopped car rather than call itself stuck, sits behind it and the race never ends.
    if (p.phase === 'stop') b.stuckT = 0;
    else {
      const wrongWay = Math.abs(U.wrapAngle(car.h - Math.atan2(tr.ty[car.loc.i], tr.tx[car.loc.i]))) > 1.9;
      b.stuckT = car.speed < 1.5 || wrongWay ? b.stuckT + dt : Math.max(0, b.stuckT - dt);
      if (b.stuckT > (inLimit ? 8 : 3)) { race.recover(car); b.stuckT = 0; return; }
    }
    let vt;
    if (p.phase === 'in') {
      vt = toLimit < 400 && !inLimit ? Math.sqrt(pit.limit ** 2 + 2 * 9 * toLimit) : pit.limit;
      if (!inLimit && toLimit > 400) vt = profAt(b, tr, s);
      if (!inLimit) vt = Math.min(vt, pitLaneV(tr)[car.loc.i]);
      car.limiter = inLimit;
      const toBox = Tracks.fwd(tr, s, box);
      for (const o of race.cars) {
        if (o === car || !o.inPit) continue;
        const ds = relS(tr, car, o);
        if (ds > 0 && ds < 25 && Math.abs(o.loc.d - car.loc.d) < 3.2) { vt = Math.min(vt, o.speed + Math.max(0, ds - 7) * 1.2); if (o.speed < 1) b.stuckT = 0; }
      }
      if (toBox < 60 && !p.served) {
        vt = Math.min(vt, Math.sqrt(2 * 4.5 * Math.max(0, toBox - 0.5)));
        control(race, car, toBox < 20 ? workLat : laneLat, vt, dt);
        if (toBox < 1.6 || (toBox > tr.L - 3)) {
          p.phase = 'stop'; p.serviceT = p.service;
          car.vx = car.vy = 0; car.r = 0;
        }
        return;
      }
      control(race, car, laneLat, vt, dt);
      // (past the end of the limit, served or not: 'in' has no braking plan and cannot drive a lap)
      if (!inLimit && Tracks.fwd(tr, pit.limitOut, s) < 300) p.phase = 'out';
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

  function wetPlan(race, car, b) {
    if (race.profFor && car.profPace) {
      const gk = car.grip == null ? 1 : car.grip / 0.972;
      const want = car.wetness > 0.05 ? U.clamp(Math.round(gk * (1 - (1 - P.wetK) * Math.min(1, car.wetness * 1.5)) / 0.04) * 0.04, 0.2, 1) : 1;
      if (want !== (b.profK || 1)) { b.profK = want; b.prof = race.profFor(car.team, car.profPace, want); }
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
    if (b.style) {
      const st = b.style;
      if (!b.launched) { b.launched = true; if (b.rng() < st.err * 4) b.thrCutT = 0.7 + b.rng() * 0.8; }
      // how the driver is going today: a new rhythm each lap. Time behind a car is what makes them
      // try something
      b.stuckBehind = b.gapAhead < 30 ? (b.stuckBehind || 0) + dt : Math.max(0, (b.stuckBehind || 0) - dt * 3);
      if (st.formLap !== car.lap) { st.formLap = car.lap; const g = b.rng() + b.rng() + b.rng() - 1.5; st.form = 1 + g * st.rhythm; }
      if (b.cutS != null && Tracks.fwd(tr, b.cutS, car.loc.s) < 30) { b.cutS = null; b.thrCutT = 0.5 + b.rng() * 0.5; }
    }
    // Conditions: on a wet track the speed plan is remade for
    // the grip the tyres have now, in steps of 4 per cent, so the braking points move back and
    // the corner speeds come down as the physics has them (with downforce, a wet corner is
    // slower than the square root of the grip lost). The dry plan comes back as it dries.
    wetPlan(race, car, b);
    // per-lap braking noise: small variations so AI lap times are not identical
    b.noiseT -= dt;
    if (b.noiseT <= 0) { b.noiseT = 2 + b.rng() * 3; b.noise = 1 + (b.rng() - 0.5) * 0.012 * (1.4 - b.aggr); }
    if (P.live && race.green) readGrip(car, b, tr, i);
    const leadIdx = (i + Math.round((v * P.leadT + 2) / tr.ds)) % tr.N;
    let vt = b.prof[leadIdx] * b.noise * gripAt(b, tr, leadIdx);
    if (b.style) { const st = b.style, slow = U.clamp((70 - vt) / 40, 0, 1); if (tr.brk[leadIdx] || Math.abs(tr.line.kap[leadIdx]) > 1 / 500) vt *= st.form * (st.slow * slow + st.fast * (1 - slow)); }
    // off-line penalty in corners, and a slower car with a damaged front wing
    const kl = Math.abs(tr.line.kap[leadIdx]);
    const cornerK = Math.min(1, kl * 60);
    const dev = Math.max(Math.abs(b.bias), Math.abs(car.loc.d - tr.line.off[leadIdx]));
    vt *= 1 - Math.min(0.22, dev * cornerK * 0.035);
    if (car.dm) { if (tr.brk[leadIdx] || kl > 1 / 500) vt *= car.dm.paceK; }
    else vt *= 1 - car.wingDmg * 0.3 * Math.max(cornerK, tr.brk[leadIdx] ? 0.8 : 0);
    // racing in traffic: nobody drives qualifying limits with a car inches away
    if (((b.ahead && b.gapAhead < 40) || b.alongside) && (tr.brk[leadIdx] || kl > 1 / 500)) vt *= P.trafK;
    // the first lap is all elbows: everyone leaves a little more
    const lap1 = b.style && race.time - race.startTime < P.lap1T;
    if (b.mpcK < 1 && (P.mpc === 3 || tr.brk[leadIdx] || kl > 1 / 500)) vt *= b.mpcK;
    if (b.mpcL != null && kl > 1 / 300) vt *= 1 - 0.01 * Math.min(4, Math.abs(car.loc.d - tr.line.off[leadIdx])); // less grip off the line
    if (lap1 && (tr.brk[leadIdx] || kl > 1 / 500)) vt *= P.lap1K;
    // in too hot, this one corner
    if (b.hot) { if (Tracks.fwd(tr, b.hotS, car.loc.s) < 40) b.hot = 0; else vt *= b.hot; }
    // fuel load: a heavier car brakes later and corners slower than the reference
    // (limits are learned at 20 kg); the AI adjusts its marks as the fuel burns off
    const mass = car.spec.mass + car.fuel;
    if (mass > 822 && (tr.brk[leadIdx] || kl > 1 / 500)) vt *= Math.pow(820 / mass, 0.45);
    // worn tyres past the cliff: nurse them, there is far less grip than the numbers say
    {
      const wr = Math.max(car.wheels[0].wear, car.wheels[1].wear, car.wheels[2].wear, car.wheels[3].wear);
      if (wr > 0.5 && (tr.brk[leadIdx] || kl > 1 / 500)) vt *= 1 - Math.min(0.15, (wr - 0.5) * 0.3);
    }
    // overheated rears: the car gets loose on the exits, so a driver eases off until they cool
    // (a rear 50 degrees over its window has a fifth less grip, and the plan knows nothing of it;
    // at Legend pace in a simulation race this was a field spinning at the same exit on lap 4).
    // Only where it bites: corners it brakes for, and curves the plan takes near the grip limit.
    // Soft rears run this hot all race, and easing in every curve cost the AI throttle through
    // flat-out kinks, where the tyres have grip to spare. (The rear lets go with no warning in
    // the tyre itself, so this has to come from the plan: easing on rear slip came too late.)
    {
      const over = Math.max(car.wheels[2].temp, car.wheels[3].temp) - car.compound.topt;
      b.hotRear = over > 15 ? Math.min(1, (over - 15) / 25) : 0;
      if (b.hotRear && (tr.brk[leadIdx] || (kl > 1 / 500 && loadAt(b.prof, leadIdx) > HOT_LOAD))) vt *= 1 - 0.06 * b.hotRear;
    }
    // tyre saving: a slightly earlier lift and gentler corner speed when told to manage
    if (b.manage && b.manage < 1 && (tr.brk[leadIdx] || kl > 1 / 500)) vt *= b.manage;
    // drive to the conditions: tyre temperature / wear and dirty air cost grip (beyond what the
    // plan already allows for, see above)
    if (tr.brk[leadIdx] || kl > 1 / 500) {
      const gf = (car.grip == null ? 0.972 : car.grip) / 0.972 / (b.profK || 1) * (1 - (1 - car.dfMul) * P.dirtyK);
      // (the plan was coached on mediums: softer tyres in good shape have a little more in them)
      vt *= Math.sqrt(Math.min(gf, 1.03));
      if (car.wetness > 0.05) vt *= 1 - P.wetMargin * Math.min(1, car.wetness * 1.2); // a careful margin on a slippery road
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
        // (the bigger the closing speed the sooner it counts, and the wider: a slow car may be crossing)
        const cl = Math.max(0, v - o.speed), side = 2.35 + Math.min(1.8, cl * 0.05);
        if (ds <= 0 || ds > (o.speed < 20 ? 280 : Math.max(80, cl * cl / 18 + 40))) continue;
        if (o === b.hazard && Math.abs(o.loc.d - car.loc.d) > 2.4) continue; // round it already
        // where our own line takes us by the time we get there: a car beside our lane
        // now is in it if the line swings across before we reach it
        const there = ds < 40 ? U.clamp(tr.line.off[o.loc.i], b.lo == null ? -tr.hw : b.lo, b.hi == null ? tr.hw : b.hi) : planLat;
        if ((Math.abs(o.loc.d - myLat) < side || Math.abs(o.loc.d - planLat) < side || Math.abs(o.loc.d - there) < side) && ds < bds) { blk = o; bds = ds; }
      }
      if (blk) {
        const gap = bds - car.spec.len;
        // more room into a braking zone: dirty air costs braking grip and the car ahead may brake early
        const nearBrake = tr.brk[i] || tr.brk[(i + Math.round(60 / tr.ds)) % tr.N];
        // (sitting in a tow on a straight, a driver closes right up to the gearbox)
        // (with no run to try, a driver hangs back a little and saves his tyres)
        const wait = b.style && v - blk.speed < 0.5 ? 2.5 * (1 - Math.min(1, b.style.nerve)) : 0;
        const want = (b.mode === 'tow' && blk === b.target && !nearBrake ? 1.2 + 0.03 * v : 1.5 + P.gapV * v + wait + (nearBrake ? P.gapBrk * v : 0)) * (lap1 ? P.lap1Gap : 1);
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
      car.pitPlan = { compound: race.mandatory && new Set(car.tyreHist).size < 2 && !car.compound.wet ? (car.compound.id === 'S' ? 'M' : 'S') : car.compound.id };
    }
    // pit approach: get over to the pit side before the entry
    const lo = b.lo == null ? -tr.hw : b.lo, hi = b.hi == null ? tr.hw : b.hi;
    const LL = edgeOf(tr);
    // (each lap the driver's own line turns a little toward another shape)
    if (b.style) {
      const st = b.style;
      if (!st.a) styleLine(tr, b);
      if (st.lap !== car.lap) { st.lap = car.lap; const ph = b.rng() * 6.283; st.c = Math.cos(ph); st.s = Math.sin(ph); }
    }
    // off the line by choice: his own line, or close behind a car a little to the inside, out of
    // the worst of the dirty air and showing a nose; and off it by mistake, a missed apex
    const dodge = b.style && b.closeFollow ? 0.6 * (nextCornerSign(tr, i, 150) || 0) : 0;
    let miss = 0;
    if (b.wideA != null) { const w = Tracks.fwd(tr, b.wideA, car.loc.s); if (w < 110) miss = b.wide * Math.sin(Math.PI * w / 110); else if (w < tr.L - 220) b.wideA = null; }
    let latFn = b.style ? j => U.clamp(LL.clamp(j, tr.line.off[j] + (dodge ? dodge * tr.styleEnv[j] : styleAt(b, j)) + miss), lo, hi) : j => U.clamp(LL.clamp(j, tr.line.off[j]), lo, hi);
    if (b.pit && b.pit.phase === 'approach') {
      const d = Tracks.fwd(tr, car.loc.s, tr.pit.sIn);
      const past = Tracks.fwd(tr, tr.pit.sIn, car.loc.s), near = past < pitOpen(tr);
      // across to the pit side over the straight before the entry, eased (pitW, as pitLaneV plans it)
      if (d < pitRun(tr) || near) {
        const base = latFn;
        latFn = j => { const w = pitW(tr, j), pt = pitTarget(tr, j); if (w >= 1) return pt; const o = base(j); return o + (pt - o) * w; };
      }
      // slow enough for the lane's curve and to get across to it (pitLaneV; the brake look-ahead
      // below reads it too)
      if (d < 500 || near) vt = Math.min(vt, pitLaneV(tr)[i]);
      if (!isNaN(tr.pit.off[i]) && Tracks.fwd(tr, tr.pit.sIn, car.loc.s) < 150 && Math.abs(car.loc.d - tr.pit.off[i]) < tr.pit.lane / 2 + 1 && canJoinLane(tr, car)) {
        b.pit.phase = 'in'; car.inPit = true; b.mode = 'race';
      }
    }
    // recovering from an off: slow down until we are back on the asphalt, braking gently (on the
    // grass a full stop, wheels locked, with the car turning back, spun it)
    if (Math.abs(car.loc.d) > tr.hw + 1.2 && !car.inPit) vt = Math.min(vt, Math.max(30, car.u - 5));
    // look down the road for the hardest braking this approach needs (same modifiers
    // as the target speed: pace noise, line offset, damage, tyre condition)
    {
      // (a damaged car brakes for the corner it can take now, not for the one it had before)
      const dmK = car.dm && !(tr.brk[leadIdx] || kl > 1 / 500) ? car.dm.paceK : 1;
      const scale = vt / Math.max(1, b.prof[leadIdx]) * dmK;
      const horizon = v * v / (car.wetness > 0.02 ? 24 * Math.min(1, (car.grip == null ? 0.972 : car.grip) / 0.972) : 24) + 15;
      let aReq = 0;
      const lat = car.loc.d, pitV = b.pit && b.pit.phase === 'approach' && !car.inPit ? pitLaneV(tr) : null;
      let offRun = 0;
      for (let d = 4; d < horizon; d += 4) {
        const j = (i + Math.round(d / tr.ds)) % tr.N;
        let vj = b.prof[j] * Math.min(scale, b.hot ? b.hot : 1.02) * (gripAt(b, tr, j) / Math.max(0.5, gripAt(b, tr, leadIdx)));
        if (pitV) vj = Math.min(vj, pitV[j]);
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
    // waving a faster car through: easing off the throttle while it goes by (a lift, never the brakes,
    // so nobody behind is caught out)
    if (b.yieldLift) car.ctl.throttle = 0;
    // (and with hot rears, a gentler foot on the way out of a corner)
    if (b.hotRear > 0 && Math.abs(tr.line.kap[car.loc.i]) > 1 / 600 && loadAt(b.prof, car.loc.i) > HOT_LOAD) car.ctl.throttle = Math.min(car.ctl.throttle, 1 - 0.6 * b.hotRear);
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
    // (a car waiting in a queue, behind another that is stopped or crawling, is not stuck)
    const queued = car.speed < 2.5 && !wrongWay && !lost && b.ahead && b.gapAhead < 22 && b.ahead.speed < 5;
    if ((car.speed < 2.5 || wrongWay || lost) && !car.finished && !queued) b.stuckT += dt; else b.stuckT = Math.max(0, b.stuckT - dt);
    // a car stopped on the racing line is a hazard: clear it quickly
    const onLine = Math.abs(car.loc.d) < tr.hw;
    if (b.stuckT > (car.speed < 1.5 && onLine ? 1.2 : 3) && !b.helpOnly) { race.recover(car); b.stuckT = 0; }
  }

  F1.AI = { P, makeBrain, drive, pitDrive, sense, relS, upcomingZone, wetPlan, pitOpen, edgeOf, pitLaneV, canJoinLane };
})(typeof window !== 'undefined' ? window : globalThis);
