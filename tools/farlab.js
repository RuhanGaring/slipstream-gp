// What the field does when only some cars can think, as in the browser (js/thinkpool.js: two
// workers, the cars near the camera first). 20-car Legend sim races, each on its own worker thread:
//   none   look-ahead off for everyone
//   near   only cars within THINK.nearM of the player think (the rest drive their plan)
//   share  as near, with the field's shared memory on (Race.THINK.share)
//   all    every Legend car thinks (what tools/abrace.js measures)
// Prints per mode the median best lap, the winner's time and the median finish, walls, contacts,
// recoveries.   node tools/farlab.js [modes] [seeds] [laps] [tracks]
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const os = require('os');
if (!isMainThread) {
  const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'damage.js', 'softbody.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js']);
  const { mode, track, seed, laps } = workerData;
  F1.Race.THINK.on = mode !== 'none';
  F1.Race.THINK.share = mode === 'share';
  const race = F1.Race.create({ track, mode: 'sim', laps, difficulty: 4, team: 0, driver: 0, grid: 10, seed, spectate: true, assists: { damage: 'full' }, safetyCar: 'off', mandatory: false });
  race.autoPlayer = true;
  if (mode === 'near' || mode === 'share') {
    // (true: taken, no answer comes; false: think on the spot, as the page did)
    race.thinkPool = { ask: (r, c) => {
      const fo = r.player; let gap = Math.abs(c.loc.s - fo.loc.s); if (gap > r.track.L / 2) gap = r.track.L - gap;
      return c !== fo && gap > F1.Race.THINK.nearM;
    } };
  }
  let walls = 0, contacts = 0, resets = 0;
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
  }
  const fin = race.cars.filter(c => c.finished).map(c => c.finishTime).sort((a, b) => a - b), bests = race.cars.filter(c => c.bestLap).map(c => c.bestLap).sort((a, b) => a - b);
  parentPort.postMessage({ best: bests[bests.length >> 1], win: fin[0], midFin: fin[fin.length >> 1], walls, contacts, resets });
} else {
  const modes = (process.argv[2] || 'none,near,share').split(','), seeds = +(process.argv[3] || 2), laps = +(process.argv[4] || 4);
  const tracks = (process.argv[5] || 'montaurele,kestrel,hakone').split(',');
  const jobs = [];
  for (const track of tracks) for (let s = 0; s < seeds; s++) for (const mode of modes) jobs.push({ mode, track, seed: 700 + s * 13, laps });
  const res = {}, NT = Math.max(1, os.cpus().length - 1), t0 = Date.now();
  let next = 0, done = 0;
  const bar = () => { const p = done / jobs.length, el = (Date.now() - t0) / 1000; process.stdout.write(`\r[${'#'.repeat(Math.round(p * 30)).padEnd(30, '.')}] ${(p * 100).toFixed(0)}%  ${done}/${jobs.length} races  ${Math.floor(el / 60)}m${String(Math.round(el % 60)).padStart(2, '0')}s, about ${p > 0 ? Math.ceil(el / p * (1 - p) / 60) : '?'} min left `); };
  const launch = () => {
    while (next < jobs.length && next - done < NT) {
      const j = jobs[next++], w = new Worker(__filename, { workerData: j });
      w.on('message', m => { ((res[j.mode] = res[j.mode] || {})[j.track] = res[j.mode][j.track] || []).push(m); });
      w.on('error', e => console.error('\n' + j.mode + ' ' + j.track + ': ' + e.message));
      w.on('exit', () => { done++; bar(); if (done === jobs.length) report(); else launch(); });
    }
  };
  const report = () => {
    console.log(`\n${seeds} races per circuit, ${laps} laps, 20 cars, Legend`);
    for (const track of tracks) for (const mode of modes) {
      const r = (res[mode] || {})[track] || [], m = k => r.reduce((a, x) => a + (x[k] || 0), 0) / Math.max(1, r.length);
      console.log(`${track.padEnd(11)} ${mode.padEnd(6)} median best ${m('best').toFixed(2)}  win ${m('win').toFixed(1)}  mid finish ${m('midFin').toFixed(1)}  walls ${m('walls').toFixed(1)}  contacts ${m('contacts').toFixed(1)}  recoveries ${m('resets').toFixed(1)}`);
    }
  };
  bar(); launch();
}
