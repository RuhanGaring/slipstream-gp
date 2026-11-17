// Race starts: how the AI field gets off the grid and through lap 1, per set of AI settings.
// Every (variant, circuit, seed) is one 20-car Legend sim race run to the end of lap 1 on its own
// worker thread, look-ahead off (the start is the driving itself). Prints, per variant: time to
// 100 km/h, metres covered in the first 10 s by the cars from P3 back, the median lap 1, and the
// lap 1 wall hits, car contacts and recoveries.
//   node tools/startlab.js '{"name":{...AI.P overrides}}' [seeds] [tracks]
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const os = require('os');
if (!isMainThread) {
  const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'damage.js', 'softbody.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js']);
  const { P, track, seed } = workerData;
  Object.assign(F1.AI.P, P);
  F1.Race.THINK.on = false;
  const race = F1.Race.create({ track, mode: 'sim', laps: 5, difficulty: 4, team: 0, driver: 0, grid: 10, seed, spectate: true, assists: { damage: 'full' }, safetyCar: 'off', mandatory: false });
  race.autoPlayer = true;
  let walls = 0, contacts = 0, resets = 0, go = null;
  const last = new Map(), or = race.recover; race.recover = c => { resets++; or(c); };
  const t100 = new Map(), d0 = new Map(), d10 = new Map();
  while (race.time < 400 && !race.cars.every(c => c.lapTimes.length >= 1 || c.retired)) {
    F1.Race.step(race, 1 / 240);
    if (go == null && race.green) { go = race.time; race.cars.forEach(c => d0.set(c, c.dist)); }
    if (go != null) {
      for (const c of race.cars) {
        if (!t100.has(c) && c.speed * 3.6 >= 100) t100.set(c, race.time - go);
        if (!d10.has(c) && race.time - go >= 10) d10.set(c, c.dist - d0.get(c));
      }
    }
    for (const f of race.fx) {
      if (f.type !== 'wall' && f.type !== 'car') continue;
      const k = f.type + f.car.id, fresh = !(last.get(k) > race.time - 3); last.set(k, race.time);
      if (fresh && f.type === 'wall' && f.power > 4) walls++;
      if (fresh && f.type === 'car' && f.power > 3) contacts++;
    }
    race.fx.length = 0; race.events.length = 0;
  }
  const back = race.cars.filter(c => c.gridPos >= 3);
  const lap1 = race.cars.map(c => (c.lapTimes[0] ? c.lapTimes[0].t : 400)).sort((a, b) => a - b);
  parentPort.postMessage({
    t100: [...t100.values()].reduce((a, b) => a + b, 0) / Math.max(1, t100.size),
    d10: back.reduce((a, c) => a + (d10.get(c) || 0), 0) / back.length,
    lap1: lap1[lap1.length >> 1], lap1last: lap1[lap1.length - 1], walls, contacts, resets,
  });
} else {
  const variants = JSON.parse(process.argv[2] || '{"now":{}}');
  const seeds = +(process.argv[3] || 6), tracks = (process.argv[4] || 'montaurele,kestrel,hakone,bahia').split(',');
  const jobs = [];
  for (const name in variants) for (const track of tracks) for (let s = 0; s < seeds; s++) jobs.push({ name, P: variants[name], track, seed: 300 + s * 17 });
  const res = {}, NT = Math.max(1, os.cpus().length - 1), t0 = Date.now();
  let next = 0, done = 0;
  const bar = () => { const p = done / jobs.length, el = (Date.now() - t0) / 1000; process.stdout.write(`\r[${'#'.repeat(Math.round(p * 30)).padEnd(30, '.')}] ${(p * 100).toFixed(0)}%  ${done}/${jobs.length} starts  ${Math.floor(el / 60)}m${String(Math.round(el % 60)).padStart(2, '0')}s, about ${p > 0 ? Math.ceil(el / p * (1 - p) / 60) : '?'} min left `); };
  const launch = () => {
    while (next < jobs.length && next - done < NT) {
      const j = jobs[next++];
      const w = new Worker(__filename, { workerData: j });
      w.on('message', m => { (res[j.name] = res[j.name] || []).push(m); });
      w.on('error', e => console.error('\n' + j.name + ' ' + j.track + ': ' + e.message));
      w.on('exit', () => { done++; bar(); if (done === jobs.length) report(); else launch(); });
    }
  };
  const report = () => {
    console.log(`\n${seeds} starts each on ${tracks.join(', ')}`);
    for (const name in res) {
      const r = res[name], m = k => r.reduce((a, x) => a + x[k], 0) / r.length;
      console.log(`${name.padEnd(12)} 0-100 ${m('t100').toFixed(2)} s   10 s from P3 back ${m('d10').toFixed(0)} m   lap 1 median ${m('lap1').toFixed(1)} s, last ${m('lap1last').toFixed(1)} s   walls ${m('walls').toFixed(2)}  contacts ${m('contacts').toFixed(2)}  recoveries ${m('resets').toFixed(2)}`);
    }
  };
  bar(); launch();
}
