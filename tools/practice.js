// AI practice: a Legend car alone on a circuit learns where it can carry more speed and take a better
// line (js/race.js THINK: pace and line per 10 m). Laps alternate: on an explore lap the look-ahead
// tries changes; on the next, driven on what was learned alone, each 200 m sector keeps them only if
// it went quicker. So what comes out works without the look-ahead.
//   node tools/practice.js TRACK [rounds] [out.json]     (TRACK: kestrel, gen-101, gen2-city-3, ...)
// Prints the validation laps as they go; writes { id, pace, line } (per 10 m) to out.json.
const F1 = require('./load')(['util.js', 'tracks.js', 'trackgen.js', 'trackgen2.js', 'trackgen2-fixed.js', 'car.js', 'damage.js', 'softbody.js', 'raceline.js', 'lines.js', 'limits.js', 'premade.js', 'gripmodel.js', 'gripmodel-data.js', 'data.js', 'ai.js', 'race.js']);
let id = process.argv[2] || 'kestrel';
{ const m = /^gen2-([a-z]+)-(\d+)$/.exec(id); if (m) id = F1.TrackGen2.adopt(F1.TrackGen2.make(+m[2], m[1])).id; }
const rounds = +(process.argv[3] || 8), out = process.argv[4], DT = 1 / 240;
if (process.env.THINK) Object.assign(F1.Race.THINK, JSON.parse(process.env.THINK));
const race = F1.Race.create({ track: id, mode: 'tt', laps: 999, difficulty: 4, team: 0, driver: 0, seed: 7, field: 1, spectate: true, assists: {} });
race.autoPlayer = true;
const c = race.player, tr = race.track, b = c.brain, T = F1.Race.THINK;
// (fixed conditions, as the coach runs: fresh tyres, light fuel, a rubbered line)
const hold = () => { for (const w of c.wheels) w.wear = 0; c.fuel = 10; tr.rubber.fill(0.6); };
let g = 0, walls = 0, lastW = -9;
const lap = explore => {
  b.exploring = explore; T.on = explore;
  const n0 = c.lapTimes.length, w0 = walls;
  while (c.lapTimes.length === n0 && g++ < 240 * 900 * rounds) {
    hold(); F1.Race.step(race, DT);
    for (const f of race.fx) if (f.type === 'wall' && race.time - lastW > 1) { walls++; lastW = race.time; }
    race.fx.length = 0;
  }
  return { t: c.lapTimes[c.lapTimes.length - 1].t, walls: walls - w0 };
};
lap(false); // out lap
const base = lap(false), hist = [base.t];
console.log(`${id}: base ${base.t.toFixed(3)} (walls ${base.walls})`);
let best = base.t;
for (let r = 0; r < rounds; r++) {
  lap(true);
  const v = lap(false);
  hist.push(v.t); best = Math.min(best, v.t);
  console.log(`${id}: round ${r + 1} learned lap ${v.t.toFixed(3)} (walls ${v.walls})  best ${best.toFixed(3)}  ${((1 - best / base.t) * 100).toFixed(1)}% faster`);
}
if (out) require('fs').writeFileSync(out, JSON.stringify({ id, base: base.t, best, hist, pace: Array.from(b.paceBest || b.paceMem, x => +x.toFixed(4)), line: Array.from(b.lineBest || b.lineMem, x => +x.toFixed(3)) }));
