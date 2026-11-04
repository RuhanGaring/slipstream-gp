// Where one car alone gets on the brakes for each big stop, and how hard, lap after lap.
// usage: node tools/brakepoints.js [track] [difficulty] [laps]
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js']);
const id = process.argv[2] || 'kestrel', diff = +(process.argv[3] || 3), laps = +(process.argv[4] || 4), DT = 1 / 240;
const race = F1.Race.create({ track: id, mode: 'sim', laps, difficulty: diff, team: 0, driver: 0, field: 2, seed: 7, assists: {} });
const car = race.cars.find(c => !c.isPlayer), tr = race.track;
race.cars = [car]; race.order = [car]; race.player = car;
const stops = [];
let cur = null;
while (!race.done && race.time < 900) {
  F1.Race.step(race, DT); race.fx.length = 0;
  if (!race.green || car.lap < 1 || car.inPit) continue;
  const b = car.ctl.brake;
  if (b > 0.08 && !cur) cur = { s: car.loc.s, v: car.speed, min: car.speed, peak: 0, t: 0, lap: car.lap };
  if (cur) {
    cur.t += DT; cur.min = Math.min(cur.min, car.speed); cur.peak = Math.max(cur.peak, -(car.ax || 0));
    if (b < 0.02 && cur.t > 0.15) { cur.len = F1.Tracks.fwd(tr, cur.s, car.loc.s); if (cur.v - cur.min > 12) stops.push(cur); cur = null; }
  }
}
const by = new Map();
for (const q of stops) { const k = Math.round(q.s / 120); if (!by.has(k)) by.set(k, []); by.get(k).push(q); }
const avg = (a, f) => a.reduce((x, y) => x + f(y), 0) / a.length;
let ln = 0;
const out = [];
for (const [k, a] of [...by].sort((p, q) => p[0] - q[0])) { out.push(`${Math.round(avg(a, q => q.s))}:${(avg(a, q => q.v) * 3.6).toFixed(0)}>${(avg(a, q => q.min) * 3.6).toFixed(0)} ${avg(a, q => q.len).toFixed(0)}m ${(avg(a, q => q.peak) / 9.81).toFixed(1)}g`); ln += avg(a, q => q.len); }
console.log(`d${diff} best ${car.bestLap ? F1.U.fmtTime(car.bestLap) : '-'} total brake ${ln.toFixed(0)} m | ` + out.join(' | '));
