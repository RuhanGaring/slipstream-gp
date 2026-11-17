// Compares two builds of the game on the same full races: every race of both builds goes into one
// pool of worker threads (one per core but one), so no core waits while the other build finishes,
// and a progress bar with the time left runs as they go.
//   node tools/abrace.js <buildA> <buildB> [seeds] [laps]
//   (a build is a folder holding js/ and tools/, such as the repo or a `git archive <commit> js tools`)
//   env: TRACKS=kestrel,hakone,...   DIFFS=2,4   SEED=500   FIELD=20
// Per build it prints the race averages: walls hit, car contacts, recoveries, passes, retirements,
// cars that lost a wheel, the winner's time and the median best lap; then B against A.
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const os = require('os'), path = require('path');
if (!isMainThread) {
  const { root, track, diff, seed, laps, field } = workerData;
  const F1 = require(path.join(root, 'tools', 'load'))(['util.js', 'tracks.js', 'car.js', 'damage.js', 'softbody.js', 'raceline.js', 'lines.js', 'limits.js', 'aimem.js', 'data.js', 'ai.js', 'race.js']);
  const race = F1.Race.create({ track, mode: 'sim', laps, difficulty: diff, team: 0, driver: 0, grid: 10, field, seed, assists: { damage: 'full' }, safetyCar: 'off', mandatory: false });
  race.autoPlayer = true;
  if (process.env.NOTHINK) F1.Race.THINK.on = false; // (every car on its plan, the look-ahead off)
  // NEAR=1: as in the browser (js/thinkpool.js), only the cars near the player think; the rest
  // drive their plan (true: taken, no answer comes; false: think on the spot)
  if (process.env.NEAR) race.thinkPool = { ask: (r, c) => { const fo = r.player; let g = Math.abs(c.loc.s - fo.loc.s); if (g > r.track.L / 2) g = r.track.L - g; return c !== fo && g > F1.Race.THINK.nearM; } };
  let walls = 0, contacts = 0, resets = 0, passes = 0, n = 0, prev = null;
  const last = new Map(), or = race.recover; race.recover = c => { resets++; or(c); };
  while (!race.done && race.time < 300 * laps) {
    F1.Race.step(race, 1 / 240);
    for (const f of race.fx) {
      if (f.type !== 'wall' && f.type !== 'car') continue;
      const k = f.type + f.car.id, fresh = !(last.get(k) > race.time - 3); last.set(k, race.time);
      if (fresh && f.type === 'wall' && f.power > 4) walls++;
      if (fresh && f.type === 'car' && f.power > 3) contacts++;
    }
    race.fx.length = 0; race.events.length = 0;
    if (++n % 48 === 0 && race.green && race.time - race.startTime > 30) {
      const ord = race.order.filter(c => !c.retired && !c.inPit && !(c.brain && c.brain.pit)).map(c => c.id);
      if (prev) ord.forEach((id, q) => { const p = prev.indexOf(id); if (p > q && p >= 0) passes += p - q; });
      prev = ord;
    }
  }
  const fin = race.cars.filter(c => c.finished).map(c => c.finishTime), bests = race.cars.filter(c => c.bestLap).map(c => c.bestLap).sort((a, b) => a - b);
  parentPort.postMessage({ walls, contacts, resets, passes, ret: race.cars.filter(c => c.retired).length, wheels: race.cars.filter(c => c.dm && c.dm.wheelOff && c.dm.wheelOff.some(Boolean)).length, win: fin.length ? Math.min(...fin) : NaN, best: bests.length ? bests[bests.length >> 1] : NaN });
} else {
  const [A, B] = [process.argv[2], process.argv[3]].map(p => path.resolve(p || '.'));
  const seeds = +process.argv[4] || 3, laps = +process.argv[5] || 5;
  const TRACKS = (process.env.TRACKS || 'kestrel,hakone,bahia,sierra,lonestar').split(','), DIFFS = (process.env.DIFFS || '2,4').split(',').map(Number);
  const seed0 = +process.env.SEED || 500, field = +process.env.FIELD || 20, NT = Math.max(1, os.cpus().length - 1);
  // both builds' races interleaved, so each build is measured in the same machine conditions
  const jobs = [];
  for (const track of TRACKS) for (const diff of DIFFS) for (let s = 0; s < seeds; s++) for (const root of [A, B]) jobs.push({ root, track, diff, seed: seed0 + s, laps, field });
  const res = { [A]: [], [B]: [] }, t0 = Date.now();
  let next = 0, done = 0, running = 0;
  const bar = () => {
    const f = done / jobs.length, el = (Date.now() - t0) / 1000, eta = done ? el / done * (jobs.length - done) : 0;
    process.stdout.write(`\r[${'#'.repeat(Math.round(f * 30)).padEnd(30, '.')}] ${(f * 100).toFixed(0).padStart(3)}%  ${done}/${jobs.length} races  ${Math.floor(el / 60)}m${String(Math.round(el % 60)).padStart(2, '0')}s, about ${Math.ceil(eta / 60)} min left `);
  };
  const avg = rs => { const o = {}; for (const k of Object.keys(rs[0])) { const v = rs.map(r => r[k]).filter(x => x === x); o[k] = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length); } return o; };
  const show = o => `walls ${o.walls.toFixed(1)}  contacts ${o.contacts.toFixed(1)}  recoveries ${o.resets.toFixed(1)}  passes ${o.passes.toFixed(0)}  retired ${o.ret.toFixed(2)}  lost a wheel ${o.wheels.toFixed(2)}  win ${o.win.toFixed(1)} s  median best lap ${o.best.toFixed(2)} s`;
  const launch = () => {
    while (running < NT && next < jobs.length) {
      const j = jobs[next++]; running++;
      const w = new Worker(__filename, { workerData: j });
      w.once('message', r => { res[j.root].push(r); });
      w.once('exit', () => { running--; done++; bar(); if (done === jobs.length) finish(); else launch(); });
      w.once('error', e => { console.error('\n' + j.track + ' ' + j.root + ': ' + e.message); });
    }
  };
  const finish = () => {
    const a = avg(res[A]), b = avg(res[B]);
    console.log(`\n\n${jobs.length / 2} races each (${TRACKS.join(', ')}; difficulties ${DIFFS.join(', ')}; ${seeds} seeds; ${laps} laps; ${field} cars), ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    console.log('A ' + A + '\n  ' + show(a));
    console.log('B ' + B + '\n  ' + show(b));
    console.log('B - A: ' + Object.keys(a).map(k => `${k} ${(b[k] - a[k] >= 0 ? '+' : '') + (b[k] - a[k]).toFixed(2)}`).join('  '));
    process.exit(0);
  };
  console.log(`${jobs.length} races on ${NT} threads`);
  bar(); launch();
}
