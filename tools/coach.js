// A driving coach. The speed plan comes from a model of the car, so it is only ever a guess at what
// the real physics will take. This finds out by trying it: a lone car drives flying laps with every
// corner of the plan nudged a little (corner speed or brake point, up or down), the time of each
// stretch of road is compared with the plan as it stands, and a nudge is kept only where the car
// was truly quicker there and stayed clean. Stretches run from one braking point to the next, so a
// single lap tests every corner at once and a corner is judged on what it does for the straight
// after it too. Runs on every thread the machine has.
// usage: node tools/coach.js <track,track|all> [rounds]    writes OUT/<track>.json (default tools/data/coach)
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const fs = require('fs'), os = require('os'), path = require('path');
const LOAD = ['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js'];
const DT = 1 / 240;
if (!isMainThread) {
  const F1 = require('./load')(LOAD);
  const { id } = workerData;
  const race = F1.Race.create({ track: id, mode: 'tt', laps: 4, difficulty: 4, team: 0, driver: 0, seed: 7, field: 1, assists: {} });
  race.autoPlayer = true;
  const c = race.player, tr = race.track, E = F1.Raceline.lineLimits(tr);
  const lap = (g, gB, segEnd) => {
    // one lap to settle on this plan, then a flying lap timed stretch by stretch
    c.brain.prof = F1.Raceline.speedProfile(tr, tr.line, c.spec, { pace: 1, grip: g, gripB: gB, brakePace: 1, brake: 1 });
    const n = segEnd.length, t = new Float64Array(n), bad = new Uint8Array(n);
    // (every test on the same fresh tyres and the same tank, or a long session drifts away from itself)
    for (const w of c.wheels) w.wear = +process.env.COACH_WEAR || 0;
    c.fuel = +process.env.COACH_FUEL || 10;
    const wait0 = c.lapTimes.length; let g0 = 0;
    while (c.lapTimes.length === wait0 && g0++ < 240 * 400) { F1.Race.step(race, DT); race.fx.length = 0; }
    const start = race.time; let k = 0;
    const wait = c.lapTimes.length; let guard = 0;
    while (c.lapTimes.length === wait && guard++ < 240 * 400) {
      F1.Race.step(race, DT);
      for (const f of race.fx) if (f.type === 'wall' && f.power > 2) bad[k] = 1;
      race.fx.length = 0;
      const s = c.loc.s, i = c.loc.i;
      if (c.loc.d < -E.L[i] - 1.1 || c.loc.d > E.R[i] + 1.1 || (Math.abs(c.r) > 1.6 && c.speed > 20 && Math.abs(c.v) > 6)) bad[k] = 1;
      while (k < n - 1 && s >= segEnd[k] && s < segEnd[k] + 200) { t[k] = race.time - start; k++; }
    }
    t[n - 1] = race.time - start;
    const tot = t[n - 1];
    for (let q = n - 1; q > 0; q--) t[q] -= t[q - 1];
    if (guard >= 240 * 400) bad.fill(1);
    return { t: Array.from(t), bad: Array.from(bad), tot };
  };
  parentPort.on('message', m => { parentPort.postMessage({ k: m.k, r: lap(Float64Array.from(m.g), Float64Array.from(m.gB), m.segEnd) }); });
  parentPort.postMessage({ ready: true });
} else {
  const F1 = require('./load')(LOAD);
  const ids = !process.argv[2] || process.argv[2] === 'all' ? F1.Tracks.DEFS.map(d => d.id) : process.argv[2].split(',');
  const ROUNDS = +process.argv[3] || 14, OUT = process.env.OUT || path.join(__dirname, 'data', 'coach');
  const NT = Math.max(2, os.cpus().length - 1);
  fs.mkdirSync(OUT, { recursive: true });
  const coach = async id => {
    const tr = F1.Race.getTrack(id), N = tr.N, g0 = F1.Race.learnedGrip(tr, 'sim') || new Float64Array(N).fill(1);
    const ws = await Promise.all(Array.from({ length: NT }, () => new Promise(res => { const w = new Worker(__filename, { workerData: { id } }); w.once('message', () => res(w)); })));
    const call = (w, msg) => new Promise(res => { const f = m => { if (m.k === msg.k) { w.off('message', f); res(m.r); } }; w.on('message', f); w.postMessage(msg); });
    // (a circuit already coached carries on from where it got to)
    const gB0 = F1.Race.learnedBrake(tr), base0 = Float64Array.from(g0, x => x * (gB0 ? 1 : 0.95)), baseB0 = gB0 ? Float64Array.from(gB0) : Float64Array.from(g0, x => x * 0.85);
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
    // a stretch's factor over its road, blended across each end
    const W = Math.round(30 / tr.ds);
    const mix = (base, kk) => {
      const o = Float64Array.from(base);
      for (let i = 0; i < N; i++) { let m = 0, c = 0; for (let q = -W; q <= W; q += 3) { m += Math.log(kk[segAt[(i + q + N) % N]]); c++; } o[i] = base[i] * Math.exp(m / c); }
      return o;
    };
    let C = new Float64Array(n).fill(1), B = new Float64Array(n).fill(1), dC = 0.016, dB = 0.05;
    let seq = 0;
    const run = (cs, bs, w) => call(w, { k: ++seq, g: Array.from(mix(base0, cs)), gB: Array.from(mix(baseB0, bs)), segEnd });
    const baseLap = async () => { const rs = await Promise.all(ws.slice(0, 3).map(w => run(C, B, w))); return rs[rs.length - 1]; };
    let base = await baseLap();
    const first = base.tot, firstBad = base.bad.reduce((a, b) => a + b, 0);
    let best = { tot: base.tot, C: C.slice(), B: B.slice() };
    const rnd = F1.U.rng(1234 + id.length);
    for (let rd = 0; rd < ROUNDS; rd++) {
      const arms = Array.from({ length: n }, () => [[], [], [], []]); // corner up, down, brake up, down
      await Promise.all(ws.map(async w => {
        for (let l = 0; l < 3; l++) {
          const cs = C.slice(), bs = B.slice(), pick = new Int8Array(n);
          for (let s = 0; s < n; s++) { const a = Math.floor(rnd() * 4); pick[s] = a; if (a < 2) cs[s] *= a ? 1 - dC : 1 + dC; else bs[s] *= a === 3 ? 1 - dB : 1 + dB; }
          const r = await run(cs, bs, w);
          for (let s = 0; s < n; s++) arms[s][pick[s]].push({ t: r.t[s], bad: r.bad[s] || r.bad[(s + 1) % n] });
        }
      }));
      let moved = 0;
      for (let s = 0; s < n; s++) {
        let bestA = -1, gain = 0.002;
        arms[s].forEach((L, a) => {
          if (!L.length) return;
          const bads = L.filter(x => x.bad).length;
          const ts = L.map(x => x.t).sort((x, y) => x - y), med = ts[ts.length >> 1], d = base.t[s] - med;
          if (bads === 0 && d > gain) { gain = d; bestA = a; }
          // a stretch that is hitting something takes any nudge that stops it
          else if (base.bad[s] && bads * 2 < L.length && bestA < 0) bestA = a;
        });
        if (bestA < 0) continue;
        moved++;
        if (bestA < 2) C[s] *= bestA ? 1 - dC : 1 + dC; else B[s] *= bestA === 3 ? 1 - dB : 1 + dB;
      }
      base = await baseLap();
      const badN = base.bad.reduce((a, b) => a + b, 0);
      if (base.tot < best.tot && badN <= firstBad) best = { tot: base.tot, C: C.slice(), B: B.slice() };
      else if (base.tot > best.tot + 0.25 || badN > firstBad) { C = best.C.slice(); B = best.B.slice(); base = await baseLap(); }
      if (moved < 2 || rd % 4 === 3) { dC = Math.max(0.004, dC * 0.65); dB = Math.max(0.012, dB * 0.65); }
      console.log(`${id} round ${rd + 1}/${ROUNDS} lap ${base.tot.toFixed(3)} best ${best.tot.toFixed(3)} moved ${moved}/${n} bad ${badN} step ${dC.toFixed(3)}/${dB.toFixed(3)}`);
    }
    await Promise.all(ws.map(w => w.terminate()));
    const g = mix(base0, best.C), gB = mix(baseB0, best.B);
    fs.writeFileSync(path.join(OUT, id + '.json'), JSON.stringify({ id, first, best: best.tot, g: Array.from(g, x => +x.toFixed(4)), gB: Array.from(gB, x => +x.toFixed(4)), n }));
    console.log(`DONE ${id} ${first.toFixed(3)} -> ${best.tot.toFixed(3)}  (${n} stretches)`);
  };
  (async () => { for (const id of ids) await coach(id); process.exit(0); })();
}
