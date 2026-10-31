// One AI car alone on a circuit, three laps, scored for the grip model: best flying lap,
// recoveries, wall hits and track-limit breaches. MODE: 'none' (an unlearned circuit as the
// game had it: default line, plain grip), 'model' (default line, grip from js/gripmodel.js),
// 'learned' (the learned line and grip from FILE, the upper bound).
// usage: node tools/gripdrive.js ID MODE [FILE] [kind]   (MODEL=file.json uses those trees)
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'gripmodel.js', 'ai.js', 'race.js']);
const [id, mode, file, kind = 'sim'] = process.argv.slice(2);
if (process.env.MODEL) F1.GripModelData = JSON.parse(require('fs').readFileSync(process.env.MODEL, 'utf8'));
if (process.env.SCALE) for (const k of ['sim', 'arcade']) if (F1.GripModelData && F1.GripModelData[k]) F1.GripModelData[k].scale = +process.env.SCALE;
if (mode === 'none') { F1.GripModel = null; F1.GripModelData = null; }
if (mode === 'learned') { const o = JSON.parse(require('fs').readFileSync(file, 'utf8')); F1.Lines[id] = o.line; F1.Limits[id] = o.limits; }
// 'lline': learned line, model grip (how much the grip model alone gives); 'tech': the
// technique line the learning starts from, model grip
if (mode === 'lline') { const o = JSON.parse(require('fs').readFileSync(file, 'utf8')); F1.Lines[id] = o.line; }
if (mode === 'tech') { const tr = F1.Race.getTrack(id); F1.Raceline.applyLine(tr, F1.Raceline.lineFromOffsets(tr, F1.Raceline.techniqueLine(tr))); }
const race = F1.Race.create({ track: id, mode: kind, laps: 3, difficulty: 4, team: 0, driver: 0, seed: 7, field: 1 });
race.cars = [race.player]; race.order = [race.player]; race.autoPlayer = true;
const c = race.player;
let rec = 0, walls = 0, lim = 0, lastW = -9, lastL = -9;
const orig = race.recover; race.recover = car => { rec++; orig(car); };
while (!race.done && race.time < 420 && c.lapTimes.length < 3) {
  F1.Race.step(race, 1 / 240);
  for (const f of race.fx) if (f.type === 'wall' && f.power > 2 && race.time - lastW > 2) { walls++; lastW = race.time; }
  race.fx.length = 0;
  if (c.wheels.every(w => w.outside) && race.time - lastL > 1.5) { lim++; lastL = race.time; }
}
const fly = c.lapTimes.slice(1).map(l => l.t);
console.log(JSON.stringify({ id, mode, best: fly.length ? Math.min(...fly) : null, laps: c.lapTimes.length, rec, walls, lim }));
