// How fast can the AI go? A lone car on fresh tyres and a light tank drives flying laps at each
// step of a speed plan pushed harder and harder, on as many threads as the machine has, and the
// table shows where it stops being clean. The last column is the lap the speed model says the car
// could do on this line and this grip with a perfect driver, so the gap to it is what the driving
// itself still leaves on the table.
// usage: node tools/limit.js [tracks,comma] [paces,comma]   env BRAKE (default 1) BP (brakePace)
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const os = require('os');
const LOAD = ['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js'];
if (isMainThread) {
  const F1 = require('./load')(LOAD);
  const ids = process.argv[2] && process.argv[2] !== 'all' ? process.argv[2].split(',') : F1.Tracks.DEFS.map(d => d.id);
  const paces = (process.argv[3] || '0.96,0.98,1,1.01,1.02,1.03,1.04,1.06').split(',').map(Number);
  const jobs = []; for (const id of ids) for (const pace of paces) jobs.push({ id, pace });
  const res = new Map(); let q = 0, live = 0;
  const done = () => {
    for (const id of ids) {
      const rows = paces.map(p => res.get(id + p)), tr = F1.Race.getTrack(id);
      const qss = rows[0].qss;
      console.log(`${id.padEnd(11)} L ${tr.L.toFixed(0)}  model ${qss.toFixed(3)}  ` + rows.map(r => `${r.pace}: ${r.best ? r.best.toFixed(3) : 'none'}${r.walls ? ' w' + r.walls : ''}${r.rec ? ' r' + r.rec : ''}${r.limits ? ' t' + r.limits : ''}`).join('  '));
    }
  };
  const next = () => {
    while (live < Math.max(2, os.cpus().length - 2) && q < jobs.length) {
      const j = jobs[q++]; live++;
      const w = new Worker(__filename, { workerData: j, env: process.env });
      w.on('message', r => { res.set(j.id + j.pace, r); });
      w.on('error', e => { console.log('ERR', j, e.message); res.set(j.id + j.pace, { pace: j.pace, best: 0, qss: 0 }); });
      w.on('exit', () => { live--; if (q < jobs.length) next(); else if (!live) done(); });
    }
  };
  next();
} else {
  const F1 = require('./load')(LOAD);
  const { id, pace } = workerData;
  const race = F1.Race.create({ track: id, mode: 'tt', laps: 4, difficulty: 4, team: 0, driver: 0, seed: 7, field: 1, assists: {} });
  race.autoPlayer = true;
  const c = race.player, tr = race.track, g = F1.Race.learnedGrip(tr, 'sim');
  const opt = { pace, grip: g, gripB: F1.Race.learnedBrake(tr), brakePace: +(process.env.BP || pace), brake: +(process.env.BRAKE || 1) };
  c.brain.prof = F1.Raceline.speedProfile(tr, tr.line, c.spec, opt);
  const qss = F1.Raceline.lapTime(tr, tr.line, c.spec, { pace: 1, grip: g, real: true, brake: 1 });
  let walls = 0, rec = 0, last = -9;
  const orig = race.recover; race.recover = x => { rec++; orig(x); };
  const DT = 1 / 240;
  while (!race.done && race.time < 600 && c.lapTimes.length < 4) {
    F1.Race.step(race, DT);
    for (const f of race.fx) if (f.type === 'wall' && f.power > 3 && race.time > last + 2) { walls++; last = race.time; }
    race.fx.length = 0;
  }
  const laps = c.lapTimes.slice(1).filter(l => l.valid !== false).map(l => l.t);
  parentPort.postMessage({ pace, best: laps.length ? Math.min(...laps) : 0, walls, rec, limits: c.warnings, qss });
}
