// Where can you really pass? Full 20-car races are run on every circuit and every overtaking move
// is followed: which braking zone it was aimed at, whether it stuck, whether it ended in contact.
// The result is a value for each braking zone, -1 (a place to sit and wait) to 1 (the place to go),
// stored in js/limits.js as passV. ai.js uses it to pick its moments and to choose where to defend.
// Runs on every thread the machine has.
// usage: node tools/passlab.js [races per circuit and difficulty]   add WRITE=1 to store the result
const { Worker, isMainThread, parentPort } = require('worker_threads');
const fs = require('fs'), os = require('os'), path = require('path');
const LOAD = ['util.js', 'tracks.js', 'car.js', 'damage.js', 'softbody.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js'];
if (!isMainThread) {
  const F1 = require('./load')(LOAD), DT = 1 / 240;
  parentPort.on('message', m => {
    const race = F1.Race.create({ track: m.track, mode: 'sim', laps: 6, difficulty: m.diff, team: 0, driver: 0, grid: 10, field: 20, seed: m.seed, assists: { damage: 'full' } });
    race.autoPlayer = true;
    const tr = race.track, Z = tr.brakeZones, open = [], tally = Z.map(() => [0, 0, 0]);
    // a move runs from the pull-out to 7 s later: it stuck if the attacker is then ahead and untouched
    F1.AI.P.passLog = (rc, car, o, z) => { const k = Z.indexOf(z); if (k >= 0 && !open.some(q => q.car === car)) open.push({ car, o, k, t: rc.time, d0: car.dist, hit: false }); };
    while (!race.done && race.time < 1500) {
      F1.Race.step(race, DT);
      for (const f of race.fx) if (f.type === 'car' && f.power > 3) for (const q of open) if (q.car === f.car || q.car === f.other) q.hit = true;
      race.fx.length = 0;
      for (let q = open.length - 1; q >= 0; q--) {
        const e = open[q];
        if (race.time - e.t < 7) continue;
        const T = tally[e.k]; T[0]++;
        if (e.hit) T[2]++; else if (!e.car.retired && !e.o.retired && !e.o.inPit && e.car.dist > e.o.dist) T[1]++;
        open.splice(q, 1);
      }
    }
    F1.AI.P.passLog = null;
    parentPort.postMessage({ track: m.track, n: Z.length, tally });
  });
} else {
  const F1 = require('./load')(LOAD);
  const ids = F1.Tracks.DEFS.map(d => d.id), per = +process.argv[2] || 3, NT = Math.max(2, os.cpus().length - 1);
  const jobs = []; let seed = 3000;
  for (const track of ids) for (const diff of [2, 3, 4]) for (let s = 0; s < per; s++) jobs.push({ track, diff, seed: seed++ });
  const sum = {}; let done = 0;
  const work = () => new Promise(res => {
    const w = new Worker(__filename);
    const next = () => { const j = jobs.shift(); if (!j) { w.terminate(); res(); return; } w.postMessage(j); };
    w.on('message', r => {
      const S = sum[r.track] || (sum[r.track] = Array.from({ length: r.n }, () => [0, 0, 0]));
      r.tally.forEach((T, k) => { for (let q = 0; q < 3; q++) S[k][q] += T[q]; });
      if (++done % 10 === 0) console.log(done, 'races');
      next();
    });
    next();
  });
  (async () => {
    await Promise.all(Array.from({ length: NT }, work));
    const L = F1.Limits;
    for (const id of ids) {
      const S = sum[id], all = S.reduce((a, T) => [a[0] + T[0], a[1] + T[1], a[2] + T[2]], [0, 0, 0]), p0 = (all[1] + 2) / (all[0] + 4), h0 = (all[2] + 1) / (all[0] + 8);
      // pulled to the circuit's own average where a zone has few moves to go on
      const V = S.map(T => { const p = (T[1] + 8 * p0) / (T[0] + 8), h = (T[2] + 8 * h0) / (T[0] + 8), v = (p - p0) * 3 - (h - h0) * 5; return +Math.max(-1, Math.min(1, v)).toFixed(2); });
      console.log(id.padEnd(10), 'moves', all[0], 'stuck', all[1], 'hit', all[2], JSON.stringify(V), S.map(T => T.join('/')).join(' '));
      if (process.env.WRITE && L[id]) L[id].passV = V;
    }
    if (process.env.WRITE) {
      const P = path.join(__dirname, '..', 'js', 'limits.js'), head = fs.readFileSync(P, 'utf8').split('G.F1.Limits = ')[0];
      let s = head + 'G.F1.Limits = { stride: ' + L.stride + ',\n';
      for (const id of Object.keys(L)) {
        if (id === 'stride') continue;
        s += `    ${/^[a-z]\w*$/i.test(id) ? id : JSON.stringify(id)}: {\n`;
        for (const k of Object.keys(L[id])) s += `      ${k}: [${Array.from(L[id][k]).join(',')}],\n`;
        s += '    },\n';
      }
      fs.writeFileSync(P, s + "  };\n})(typeof window !== 'undefined' ? window : globalThis);\n");
    }
    process.exit(0);
  })();
}
