// Solo stint: tyre temperatures and lap times per lap for the reference AI.
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js']);
const id = process.argv[2] || 'kestrel', laps = +process.argv[3] || 6, pace = +process.argv[4] || 1;
const race = F1.Race.create({ track: id, mode: 'sim', laps: +(process.env.RL || 50), difficulty: 4, team: 0, driver: 0, field: 1, seed: 3 });
race.cars = [race.player]; race.order = [race.player]; race.autoPlayer = true;
const c = race.player, tr = race.track;
if (process.env.COMP) c.compound = F1.Car.COMPOUNDS[process.env.COMP];
if (process.env.FUEL) c.fuel = +process.env.FUEL;
if (process.env.WR) c.wearRate = +process.env.WR;
c.brain.prof = F1.Raceline.speedProfile(tr, tr.line, c.spec, { pace, grip: F1.Race.learnedGrip(tr, 'sim') });
const hist = []; let dumped = false;
let n = 0, maxT = [0, 0, 0, 0];
while (c.lapTimes.length < laps && race.time < 1000) {
  F1.Race.step(race, 1 / 240);
  hist.push(`s=${c.loc.s.toFixed(0)} d=${c.loc.d.toFixed(1)} line=${tr.line.off[c.loc.i].toFixed(1)} v=${(c.u*3.6).toFixed(0)} vt=${(c.brain.prof[c.loc.i]*3.6).toFixed(0)} thr=${c.ctl.throttle.toFixed(2)} brk=${c.ctl.brake.toFixed(2)} aReq=${(c.brain.aReq||0).toFixed(1)} st=${(c.steer*57.3).toFixed(1)} slide=${c.wheels.map(w=>w.slide.toFixed(1)).join('/')} lock=${c.wheels.map(w=>w.lock.toFixed(1)).join('/')} T=${c.wheels.map(w=>w.temp.toFixed(0)).join('/')} wear=${(c.wheels[2].wear*100).toFixed(0)} surf=${c.wheels.map(w=>w.surf).join('')}`);
  if (hist.length > 480) hist.shift();
  const bad = c.wheels.every(w => w.outside) || Math.abs(c.loc.d - tr.line.off[c.loc.i]) > 4;
  if (bad && race.green && race.time - race.startTime > 8 && hist.length >= 480 && !dumped && process.env.V) { dumped = true; for (let q = 0; q < 480; q += 24) console.log(hist[q]); }
  c.wheels.forEach((w, k) => { maxT[k] = Math.max(maxT[k], w.temp); });
  if (c.lapTimes.length > n) { n = c.lapTimes.length; console.log('lap', n, F1.U.fmtTime(c.lapTimes[n - 1].t), 'T', c.wheels.map(w => w.temp.toFixed(0)).join('/'), 'max', maxT.map(x => x.toFixed(0)).join('/'), 'wear', (c.wheels[2].wear * 100).toFixed(0)); maxT = [0, 0, 0, 0]; }
}
