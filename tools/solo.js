// One AI car alone. Logs line error, speed vs profile.  usage: node tools/solo.js track [secs] [pace]
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js']);
const id = process.argv[2] || 'kestrel', secs = +process.argv[3] || 90;
const DT = 1 / 240;
const race = F1.Race.create({ track: id, mode: process.argv[5] || 'sim', laps: 3, difficulty: 4, team: 0, driver: 0, seed: 7, field: 1 });
race.cars = [race.player]; race.order = [race.player];
race.autoPlayer = true;
const c = race.player;
if (process.argv[4]) { c.brain.prof = F1.Raceline.speedProfile(race.track, race.track.line, c.spec, { pace: +process.argv[4] }); }
const tr = race.track;
let n = 0, maxErr = 0, sumErr = 0, k = 0, rec = 0, walls = 0;
race.recover = (orig => car => { rec++; console.log('RECOVER at s', car.loc.s.toFixed(0), 't', race.time.toFixed(1)); orig(car); })(race.recover);
while (race.time < secs) {
  F1.Race.step(race, DT); n++;
  for (const f of race.fx) if (f.type === 'wall') { walls++; if (walls < 15) console.log('WALL s', c.loc.s.toFixed(0), 'pow', f.power.toFixed(1), 'v', (c.speed*3.6).toFixed(0)); }
  race.fx.length = 0;
  if (!race.green) continue;
  const i = c.loc.i;
  const err = c.loc.d - tr.line.off[i];
  maxErr = Math.max(maxErr, Math.abs(err)); sumErr += Math.abs(err); k++;
  if (n % (Math.abs(err) > 1.5 ? 30 : 240) === 0) console.log(`t ${race.time.toFixed(0)} s ${c.loc.s.toFixed(0)} lap ${c.lap} v ${(c.u*3.6).toFixed(0)} prof ${(c.brain.prof[i]*3.6).toFixed(0)} err ${err.toFixed(2)} d ${c.loc.d.toFixed(1)} g ${c.gear} rpm ${c.rpm.toFixed(0)} thr ${c.ctl.throttle.toFixed(2)} brk ${c.ctl.brake.toFixed(2)} st ${(c.steer*57.3).toFixed(1)} slide ${c.wheels.map(w=>w.slide.toFixed(1)).join('/')} T ${c.wheels.map(w=>w.temp.toFixed(0)).join('/')}`);
}
console.log('laps', c.lapTimes.map(l => F1.U.fmtTime(l.t) + (l.valid ? '' : '*')).join(' '), 'ref', F1.U.fmtTime(tr.refLap), 'meanErr', (sumErr / k).toFixed(2), 'maxErr', maxErr.toFixed(2), 'rec', rec, 'walls', walls);
