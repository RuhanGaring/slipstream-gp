// The AI learns its own corner lines, fast: an evolution strategy per corner, judged by driving only
// that corner with the game's own physics (tyres, downforce, kerbs, surface, brakes and power as in a
// race), from the car's exact state as it arrives there on a lap, so a candidate costs seconds of
// simulation, not whole laps. Every slow corner gets 7 control points (smooth bumps of the line,
// inward or outward); each generation tries 12 coordinated variations of them per corner, all corners
// at once on worker threads that keep the circuit loaded, and moves toward what was quicker (time to
// a point past the exit, so exit speed counts). Kept corners are then checked over full laps, on the
// plan and with the look-ahead, with no more wall hits, as before.
//   node tools/cornerlearn.js TRACK   env GENS=25 WRITE=1
const { Worker, isMainThread, parentPort } = require('worker_threads');
const fs = require('fs'), path = require('path'), os = require('os');
const LOAD = ['util.js', 'tracks.js', 'car.js', 'damage.js', 'softbody.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js'];

function soloRace(F1, id, line) {
  if (line) F1.Lines[id] = line;
  F1.Race.forgetTrack && F1.Race.forgetTrack(id);
  const race = F1.Race.create({ track: id, mode: 'tt', laps: 99, difficulty: 4, team: 0, driver: 0, seed: 7, field: 1, spectate: true, assists: {} });
  race.autoPlayer = true;
  plain(race.player);
  return race;
}
const holdOf = (c, tr) => () => { for (const w of c.wheels) w.wear = 0; c.fuel = 10; tr.rubber.fill(0.6); };
// The line is learned on a driver with no personality: no style (the wobble around the line, the
// form that changes each lap, the odd mistake) and no pace noise. With them, laps on one line vary
// by 0.3 to 0.6 s, and a search judged on single runs learns which candidates got a lucky draw
// rather than which line is quicker. In races each driver adds their own style on top again.
const plain = c => { const b = c.brain; b.style = null; b.noise = 1; b.noiseT = 1e9; b.thrCutT = 0; b.cutS = null; b.brkK = 1; };

if (!isMainThread) {
  const F1 = require('./load')(LOAD);
  F1.Race.THINK.on = false;
  let key = null, race = null;
  parentPort.on('message', m => {
    try {
      if (m.kind === 'seg') {
        // the candidate's circuit (built once per line), the car put back exactly as it arrived
        // (the circuit is built once; a new line only swaps the racing line and what follows from
        // it: the speed plan, braking zones, and the AI's caches of the line's shape)
        if (m.key !== key) {
          key = m.key;
          const tr = F1.Race.getTrack(m.id);
          F1.Lines[m.id] = m.line;
          F1.Raceline.applyLine(tr, F1.Raceline.lineFromOffsets(tr, F1.Raceline.storedOffsets(tr)));
          delete tr.insideSgn; delete tr.styleEnv; delete tr.aiCorners;
          race = F1.Race.create({ track: m.id, mode: 'tt', laps: 99, difficulty: 4, team: 0, driver: 0, seed: 7, field: 1, spectate: true, assists: {} });
          race.autoPlayer = true; plain(race.player);
        }
        const c = race.player, tr = race.track, hold = holdOf(c, tr);
        Object.assign(race, m.raceVals);
        F1.Race.thinkParts.setCarState(c, m.st);
        // (alone on the circuit: the state leaves the other cars out, so the car's view of them is reset)
        const b = c.brain; b.near = []; b.nds = []; b.senseT = 0; b.ahead = b.behind = b.alongside = b.target = b.rival = b.hazard = b.blk = null;
        plain(c);
        race.fx.length = 0; race.events.length = 0;
        const d0 = c.dist, t0 = race.time;
        let walls = 0, off = 0;
        while (c.dist - d0 < m.len && race.time - t0 < 40) {
          hold(); F1.Race.step(race, 1 / 240);
          for (const f of race.fx) if (f.type === 'wall') walls++;
          race.fx.length = 0;
          if (Math.abs(c.loc.d) > tr.hw + 0.8) off += 1 / 240;
        }
        parentPort.postMessage({ t: race.time - t0, v: c.speed, walls, off });
      } else if (m.kind === 'lap') {
        F1.Race.THINK.on = m.think;
        const r = soloRace(F1, m.id, m.line), c = r.player, tr = r.track, hold = holdOf(c, tr);
        let g = 0, walls = 0, lastW = -9;
        while (c.lapTimes.length < m.laps + 1 && g++ < 240 * 300 * (m.laps + 1)) {
          hold(); F1.Race.step(r, 1 / 240);
          for (const f of r.fx) if (f.type === 'wall' && r.time - lastW > 1) { walls++; lastW = r.time; }
          r.fx.length = 0;
        }
        F1.Race.THINK.on = false; key = null; F1.Race.forgetTrack(m.id);
        const t = c.lapTimes.slice(1).map(l => l.t);
        parentPort.postMessage({ best: t.length ? Math.min(...t) : 999, walls });
      }
    } catch (e) { parentPort.postMessage({ err: String(e && e.stack || e) }); }
  });
} else {
  const F1 = require('./load')(LOAD);
  const id = process.argv[2] || 'montaurele', GENS = +(process.env.GENS || 25), LAMBDA = 12, MU = 6, K = 7;
  const T0 = Date.now();
  // a pool of workers that keep their circuit between jobs
  const NT = Math.max(1, os.cpus().length - 1), pool = [];
  for (let k = 0; k < NT; k++) pool.push(new Worker(__filename));
  const runJobs = (jobs, label) => new Promise(ok => {
    const out = new Array(jobs.length); let next = 0, done = 0;
    const feed = w => { if (next >= jobs.length) return; const k = next++; w.once('message', m => { if (m.err) { console.error('\n' + m.err); out[k] = { t: 99, v: 0, walls: 9, off: 9, best: 999 }; } else out[k] = m; done++; if (label) process.stdout.write(`\r  ${label} [${'#'.repeat(Math.round(30 * done / jobs.length)).padEnd(30, '.')}] ${done}/${jobs.length} `); if (done === jobs.length) { if (label) process.stdout.write('\n'); ok(out); } else feed(w); }); w.postMessage(jobs[k]); };
    pool.forEach(feed);
  });
  // (jobs carrying the same line on the same worker reuse its circuit: they are grouped by line)
  const tr = F1.Tracks.build(F1.Tracks.byId(id)), N = tr.N, ds = tr.ds, st = F1.Lines.stride, base = Array.from(F1.Lines[id]);
  const lim = F1.Raceline.lineLimits(tr);
  const full = arr => { const o = new Float64Array(N); for (let i = 0; i < N; i++) { const f = i / st, k = Math.floor(f) % arr.length, t = f - Math.floor(f); o[i] = arr[k] + (arr[(k + 1) % arr.length] - arr[k]) * t; } return o; };
  const pack = o => { const out = new Array(Math.ceil(N / st)); for (let k = 0; k < out.length; k++) out[k] = +o[(k * st) % N].toFixed(3); return out; };
  // the slow corners, from the plan (as tools/linelearn.js)
  const race0 = soloRace(F1, id, base), prof = race0.cars[0].brain.prof, spans = [];
  for (let i = 0; i < N; i++) {
    const v = prof[i];
    if (v < 44 && v <= prof[(i - 1 + N) % N] && v < prof[(i + 1) % N]) {
      let s0 = i, s1 = i;
      while (prof[(s0 - 1 + N) % N] < v + 8 && i - s0 < 150 / ds) s0--;
      while (prof[(s1 + 1) % N] < v + 8 && s1 - i < 150 / ds) s1++;
      const sp = { a: Math.round(s0 * ds), b: Math.round(s1 * ds), v }, last = spans[spans.length - 1];
      if (!last || sp.a > last.b + 20) spans.push(sp); else { last.b = Math.max(last.b, sp.b); last.v = Math.min(last.v, sp.v); }
    }
  }
  // where each corner's test starts (150 m before it) and the car's state there, from a lap on the stored line
  const L = tr.L;
  // (the test runs on to 350 m past the corner, and the score charges a slow exit for the next
  // 150 m as well: a line that reaches the end sooner but leaves slower, or badly placed for the next
  // bend, loses that over a lap)
  for (const sp of spans) { sp.e = ((sp.a - 150) % L + L) % L; sp.len = (sp.b + 350) - (sp.a - 150); }
  {
    const r = race0, c = r.player, hold = holdOf(c, r.track);
    F1.Race.THINK.on = false;
    let prevS = c.loc.s, g = 0;
    const need = new Set(spans);
    while (need.size && g++ < 240 * 400) {
      hold(); F1.Race.step(r, 1 / 240); r.fx.length = 0; r.events.length = 0;
      if (c.lapTimes.length >= 1) for (const sp of need) {
        // (a lap wrap only when the distance drops by more than half the lap: in a slow hairpin it can
        // step back a fraction of a metre)
        const s = c.loc.s, wrap = prevS - s > L / 2, cross = wrap ? prevS < sp.e || s >= sp.e : prevS < sp.e && s >= sp.e;
        if (cross) {
          const rv = {}; for (const k in r) { const v = r[k]; if (v === null || typeof v !== 'object' && typeof v !== 'function') rv[k] = v; }
          sp.st = F1.Race.thinkParts.carState(r, c); sp.raceVals = rv; need.delete(sp);
        }
      }
      prevS = c.loc.s;
    }
  }
  console.log(`${id}: ${spans.length} slow corners: ${spans.map(p => `${p.a}-${p.b} m`).join(', ')}`);
  if (process.env.DEBUG) console.log('  test starts at', spans.map(sp => `${Math.round(sp.e)}:${sp.st ? Math.round(sp.st.car.loc.s) + '/' + (sp.st.car.speed * 3.6).toFixed(0) + 'kmh/len' + Math.round(sp.len) : 'none'}`).join(' '));
  // a line with one corner's control points moved by x (metres, + toward the right of the road)
  const knots = sp => Array.from({ length: K }, (_, k) => sp.a - 60 + (sp.b - sp.a + 120) * k / (K - 1));
  const bend = (arr, sp, x) => {
    const off = full(arr), ks = knots(sp), w = (ks[1] - ks[0]) / ds;
    for (let k = 0; k < K; k++) { const c = Math.round(ks[k] / ds); for (let q = -Math.ceil(2.5 * w); q <= Math.ceil(2.5 * w); q++) { const i = (c + q + N) % N; off[i] += x[k] * Math.exp(-0.5 * (q / w) ** 2); } }
    for (let i = 0; i < N; i++) off[i] = lim.clamp(i, off[i]);
    return pack(off);
  };
  const scoreOf = r => r.t + 150 / Math.max(5, r.v) + 5 * r.walls + 2 * r.off;
  (async () => {
    // the stored line's own time through each corner
    const baseRes = await runJobs(spans.map(sp => ({ kind: 'seg', key: 'base', id, line: base, st: sp.st, raceVals: sp.raceVals, len: sp.len })), 'stored line');
    spans.forEach((sp, k) => { sp.ref = scoreOf(baseRes[k]); sp.mean = new Array(K).fill(0); sp.sigma = 1.2; sp.best = sp.ref; sp.bestX = new Array(K).fill(0); });
    const rnd = (() => { let s = 12345; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();
    const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const wts = Array.from({ length: MU }, (_, k) => Math.log(MU + 0.5) - Math.log(k + 1)), ws = wts.reduce((a, b) => a + b, 0);
    let evals = 0;
    for (let gen = 0; gen < GENS; gen++) {
      const jobs = [], meta = [];
      for (const sp of spans) for (let k = 0; k < LAMBDA; k++) {
        const z = Array.from({ length: K }, gauss), x = sp.mean.map((m, d) => m + sp.sigma * z[d]);
        jobs.push({ kind: 'seg', key: `${sp.a}:${gen}:${k}`, id, line: bend(base, sp, x), st: sp.st, raceVals: sp.raceVals, len: sp.len });
        meta.push({ sp, x });
      }
      const res = await runJobs(jobs, `generation ${gen + 1}/${GENS}`);
      evals += jobs.length;
      for (const sp of spans) {
        const mine = meta.map((m, k) => ({ ...m, s: scoreOf(res[k]) })).filter(m => m.sp === sp).sort((a, b) => a.s - b.s);
        const prevBest = sp.best;
        if (mine[0].s < sp.best) { sp.best = mine[0].s; sp.bestX = mine[0].x; }
        // weighted recombination of the best half; the step grows after a gain and shrinks otherwise
        sp.mean = sp.mean.map((_, d) => mine.slice(0, MU).reduce((a, m, k) => a + wts[k] * m.x[d], 0) / ws);
        sp.sigma = Math.max(0.15, Math.min(2.5, sp.sigma * (sp.best < prevBest - 0.005 ? 1.15 : 0.85)));
      }
      if (process.env.DEBUG) for (const sp of spans) console.log(`      ${sp.a} m: ref ${sp.ref.toFixed(3)} best ${sp.best.toFixed(3)} sigma ${sp.sigma.toFixed(2)} gen scores ${meta.map((m, k) => m.sp === sp ? scoreOf(res[k]).toFixed(2) : null).filter(Boolean).slice(0, 6).join(' ')}`);
      const el = (Date.now() - T0) / 1000, left = el / (gen + 1) * (GENS - gen - 1);
      console.log(`    gain so far ${spans.reduce((a, sp) => a + (sp.best - sp.ref), 0).toFixed(2)} s over all corners, ${Math.round(el)} s, about ${Math.ceil(left / 60)} min left`);
    }
    // the corners that gained, each with its best control points, then full-lap checks
    const won = spans.filter(sp => sp.best < sp.ref - 0.03).sort((a, b) => (a.best - a.ref) - (b.best - b.ref));
    for (const sp of won) console.log(`  ${sp.a}-${sp.b} m: ${(sp.best - sp.ref).toFixed(2)} s through the corner, points ${sp.bestX.map(x => x.toFixed(1)).join(' ')}`);
    const lap = (line, think) => ({ kind: 'lap', id, line, think, laps: 3 });
    const lapsOf = async line => { const [p, t] = await runJobs([lap(line, false), lap(line, true)]); return { p, t }; };
    let cur = base, ref = await lapsOf(cur);
    const start = ref;
    console.log(`  stored line: plan ${ref.p.best.toFixed(2)} s (walls ${ref.p.walls}), look-ahead ${ref.t.best.toFixed(2)} s (walls ${ref.t.walls})`);
    const ok = sc => sc.p.best < ref.p.best - 0.02 && sc.t.best < ref.t.best + 0.05 && sc.p.walls <= ref.p.walls && sc.t.walls <= ref.t.walls;
    // all together first; if that fails, one by one
    let all = cur; for (const sp of won) all = bend(all, sp, sp.bestX);
    let sc = won.length ? await lapsOf(all) : null, kept = 0;
    if (sc && ok(sc)) { cur = all; ref = sc; kept = won.length; }
    else for (const sp of won) { const cand = bend(cur, sp, sp.bestX); const s2 = await lapsOf(cand); if (ok(s2)) { cur = cand; ref = s2; kept++; console.log(`    kept ${sp.a} m: plan ${s2.p.best.toFixed(2)}, look-ahead ${s2.t.best.toFixed(2)}`); } }
    console.log(`${id}: plan ${start.p.best.toFixed(2)} -> ${ref.p.best.toFixed(2)} s, look-ahead ${start.t.best.toFixed(2)} -> ${ref.t.best.toFixed(2)} s, ${kept} corner(s) learned, ${evals} corner runs, ${((Date.now() - T0) / 60000).toFixed(1)} min`);
    if (process.env.WRITE && kept) {
      F1.Lines[id] = cur;
      const P = path.join(__dirname, '..', 'js', 'lines.js'), head = fs.readFileSync(P, 'utf8').split('G.F1.Lines = ')[0];
      let s = head + 'G.F1.Lines = { stride: ' + st + ',\n';
      for (const k of Object.keys(F1.Lines)) if (k !== 'stride' && F1.Lines[k]) s += `    ${/^[a-z]\w*$/i.test(k) ? k : JSON.stringify(k)}: [${Array.from(F1.Lines[k]).join(',')}],\n`;
      fs.writeFileSync(P, s + "  };\n})(typeof window !== 'undefined' ? window : globalThis);\n");
      console.log('stored in js/lines.js');
    }
    pool.forEach(w => w.terminate());
  })();
}
