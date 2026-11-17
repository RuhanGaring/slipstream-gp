// Learn racing line from a human: SAVE RACE DATA files (Downloads/slipstream-race-*.json) carry
// every car's path. Where the player's best clean lap carries more speed through a corner than the
// AI's line allows, this grafts the player's line there into the circuit's stored line (js/lines.js),
// one corner at a time, and keeps a graft only if a Legend car alone then laps quicker with no more
// wall hits, both on its plan and with the look-ahead. Each candidate is tried on its own worker
// thread.
//   node tools/linegraft.js FILE.json [FILE2.json ...]   (WRITE=1 stores the kept grafts)
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const fs = require('fs'), path = require('path'), os = require('os');
const LOAD = ['util.js', 'tracks.js', 'car.js', 'damage.js', 'softbody.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js'];

function lapOf(F1, id, lineArr, think, laps) {
  if (lineArr) F1.Lines[id] = lineArr;
  F1.Race.THINK.on = think;
  F1.Race.forgetTrack && F1.Race.forgetTrack(id);
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
  return { best: t.length ? Math.min(...t) : 999, mean: t.length ? t.reduce((a, b) => a + b, 0) / t.length : 999, walls };
}

if (!isMainThread) {
  const F1 = require('./load')(LOAD);
  const { id, line, think, laps } = workerData;
  parentPort.postMessage(lapOf(F1, id, line, think, laps));
} else {
  const F1 = require('./load')(LOAD);
  const files = process.argv.slice(2).filter(f => f.endsWith('.json'));
  if (!files.length) { console.log('usage: node tools/linegraft.js FILE.json [...]'); process.exit(1); }
  // the player's best valid lap in each file: offsets d by distance s, every metre
  let id = null;
  const humans = [];
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    id = id || d.track;
    if (d.track !== id) { console.log('skipped (another circuit):', f); continue; }
    const A = new Float32Array(Buffer.from(d.samples, 'base64').buffer.slice(0)), n = d.cars.length, NF = d.nf, FI = Object.fromEntries(d.fields.map((k, i) => [k, i]));
    const at = (fr, c, k) => A[(fr * n + c) * NF + FI[k]];
    const pc = d.cars.findIndex(c => c.player), laps = d.cars[pc].lapTimes;
    let bl = -1, bt = 1e9;
    laps.forEach((l, k) => { if (k > 0 && l.valid && l.t < bt) { bt = l.t; bl = k + 1; } });
    if (bl < 0) { console.log('no clean lap in', f); continue; }
    const off = new Map(), spd = new Map();
    for (let fr = 0; fr < d.frames; fr++) {
      if (Math.round(at(fr, pc, 'lap')) !== bl || (at(fr, pc, 'flags') & 16)) continue;
      const s = Math.round(at(fr, pc, 's'));
      off.set(s, at(fr, pc, 'd')); spd.set(s, at(fr, pc, 'speed'));
    }
    humans.push({ f, lap: bt, off, spd });
    console.log(path.basename(f), 'player best lap', bt.toFixed(3), 'samples', off.size);
  }
  if (!humans.length) process.exit(1);
  const H = humans.sort((a, b) => a.lap - b.lap)[0];
  const tr = F1.Race.getTrack(id), N = tr.N, ds = tr.ds, st = F1.Lines.stride, base = Array.from(F1.Lines[id]);
  // the player's offset at every stored point (filled between samples, smoothed over 6 m)
  const L = Math.round(tr.L), ho = new Float64Array(L).fill(NaN), hv = new Float64Array(L).fill(NaN);
  for (const [s, o] of H.off) if (s >= 0 && s < L) { ho[s] = o; hv[s] = H.spd.get(s); }
  for (let s = 0; s < L; s++) if (isNaN(ho[s])) { let a = s, b = s; while (isNaN(ho[(a + L) % L]) && s - a < 40) a--; while (isNaN(ho[b % L]) && b - s < 40) b++; const oa = ho[(a + L) % L], ob = ho[b % L]; if (!isNaN(oa) && !isNaN(ob)) { ho[s] = oa + (ob - oa) * (s - a) / Math.max(1, b - a); hv[s] = hv[(a + L) % L]; } }
  const sm = new Float64Array(L);
  for (let s = 0; s < L; s++) { let a = 0, n2 = 0; for (let q = -3; q <= 3; q++) { const v = ho[(s + q + L) % L]; if (!isNaN(v)) { a += v; n2++; } } sm[s] = n2 ? a / n2 : NaN; }
  // where the player is quicker than the AI's own plan: corners whose minimum speed the human beats
  const race = F1.Race.create({ track: id, mode: 'tt', laps: 99, difficulty: 4, team: 0, driver: 0, seed: 7, field: 1, spectate: true, assists: {} });
  const prof = race.cars[0].brain.prof;
  const spans = [];
  let inSpan = null;
  for (let s = 0; s < L; s++) {
    const i = Math.floor(s / ds) % N, gain = (hv[s] || 0) - prof[i];
    if (gain > 4 && prof[i] < 45) { if (!inSpan) inSpan = { a: s, b: s, g: 0 }; inSpan.b = s; inSpan.g = Math.max(inSpan.g, gain); } else if (inSpan && s - inSpan.b > 25) { spans.push(inSpan); inSpan = null; }
  }
  if (inSpan) spans.push(inSpan);
  console.log('corners where the human carries more speed than the plan:', spans.map(p => `${p.a}-${p.b} m (+${(p.g * 3.6).toFixed(0)} km/h)`).join(', ') || 'none');
  const graft = (arr, sp) => {
    const out = arr.slice(), a = sp.a - 60, b = sp.b + 60, ramp = 30;
    for (let s = a; s <= b; s++) {
      const ss = (s + L) % L, k = Math.round(ss / ds / st) % out.length, o = sm[ss];
      if (isNaN(o)) continue;
      const w = Math.min(1, (s - a) / ramp, (b - s) / ramp);
      const lim = tr.hw - 0.6;
      out[k] = +(arr[k] + (Math.max(-lim, Math.min(lim, o)) - arr[k]) * (0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, w)))).toFixed(3);
    }
    return out;
  };
  const NT = Math.max(1, os.cpus().length - 1);
  const run = jobs => new Promise(ok => {
    const out = new Array(jobs.length); let next = 0, done = 0;
    const go = () => { while (next < jobs.length && next - done < NT) { const k = next++; const w = new Worker(__filename, { workerData: jobs[k] }); w.on('message', m => { out[k] = m; }); w.on('exit', () => { done++; process.stdout.write(`\r  ${done}/${jobs.length} laps run `); if (done === jobs.length) { process.stdout.write('\n'); ok(out); } else go(); }); } };
    go();
  });
  (async () => {
    let cur = base;
    // APPLY=a-b,c-d: graft these corners (from an earlier run's 'kept' list) and store, no laps run
    if (process.env.APPLY) {
      for (const r of process.env.APPLY.split(',')) { const [a, b] = r.split('-').map(Number); cur = graft(cur, { a, b }); }
      F1.Lines[id] = cur;
      const P = path.join(__dirname, '..', 'js', 'lines.js'), head = fs.readFileSync(P, 'utf8').split('G.F1.Lines = ')[0];
      let s = head + 'G.F1.Lines = { stride: ' + st + ',\n';
      for (const k of Object.keys(F1.Lines)) if (k !== 'stride' && F1.Lines[k]) s += `    ${/^[a-z]\w*$/i.test(k) ? k : JSON.stringify(k)}: [${Array.from(F1.Lines[k]).join(',')}],\n`;
      fs.writeFileSync(P, s + "  };\n})(typeof window !== 'undefined' ? window : globalThis);\n");
      console.log('grafted', process.env.APPLY, 'and stored in js/lines.js');
      return;
    }
    const score = async arr => { const [p, t] = await run([{ id, line: arr, think: false, laps: 3 }, { id, line: arr, think: true, laps: 3 }]); return { p, t }; };
    let ref = await score(cur);
    console.log(`stored line: plan ${ref.p.best.toFixed(2)} s (walls ${ref.p.walls}), look-ahead ${ref.t.best.toFixed(2)} s (walls ${ref.t.walls})`);
    // every corner tried at once against the stored line, then kept one by one, best first
    const tries = await run(spans.flatMap(sp => [{ id, line: graft(cur, sp), think: false, laps: 3 }, { id, line: graft(cur, sp), think: true, laps: 3 }]));
    const gains = spans.map((sp, k) => ({ sp, p: tries[2 * k], t: tries[2 * k + 1] })).map(o => ({ ...o, d: (o.p.best - ref.p.best) + (o.t.best - ref.t.best) }));
    gains.sort((x, y) => x.d - y.d);
    for (const g of gains) console.log(`  ${g.sp.a}-${g.sp.b} m: plan ${(g.p.best - ref.p.best).toFixed(2)} s walls ${g.p.walls}, look-ahead ${(g.t.best - ref.t.best).toFixed(2)} s walls ${g.t.walls}`);
    const kept = [];
    for (const g of gains) {
      if (g.d > -0.05 || g.p.walls > ref.p.walls || g.t.walls > ref.t.walls) continue;
      const cand = graft(cur, g.sp), sc = await score(cand);
      if (sc.p.best < ref.p.best - 0.02 && sc.t.best < ref.t.best + 0.05 && sc.p.walls <= ref.p.walls && sc.t.walls <= ref.t.walls) { cur = cand; ref = sc; kept.push(g.sp); console.log(`  kept ${g.sp.a}-${g.sp.b} m: plan ${sc.p.best.toFixed(2)}, look-ahead ${sc.t.best.toFixed(2)}`); }
    }
    console.log(`result: plan ${ref.p.best.toFixed(2)} s, look-ahead ${ref.t.best.toFixed(2)} s, ${kept.length} corner(s) from the human`);
    if (process.env.WRITE && kept.length) {
      F1.Lines[id] = cur;
      const P = path.join(__dirname, '..', 'js', 'lines.js'), head = fs.readFileSync(P, 'utf8').split('G.F1.Lines = ')[0];
      let s = head + 'G.F1.Lines = { stride: ' + st + ',\n';
      for (const k of Object.keys(F1.Lines)) if (k !== 'stride' && F1.Lines[k]) s += `    ${/^[a-z]\w*$/i.test(k) ? k : JSON.stringify(k)}: [${Array.from(F1.Lines[k]).join(',')}],\n`;
      fs.writeFileSync(P, s + "  };\n})(typeof window !== 'undefined' ? window : globalThis);\n");
      console.log('stored in js/lines.js');
    }
  })();
}
