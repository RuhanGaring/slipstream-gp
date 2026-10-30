// Headless race: every car is AI driven (player car too). Reports lap times,
// incidents and overtakes per track.  usage: node tools/simrace.js [track] [laps] [diff] [mode]
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js']);
const ids = process.argv[2] && process.argv[2] !== 'all' ? [process.argv[2]] : F1.Tracks.DEFS.map(d => d.id);
const laps = +process.argv[3] || 3, diff = process.argv[4] != null ? +process.argv[4] : 4, mode = process.argv[5] || 'sim';
const DT = 1 / 240;
for (const id of ids) {
  const t0 = Date.now();
  const race = F1.Race.create({ track: id, mode, laps, difficulty: diff, team: 0, driver: 0, grid: 10, field: 20, seed: +(process.env.SEED || 7), assists: {} });
  race.autoPlayer = true;
  if (process.env.PHYSLOD) race.physLod = true;
  const lastInc = new Map();
  let wall = 0, contact = 0, recov = 0, offs = 0, overtakes = 0, lastOrder = null;
  const offState = new Map();
  const origRecover = race.recover;
  race.recover = c => { recov++; if (process.env.V) console.log(`  RECOVER ${c.driver.code} s=${c.loc.s.toFixed(0)} t=${(race.time-race.startTime).toFixed(1)}`); origRecover(c); };
  let steps = 0;
  while (!race.done && race.time < 60 * 25) {
    F1.Race.step(race, DT); steps++;
    for (const f of race.fx) {
      const key = f.type + f.car.id + '-' + (f.other ? f.other.id : '') ;
      const tNow = race.time;
      if (lastInc.get(key) > tNow - 3) { lastInc.set(key, tNow); continue; }
      lastInc.set(key, tNow);
      if (f.type === 'wall' && f.power > 4) { wall++; if (process.env.V) console.log(`  wall ${f.car.driver.code} s=${f.car.loc.s.toFixed(0)} pow=${f.power.toFixed(1)} t=${(race.time-race.startTime).toFixed(1)}`); }
      if (f.type === 'car' && f.power > 3) { contact++; if (process.env.V) console.log(`  hit ${f.car.driver.code}-${f.other.driver.code} s=${f.car.loc.s.toFixed(0)} pow=${f.power.toFixed(1)} t=${(race.time-race.startTime).toFixed(1)} modes ${f.car.brain.mode}/${f.other.brain.mode} ds=${F1.AI.relS(race.track, f.car, f.other).toFixed(1)} d=${f.car.loc.d.toFixed(1)}/${f.other.loc.d.toFixed(1)} v=${(f.car.speed*3.6).toFixed(0)}/${(f.other.speed*3.6).toFixed(0)} brk=${f.car.ctl.brake.toFixed(1)}/${f.other.ctl.brake.toFixed(1)} des=${(f.car.brain.desired||0).toFixed(1)}/${(f.other.brain.desired||0).toFixed(1)}`); }
    }
    race.fx.length = 0;
    if (process.env.TRACE && steps % 60 === 0) {
      const [code, t0, t1] = process.env.TRACE.split(',');
      const c = race.cars.find(c => c.driver.code === code); const tt = race.time - race.startTime;
      if (c && tt >= +t0 && tt <= +t1) console.log(`   ${code} t=${tt.toFixed(2)} s=${c.loc.s.toFixed(0)} d=${c.loc.d.toFixed(1)} line=${race.track.line.off[c.loc.i].toFixed(1)} lo/hi=${(c.brain.lo||0).toFixed(1)}/${(c.brain.hi||0).toFixed(1)} v=${(c.u*3.6).toFixed(0)} prof=${(c.brain.prof[c.loc.i]*3.6).toFixed(0)} thr=${c.ctl.throttle.toFixed(2)} brk=${c.ctl.brake.toFixed(2)} st=${(c.steer*57.3).toFixed(1)} mode=${c.brain.mode} slide=${c.wheels.map(w=>w.slide.toFixed(1)).join('/')} wear=${(c.wheels[0].wear*100).toFixed(0)} T=${c.wheels.map(w=>w.temp.toFixed(0)).join('/')} surf=${c.wheels.map(w=>w.surf).join('')} dmg=${c.wingDmg.toFixed(2)}`);
    }
    if (steps % 24 === 0) {
      for (const c of race.cars) {
        const o = Math.abs(c.loc.d) > race.track.hw + 1.5 && !c.inPit;
        if (o && !offState.get(c)) offs++;
        offState.set(c, o);
      }
      const ord = race.order.map(c => c.id).join(',');
      if (lastOrder && race.green && race.time - race.startTime > 8) {
        const prev = lastOrder.split(',');
        race.order.forEach((c, k) => { const pk = prev.indexOf(String(c.id)); if (pk > k) overtakes += pk - k; });
      }
      lastOrder = ord;
    }
  }
  const tr = race.track;
  console.log(`\n== ${tr.name}  L=${tr.L.toFixed(0)}  ref ${F1.U.fmtTime(tr.refLap)}  sim ${(race.time).toFixed(0)}s in ${((Date.now() - t0) / 1000).toFixed(1)}s  done=${race.done}`);
  console.log(`walls ${wall}  contacts ${contact}  recoveries ${recov}  offs ${offs}  pos-changes ${overtakes}  fastest ${race.fastest ? F1.U.fmtTime(race.fastest.t) + ' ' + race.fastest.car.driver.code : '-'}`);
  for (const c of (race.result || race.order).slice(0, 20)) {
    console.log(`${String(c.resultPos || c.pos).padStart(2)} ${c.driver.code} ${c.team.short} grid ${String(c.gridPos).padStart(2)}  best ${F1.U.fmtTime(c.bestLap)}  laps ${c.lapTimes.map(l => F1.U.fmtTime(l.t) + (l.valid ? '' : '*')).join(' ')}  pits ${c.pitStops} ${c.tyreHist.join('>')} wear ${(Math.max(...c.wheels.map(w => w.wear))*100).toFixed(0)}% T ${c.wheels.map(w=>w.temp.toFixed(0)).join('/')} warn ${c.warnings} pen ${c.penalty}`);
  }
}
