// How the AI really drives, corner by corner: where each car gets on the brakes, how hard, how
// much that varies between cars and laps, and how far apart their lines are at the apex.
// usage: node tools/drivestats.js [track] [laps] [difficulty]
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js']);
const id = process.argv[2] || 'kestrel', laps = +process.argv[3] || 6, diff = process.argv[4] != null ? +process.argv[4] : 3, DT = 1 / 240;
const race = F1.Race.create({ track: id, mode: 'sim', laps, difficulty: diff, team: 0, driver: 0, grid: 10, field: 20, seed: +(process.env.SEED || 7), assists: {} });
race.autoPlayer = true;
const tr = race.track, N = tr.N;
// the heavy zones: a real stop into a corner
const zones = tr.brakeZones.filter(z => z.vIn - z.vOut > 15 || (z.vOut != null && (tr.prof[Math.floor(z.s0 / tr.ds) % N] - z.vOut) > 15));
const Z = (zones.length ? zones : tr.brakeZones).map(z => ({ z, apex: 0, hits: [], lat: [] }));
for (const q of Z) {
  let bi = -1, bk = -1;
  for (let d = 0; d < 160; d += tr.ds) { const k = Math.floor(((z => z)(q.z.s0 + d) % tr.L) / tr.ds) % N, a = Math.abs(tr.line.kap[k]); if (a > bk) { bk = a; bi = k; } }
  q.apex = bi;
}
const st = new Map();
let wall = 0, contact = 0;
const last = new Map();
while (!race.done && race.time < 60 * 30) {
  F1.Race.step(race, DT);
  for (const f of race.fx) {
    const key = f.type + f.car.id, t = race.time;
    if (last.get(key) > t - 3) { last.set(key, t); continue; }
    last.set(key, t);
    if (f.type === 'wall' && f.power > 4) wall++;
    if (f.type === 'car' && f.power > 3) contact++;
  }
  race.fx.length = 0;
  if (!race.green || race.time - race.startTime < 40) continue;
  for (const c of race.cars) {
    if (c.retired || c.inPit || c.incident) continue;
    const s = st.get(c) || { on: false, b: 0 };
    st.set(c, s);
    const brk = c.ctl.brake > 0.5;
    if (brk && !s.on) {
      for (const q of Z) {
        const d = F1.Tracks.fwd(tr, q.z.s0 - 120, c.loc.s);
        if (d < 240) { const free = !c.brain || !c.brain.ahead || c.brain.gapAhead > 45; if (free) q.hits.push({ car: c.id, lap: c.lap, s: d - 120, v: c.speed }); break; }
      }
    }
    s.on = brk;
    for (const q of Z) if (c.loc.i === q.apex && s.ap !== q.apex + c.lap * 1e5) { s.ap = q.apex + c.lap * 1e5; q.lat.push(c.loc.d - tr.line.off[q.apex]); }
  }
}
const sd = a => { if (a.length < 2) return 0; const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
const rows = Z.filter(q => q.hits.length > 8);
let sp = 0, lt = 0, n = 0;
console.log(`${tr.name} L ${tr.L.toFixed(0)} difficulty ${diff}: fastest ${race.fastest ? F1.U.fmtTime(race.fastest.t) : '-'} ref ${F1.U.fmtTime(tr.refLap)} walls ${wall} contacts ${contact}`);
for (const q of rows) {
  const ss = q.hits.map(h => h.s), v = q.hits.reduce((x, h) => x + h.v, 0) / q.hits.length, dist = Math.round((v * v - q.z.vOut * q.z.vOut) / (2 * 1));
  const byCar = new Map(); for (const h of q.hits) { if (!byCar.has(h.car)) byCar.set(h.car, []); byCar.get(h.car).push(h.s); }
  const within = sd([...byCar.values()].map(sd).filter(x => x > 0));
  void within; void dist;
  console.log(`  zone at ${Math.round(q.z.s0)}: ${(v * 3.6).toFixed(0)} to ${(q.z.vOut * 3.6).toFixed(0)} km/h, brake point ${(ss.reduce((x, y) => x + y, 0) / ss.length).toFixed(1)} m from plan, spread ${sd(ss).toFixed(1)} m, apex line spread ${sd(q.lat).toFixed(2)} m (${q.hits.length} stops)`);
  sp += sd(ss); lt += sd(q.lat); n++;
}
console.log(`MEAN brake spread ${(sp / Math.max(1, n)).toFixed(1)} m, apex line spread ${(lt / Math.max(1, n)).toFixed(2)} m over ${n} zones`);
