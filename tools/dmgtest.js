// Damage model test: crash a car into the wall at several speeds and angles, then run a full
// AI race with damage on and report what broke, failed and retired.
// usage: node tools/dmgtest.js [track] [laps]
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'damage.js', 'softbody.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js']);
const id = process.argv[2] || 'kestrel', laps = +process.argv[3] || 5;
const fmt = o => Object.entries(o).filter(([, v]) => v > 0.005).map(([k, v]) => k + ':' + v.toFixed(2)).join(' ');

// 1. crash tests
for (const [kmh, yaw] of [[80, 1.4], [150, 1.4], [250, 1.4], [200, 0.6], [250, 0.35]]) {
  const race = F1.Race.create({ track: id, mode: 'sim', laps: 3, difficulty: 3, seed: 7, assists: { damage: 'full' } });
  const tr = race.track, c = race.player;
  race.green = true; race.phase = 'race';
  for (const o of race.cars) if (o !== c) o.retired = true;
  const s0 = 700, i = Math.floor(s0 / tr.ds), [x, y, h] = F1.Tracks.pointAt(tr, s0, 0);
  F1.Car.place(c, x, y, h + yaw); F1.Tracks.locate(tr, x, y, i, c.loc);
  c.vx = Math.cos(h + yaw) * kmh / 3.6; c.vy = Math.sin(h + yaw) * kmh / 3.6;
  const evs = [];
  for (let k = 0; k < 240 * 3; k++) {
    c.ctl.throttle = 0; c.ctl.brake = 0; c.ctl.steerDirect = 0;
    F1.Race.step(race, 1 / 240);
    for (const e of race.events) if (['part', 'failure', 'retire'].includes(e.type)) evs.push(e.text);
    race.events.length = 0;
  }
  const dm = c.dm;
  console.log(`crash ${kmh} km/h yaw ${yaw}: ${fmt(dm.p)} | off ${Object.keys(dm.off).join(',') || '-'} | punct ${dm.puncture.join('')} | downF ${dm.kDownF.toFixed(2)} downR ${dm.kDownR.toFixed(2)} | ${evs.join(', ')}`);
}

if (process.env.CRASH_ONLY) process.exit(0);
// 2. a race with full damage
const race = F1.Race.create({ track: id, mode: 'sim', laps, difficulty: 3, seed: +(process.env.SEED || 7), field: 20, assists: { damage: 'full' }, safetyCar: 'on' });
race.autoPlayer = true;
const evs = [];
const t0 = Date.now();
while (!race.done && race.time < 60 * 25) {
  F1.Race.step(race, 1 / 240);
  for (const e of race.events) if (['part', 'failure', 'retire', 'sc', 'green'].includes(e.type)) evs.push(`${(race.time - race.startTime).toFixed(0)}s ${e.type} ${e.car ? e.car.driver.code : ''} ${e.text || ''}`);
  race.events.length = 0; race.fx.length = 0;
}
console.log(evs.join('\n'));
const damaged = race.cars.filter(c => c.dm && Object.values(c.dm.p).some(v => v > 0.05));
console.log('done', race.done, 'retired', race.cars.filter(c => c.retired).length, 'damaged cars', damaged.length, 'real ms', Date.now() - t0);
for (const c of damaged.slice(0, 6)) console.log(' ', c.driver.code, fmt(c.dm.p), 'engT', c.dm.engT.toFixed(0), c.dm.failed || '');
const temps = race.cars.map(c => c.dm.engT);
console.log('engine temps', Math.min(...temps).toFixed(0), '-', Math.max(...temps).toFixed(0));
