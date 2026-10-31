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
  const VERSION = 3;     // bump when physics or AI changes make stored results stale
  const STRIDE_LINE = 2, STRIDE_GRIP = 5;
  const G_MIN = 0.8, G_MAX = 1.4;

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
      return F1.Raceline.lapTime(tr, line, F1.Car.SPEC, { pace: 1, grip: g }) + rough * 0.02;
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

  // ---------- worker side ----------
  // A worker holds one circuit and, per mode, one test car. Messages:
  //  {cmd:'opt', id, off, iters, seed, a0, a1}  -> {off, t}
  //  {cmd:'init', id, mode, off}                -> {ok} (sets the line, warms the car up)
  //  {cmd:'lap', mode, g}                       -> {fail, t, clean, rec, walls}
  // ctx holds a worker's state (one per thread; a single-threaded host keeps several)
  const CTX = { runners: {}, opt: {} };
  function* handle(msg, ctx = CTX) {
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
    const cancelled = opts.cancelled || (() => false);
    const tr = F1.Race.getTrack(id), N = tr.N, nW = pool.size;
    const tStart = Date.now(), stats = { line: null, modes: {} };

    // --- stage 1: racing line ---
    const TOTAL = opts.lineIters || 45000, PER = opts.lineBatch || 12;
    const batches = Math.max(1, Math.ceil(TOTAL / (PER * nW)));
    const lim = F1.Raceline.lineLimits(tr), evalT = lineEval(tr, lim, null);
    const off = F1.Raceline.techniqueLine(tr), sep = Math.round(160 / tr.ds);
    const t0 = evalT(off);
    let tBest = t0, moves = [];
    await Promise.all(Array.from({ length: nW }, (_, w) => pool.call(w, { cmd: 'optInit', id, off })));
    for (let b = 0; b < batches; b++) {
      if (cancelled()) return null;
      const anneal = 1 - b / batches;
      const res = await Promise.all(Array.from({ length: nW }, (_, w) =>
        pool.call(w, { cmd: 'optBatch', moves, n: PER, seed: 1 + b * 7919 + w * 104729, anneal })));
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
    }
    {
      const st = F1.Raceline.straighten(tr, off, evalT); // no ripples or flicks a real car would not drive
      off.set(st.off); tBest = st.t;
    }
    stats.line = { from: t0, to: tBest, ms: Date.now() - tStart };
    // learn on exactly the line the game will race on: stored every STRIDE_LINE samples
    // to the centimetre and interpolated back (the small kinks change the speed plan)
    const line = [];
    for (let i = 0; i < N; i += STRIDE_LINE) line.push(+off[i].toFixed(2));
    for (let i = 0; i < N; i++) {
      const f = i / STRIDE_LINE, k = Math.floor(f) % line.length, t = f - Math.floor(f);
      off[i] = line[k] + (line[(k + 1) % line.length] - line[k]) * t;
    }

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

  // install a result: the circuit then uses this line and these limits everywhere
  function apply(res) {
    F1.Lines = F1.Lines || { stride: STRIDE_LINE };
    F1.Limits = F1.Limits || { stride: STRIDE_GRIP };
    if (F1.Lines.stride !== STRIDE_LINE || F1.Limits.stride !== STRIDE_GRIP) throw new Error('stride mismatch');
    F1.Lines[res.id] = res.line;
    F1.Limits[res.id] = res.limits;
    F1.Race.forgetTrack(res.id);
  }

  F1.LearnCore = { VERSION, handle, learnTrack, apply, Runner };
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
