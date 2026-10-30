// Solo lap time of the reference car at several AI paces, on the learned limits.
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js']);
const id = process.argv[2] || 'kestrel', mode = process.argv[3] || 'arcade';
const paces = (process.argv[4] || '0.6,0.7,0.8,0.9,0.95,1').split(',').map(Number);
const out = [];
for (const pace of paces) {
  const race = F1.Race.create({ track: id, mode, laps: 3, difficulty: 4, team: 0, driver: 0, field: 1, seed: 3 });
  race.cars = [race.player]; race.order = [race.player]; race.autoPlayer = true;
  const c = race.player, tr = race.track;
  const gk = mode === 'sim' ? 1 : 1.12;
  c.brain.prof = F1.Raceline.speedProfile(tr, tr.line, c.spec, { pace: pace * gk, grip: F1.Race.learnedGrip(tr, mode === 'sim' ? 'sim' : 'arcade') });
  let rec = 0, walls = 0, offs = 0, wasOff = false;
  race.recover = (o => car => { rec++; o(car); })(race.recover);
  while (c.lapTimes.length < 3 && race.time < 400) {
    F1.Race.step(race, 1 / 240);
    for (const f of race.fx) if (f.type === 'wall' && f.power > 2) walls++;
    race.fx.length = 0;
    const off = c.wheels.every(w => w.outside); if (off && !wasOff) offs++; wasOff = off;
  }
  out.push(pace + ':' + c.lapTimes.slice(1).map(l => F1.U.fmtTime(l.t) + (l.valid ? '' : '*')).join('/') + ` limits ${offs} rec ${rec} walls ${walls}`);
}
console.log(id, mode, out.join('  '));
