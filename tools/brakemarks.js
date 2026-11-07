// Where the fastest driver really goes for the pedal: a Legend drives flying laps on each circuit and
// every braking point is stored in js/limits.js as simOn (metres round the lap). The guide's red
// bar sits on these, so it shows a braking point the car has been proved to make, not one a model
// worked out. Run after any change to the AI's driving or plan. Runs on every thread the machine has.
// usage: node tools/brakemarks.js
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const fs = require('fs'), os = require('os'), path = require('path');
const LOAD = ['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js'], DT = 1 / 240;
if (!isMainThread) {
  const F1 = require('./load')(LOAD), id = workerData.id;
  const race = F1.Race.create({ track: id, mode: 'tt', laps: 9, difficulty: 4, team: 0, driver: 0, seed: 7, field: 1, spectate: true, assists: {} });
  race.autoPlayer = true;
  const c = race.player, tr = race.track, hold = () => { for (const w of c.wheels) w.wear = 0; c.fuel = 10; tr.rubber.fill(0.6); };
  let g = 0; while (c.lapTimes.length < 3 && g++ < 240 * 500) { hold(); F1.Race.step(race, DT); race.fx.length = 0; }
  const on = []; let cur = null; const wait = c.lapTimes.length;
  while (c.lapTimes.length === wait && g++ < 240 * 900) {
    hold(); F1.Race.step(race, DT); race.fx.length = 0;
    const b = c.ctl.brake;
    if (b > 0.1 && !cur) cur = { s: c.loc.s, v0: c.u, vMin: c.u, off: 0 };
    if (cur) {
      cur.vMin = Math.min(cur.vMin, c.u);
      cur.off = b > 0.05 ? 0 : cur.off + DT;
      if (cur.off > 0.4) { if (cur.v0 - cur.vMin > 6) on.push(Math.round(cur.s)); cur = null; }
    }
  }
  parentPort.postMessage({ id, on });
} else {
  const F1 = require('./load')(LOAD), L = F1.Limits, ids = F1.Tracks.DEFS.map(d => d.id), q = ids.slice(), NT = Math.max(2, os.cpus().length - 1);
  const one = id => new Promise(res => { const w = new Worker(__filename, { workerData: { id } }); w.once('message', r => { L[id].simOn = r.on; console.log(id, r.on.length, 'braking points'); w.terminate(); res(); }); });
  (async () => {
    await Promise.all(Array.from({ length: Math.min(NT, ids.length) }, async () => { while (q.length) await one(q.shift()); }));
    const P = path.join(__dirname, '..', 'js', 'limits.js'), head = fs.readFileSync(P, 'utf8').split('G.F1.Limits = ')[0];
    let s = head + 'G.F1.Limits = { stride: ' + L.stride + ',\n';
    for (const id of Object.keys(L)) {
      if (id === 'stride') continue;
      s += `    ${/^[a-z]\w*$/i.test(id) ? id : JSON.stringify(id)}: {\n`;
      for (const k of Object.keys(L[id])) s += `      ${k}: [${Array.from(L[id][k]).join(',')}],\n`;
      s += '    },\n';
    }
    fs.writeFileSync(P, s + "  };\n})(typeof window !== 'undefined' ? window : globalThis);\n");
    process.exit(0);
  })();
}
