// Tunes the AI's racecraft margins on full 20-car races with damage, on every thread the machine has.
// Coordinate search: each setting is tried up and down, and kept only if the race score improves.
// Score: crashes and contacts cost, pace and passing earn. Prints the best settings.
// usage: node tools/racetune.js [passes]     verify: node tools/racetune.js check '{"trafK":0.99}' [seedBase]
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const os = require('os');
const TRACKS = process.env.TRACKS ? process.env.TRACKS.split(',') : ['kestrel', 'hakone', 'bahia', 'sierra', 'lonestar'], DIFFS = [2, 4];
if (!isMainThread) {
  const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'damage.js', 'softbody.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js']);
  const base = Object.assign({}, F1.AI.P), DT = 1 / 240;
  parentPort.on('message', m => {
    Object.assign(F1.AI.P, base, m.tune);
    const race = F1.Race.create({ track: m.track, mode: 'sim', laps: 5, difficulty: m.diff, team: 0, driver: 0, grid: 10, field: 20, seed: m.seed, assists: { damage: 'full' }, safetyCar: 'off', mandatory: true });
    race.autoPlayer = true;
    let walls = 0, contacts = 0, resets = 0, passes = 0, n = 0, prev = null; const last = new Map();
    const or = race.recover; race.recover = c => { resets++; or(c); };
    while (!race.done && race.time < 1500) {
      F1.Race.step(race, DT);
      for (const f of race.fx) {
        if (f.type !== 'wall' && f.type !== 'car') continue;
        const k = f.type + f.car.id, fresh = !(last.get(k) > race.time - 3); last.set(k, race.time);
        if (fresh && f.type === 'wall' && f.power > 4) walls++;
        if (fresh && f.type === 'car' && f.power > 3) contacts++;
      }
      race.fx.length = 0;
      if (++n % 48 === 0 && race.green && race.time - race.startTime > 30) {
        const ord = race.order.filter(c => !c.retired && !c.inPit && !(c.brain && c.brain.pit)).map(c => c.id);
        if (prev) ord.forEach((id, q) => { const p = prev.indexOf(id); if (p > q && p >= 0) passes += p - q; });
        prev = ord;
      }
    }
    const fin = race.cars.filter(c => c.finished).map(c => c.finishTime), bests = race.cars.filter(c => c.bestLap).map(c => c.bestLap).sort((a, b) => a - b);
    parentPort.postMessage({ walls, contacts, resets, passes, ret: race.cars.filter(c => c.retired).length, win: Math.min(...fin), best: bests[bests.length >> 1], done: race.done ? 1 : 0 });
  });
} else {
  const NT = Math.max(2, os.cpus().length - 1), pool = Array.from({ length: NT }, () => new Worker(__filename, { workerData: {} }));
  const free = pool.slice(), wait = [];
  const job = m => new Promise(res => {
    const go = w => { w.once('message', r => { res(r); const q = wait.shift(); if (q) q(w); else free.push(w); }); w.postMessage(m); };
    const w = free.pop(); if (w) go(w); else wait.push(go);
  });
  const evalT = async (tune, seed0, seeds) => {
    const js = []; for (const track of TRACKS) for (const diff of DIFFS) for (let s = 0; s < seeds; s++) js.push(job({ track, diff, seed: seed0 + s, tune }));
    const rs = await Promise.all(js), o = { races: rs.length };
    for (const k of ['walls', 'contacts', 'resets', 'passes', 'ret', 'win', 'best', 'done']) o[k] = rs.reduce((a, r) => a + r[k], 0) / rs.length;
    o.score = o.ret * 12 + o.contacts * 0.6 + o.walls * 1.5 + o.resets * 0.3 + (o.win - 370) * 0.5 + (o.best - 69) * 4 - o.passes * 0.04;
    return o;
  };
  const show = o => `score ${o.score.toFixed(1)} ret ${o.ret.toFixed(2)} contacts ${o.contacts.toFixed(1)} walls ${o.walls.toFixed(1)} resets ${o.resets.toFixed(1)} passes ${o.passes.toFixed(0)} win ${o.win.toFixed(1)} best ${o.best.toFixed(2)} done ${o.done}`;
  (async () => {
    if (process.argv[2] === 'check') { console.log(show(await evalT(JSON.parse(process.argv[3] || '{}'), +process.argv[4] || 500, 3))); process.exit(0); }
    const STEPS = process.env.MPC ? { mpcCorner: [1.5, 3.5], mpcCare: [0.6, 1.6], mpcKeep: [3, 0.5], mpcPass: [4, 14], trafK: [0.985, 0.995], gapV: [0.09, 0.15] } : { trafK: [0.985, 0.975], lap1K: [0.95, 0.93], lap1T: [50, 70], lap1Gap: [2.2, 3], gapV: [0.12, 0.16], gapBrk: [0.14, 0.22], trafBrk: [0.92, 0.85] };
    const SEEDS = +process.env.SEEDS || 1;
    let bestT = process.env.MPC ? JSON.parse(process.env.MPC) : {}, best = await evalT(bestT, 100, SEEDS); console.log('base', show(best));
    for (let pass = 0; pass < (+process.argv[2] || 2); pass++) for (const k in STEPS) for (const v of STEPS[k]) {
      const t = Object.assign({}, bestT, { [k]: v }), r = await evalT(t, 100, SEEDS);
      console.log(k, v, show(r));
      if (r.score < best.score) { best = r; bestT = t; console.log('  kept', JSON.stringify(bestT)); }
    }
    console.log('BEST', JSON.stringify(bestT)); console.log('verify', show(await evalT(bestT, 1700, 3))); console.log('old   ', show(await evalT({ mpc: 0 }, 1700, 3)));
    process.exit(0);
  })();
}
