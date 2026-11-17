// The AI learns its own corner lines, by driving. Every slow corner of a circuit gets five control
// points along it, and a search nudges each inward or outward, screening with a Legend car alone on
// its plan, keeping what is quicker with no more wall hits (checked on the plan and with the
// look-ahead), and halving the step when nothing gains. A human's laps at Mont-Aurele showed the
// kind of change that pays (outside on entry, then hugging the inside from the apex on); the search
// finds such shapes by itself, on any circuit with a stored line.
// Every candidate lap runs on its own worker thread.
//   node tools/linelearn.js TRACK [TRACK...]   (WRITE=1 stores what it keeps in js/lines.js)
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const fs = require('fs'), path = require('path'), os = require('os');
const LOAD = ['util.js', 'tracks.js', 'car.js', 'damage.js', 'softbody.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js'];

function lapOf(F1, id, lineArr, think, laps) {
  if (lineArr) F1.Lines[id] = lineArr;
  F1.Race.THINK.on = think;
  const race = F1.Race.create({ track: id, mode: 'tt', laps: 99, difficulty: 4, team: 0, driver: 0, seed: 7, field: 1, spectate: true, assists: {} });
  race.autoPlayer = true;
  const c = race.player, tr = race.track;
  const hold = () => { for (const w of c.wheels) w.wear = 0; c.fuel = 10; tr.rubber.fill(0.6); };
  let g = 0, walls = 0, lastW = -9;
  while (c.lapTimes.length < laps + 1 && g++ < 240 * 300 * (laps + 1)) {
    hold(); F1.Race.step(race, 1 / 240);
    for (const f of race.fx) if (f.type === 'wall' && race.time - lastW > 1) { walls++; lastW = race.time; }
    race.fx.length = 0;
  }
  const t = c.lapTimes.slice(1).map(l => l.t);
  return { best: t.length ? Math.min(...t) : 999, walls };
}

if (!isMainThread) {
  const F1 = require('./load')(LOAD);
  const { id, line, think, laps } = workerData;
  parentPort.postMessage(lapOf(F1, id, line, think, laps));
} else {
  const F1 = require('./load')(LOAD);
  const ids = process.argv.slice(2);
  const NT = Math.max(1, os.cpus().length - 1);
  const run = jobs => new Promise(ok => {
    const out = new Array(jobs.length); let next = 0, done = 0;
    const go = () => { while (next < jobs.length && next - done < NT) { const k = next++; const w = new Worker(__filename, { workerData: jobs[k] }); w.on('message', m => { out[k] = m; }); w.on('error', e => { out[k] = { best: 999, walls: 99 }; console.error(e.message); }); w.on('exit', () => { done++; process.stdout.write(`\r  [${'#'.repeat(Math.round(30 * done / jobs.length)).padEnd(30, '.')}] ${done}/${jobs.length} laps `); if (done === jobs.length) { process.stdout.write('\n'); ok(out); } else go(); }); } };
    go();
  });
  const store = () => {
    const P = path.join(__dirname, '..', 'js', 'lines.js'), head = fs.readFileSync(P, 'utf8').split('G.F1.Lines = ')[0];
    let s = head + 'G.F1.Lines = { stride: ' + F1.Lines.stride + ',\n';
    for (const k of Object.keys(F1.Lines)) if (k !== 'stride' && F1.Lines[k]) s += `    ${/^[a-z]\w*$/i.test(k) ? k : JSON.stringify(k)}: [${Array.from(F1.Lines[k]).join(',')}],\n`;
    fs.writeFileSync(P, s + "  };\n})(typeof window !== 'undefined' ? window : globalThis);\n");
  };
  (async () => {
    for (const id of ids) {
      if (!F1.Lines[id]) { console.log(id + ': no stored line, skipped'); continue; }
      const t0 = Date.now();
      const tr = F1.Tracks.build(F1.Tracks.byId(id)), N = tr.N, ds = tr.ds, st = F1.Lines.stride, base = Array.from(F1.Lines[id]);
      const lim = F1.Raceline.lineLimits(tr);
      const race = F1.Race.create({ track: id, mode: 'tt', laps: 99, difficulty: 4, team: 0, driver: 0, seed: 7, field: 1, spectate: true, assists: {} });
      const prof = race.cars[0].brain.prof;
      // the slow corners: stretches where the plan is under 160 km/h, around each one's slowest point
      const spans = [];
      for (let i = 0; i < N; i++) {
        const v = prof[i], a = prof[(i - 1 + N) % N], b = prof[(i + 1) % N];
        if (v < 44 && v <= a && v < b) {
          let s0 = i, s1 = i;
          while (prof[(s0 - 1 + N) % N] < v + 8 && i - s0 < 150 / ds) s0--;
          while (prof[(s1 + 1) % N] < v + 8 && s1 - i < 150 / ds) s1++;
          const sp = { a: Math.round(s0 * ds), b: Math.round(s1 * ds), v };
          const last = spans[spans.length - 1];
          if (!last || sp.a > last.b + 20) spans.push(sp); else { last.b = Math.max(last.b, sp.b); last.v = Math.min(last.v, sp.v); }
        }
      }
      // the stored offsets at every sample, and back
      const full = arr => { const o = new Float64Array(N); for (let i = 0; i < N; i++) { const f = i / st, k = Math.floor(f) % arr.length, t = f - Math.floor(f); o[i] = arr[k] + (arr[(k + 1) % arr.length] - arr[k]) * t; } return o; };
      const pack = o => { const out = new Array(Math.ceil(N / st)); for (let k = 0; k < out.length; k++) out[k] = +o[(k * st) % N].toFixed(3); return out; };
      // a rounder line over one corner: minimum curvature at reach h samples, faded in at the ends
      const relax = (arr, sp, h) => {
        const off = full(arr), o0 = Float64Array.from(off);
        const i0 = Math.floor((sp.a - 70) / ds), i1 = Math.ceil((sp.b + 70) / ds), W = i1 - i0;
        for (const hh of [h, Math.max(1, h >> 1), 1]) for (let it = 0; it < 160; it++) {
          for (let q = 1; q < W; q++) {
            const i = (i0 + q + N) % N, a = (i - hh + N) % N, b = (i + hh) % N;
            const ax = tr.x[a] + tr.nx[a] * off[a], ay = tr.y[a] + tr.ny[a] * off[a], bx = tr.x[b] + tr.nx[b] * off[b], by = tr.y[b] + tr.ny[b] * off[b];
            const o = ((ax + bx) / 2 - tr.x[i]) * tr.nx[i] + ((ay + by) / 2 - tr.y[i]) * tr.ny[i];
            off[i] = lim.clamp(i, off[i] + (o - off[i]) * 0.8);
          }
        }
        const ramp = Math.round(30 / ds);
        for (let q = 0; q <= W; q++) { const i = (i0 + q + N) % N, w = Math.min(1, q / ramp, (W - q) / ramp), k = 0.5 - 0.5 * Math.cos(Math.PI * w); off[i] = o0[i] + (off[i] - o0[i]) * k; }
        for (let i = 0; i < N; i++) if (!((i - i0 + N) % N <= W)) off[i] = o0[i];
        return pack(off);
      };
      // the other family, the one a human's laps showed: turn in earlier and hug the inside of the bend
      // (the line moved toward the inside by k metres over the corner), or the whole corner's shape
      // slid earlier or later along the road (an earlier or later apex)
      const sideOf = sp => { let k = 0; for (let s = sp.a; s <= sp.b; s += 2) k += tr.kap[Math.floor(s / ds) % N]; return Math.sign(k) || 1; };
      const shape = (arr, sp, kind, amt) => {
        const off = full(arr), o0 = Float64Array.from(off);
        const i0 = Math.floor((sp.a - 60) / ds), i1 = Math.ceil((sp.b + 50) / ds), W = i1 - i0, ramp = Math.round(30 / ds);
        // (the inside of the bend has the sign of the road's curvature: at Mont-Aurele 1940 m the
        // curvature is negative and the human's line went to negative offsets)
        const inSide = sideOf(sp);
        for (let q = 0; q <= W; q++) {
          const i = (i0 + q + N) % N, w = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, q / ramp, (W - q) / ramp));
          let v = o0[i];
          if (kind === 'in') v = o0[i] + inSide * amt * w;
          else { const j = (i + Math.round(amt / ds) + N) % N; v = o0[i] + (o0[j] - o0[i]) * w; }
          off[i] = lim.clamp(i, v);
        }
        return pack(off);
      };
      const KINDS = [['in', 1], ['in', 2], ['in', 3], ['shift', 8], ['shift', 16], ['shift', -8]];
      const REACH = [4, 8, 14].map(m => Math.max(2, Math.round(m * 2 / ds)));
      console.log(`${id}: ${spans.length} slow corners: ${spans.map(p => `${p.a}-${p.b} m (${(p.v * 3.6).toFixed(0)} km/h)`).join(', ')}`);
      const score = async arr => { const [p, t] = await run([{ id, line: arr, think: false, laps: 3 }, { id, line: arr, think: true, laps: 3 }]); return { p, t }; };
      let cur = base, ref = await score(cur);
      const start = { p: ref.p.best, t: ref.t.best };
      console.log(`  stored line: plan ${ref.p.best.toFixed(2)} s (walls ${ref.p.walls}), look-ahead ${ref.t.best.toFixed(2)} s (walls ${ref.t.walls})`);
      // A search per corner: five control points (40 m before it, its entry, middle and exit, 40 m
      // after), each a smooth bump of the line inward or outward. Every round tries each point one
      // step either way on every corner at once (plan laps, quick), keeps per corner the move that
      // gained most, checks all the kept moves together, and halves the step when nothing gains.
      const knotsOf = sp => [sp.a - 40, sp.a, (sp.a + sp.b) / 2, sp.b, sp.b + 40];
      const bend = (arr, moves) => {
        const off = full(arr), w = Math.round(22 / ds);
        for (const { s, d } of moves) { const c = Math.round(s / ds); for (let q = -2 * w; q <= 2 * w; q++) { const i = (c + q + N) % N; off[i] += d * Math.exp(-0.5 * (q / w) ** 2); } }
        for (let i = 0; i < N; i++) off[i] = lim.clamp(i, off[i]);
        return pack(off);
      };
      let step = 1.2, kept = 0;
      // first the family a human's laps showed: outside on entry, then inside from a turn-in point
      // to an exit point; where it starts, ends and how far in, all tried per corner at once
      {
        const inSideOf = sp => { let k = 0; for (let s0 = sp.a; s0 <= sp.b; s0 += 2) k += tr.kap[Math.floor(s0 / ds) % N]; return Math.sign(k) || 1; };
        const hug = (arr, c) => {
          const off = full(arr), sg = inSideOf(c.sp), rin = Math.round(15 / ds), rout = Math.round(30 / ds);
          const i0 = Math.round(c.s0 / ds), i1 = Math.round(c.s1 / ds);
          for (let q = i0 - rin; q <= i1 + rout; q++) {
            const i = (q + N) % N, w = q < i0 ? (q - (i0 - rin)) / rin : q > i1 ? 1 - (q - i1) / rout : 1;
            off[i] = lim.clamp(i, off[i] + sg * c.k * (0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, w)))));
          }
          return pack(off);
        };
        const fam = spans.flatMap(sp => [sp.a - 20, sp.a, sp.a + 15].flatMap(s0 => [sp.b + 20, sp.b + 50].flatMap(s1 => [1.5, 2.5, 3.5].map(k => ({ sp, s0, s1, k })))));
        const res = await run(fam.map(c => ({ id, line: hug(cur, c), think: false, laps: 2 })));
        const bestPer = new Map();
        fam.forEach((c, k) => { const g = res[k].best - ref.p.best; if (res[k].walls <= ref.p.walls && g < -0.03 && (!bestPer.has(c.sp) || g < bestPer.get(c.sp).g)) bestPer.set(c.sp, { ...c, g }); });
        const order = [...bestPer.values()].sort((x, y) => x.g - y.g);
        console.log(`    inside lines: ${order.length} corner(s) gain${order.length ? ' (' + order.map(m => `${m.sp.a} m ${m.g.toFixed(2)} s, ${m.k} m in from ${Math.round(m.s0)} to ${Math.round(m.s1)}`).join('; ') + ')' : ''}`);
        for (const c of order) {
          const cand = hug(cur, c), sc = await score(cand);
          if (sc.p.best < ref.p.best - 0.02 && sc.t.best < ref.t.best + 0.05 && sc.p.walls <= ref.p.walls && sc.t.walls <= ref.t.walls) { cur = cand; ref = sc; kept++; console.log(`      kept ${c.sp.a} m: plan ${sc.p.best.toFixed(2)} s, look-ahead ${sc.t.best.toFixed(2)} s`); }
        }
      }
      const ROUNDS = +(process.env.ROUNDS || 4);
      for (let round = 0; round < ROUNDS && step >= 0.3; round++) {
        const cands = spans.flatMap(sp => knotsOf(sp).flatMap(s0 => [step, -step].map(d => ({ sp, s: s0, d }))));
        const res = await run(cands.map(c => ({ id, line: bend(cur, [c]), think: false, laps: 2 })));
        const bestPer = new Map();
        cands.forEach((c, k) => { const g = res[k].best - ref.p.best; if (res[k].walls <= ref.p.walls && g < -0.02 && (!bestPer.has(c.sp) || g < bestPer.get(c.sp).g)) bestPer.set(c.sp, { ...c, g }); });
        const moves = [...bestPer.values()];
        console.log(`    round ${round + 1}, step ${step.toFixed(2)} m: ${moves.length} corner(s) gain${moves.length ? ' (' + moves.map(m => `${m.sp.a} m ${m.g.toFixed(2)} s`).join(', ') + ')' : ''}`);
        if (!moves.length) { step /= 2; continue; }
        // all the round's moves together; if that loses, the single best one alone
        let cand = bend(cur, moves), sc = await score(cand);
        if (!(sc.p.best < ref.p.best - 0.02 && sc.p.walls <= ref.p.walls && sc.t.walls <= ref.t.walls && sc.t.best < ref.t.best + 0.05)) {
          const one = moves.sort((x, y) => x.g - y.g)[0];
          cand = bend(cur, [one]); sc = await score(cand);
          if (!(sc.p.best < ref.p.best - 0.02 && sc.p.walls <= ref.p.walls && sc.t.walls <= ref.t.walls && sc.t.best < ref.t.best + 0.05)) { step /= 2; continue; }
        }
        cur = cand; ref = sc; kept++;
        console.log(`      now plan ${sc.p.best.toFixed(2)} s, look-ahead ${sc.t.best.toFixed(2)} s`);
      }
      console.log(`  ${id}: plan ${start.p.toFixed(2)} -> ${ref.p.best.toFixed(2)} s, look-ahead ${start.t.toFixed(2)} -> ${ref.t.best.toFixed(2)} s, ${kept} round(s) kept, ${Math.round((Date.now() - t0) / 60000)} min`);
      if (process.env.WRITE && kept) { F1.Lines[id] = cur; store(); console.log('  stored in js/lines.js'); }
    }
  })();
}
