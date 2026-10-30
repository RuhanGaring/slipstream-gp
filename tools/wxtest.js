// Headless weather and safety car test: every car AI driven.
// usage: WEATHER=dry|light|heavy|mixed SC=on|off|always node tools/wxtest.js [track] [laps]
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js']);
const id = process.argv[2] || 'kestrel', laps = +process.argv[3] || 5;
const DT = 1 / 120;
const race = F1.Race.create({ track: id, mode: 'sim', laps, difficulty: 3, team: 0, driver: 0, grid: 10, field: 20, seed: +(process.env.SEED || 7), assists: {}, weather: process.env.WEATHER || 'dry', safetyCar: process.env.SC || 'off' });
race.autoPlayer = true;
const ev = [], walls = { n: 0 };
const t0 = Date.now();
let nextLog = 0;
while (!race.done && race.time < 60 * 20) {
  F1.Race.step(race, DT);
  for (const f of race.fx) if (f.type === 'wall' && f.power > 4) { walls.n++; if (process.env.V && walls.n < 12) console.log('wall', f.car.driver.code, 't', (race.time-race.startTime).toFixed(1), 's', f.car.loc.s.toFixed(0), 'd', f.car.loc.d.toFixed(1), 'v', (f.car.speed*3.6).toFixed(0), 'pow', f.power.toFixed(1), 'tyre', f.car.compound.id, 'brk', f.car.ctl.brake.toFixed(2)); const k = Math.round(f.car.loc.s / 100) * 100; walls[k] = (walls[k] || 0) + 1; }
  race.fx.length = 0;
  for (const e of race.events) if (['rain', 'rainstop', 'incident', 'sc', 'scin', 'green', 'retire'].includes(e.type)) ev.push((race.time - race.startTime).toFixed(0) + 's ' + e.type + ' ' + (e.text || ''));
  race.events.length = 0;
  if (race.green && race.time - race.startTime > nextLog) {
    nextLog += 30;
    const comps = {}; race.cars.forEach(c => { comps[c.compound.id] = (comps[c.compound.id] || 0) + 1; });
    const lead = race.order[0];
    console.log(`t=${(race.time - race.startTime).toFixed(0)} rain=${race.rain.toFixed(2)} wet=${race.wet.toFixed(2)} sc=${race.sc.state} tyres=${JSON.stringify(comps)} leadLap=${lead.lap} v=${(lead.speed * 3.6).toFixed(0)}`);
  }
}
console.log(ev.join('\n'));
const lt = race.cars.flatMap(c => c.lapTimes.map(l => l.t)).filter(t => t > 20);
console.log('done', race.done, 'time', (race.time - race.startTime).toFixed(0), 'walls', JSON.stringify(walls), 'retired', race.cars.filter(c => c.retired).length, 'fast', race.fastest && race.fastest.t.toFixed(1), 'real ms', Date.now() - t0);
console.log('winner', race.result && race.result[0].driver.code, 'compounds used by winner', race.result && race.result[0].tyreHist.join(''));
