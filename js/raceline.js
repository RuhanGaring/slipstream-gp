// Racing line and speed profile.
// The line is a minimum-curvature path found by relaxing lateral offsets inside the
// track width (wheels allowed onto the kerbs). The speed profile is the classic
// quasi-steady-state lap: corner speed from grip plus downforce, then forward
// (traction / power) and backward (braking) passes around the loop.
(function simModule(G) {
  'use strict';
  (G.F1simMods = G.F1simMods || []).push(simModule); // the learning workers rebuild the sim from these
  const F1 = G.F1;
  const U = F1.U;
  const Car = F1.Car;
  const SURF = F1.SURF;

  function computeLine(tr) {
    const N = tr.N;
    const lim = tr.hw - 0.55; // car centre limit: outer wheels just onto the kerb
    const off = new Float64Array(N);
    const px = new Float64Array(N), py = new Float64Array(N);
    const strides = [24, 12, 6, 3, 2, 1];
    for (const h of strides) {
      const iters = h > 3 ? 120 : 220;
      for (let it = 0; it < iters; it++) {
        for (let i = 0; i < N; i++) { px[i] = tr.x[i] + tr.nx[i] * off[i]; py[i] = tr.y[i] + tr.ny[i] * off[i]; }
        for (let i = 0; i < N; i++) {
          const a = (i - h + N) % N, b = (i + h) % N;
          const mx = (px[a] + px[b]) / 2, my = (py[a] + py[b]) / 2;
          const o = (mx - tr.x[i]) * tr.nx[i] + (my - tr.y[i]) * tr.ny[i];
          off[i] = U.clamp(off[i] + (o - off[i]) * 0.9, -lim, lim);
          px[i] = tr.x[i] + tr.nx[i] * off[i]; py[i] = tr.y[i] + tr.ny[i] * off[i];
        }
      }
    }
    // gentle smoothing so the line has no kinks where the clamp bites
    for (let pass = 0; pass < 3; pass++) {
      const o2 = new Float64Array(N);
      for (let i = 0; i < N; i++) o2[i] = (off[(i - 1 + N) % N] + 2 * off[i] + off[(i + 1) % N]) / 4;
      for (let i = 0; i < N; i++) off[i] = U.clamp(o2[i], -lim, lim);
    }
    return lineFromOffsets(tr, off);
  }

  // Where the car centre may go on each side. Where there is a kerb the line may put two
  // wheels right over it, as F1 drivers do through chicanes and at apexes: the car centre
  // up to 0.45 m past the white line leaves the other two wheels inside it (the car is off
  // the track only with all four out), the outer pair still on the kerb. That much only in
  // slow corners and chicanes (the tightest radius within 40 m under 40 m); by a 90 m radius
  // it is back to the outer wheels on the kerb, since a faster car drifts over half a metre
  // wide of its line on the exit. (The radius, not a speed: it is known before any line is.)
  // Whether a kerb pays is the optimiser's call: kerbGrip() below charges for it.
  // Elsewhere all four wheels stay on the asphalt, as on a real lap: the kerbs are for the
  // corners only.
  function lineLimits(tr) {
    const N = tr.N, L = new Float64Array(N), R = new Float64Array(N);
    const over0 = Math.max(-0.05, Math.min(0.45, tr.kerbW - 1.15));
    const W = Math.max(1, Math.round(40 / tr.ds)), kmax = new Float64Array(N);
    for (let i = 0; i < N; i++) { let k = 0; for (let q = -W; q <= W; q++) k = Math.max(k, Math.abs(tr.kap[(i + q + N) % N])); kmax[i] = k; }
    // a kerb counts only where it runs under the whole car (2.5 m either way), so the line
    // does not hang a wheel off its end into the grass
    const C = Math.max(1, Math.round(2.5 / tr.ds));
    const under = (K, i) => { for (let q = -C; q <= C; q++) if (!K[(i + q + N) % N]) return false; return true; };
    for (let i = 0; i < N; i++) {
      const slow = U.clamp((90 - 1 / Math.max(1e-6, kmax[i])) / 50, 0, 1);
      const over = -0.05 + (over0 + 0.05) * slow;
      // (off the kerbs the wheels stay on the asphalt: next to grass or gravel the car centre
      // keeps 1.2 m in from the edge, so the outer tyre stays inside it even running a little
      // wide; next to paved run-off or a street wall the old 0.55 m)
      const soft = side => { const t = tr.runT && tr.runT[side] ? tr.runT[side][i] : SURF.GRASS; return t === SURF.GRASS || t === SURF.GRAVEL; };
      L[i] = under(tr.kerbL, i) ? tr.hw + over : tr.hw - (soft(0) ? 1.2 : 0.55);
      R[i] = under(tr.kerbR, i) ? tr.hw + over : tr.hw - (soft(1) ? 1.2 : 0.55);
    }
    return { L, R, clamp: (i, o) => (o < -L[i] ? -L[i] : o > R[i] ? R[i] : o) };
  }

  // Grip left with the car centre at offset o: the wheels on a kerb have less grip
  // (painted concrete, a tenth less) and the ridges unsettle the car, more so on the tall
  // kerbs of slow corners. The loss counts by the share of the load those wheels carry:
  // over an apex kerb they are the light inside pair, over an exit kerb the loaded outer
  // pair. kap is the line's curvature there (positive: a right-hander, inside on the right).
  // Used by the line optimiser so kerbs are only taken where they save time.
  const HALF_TRACK = 0.8;
  function kerbGrip(tr, i, o, kap) {
    const a = Math.abs(o), kb = o > 0 ? tr.kerbR[i] : tr.kerbL[i];
    if (!kb) return 1;
    const fo = U.clamp((a + HALF_TRACK - tr.hw) / 0.35, 0, 1), fi = U.clamp((a - HALF_TRACK - tr.hw) / 0.35, 0, 1);
    const h = tr.kerbH ? tr.kerbH[i] / 0.035 : 1;
    const inside = kap != null && Math.abs(kap) > 1 / 1500 && Math.sign(kap) === Math.sign(o);
    const share = kap == null || Math.abs(kap) <= 1 / 1500 ? 0.5 : inside ? 0.35 : 0.65;
    const loss = 0.1 + 0.06 * h;
    return 1 - loss * (share * fo + (1 - share) * fi);
  }

  // Corners of the circuit from centreline curvature: start, end, peak, direction,
  // turn angle, and the straight that follows (which decides how late to apex).
  function cornersOf(tr) {
    const N = tr.N, ds = tr.ds;
    const k = new Float64Array(N);
    for (let i = 0; i < N; i++) { let a = 0; for (let q = -5; q <= 5; q++) a += tr.kap[(i + q + N) % N]; k[i] = a / 11; }
    const TH = 1 / 450;
    let st = 0;
    while (Math.abs(k[st]) > TH && st < N - 1) st++;
    const out = [];
    let cur = null;
    for (let q = 0; q < N; q++) {
      const i = (st + q) % N;
      if (Math.abs(k[i]) <= TH) continue;
      const sg = Math.sign(k[i]);
      if (cur && cur.sg === sg && (q - cur.endQ) * ds < 30) cur.endQ = q;
      else { if (cur) out.push(cur); cur = { sg, startQ: q, endQ: q, peakQ: q, peakK: 0, angle: 0 }; }
      if (Math.abs(k[i]) > cur.peakK) { cur.peakK = Math.abs(k[i]); cur.peakQ = q; }
      cur.angle += k[i] * ds;
    }
    if (cur) out.push(cur);
    for (let n = 0; n < out.length; n++) {
      const c = out[n], nx = out[(n + 1) % out.length];
      let gap = nx.startQ - c.endQ;
      if (gap <= 0) gap += N;
      c.straightAfter = gap * ds;
      c.len = (c.endQ - c.startQ) * ds;
      c.start = (st + c.startQ) % N; c.end = (st + c.endQ) % N; c.peak = (st + c.peakQ) % N;
      c.q0 = c.startQ; c.q1 = c.endQ; c.st = st;
    }
    return out;
  }

  // A line built the way a driver lays out a corner: turn in from the outside, clip a
  // late apex on the inside kerb, let the car run out to the exit kerb. The apex moves
  // later the longer the straight that follows (exit speed is worth more there), and
  // linked corners (esses, chicanes, double apexes) drop the outside points between
  // them so the car runs apex to apex. tools/optline.js then refines it for lap time.
  function techniqueLine(tr) {
    const N = tr.N, ds = tr.ds, lim = lineLimits(tr);
    const cs = cornersOf(tr);
    const keys = []; // {q, off, kind, c}
    for (const c of cs) {
      const deg = Math.abs(c.angle) * 180 / Math.PI;
      if (deg < 12) continue; // a kink: flat and straight through
      const late = c.straightAfter > 450 ? 0.3 : c.straightAfter > 250 ? 0.2 : c.straightAfter > 120 ? 0.1 : 0.0;
      const f = Math.min(0.85, (deg > 120 ? 0.6 : 0.5) + late);
      const apexQ = Math.round(c.startQ + (c.endQ - c.startQ) * f);
      const entry = Math.min(120, 12 + c.len * 0.35 + deg * 0.25) / ds;
      const exit = Math.min(180, 20 + c.len * 0.5 + deg * 0.35 + late * 120) / ds;
      const iA = (c.st + apexQ) % N;
      keys.push({ q: c.startQ - entry, side: -c.sg, kind: 'in', c });
      keys.push({ q: apexQ, side: c.sg, kind: 'apex', c, i: iA });
      keys.push({ q: c.endQ + exit, side: -c.sg, kind: 'out', c });
    }
    keys.sort((a, b) => a.q - b.q);
    // linked corners: an outside point that falls inside the neighbouring corner's run is dropped
    const keep = keys.filter((k, n) => {
      if (k.kind === 'apex') return true;
      const prevA = keys.slice(0, n).reverse().find(x => x.kind === 'apex');
      const nextA = keys.slice(n + 1).find(x => x.kind === 'apex');
      if (k.kind === 'out' && nextA && nextA.c !== k.c && nextA.q - k.q < 25 / ds) return false;
      if (k.kind === 'in' && prevA && prevA.c !== k.c && k.q - prevA.q < 25 / ds) return false;
      // outside point overtaken by the next corner's turn-in
      if (k.kind === 'out') { const nIn = keys.slice(n + 1).find(x => x.kind === 'in' && x.c !== k.c); if (nIn && nIn.q < k.q) return false; }
      return true;
    });
    const st = cs.length ? cs[0].st : 0;
    const pts = keep.map(k => {
      const i = ((st + Math.round(k.q)) % N + N) % N;
      const o = k.side > 0 ? lim.R[i] : -lim.L[i];
      return { i, o };
    }).sort((a, b) => a.i - b.i);
    const off = new Float64Array(N);
    if (pts.length < 2) return computeLine(tr).off;
    for (let n = 0; n < pts.length; n++) {
      const a = pts[n], b = pts[(n + 1) % pts.length];
      let span = b.i - a.i; if (span <= 0) span += N;
      for (let q = 0; q <= span; q++) {
        const t = q / span, w = 0.5 - 0.5 * Math.cos(Math.PI * t);
        const i = (a.i + q) % N;
        off[i] = lim.clamp(i, a.o + (b.o - a.o) * w);
      }
    }
    for (let pass = 0; pass < 4; pass++) {
      const o2 = new Float64Array(N);
      for (let i = 0; i < N; i++) o2[i] = (off[(i - 2 + N) % N] + 2 * off[(i - 1 + N) % N] + 3 * off[i] + 2 * off[(i + 1) % N] + off[(i + 2) % N]) / 9;
      for (let i = 0; i < N; i++) off[i] = lim.clamp(i, o2[i]);
    }
    return off;
  }

  // The driver's reference points for each corner on a given line and speed plan:
  // where braking starts, where the car turns in, where it clips the apex (closest to
  // the inside edge) and where it runs out to the exit (closest to the outside edge).
  function cornerMarks(tr, line, prof) {
    const N = tr.N, ds = tr.ds, out = [];
    for (const c of cornersOf(tr)) {
      const deg = Math.abs(c.angle) * 180 / Math.PI;
      if (deg < 12) continue;
      const sg = c.sg, w = i => (i % N + N) % N;
      // apex: deepest point toward the inside around the corner
      let apex = c.peak, best = -1e9;
      for (let q = -Math.round(c.len / ds) - 10; q <= Math.round(c.len / ds) + 10; q++) {
        const i = w(c.peak + q), v = line.off[i] * sg;
        if (v > best + 0.02) { best = v; apex = i; }
      }
      // turn-in: last point before the apex still out toward the outside edge
      // turn-in / track-out: the point nearest the apex where the car is (within 0.4 m)
      // as far out as it gets on that side of the corner
      const edge = (dir, range) => {
        let ext = 1e9;
        for (let q = 1; q < Math.round(range / ds); q++) ext = Math.min(ext, line.off[w(apex + dir * q)] * sg);
        for (let q = 1; q < Math.round(range / ds); q++) { const i = w(apex + dir * q); if (line.off[i] * sg <= ext + 0.4) return i; }
        return apex;
      };
      const turnIn = edge(-1, 160), exit = edge(1, 220);
      // braking point: where the speed plan starts falling toward this corner
      let minV = 1e9, minI = apex;
      for (let q = -Math.round(60 / ds); q <= Math.round(30 / ds); q++) { const i = w(apex + q); if (prof[i] < minV) { minV = prof[i]; minI = i; } }
      // walk back up the braking curve to its top (small ripples in the plan are ignored)
      let brake = -1, top = minV, topI = minI;
      for (let q = 1; q < Math.round(450 / ds); q++) {
        const i = w(minI - q), v = prof[i];
        if (v > top + 0.01) { top = v; topI = i; }
        else if (v < top - 2) break; // past the top: that is the previous corner
      }
      if (top - minV > 6) brake = topI;
      const prev = out[out.length - 1];
      if (prev && Math.abs(prev.apex - apex) < 12) continue; // one corner seen twice
      out.push({ brake, turnIn, apex, exit, side: sg, minV, minI, deg });
    }
    out.sort((a, b) => a.apex - b.apex);
    // a braking point belongs to the first corner it feeds, and comes before its turn-in
    const fwdI = (a, b) => ((b - a) % N + N) % N;
    const used = new Set();
    for (const m of out) {
      if (m.brake < 0) continue;
      if (fwdI(m.brake, m.turnIn) > fwdI(m.brake, m.apex) || used.has(m.brake)) { m.brake = -1; continue; }
      used.add(m.brake);
    }
    return out;
  }

  // Geometry of a line given its lateral offsets: points, segment lengths, curvature.
  function lineFromOffsets(tr, off) {
    const N = tr.N;
    const px = new Float64Array(N), py = new Float64Array(N);
    for (let i = 0; i < N; i++) { px[i] = tr.x[i] + tr.nx[i] * off[i]; py[i] = tr.y[i] + tr.ny[i] * off[i]; }
    const dsl = new Float64Array(N), kap = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const b = (i + 1) % N;
      dsl[i] = Math.hypot(px[b] - px[i], py[b] - py[i]);
    }
    for (let i = 0; i < N; i++) {
      const a = (i - 2 + N) % N, b = (i + 2) % N;
      const h1 = Math.atan2(py[i] - py[a], px[i] - px[a]);
      const h2 = Math.atan2(py[b] - py[i], px[b] - px[i]);
      const l = Math.hypot(px[i] - px[a], py[i] - py[a]) + Math.hypot(px[b] - px[i], py[b] - py[i]);
      kap[i] = U.wrapAngle(h2 - h1) / (l / 2);
    }
    return { off, px, py, dsl, kap };
  }

  // Straight-line acceleration capability (m/s^2) as a function of speed, from the
  // same engine, gearing and traction numbers the physics uses.
  function accelTable(spec, mu, vmax = 110) {
    const tab = [];
    const m = spec.mass + 20;
    for (let v = 0; v <= vmax; v += 1) {
      let best = 0;
      for (let g = 1; g <= spec.gears.length; g++) {
        const rpm = Math.max(v / spec.R * spec.gears[g - 1] * 60 / (2 * Math.PI), g === 1 ? 9000 : 0);
        if (rpm > spec.rpmLimit) continue;
        const P = spec.power * Car.powerFrac(rpm, spec);
        const F = P / (rpm * 2 * Math.PI / 60) * spec.gears[g - 1] * 0.92 / spec.R;
        best = Math.max(best, F);
      }
      const q = 0.5 * Car.RHO * v * v;
      const down = spec.ClA * q;
      const rearLoad = m * Car.GRAV * spec.cgFront + down * (1 - spec.aeroBal) + m * 0.4 * Car.GRAV * spec.cgH / spec.wb;
      best = Math.min(best, rearLoad * mu * 0.95);
      const drag = spec.CdA * q;
      tab.push((best - drag - 0.012 * m * Car.GRAV) / m);
    }
    return tab;
  }

  // How much of the modelled acceleration the car really finds flat out, by speed (every
  // 4 m/s from 0): measured from the AI's own laps by tools/accelcal.js. The model above has
  // no shift losses, deployment limits or tyre slip, and at 300 km/h finds about four times
  // the push the car has. Used when timing a lap to compare lines (opt.real), so the search
  // values a fast exit for what it is really worth; the AI's own speed targets keep the plain
  // model, so it never lifts on a straight where the car (with a tow, DRS) could go faster.
  const ACC_CAL = [0.95, 0.95, 0.95, 0.95, 0.95, 0.955, 0.899, 0.854, 0.778, 0.662, 0.572, 0.593, 0.574, 0.563, 0.532, 0.515, 0.496, 0.466, 0.437, 0.399, 0.337, 0.273, 0.187, 0.1, 0, 0, 0];
  const accCal = v => { const f = U.clamp((v - 2) / 4, 0, ACC_CAL.length - 1), k = Math.floor(f), t = f - k; return ACC_CAL[k] + ((ACC_CAL[k + 1] == null ? ACC_CAL[k] : ACC_CAL[k + 1]) - ACC_CAL[k]) * t; };

  // Speed profile along the racing line. pace scales the grip used (0.85..1.0).
  // Grip model fitted to the physics on a skidpad (tools/calib.js): load
  // sensitivity makes downforce worth less than its raw newtons.
  const MU_G = 0.873, MU_A = 0.788; // fitted to tools/calib.js on the current physics
  function speedProfile(tr, line, spec, opt = {}) {
    const N = tr.N;
    const pace = opt.pace || 0.96;
    const mu = spec.mu * MU_G * pace;
    // per-sample grip the AI has learned it can actually use (tools/learn.js)
    const g = opt.grip;
    const muAt = i => (g ? mu * g[i] : mu);
    const m = spec.mass + 20;
    const kA = 0.5 * Car.RHO * spec.ClA / m * (MU_A / MU_G);
    const acc = accelTable(spec, mu);
    const vtop = 105;
    const v = new Float64Array(N);
    // the road in 3D: crests take load off the tyres (v^2 times the vertical curvature),
    // compressions add it, banking into a corner helps, and grades help or hurt
    const ddz = i => (tr.ddz ? U.clamp(tr.ddz[i], -0.004, 0.004) : 0);
    const grade = i => (tr.dz ? tr.dz[i] : 0);
    const bankHelp = i => (tr.bank ? -tr.bank[i] * Math.sign(line.kap[i]) : 0);
    const gN = (i, vv) => Math.max(0.35 * Car.GRAV, Car.GRAV + vv * vv * ddz(i));
    for (let i = 0; i < N; i++) {
      const k = Math.abs(line.kap[i]);
      const mi = muAt(i);
      const den = k - mi * kA - mi * ddz(i);
      v[i] = den <= 1e-6 ? vtop : Math.min(vtop, Math.sqrt(Car.GRAV * (mi + bankHelp(i)) / den));
    }
    const brakeEff = opt.brake || 0.92;
    for (let loop = 0; loop < 3; loop++) {
      // forward: acceleration
      for (let k = 0; k < N; k++) {
        const i = k, j = (k + 1) % N;
        const vi = v[i];
        const aGrip = muAt(i) * (gN(i, vi) + kA * vi * vi);
        const aLat = vi * vi * Math.abs(line.kap[i]);
        const left = Math.sqrt(Math.max(0, aGrip * aGrip - aLat * aLat));
        const a0 = acc[Math.min(acc.length - 1, Math.round(vi))];
        const aP = (opt.real ? Math.max(0, a0) * accCal(vi) : a0) - Car.GRAV * grade(i);
        const a = Math.max(opt.real ? 0 : 0.5, Math.min(aP, left));
        const vn = Math.sqrt(Math.max(0, vi * vi + 2 * a * line.dsl[i]));
        if (vn < v[j]) v[j] = vn;
      }
      // backward: braking
      for (let k = N - 1; k >= 0; k--) {
        const i = k, j = (k + 1) % N;
        const vj = v[j];
        const aGrip = muAt(j) * (gN(j, vj) + kA * vj * vj);
        const aLat = vj * vj * Math.abs(line.kap[j]);
        const left = Math.sqrt(Math.max(0, aGrip * aGrip - aLat * aLat));
        const drag = 0.5 * Car.RHO * spec.CdA * vj * vj / m;
        const a = Math.max(2, left * brakeEff + drag + Car.GRAV * grade(j));
        const vn = Math.sqrt(vj * vj + 2 * a * line.dsl[i]);
        if (vn < v[i]) v[i] = vn;
      }
    }
    return v;
  }

  // Braking zones (for distance boards and the racing-line colouring).
  function brakingZones(tr, prof) {
    const N = tr.N, out = [];
    const brk = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (prof[(i + 1) % N] < prof[i] - 0.05) brk[i] = 1;
    // find runs
    let start = 0;
    while (brk[start] && start < N) start++;
    for (let k = 0; k < N; k++) {
      const i = (start + k) % N;
      if (brk[i] && !brk[(i - 1 + N) % N]) {
        let j = i, n = 0;
        while (brk[j] && n < N) { j = (j + 1) % N; n++; }
        const dv = prof[i] - prof[j];
        if (dv > 12) out.push({ s0: i * tr.ds, s1: j * tr.ds, vIn: prof[i], vOut: prof[j], len: n * tr.ds });
      }
    }
    return { zones: out, brk };
  }

  // Lap time of a line under the quasi-steady model (used by tools/optline.js).
  function lapTime(tr, line, spec, opt) {
    const v = speedProfile(tr, line, spec, opt);
    let t = 0;
    for (let i = 0; i < tr.N; i++) t += line.dsl[i] / Math.max(3, v[i]);
    return t;
  }

  // Final pass over an optimised line. The lap-time model treats any curve gentler than
  // ~200 m radius as free (downforce outgrows the cornering load) and has no yaw inertia,
  // so a random-bump optimiser leaves ripples on the straights and sudden flicks across
  // the track that a real car would never drive (and the guide line shows them). This
  // keeps the line's shape but: 1) smooths the whole lap as far as that still helps,
  // 2) irons out local ripples that earn (almost) nothing, 3) spreads sharp crossings of
  // the track on a straight over a longer run, for at most a few hundredths of a second.
  // evalT(off) -> lap time. Returns { off, t }.
  function straighten(tr, off0, evalT) {
    const N = tr.N, lim = lineLimits(tr), ds = tr.ds;
    const blur = (a, sig) => {
      const R = Math.ceil(sig * 3), w = [];
      let ws = 0;
      for (let q = -R; q <= R; q++) { const k = Math.exp(-0.5 * (q / sig) ** 2); w.push(k); ws += k; }
      const o = new Float64Array(N);
      for (let i = 0; i < N; i++) { let s = 0; for (let q = -R; q <= R; q++) s += a[(i + q + N) % N] * w[q + R]; o[i] = lim.clamp(i, s / ws); }
      return o;
    };
    let off = Float64Array.from(off0), t = evalT(off);
    // 1. whole-lap smoothing
    for (;;) {
      let best = null, bt = t;
      for (const m of [3, 5, 8, 12, 16]) { const o = blur(off, m / ds), tt = evalT(o); if (tt < bt) { bt = tt; best = o; } }
      if (!best) break;
      off = best; t = bt;
    }
    // 2. local ripples
    const sm = blur(off, 10 / ds), win = Math.round(30 / ds), step = Math.round(12 / ds);
    let budget = 0.03;
    for (let pass = 0; pass < 2; pass++) for (let c = 0; c < N; c += step) {
      const cand = Float64Array.from(off);
      for (let q = -3 * win; q <= 3 * win; q++) { const i = (c + q + N) % N, w = Math.exp(-0.5 * (q / win) ** 2); cand[i] = lim.clamp(i, off[i] + (sm[i] - off[i]) * w); }
      const tt = evalT(cand);
      if (tt <= t + 0.0005 && tt - t <= budget) { budget -= Math.max(0, tt - t); off = cand; t = tt; }
    }
    // 3. sharp crossings on a straight
    const look = Math.round(25 / ds);
    const flicks = o => {
      const out = [];
      for (let i = 0; i < N; i++) {
        if (Math.abs((o[(i + 1) % N] - o[(i - 1 + N) % N]) / (2 * ds)) < 0.18) continue;
        let kt = 0;
        for (let q = -look; q <= look; q++) kt = Math.max(kt, Math.abs(tr.kap[(i + q + N) % N]));
        if (kt < 1 / 250) out.push(i);
      }
      return out;
    };
    let fb = 0.25;
    for (let it = 0; it < 40; it++) {
      const fl = flicks(off);
      let done = false;
      for (const c of fl) {
        for (const m of [20, 30, 45]) {
          const sig = m / ds, bl = blur(off, sig * 0.6), cand = Float64Array.from(off), R = Math.round(sig * 2.5);
          for (let q = -R; q <= R; q++) { const i = (c + q + N) % N, w = Math.exp(-0.5 * (q / sig) ** 2); cand[i] = lim.clamp(i, off[i] + (bl[i] - off[i]) * w); }
          const tt = evalT(cand);
          if (tt - t <= Math.min(0.05, fb)) { fb -= Math.max(0, tt - t); off = cand; t = tt; done = true; break; }
        }
        if (done) break;
      }
      if (!done) break;
    }
    return { off, t };
  }

  // Optimised minimum-time offsets (js/lines.js, from tools/optline.js), stored every
  // `stride` samples; falls back to the minimum-curvature line.
  function storedOffsets(tr) {
    const S = G.F1.Lines && G.F1.Lines[tr.id];
    if (!S || !S.length) return null;
    const st = G.F1.Lines.stride, off = new Float64Array(tr.N);
    for (let i = 0; i < tr.N; i++) {
      const f = i / st, k = Math.floor(f) % S.length, t = f - Math.floor(f);
      off[i] = S[k] + (S[(k + 1) % S.length] - S[k]) * t;
    }
    return off;
  }

  function prepare(tr) {
    const stored = storedOffsets(tr);
    return applyLine(tr, stored ? lineFromOffsets(tr, stored) : computeLine(tr));
  }
  // set a circuit's racing line and everything derived from it
  function applyLine(tr, line) {
    tr.line = line;
    tr.prof = speedProfile(tr, tr.line, Car.SPEC);
    // kerb height follows the speed through the corner: tall ridged kerbs where the cars
    // are slow, low flat ones in the fast sweepers (as real circuits build them)
    if (tr.kerbH) {
      const W = Math.round(40 / tr.ds);
      for (let i = 0; i < tr.N; i++) {
        let v = 1e9;
        for (let k = -W; k <= W; k++) v = Math.min(v, tr.prof[(i + k + tr.N) % tr.N]);
        tr.kerbH[i] = 0.012 + 0.023 * Math.min(1, Math.max(0, (230 - v * 3.6) / 120));
      }
    }
    const bz = brakingZones(tr, tr.prof);
    tr.brakeZones = bz.zones; tr.brk = bz.brk;
    let t = 0;
    for (let i = 0; i < tr.N; i++) t += tr.line.dsl[i] / Math.max(5, tr.prof[i]);
    tr.refLap = t;
    return tr;
  }

  F1.Raceline = { computeLine, cornerMarks, lineFromOffsets, lineLimits, kerbGrip, cornersOf, techniqueLine, lapTime, storedOffsets, speedProfile, accelTable, brakingZones, prepare, applyLine, straighten };
})(typeof window !== 'undefined' ? window : globalThis);
