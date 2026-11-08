// Flashback checks: a snapshot put back must match the race exactly, the race must carry on
// sanely from it, and a snapshot must be cheap enough to take during a race.
// usage: node tools/fbtest.js [track] [mode]
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'damage.js', 'softbody.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js', 'flashback.js']);
const id = process.argv[2] || 'kestrel', mode = process.argv[3] || 'sim', DT = 1 / 240;
const race = F1.Race.create({ track: id, mode, laps: 5, difficulty: 2, team: 0, driver: 0, grid: 10, field: 20, seed: 11, assists: { damage: 'full', abs: true, tc: 1, autoGear: true, steerAssist: 1 } });
race.autoPlayer = true;
const run = secs => { const n = Math.round(secs / DT); for (let i = 0; i < n; i++) { F1.Race.step(race, DT); race.fx.length = 0; } };

// everything that matters about a race as a plain value, for comparing
const seen = new Set(['track', 'cfg', 'rng', 'spec', 'team', 'driver', 'compound', 'prof', 'style', 'profFor', 'rec', 'ghost', 'ghostRec', 'player', 'fx', 'events', 'diff']);
function fp(o, stack = new Set()) {
  if (o === null || typeof o !== 'object') return typeof o === 'function' ? 'fn' : typeof o === 'number' ? (Number.isNaN(o) ? 'NaN' : o) : o;
  if (stack.has(o)) return 'cycle';
  if (o.driver && o.driver.code && stack.size > 0) return 'car:' + o.driver.code;
  stack.add(o);
  let r;
  if (ArrayBuffer.isView(o)) r = Array.from(o);
  else if (Array.isArray(o)) r = o.map(v => fp(v, stack));
  else if (o instanceof Map) r = Array.from(o).map(([k, v]) => [fp(k, stack), fp(v, stack)]);
  else if (o instanceof Set) r = Array.from(o).map(v => fp(v, stack));
  else { r = {}; for (const k of Object.keys(o).sort()) if (!seen.has(k)) r[k] = fp(o[k], stack); }
  stack.delete(o);
  return r;
}
const sig = () => JSON.stringify({ time: race.time, cars: race.cars.map(c => fp(c)), order: race.order.map(c => c.id), sc: fp(race.sc), rain: race.rain, wet: race.wet });

let fails = 0;
const check = (name, ok, extra) => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) fails++; };

run(40);
const ring = new F1.Flashback.Ring(race, { step: 0.25, span: 30 });
const t0 = process.hrtime.bigint();
let caps = 0;
for (let i = 0; i < 240 * 20; i++) { F1.Race.step(race, DT); race.fx.length = 0; if (ring.capture()) caps++; }
const before = process.hrtime.bigint();
for (let i = 0; i < 40; i++) { ring.next = 0; ring.capture(); }
const ms = Number(process.hrtime.bigint() - before) / 1e6 / 40;
ring.snaps.length = Math.min(ring.snaps.length, caps); // (the timing loop's extra copies go)
check('snapshot under 2 ms', ms < 2, ms.toFixed(2) + ' ms each, ' + ring.snaps.length + ' held, ' + (ring.snaps[0].list.length / 2) + ' objects');

// back ten seconds: the state must be the state at that moment
const want = race.time - 10;
const mid = F1.Flashback.take(race);
const midSig = sig();
ring.next = 0; const s = ring.snaps.filter(x => x.t <= want).pop();
F1.Flashback.put(race, s);
const a = sig();
F1.Flashback.put(race, mid);
check('put back exact (forward)', sig() === midSig);
F1.Flashback.put(race, s);
check('put back exact (twice)', sig() === a);
check('time rewound', Math.abs(race.time - s.t) < 1e-9, race.time.toFixed(2));
check('cars still the same objects', race.order.every(c => race.cars.includes(c)) && race.cars.includes(race.player));
check('brain rivals are live cars', race.cars.every(c => !c.brain.ahead || race.cars.includes(c.brain.ahead)));

// and it must go on driving
const lapsBefore = race.player.dist;
ring.rollback(s.t);
run(60);
check('race goes on', race.player.dist > lapsBefore + 1000 && !race.cars.some(c => !isFinite(c.x)), 'player ' + (race.player.dist - lapsBefore).toFixed(0) + ' m further');
check('no car lost', race.cars.length === 20 && race.order.length === 20);
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
