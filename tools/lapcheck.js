// What the AI really does alone: Legend flying laps on every circuit, the same way every time, to
// compare two builds. usage: node tools/lapcheck.js [laps]   (run it in each build's folder)
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const os = require('os');
const LOAD = ['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js'];
if (!isMainThread) {
  const F1 = require('./load')(LOAD), DT = 1 / 240, { id, laps } = workerData;
  const race = F1.Race.create({ track: id, mode: 'tt', laps: laps + 3, difficulty: 4, team: 0, driver: 0, seed: 7, field: 1, spectate: true, assists: {} });
  race.autoPlayer = true;
  const c = race.player, ts = [];
  let guard = 0, rub = -1;
  while (ts.length < laps + 2 && guard++ < 240 * 1500) {
    const n = c.lapTimes.length;
    for (const w of c.wheels) w.wear = 0;
    c.fuel = 10;
    if (c.lapTimes.length !== rub) { rub = c.lapTimes.length; race.track.rubber.fill(0.6); } // (as the coach does: rubber otherwise builds lap on lap)
    F1.Race.step(race, DT); race.fx.length = 0;
    if (c.lapTimes.length > n) ts.push(c.lastLap);
  }
  parentPort.postMessage({ id, ts: ts.slice(2) });
} else {
  const F1 = require('./load')(LOAD), laps = +process.argv[2] || 5;
  const ids = F1.Tracks.DEFS.map(d => d.id), out = {}, NT = Math.max(2, os.cpus().length - 1);
  const run = id => new Promise(res => { const w = new Worker(__filename, { workerData: { id, laps } }); w.once('message', r => { out[id] = r.ts; w.terminate(); res(); }); });
  (async () => {
    const q = ids.slice();
    await Promise.all(Array.from({ length: Math.min(NT, ids.length) }, async () => { while (q.length) await run(q.shift()); }));
    let sum = 0;
    for (const id of ids) { const t = out[id].slice().sort((a, b) => a - b), m = t[t.length >> 1]; sum += m; console.log(id.padEnd(11), m.toFixed(3), 'spread', (t[t.length - 1] - t[0]).toFixed(3)); }
    console.log('TOTAL', sum.toFixed(2));
    process.exit(0);
  })();
}
