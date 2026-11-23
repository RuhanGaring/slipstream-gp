// Teaches the AI a new circuit, spread over many threads. The same two stages as the
// offline tools (tools/optline.js, tools/learn.js), rebuilt to run in parallel:
//  1. Racing line: rounds of hill-climbing on every thread from the best line so far;
//     after each round the fastest line wins and seeds the next.
//  2. Grip limits: instead of one car bisecting lap after lap, a field of test cars each
//     drives the same lap at a different grip level. Where a car slides, runs wide or
//     hits a wall, that level is too much there; where it stays clean it is fine. Each
//     round narrows every corner's window between the highest clean and the lowest
//     failing level (a search with as many probes per lap as there are cars), then a
//     check lap confirms the result.
// DOM-free: the browser runs it in Web Workers (js/learnworker.js), Node in worker
// threads (tools/learnpar.js). Work is written as generators so a single-threaded host
// can also run it in small time slices.
(function simModule(G) {
  'use strict';
  (G.F1simMods = G.F1simMods || []).push(simModule); // the learning workers rebuild the sim from these
  const F1 = G.F1;
  const U = F1.U;
  const DT = 1 / 240;
  const VERSION = 8;     // bump when physics or AI changes make stored results stale
  const STRIDE_LINE = 2, STRIDE_GRIP = 5;
  const G_MIN = 0.8, G_MAX = 1.4;
  const LINE_SLOTS = 14; // racing-line searchers, the most threads a browser is given

  // ---------- 1. racing line ----------
  // the same move as tools/optline.js: a smooth lateral bump, kept if the lap gets quicker
  function lineEval(tr, lim, grip) {
    const N = tr.N, g = new Float64Array(N);
    return off => {
      const line = F1.Raceline.lineFromOffsets(tr, off);
      let rough = 0;
      for (let i = 0; i < N; i++) { const d2 = off[(i + 1) % N] - 2 * off[i] + off[(i - 1 + N) % N]; rough += d2 * d2; }
      // wheels over a kerb cost grip: the line takes a kerb only where the shorter or
      // straighter path more than pays for it
      for (let i = 0; i < N; i++) g[i] = (grip ? grip[i] : 1) * F1.Raceline.kerbGrip(tr, i, off[i], line.kap[i]);
      return F1.Raceline.lapTime(tr, line, F1.Car.SPEC, { pace: 1, grip: g, real: true }) + rough * 0.02;
    };
  }
  function bump(off, lim, N, c, sig, amp) {
    const R = Math.ceil(sig * 3);
    for (let q = -R; q <= R; q++) {
      const i = (c + q + N) % N;
      off[i] = lim.clamp(i, off[i] + amp * Math.exp(-0.5 * (q / sig) ** 2));
    }
  }
  // Batch search: every worker tries its own share of bumps against the same line and
  // reports the ones that help; the master keeps the best ones that do not overlap and
  // every worker then applies exactly those, so all threads stay on the same line.
  function optInit(OPT, id, off) {
    const tr = F1.Race.getTrack(id), lim = F1.Raceline.lineLimits(tr);
    OPT.tr = tr; OPT.N = tr.N; OPT.lim = lim; OPT.evalT = lineEval(tr, lim, null);
    OPT.off = Float64Array.from(off); OPT.cand = new Float64Array(tr.N); OPT.t = OPT.evalT(OPT.off);
    return { t: OPT.t };
  }
  function* optBatch(OPT, moves, n, seed, anneal) {
    const { tr, N, lim, evalT, off, cand } = OPT;
    for (const m of moves) bump(off, lim, N, m[0], m[1], m[2]);
    const base = moves.length ? evalT(off) : OPT.t;
    OPT.t = base;
    const rnd = U.rng(seed), found = [];
    for (let k = 0; k < 3; k++) rnd();
    for (let it = 0; it < n; it++) {
      const c = Math.floor(rnd() * N);
      const sig = (5 + rnd() * 35) / tr.ds * 2;
      const amp = (rnd() - 0.5) * 2 * (0.3 + 2.2 * anneal);
      cand.set(off);
      bump(cand, lim, N, c, sig, amp);
      const t = evalT(cand);
      if (t < base) found.push([c, sig, amp, base - t]);
      if ((it & 7) === 7) yield;
    }
    return { found, base };
  }

  // ---------- 2. test laps ----------
  // One test car on its own, kept running between laps so its tyres stay warm. Each
  // lap() drives exactly one flying lap at the grip it is given and reports where the
  // car got into trouble (the failure rules of tools/learn.js).
  function Runner(id, mode) {
    const race = F1.Race.create({ track: id, mode, laps: 9999, difficulty: 4, team: 0, driver: 0, field: 1, seed: 3 });
    race.thinkOff = true; // (it learns the plan the base driving holds; the look-ahead sits on top of it)
    race.cars = [race.player]; race.order = [race.player];
    race.autoPlayer = true;
    const c = race.player;
    c.wearRate = 1e-9; // (0 would read as the default rate)
    // no damage: a test car with a broken wing drives slowly ever after, and its clean
    // laps would teach the AI limits a healthy car cannot hold
    c.assist.damage = false;
    this.race = race; this.car = c; this.tr = race.track; this.mode = mode;
    this.gripK = mode === 'sim' ? 1 : 1.12;
    this.fail = new Uint8Array(this.tr.N);
    race.recover = (orig => car => { this.fail[car.loc.i] = 1; this.rec++; orig(car); })(race.recover);
    this.rec = 0;
  }
  Runner.prototype.lap = function* (g) {
    const { race, car: c, tr } = this, N = tr.N;
    c.brain.prof = F1.Raceline.speedProfile(tr, tr.line, c.spec, { pace: this.gripK, grip: g });
    c.wingDmg = 0;
    this.fail = new Uint8Array(N); this.rec = 0;
    const fail = this.fail;
    const n0 = c.lapTimes.length, t0 = race.time;
    let slideT = 0, k = 0, walls = 0;
    while (c.lapTimes.length === n0 && race.time - t0 < 400) {
      c.fuel = 20; // limits are learned at a reference fuel load; the AI scales for the rest
      F1.Race.step(race, DT);
      for (const f of race.fx) if (f.type === 'wall' && f.power > 2) { fail[c.loc.i] = 1; walls++; }
      race.fx.length = 0;
      if (race.green) {
        const i = c.loc.i;
        const err = Math.abs(c.loc.d - tr.line.off[i]);
        const sliding = c.satR > 1.5 || (Math.abs(c.beta) > 0.13 && c.speed > 15);
        slideT = sliding ? slideT + DT : 0;
        const rear = slideT > 0.12 || Math.abs(c.beta) > 0.3;
        if (err > 4 || rear || c.satF > 1.75 || c.wheels.every(w => w.outside)) fail[i] = 1;
      }
      if ((++k & 511) === 0) yield;
    }
    const lt = c.lapTimes.length > n0 ? c.lapTimes[c.lapTimes.length - 1].t : null;
    return { fail, t: lt, clean: !fail.some(x => x), rec: this.rec, walls };
  };

  // ---------- 3. coaching ----------
  // The speed plan comes from a model of the car, so it is only a guess at what the real physics
  // will take. tools/coach.js finds out by driving; this is the same coach for the browser. One lone
  // car drives flying laps with the plan's corners nudged (corner speed or brake point, up or
  // down); each stretch of road, from one braking point to the next, is timed, and a nudge is kept
  // only where the car was truly quicker there and stayed clean.
  function install(id, line, limits) {
    F1.Lines = F1.Lines || { stride: STRIDE_LINE };
    F1.Limits = F1.Limits || { stride: STRIDE_GRIP };
    F1.Lines[id] = line; F1.Limits[id] = limits;
    F1.Race.forgetTrack(id);
  }
  function CoachRunner(id) {
    const race = F1.Race.create({ track: id, mode: 'tt', laps: 4, difficulty: 4, team: 0, driver: 0, seed: 7, field: 1, assists: {} });
    race.autoPlayer = true; race.thinkOff = true;
    const c = race.player;
    if (c.assist) c.assist.damage = false; // (a broken wing would slow every lap after it)
    this.race = race; this.car = c; this.tr = race.track; this.E = F1.Raceline.lineLimits(this.tr);
  }
  CoachRunner.prototype.lap = function* (g, gB, segEnd, trace) {
    const { race, car: c, tr, E } = this, N = tr.N;
    c.brain.prof = F1.Raceline.speedProfile(tr, tr.line, c.spec, { pace: 1, grip: g, gripB: gB, brakePace: 1, brake: 1 });
    const prof = c.brain.prof;
    const n = segEnd.length, t = new Float64Array(n), bad = new Uint8Array(n);
    // (every test on the same fresh tyres and the same tank, or a long session drifts away from itself)
    for (const w of c.wheels) w.wear = 0;
    c.fuel = 10; c.wingDmg = 0;
    const wait0 = c.lapTimes.length; let g0 = 0;
    while (c.lapTimes.length === wait0 && g0++ < 240 * 400) { F1.Race.step(race, DT); race.fx.length = 0; if ((g0 & 511) === 0) yield; }
    const start = race.time; let k = 0, q = 0;
    const ts = trace ? new Float32Array(N).fill(-1) : null, vs = trace ? new Float32Array(N) : null;
    const wait = c.lapTimes.length; let guard = 0;
    while (c.lapTimes.length === wait && guard++ < 240 * 400) {
      F1.Race.step(race, DT);
      for (const f of race.fx) if (f.type === 'wall' && f.power > 2) bad[k] = 1;
      race.fx.length = 0;
      const s = c.loc.s, i = c.loc.i;
      // (all four wheels past the white line is a track-limits strike in a race: it deletes the lap and earns a warning, so it counts as trouble here)
      if (c.loc.d < -E.L[i] - 1.1 || c.loc.d > E.R[i] + 1.1 || (Math.abs(c.r) > 1.6 && c.speed > 20 && Math.abs(c.v) > 6) || c.wheels.every(w => w.outside)) bad[k] = 1;
      while (k < n - 1 && s >= segEnd[k] && s < segEnd[k] + 200) { t[k] = race.time - start; k++; }
      if (ts) { ts[i] = race.time - start; vs[i] = c.speed; }
      if ((++q & 511) === 0) yield;
    }
    t[n - 1] = race.time - start;
    const tot = t[n - 1];
    for (let j = n - 1; j > 0; j--) t[j] -= t[j - 1];
    if (guard >= 240 * 400) bad.fill(1);
    const out = { t: Array.from(t), bad: Array.from(bad), tot };
    if (trace) {
      // (samples the lap skipped take the one before them)
      for (let i = 1; i < N; i++) if (ts[i] < 0) { ts[i] = ts[i - 1]; vs[i] = vs[i - 1]; }
      out.ts = Array.from(ts, x => +x.toFixed(3)); out.vs = Array.from(vs, x => +x.toFixed(2)); out.plan = Array.from(prof, x => +x.toFixed(2));
    }
    return out;
  };

  // ---------- worker side ----------
  // A worker holds one circuit and, per mode, one test car. Messages:
  //  {cmd:'opt', id, off, iters, seed, a0, a1}  -> {off, t}
  //  {cmd:'init', id, mode, off}                -> {ok} (sets the line, warms the car up)
  //  {cmd:'lap', mode, g}                       -> {fail, t, clean, rec, walls}
  //  {cmd:'cInit', id, line, limits}            -> {ok} (the coach's car, on this line and these limits)
  //  {cmd:'cLap', g, gB, segEnd, trace}         -> {t, bad, tot}: one flying lap timed stretch by stretch
  // ctx holds a worker's state (one per thread; a single-threaded host keeps several)
  const CTX = { runners: {}, opt: {} };
  function* handle(msg, ctx = CTX) {
    // msg.slot: one of several searchers sharing this thread, each with its own state (see
    // LINE_SLOTS: the line must not depend on how many threads the player's CPU has)
    if (msg.slot != null) { const s = ctx.slots || (ctx.slots = {}); ctx = s[msg.slot] || (s[msg.slot] = { runners: {}, opt: {} }); }
    if (msg.cmd === 'optInit') return optInit(ctx.opt, msg.id, msg.off);
    if (msg.cmd === 'optBatch') return yield* optBatch(ctx.opt, msg.moves, msg.n, msg.seed, msg.anneal);
    if (msg.cmd === 'init') {
      const tr = F1.Race.getTrack(msg.id);
      if (msg.off) F1.Raceline.applyLine(tr, F1.Raceline.lineFromOffsets(tr, Float64Array.from(msg.off)));
      const r = ctx.runners[msg.mode] = new Runner(msg.id, msg.mode);
      yield* r.lap(new Float64Array(tr.N).fill(1)); // standing start: just warm the tyres
      return { ok: true };
    }
    if (msg.cmd === 'lap') return yield* ctx.runners[msg.mode].lap(Float64Array.from(msg.g));
    if (msg.cmd === 'cInit') { install(msg.id, msg.line, msg.limits); ctx.coach = new CoachRunner(msg.id); return { ok: true }; }
    if (msg.cmd === 'cLap') return yield* ctx.coach.lap(Float64Array.from(msg.g), Float64Array.from(msg.gB), msg.segEnd, msg.trace);
    throw new Error('unknown command ' + msg.cmd);
  }

  // ---------- master side ----------
  // pool: { size, call(worker, msg) -> Promise(result) }. Every worker must be able to
  // build the circuit from its id (hand-made, or generated from the seed in the id).
  const smooth = (a, r) => {
    const N = a.length, o = new Float64Array(N);
    for (let i = 0; i < N; i++) { let s = 0; for (let k = -r; k <= r; k++) s += a[(i + k + N) % N]; o[i] = s / (2 * r + 1); }
    return o;
  };
  // a failure counts against the braking zone before it as well (as in tools/learn.js)
  function badMask(tr, fail) {
    const N = tr.N, bad = new Uint8Array(N), back = Math.round(140 / tr.ds), fwd = Math.round(16 / tr.ds);
    for (let k = 0; k < N; k++) if (fail[k]) for (let q = -back; q <= fwd; q++) bad[(k + q + N) % N] = 1;
    return bad;
  }

  // a clean pass only proves something if the car got there at speed: after trouble
  // (a slide, a recovery) it arrives slow for a while, so that stretch proves nothing
  function taintMask(tr, fail) {
    const N = tr.N, t = new Uint8Array(N), span = Math.round(800 / tr.ds);
    let last = -1e9;
    for (let k = 0; k < 2 * N; k++) {
      const i = k % N;
      if (k - last <= span && k >= N) t[i] = 1;
      if (k - last <= span && k < N && last > -1e9) t[i] = 1;
      if (fail[i]) last = k;
    }
    return t;
  }

  async function learnTrack(pool, id, opts = {}) {
    const report = opts.progress || (() => {});
    const ev = opts.on || (() => {}); // structured events for the training lab (js/trainlab.js)
    const cancelled = opts.cancelled || (() => false);
    const tr = F1.Race.getTrack(id), N = tr.N, nW = pool.size;
    const tStart = Date.now(), stats = { line: null, modes: {} };

    // --- stage 1: racing line ---
    const TOTAL = opts.lineIters || 45000, PER = opts.lineBatch || 12;
    // the search runs as LINE_SLOTS searchers whatever the thread count (a thread takes
    // several when there are fewer): the same seeds and the same merges every time, so a
    // 6-core laptop learns the very line a 16-core desktop does. The total work is the same
    // either way; with fewer threads it only takes longer. (The page-only fallback keeps its
    // own small search.)
    const V = opts.lineSlots || (pool.kind === 'local' ? nW : Math.max(nW, LINE_SLOTS));
    const batches = Math.max(1, Math.ceil(TOTAL / (PER * V)));
    const lim = F1.Raceline.lineLimits(tr), evalT = lineEval(tr, lim, null);
    // opts.start (offsets every STRIDE_LINE samples): search on from that line (pulled inside
    // the limits) instead of from scratch
    const off = F1.Raceline.techniqueLine(tr), sep = Math.round(160 / tr.ds);
    if (opts.start) for (let i = 0; i < N; i++) { const f = i / STRIDE_LINE, L = opts.start, k = Math.floor(f) % L.length, t = f - Math.floor(f); off[i] = lim.clamp(i, L[k] + (L[(k + 1) % L.length] - L[k]) * t); }
    const t0 = evalT(off);
    let tBest = t0, moves = [];
    await Promise.all(Array.from({ length: V }, (_, v) => pool.call(v % nW, { cmd: 'optInit', id, off, slot: v })));
    // opts.converge: keep running whole rounds of the search (each starting bold again from
    // the best line so far) until a round gains less than that fraction of the lap
    // opts.line (offsets every STRIDE_LINE samples): race this line, learn only the limits
    const rounds = opts.line ? 0 : opts.converge ? (opts.maxRounds || 60) : 1;
    if (opts.line) for (let i = 0; i < N; i++) { const f = i / STRIDE_LINE, L = opts.line, k = Math.floor(f) % L.length, t = f - Math.floor(f); off[i] = L[k] + (L[(k + 1) % L.length] - L[k]) * t; }
    let tRound = tBest;
    for (let round = 0; round < rounds; round++) {
    for (let b = 0; b < batches; b++) {
      if (cancelled()) return null;
      const anneal = 1 - b / batches;
      const res = await Promise.all(Array.from({ length: V }, (_, v) =>
        pool.call(v % nW, { cmd: 'optBatch', moves, n: PER, seed: 1 + b * 7919 + v * 104729, anneal, slot: v })));
      const found = [].concat(...res.map(x => x.found)).sort((p, q) => q[3] - p[3]);
      // the best bumps, as long as their centres are well apart
      moves = [];
      for (const m of found) {
        if (moves.every(o => { let d = Math.abs(o[0] - m[0]); d = Math.min(d, tr.N - d); return d > sep + 3 * (o[1] + m[1]); })) moves.push(m);
        if (moves.length >= 8) break;
      }
      if (moves.length > 1) {
        // check they really do add up; if not, keep only the single best
        const test = Float64Array.from(off);
        for (const m of moves) bump(test, lim, N, m[0], m[1], m[2]);
        if (evalT(test) > tBest - found[0][3]) moves = [found[0]];
      }
      for (const m of moves) bump(off, lim, N, m[0], m[1], m[2]);
      if (moves.length) tBest = evalT(off);
      if ((b & 7) === 7) report(0.3 * (b + 1) / batches, 'line');
      if ((b & 3) === 3 || b === batches - 1) ev({ type: 'line', round, rounds, b: b + 1, batches, t: tBest, t0 });
    }
      if (opts.onRound) opts.onRound(round, tBest);
      ev({ type: 'lineRound', round: round + 1, rounds, t: tBest, t0, off: Array.from(off) });
      if (tRound - tBest < (opts.converge || 0) * tBest) break;
      tRound = tBest;
    }
    if (!opts.line) {
      const st = F1.Raceline.straighten(tr, off, evalT); // no ripples or flicks a real car would not drive
      off.set(st.off); tBest = st.t;
    }
    stats.line = { from: t0, to: tBest, ms: Date.now() - tStart };
    ev({ type: 'lineDone', from: t0, to: tBest, off: Array.from(off) });
    // learn on exactly the line the game will race on: stored every STRIDE_LINE samples
    // to the centimetre and interpolated back (the small kinks change the speed plan)
    const line = [];
    for (let i = 0; i < N; i += STRIDE_LINE) line.push(+off[i].toFixed(2));
    for (let i = 0; i < N; i++) {
      const f = i / STRIDE_LINE, k = Math.floor(f) % line.length, t = f - Math.floor(f);
      off[i] = line[k] + (line[(k + 1) % line.length] - line[k]) * t;
    }
    // the line is most of the pace: the game can race on it now, with the grip model
    // standing in for the limits until they are learned
    if (opts.onLine) opts.onLine(line);

    // --- stage 2: grip limits, both handling modes side by side ---
    const modes = opts.modes || ['sim', 'arcade'];
    const groups = modes.map((m, k) => {
      const ws = [];
      for (let w = 0; w < nW; w++) if (nW < modes.length || w % modes.length === k) ws.push(w);
      return { mode: m, ws };
    });
    const GENS = opts.gens || 3, CHECKS = opts.checks || 4;
    const steps = modes.length * (1 + GENS + CHECKS);
    let done = 0;
    const tick = () => report(0.3 + 0.7 * (++done) / steps, 'limits');
    const margin = tr.def.style === 'street' ? 0.955 : 0.985;

    const runMode = async ({ mode, ws }) => {
      const P = ws.length;
      await Promise.all(ws.map(w => pool.call(w, { cmd: 'init', id, mode, off })));
      tick();
      let lo = new Float64Array(N).fill(G_MIN), hi = new Float64Array(N).fill(G_MAX);
      let laps = 0, fails = 0;
      // search: every car probes its own fraction of each corner's window
      for (let gen = 0; gen < GENS; gen++) {
        if (cancelled()) return null;
        const probes = ws.map((_, p) => { const f = (p + 1) / (P + 1), g = new Float64Array(N); for (let i = 0; i < N; i++) g[i] = lo[i] + (hi[i] - lo[i]) * f; return g; });
        if (gen === 0 && P > 1) for (let i = 0; i < N; i++) probes[P - 1][i] = G_MAX; // someone always tries flat out
        const res = await Promise.all(ws.map((w, p) => pool.call(w, { cmd: 'lap', mode, g: probes[p] })));
        laps += P;
        const bads = res.map(x => badMask(tr, x.fail)), taints = res.map(x => taintMask(tr, x.fail));
        for (let i = 0; i < N; i++) {
          let minFail = hi[i];
          for (let p = 0; p < P; p++) if (bads[p][i]) { minFail = Math.min(minFail, probes[p][i]); fails++; }
          let ok = lo[i];
          for (let p = 0; p < P; p++) if (!bads[p][i] && !taints[p][i] && probes[p][i] < minFail) ok = Math.max(ok, probes[p][i]);
          // a clean lap above a failure is luck: trust the failure
          hi[i] = minFail;
          lo[i] = Math.min(ok, minFail - 0.004);
        }
        { const any = new Array(N).fill(0); for (const b of bads) for (let i = 0; i < N; i++) if (b[i]) any[i] = 1; ev({ type: 'gen', mode, gen: gen + 1, gens: GENS, cars: P, laps, lo: Array.from(lo), hi: Array.from(hi), bad: any, fails: res.map(x => x.fail.reduce((a, v) => a + v, 0)) }); }
        if (opts.watch != null) { const i = opts.watch; console.log(mode, 'gen', gen, 'probes', probes.map(q => q[i].toFixed(3)).join(' '), 'bad', bads.map(b => b[i]).join(''), 'fails', res.map(x => x.fail.reduce((a, v) => a + v, 0)).join(','), 'lo', lo[i].toFixed(3), 'hi', hi[i].toFixed(3)); }
        // grip can only change smoothly along the lap (as in tools/learn.js)
        const ls = smooth(lo, 6);
        for (let i = 0; i < N; i++) lo[i] = Math.max(G_MIN, Math.min(lo[i], ls[i] + 0.01));
        tick();
      }
      // check laps: every car drives the result, each arriving at every corner with its
      // own history (tyres, a slightly different line), so a corner on a knife edge shows
      // up; anywhere any of them gets into trouble backs off a little
      let g = Float64Array.from(lo);
      for (let chk = 0; chk < CHECKS; chk++) {
        if (cancelled()) return null;
        const res = await Promise.all(ws.map(w => pool.call(w, { cmd: 'lap', mode, g })));
        laps += P;
        const hit = new Uint8Array(N);
        for (const x of res) { const b = badMask(tr, x.fail); for (let i = 0; i < N; i++) if (b[i]) hit[i] = 1; }
        let n = 0;
        for (let i = 0; i < N; i++) if (hit[i]) { g[i] = Math.max(G_MIN, g[i] - 0.025); n++; }
        ev({ type: 'check', mode, chk: chk + 1, checks: CHECKS, backed: n, hit: Array.from(hit), g: Array.from(g), laps });
        if (opts.watch != null) console.log(mode, 'check', chk, 'g', g[opts.watch].toFixed(3), 'hit', hit[opts.watch], 'samples backed off', n);
        tick();
        if (!n && chk > 0) { while (++chk < CHECKS) tick(); break; }
      }
      const gs = smooth(g, 6);
      for (let i = 0; i < N; i++) g[i] = Math.min(g[i], gs[i] + 0.01) * margin;
      const out = [];
      for (let i = 0; i < N; i += STRIDE_GRIP) out.push(+g[i].toFixed(3));
      let mean = 0; for (const v of out) mean += v;
      stats.modes[mode] = { laps, mean: mean / out.length, cars: P };
      return out;
    };
    const learned = await Promise.all(groups.map(runMode));
    if (learned.some(x => !x)) return null;
    const limits = {};
    modes.forEach((m, k) => { limits[m] = learned[k]; });
    stats.ms = Date.now() - tStart;
    return { version: VERSION, id, N, line, limits, stats };
  }

  // Coach a learned circuit: base is { line, limits } (the quick learner's result). The plan before
  // coaching is the same as an uncoached circuit's in the game: 5 per cent off the corner limits,
  // 15 off the braking ones. Returns the coached plan, or null where nothing beat that.
  async function coachTrack(pool, id, base, opts = {}) {
    const ev = opts.on || (() => {}), cancelled = opts.cancelled || (() => false);
    const nW = pool.size, ROUNDS = opts.rounds || 14, st = STRIDE_GRIP;
    const expand = (L, N) => { const g = new Float64Array(N); for (let i = 0; i < N; i++) { const f = i / st, k = Math.floor(f) % L.length, t = f - Math.floor(f); g[i] = L[k] + (L[(k + 1) % L.length] - L[k]) * t; } return g; };
    const pick = a => Array.from(a).filter((_, i) => i % st === 0).map(x => +x.toFixed(4));
    let tr = F1.Race.getTrack(id), N = tr.N;
    const g0 = expand(base.limits.sim, N);
    // (from a plan already coached: carry on from it, nudges again from 1)
    // Only the corner grip is coached, and the braking grip rides with it, 0.85/0.95 of it, as the game derives it
    // from a circuit's limits (js/race.js planOpts: corners x0.95, braking x0.85). A circuit given a braking grip of
    // its own counts as one of the hand-made, coached ones, and the AI then stops trimming its line off the kerbs:
    // on a generated road that made the whole field run past the white line at the fast corners.
    const base0 = opts.from ? Float64Array.from(expand(opts.from.sim, N), x => x * 0.95) : Float64Array.from(g0, x => x * 0.95), baseB0 = Float64Array.from(base0, x => x * 0.85 / 0.95);
    const unmargin = a => Float64Array.from(a, x => x / 0.95); // (what is stored: the game puts the 0.95 back)
    const lim0 = { sim: base.limits.sim, arcade: base.limits.arcade };
    install(id, base.line, lim0);
    tr = F1.Race.getTrack(id);
    await Promise.all(Array.from({ length: nW }, (_, w) => pool.call(w, { cmd: 'cInit', id, line: base.line, limits: lim0 })));
    // stretches: from a little before one braking point to a little before the next
    const prof = F1.Raceline.speedProfile(tr, tr.line, F1.Car.SPEC, { pace: 1, grip: base0, gripB: baseB0, brakePace: 1, brake: 1 });
    const stops = [];
    for (let i = 0, on = false, top = 0, at = 0; i < N; i++) {
      const down = prof[(i + 1) % N] < prof[i] - 0.02;
      if (down && !on) { on = true; top = prof[i]; at = i; }
      if (!down && on) { on = false; if (top - prof[i] > 1.2) stops.push(at * tr.ds); }
    }
    const segEnd = stops.map(x => x - 45).filter(x => x > 30).filter((x, i, a) => !i || x - a[i - 1] > 50); segEnd.push(tr.L + 1);
    const n = segEnd.length;
    const segAt = new Int16Array(N); for (let i = 0; i < N; i++) { const s = i * tr.ds; let k = 0; while (k < n - 1 && s >= segEnd[k]) k++; segAt[i] = k; }
    const W = Math.round(30 / tr.ds);
    const mix = (b, kk) => {
      const o = Float64Array.from(b);
      for (let i = 0; i < N; i++) { let m = 0, c = 0; for (let q = -W; q <= W; q += 3) { m += Math.log(kk[segAt[(i + q + N) % N]]); c++; } o[i] = b[i] * Math.exp(m / c); }
      return o;
    };
    let C = new Float64Array(n).fill(1), B = new Float64Array(n).fill(1), dC = 0.016, dB = 0.05;
    let seq = 0;
    const run = (cs, bs, w, trace) => pool.call(w, { cmd: 'cLap', g: Array.from(mix(base0, cs)), gB: Array.from(mix(baseB0, cs)), segEnd, trace });
    const baseLap = () => run(C, B, 0, true);
    let cur = await baseLap();
    const first = cur.tot, firstBad = cur.bad.reduce((a, b) => a + b, 0);
    let best = { tot: cur.tot, C: C.slice(), B: B.slice(), lap: cur };
    ev({ type: 'coachBase', first, firstBad, n, segEnd, lap: cur, rounds: ROUNDS });
    const rnd = F1.U.rng(1234 + id.length);
    let rd = 0, stopped = false;
    for (; rd < ROUNDS; rd++) {
      if (cancelled()) { stopped = true; break; }
      const arms = Array.from({ length: n }, () => [[], [], [], []]); // corner up, down, brake up, down
      await Promise.all(Array.from({ length: nW }, async (_, w) => {
        for (let l = 0; l < 3; l++) {
          const cs = C.slice(), bs = B.slice(), pk = new Int8Array(n);
          for (let s = 0; s < n; s++) { const a = Math.floor(rnd() * 2); pk[s] = a; if (a < 2) cs[s] *= a ? 1 - dC : 1 + dC; else bs[s] *= a === 3 ? 1 - dB : 1 + dB; }
          const r = await run(cs, bs, w, false);
          for (let s = 0; s < n; s++) arms[s][pk[s]].push({ t: r.t[s], bad: r.bad[s] || r.bad[(s + 1) % n] });
        }
      }));
      let moved = 0;
      const moves = new Int8Array(n).fill(-1);
      for (let s = 0; s < n; s++) {
        let bestA = -1, gain = 0.002;
        arms[s].forEach((L, a) => {
          if (!L.length) return;
          const bads = L.filter(x => x.bad).length;
          const ts = L.map(x => x.t).sort((x, y) => x - y), med = ts[ts.length >> 1], d = cur.t[s] - med;
          if (bads === 0 && d > gain) { gain = d; bestA = a; }
          // a stretch that is hitting something takes any nudge that stops it
          else if (cur.bad[s] && bads * 2 < L.length && bestA < 0) bestA = a;
        });
        if (bestA < 0) continue;
        moved++; moves[s] = bestA;
        if (bestA < 2) C[s] *= bestA ? 1 - dC : 1 + dC; else B[s] *= bestA === 3 ? 1 - dB : 1 + dB;
      }
      cur = await baseLap();
      const badN = cur.bad.reduce((a, b) => a + b, 0);
      let kept = false;
      if (cur.tot < best.tot && badN <= firstBad) { best = { tot: cur.tot, C: C.slice(), B: B.slice(), lap: cur }; kept = true; }
      else if (cur.tot > best.tot + 0.25 || badN > firstBad) { C = best.C.slice(); B = best.B.slice(); cur = await baseLap(); }
      if (moved < 2 || rd % 4 === 3) { dC = Math.max(0.004, dC * 0.65); dB = Math.max(0.012, dB * 0.65); }
      ev({ type: 'coach', round: rd + 1, rounds: ROUNDS, tot: cur.tot, best: best.tot, first, moved, n, bad: badN, kept, dC, dB, C: Array.from(C), B: Array.from(B), moves: Array.from(moves), lap: best.lap, plan: kept ? { g: pick(unmargin(mix(base0, best.C))), best: best.tot } : null });
    }
    // the plan to be shipped, driven once more from scratch
    const g = mix(base0, best.C), gB = mix(baseB0, best.C);
    const ver = await pool.call(0, { cmd: 'cLap', g: Array.from(g), gB: Array.from(gB), segEnd, trace: true });
    const verBad = ver.bad.reduce((a, b) => a + b, 0);
    ev({ type: 'verify', tot: ver.tot, bad: verBad, first, lap: ver });
    const gain = first - ver.tot;
    if (!(gain > 0.02) || verBad > firstBad) return { none: true, first, best: ver.tot, bad: verBad, rounds: rd, n, stopped };
    return { none: false, first, best: ver.tot, bad: verBad, firstBad, rounds: rd, n, stopped, g: pick(unmargin(g)), segEnd, C: Array.from(best.C), B: Array.from(best.B) };
  }

  // The full training: the learned line kept, a longer limits search, then the coach.
  // opts: gens, checks, coachRounds, on(event), cancelled()
  async function deepTrack(pool, id, opts = {}) {
    const ev = opts.on || (() => {}), cancelled = opts.cancelled || (() => false);
    const start = F1.Lines && F1.Lines[id] ? Array.from(F1.Lines[id]) : null; // (carries on from the line it has)
    // opts.resume: a result stored earlier ({ line, limits }): only the coach runs, on from its plan
    let quick = opts.resume ? { version: VERSION, id, N: opts.resume.N, line: opts.resume.line, limits: opts.resume.limits, stats: opts.resume.stats } : null;
    if (!quick) {
      ev({ type: 'phase', phase: 'line' });
      // A line already learned is kept. A longer search for a better one was tried and rejected: its model lap
      // was no better, but it ran the corners wider, and in races the AI then drove all four wheels past the
      // white line (laps deleted, warnings, time penalties). Only a circuit with no line yet searches for one.
      quick = await learnTrack(pool, id, start ? { line: start, gens: opts.gens, checks: opts.checks, on: ev, cancelled }
        : { lineIters: opts.lineIters, gens: opts.gens, checks: opts.checks, on: ev, cancelled });
      if (!quick || cancelled()) return null;
      ev({ type: 'quick', res: quick });
    }
    ev({ type: 'phase', phase: 'coach' });
    const from = opts.resume && opts.resume.deep && !opts.resume.deep.none ? opts.resume.limits : null;
    const co = await coachTrack(pool, id, quick, { rounds: opts.coachRounds, from, on: ev, cancelled });
    const prev = opts.resume && opts.resume.deep;
    const res = { version: VERSION, id, N: quick.N, line: quick.line, limits: quick.limits, stats: quick.stats, deep: { first: prev && prev.first0 != null ? prev.first0 : co.first, first0: prev && prev.first0 != null ? prev.first0 : co.first, best: co.none && prev ? prev.best : co.best, rounds: co.rounds + (prev ? prev.rounds || 0 : 0), n: co.n, none: co.none && !(prev && !prev.none), stopped: co.stopped, at: Date.now() } };
    if (!co.none) {
      res.limits = { sim: co.g, arcade: quick.limits.arcade };
      res.deep.C = co.C; res.deep.B = co.B; res.deep.segEnd = co.segEnd;
    }
    return res;
  }

  // install a result: the circuit then uses this line and these limits everywhere
  function apply(res) {
    F1.Lines = F1.Lines || { stride: STRIDE_LINE };
    F1.Limits = F1.Limits || { stride: STRIDE_GRIP };
    if (F1.Lines.stride !== STRIDE_LINE || F1.Limits.stride !== STRIDE_GRIP) throw new Error('stride mismatch');
    F1.Lines[res.id] = res.line;
    F1.Limits[res.id] = res.limits;
    F1.Race.forgetTrack(res.id);
  }

  // just a learned line (the limits still to come): the grip model fills in meanwhile
  function applyLine(id, line) {
    F1.Lines = F1.Lines || { stride: STRIDE_LINE };
    F1.Lines[id] = line;
    F1.Race.forgetTrack(id);
  }

  F1.LearnCore = { VERSION, handle, learnTrack, coachTrack, deepTrack, apply, applyLine, install, Runner, STRIDE_LINE, STRIDE_GRIP };
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
