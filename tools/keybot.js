// A "keyboard human": only on/off W A S D, fed through the same ramps the game uses.
// Checks the car is drivable on digital keys in arcade and sim handling.
// usage: node tools/keybot.js track mode [secs]
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js']);
const U = F1.U;
const id = process.argv[2] || 'kestrel', mode = process.argv[3] || 'arcade', secs = +process.argv[4] || 200;
const sim = mode === 'sim';
const assists = sim ? { abs: true, tc: 1, autoGear: true, steerAssist: 1, stability: 0, damage: true, gripMul: 1 } : { abs: true, tc: 2, autoGear: true, steerAssist: 1, stability: 1, gripMul: 1.12, damage: false };
const race = F1.Race.create({ track: id, mode: sim ? 'sim' : 'arcade', laps: 3, difficulty: 2, team: 0, driver: 0, field: 1, assists });
race.cars = [race.player]; race.order = [race.player];
const p = race.player, tr = race.track;
const DT = 1 / 240;
const inp = { steer: 0, thr: 0, brk: 0 };
let keys = { W: 0, S: 0, A: 0, D: 0 }, react = 0;
const hist = [];
let offs = 0, wasOff = false, walls = 0, resets = 0, spins = 0;
const prof = F1.Raceline.speedProfile(tr, tr.line, p.spec, { pace: +(process.env.PACE || (sim ? 0.88 : 0.95)) });
while (race.time < secs) {
  // decide keys every 60 ms (human-ish reaction), digital only
  react -= DT;
  if (react <= 0 && race.green) {
    react = 0.06;
    const i = p.loc.i, v = p.speed;
    const look = 8 + v * 0.35;
    const j = (i + Math.round(look / tr.ds)) % tr.N;
    const tx = tr.x[j] + tr.nx[j] * tr.line.off[j], ty = tr.y[j] + tr.ny[j] * tr.line.off[j];
    const ang = U.wrapAngle(Math.atan2(ty - p.y, tx - p.x) - p.h);
    keys.D = ang > 0.03 ? 1 : 0; keys.A = ang < -0.03 ? 1 : 0;
    const vt = prof[(i + Math.round((v * 0.25 + 4) / tr.ds)) % tr.N];
    keys.W = v < vt - 1 ? 1 : 0; keys.S = v > vt + 3 ? 1 : 0;
  }
  const st = keys.D - keys.A;
  const toward = st === 0 ? 7 : (Math.sign(st) !== Math.sign(inp.steer) && inp.steer !== 0 ? 9 : (sim ? 3.8 : 4.2));
  inp.steer = U.approach(inp.steer, st, toward * DT);
  inp.thr = U.approach(inp.thr, keys.W, (keys.W ? 6 : 12) * DT);
  inp.brk = U.approach(inp.brk, keys.S, (keys.S ? 7 : 14) * DT);
  p.ctl.steer = inp.steer; p.ctl.throttle = inp.thr; p.ctl.brake = inp.brk; p.ctl.steerDirect = null;
  F1.Race.step(race, DT);
  for (const f of race.fx) if (f.type === 'wall' && f.power > 3) walls++;
  race.fx.length = 0;
  const off = Math.abs(p.loc.d) > tr.hw + 1;
  if (off && !wasOff) offs++;
  wasOff = off;
  const head = Math.atan2(tr.ty[p.loc.i], tr.tx[p.loc.i]);
  hist.push(`s=${p.loc.s.toFixed(0)} v=${(p.speed*3.6).toFixed(0)} thr=${p.ctl.throttle.toFixed(2)} brk=${p.ctl.brake.toFixed(2)} st=${p.ctl.steer.toFixed(2)} d=${p.steer.toFixed(3)} beta=${(Math.atan2(p.v,Math.abs(p.u))*57.3).toFixed(1)} r=${p.r.toFixed(2)} slide=${p.wheels.map(w=>w.slide.toFixed(1)).join('/')} spin=${p.wheels[2].spin.toFixed(1)}/${p.wheels[3].spin.toFixed(1)} lock=${p.wheels.map(w=>w.lock.toFixed(1)).join('/')} g=${p.gear} surf=${p.wheels.map(w=>w.surf).join('')}`);
  if (hist.length > 240) hist.shift();
  if (Math.abs(U.wrapAngle(p.h - head)) > 1.6 && race.green) { spins++; if (process.env.V && spins <= 2) { console.log('--- spin'); for (let q = 0; q < 240; q += 24) console.log(hist[q]); } race.recover(p); resets++; }
}
console.log(id, mode, 'laps', p.lapTimes.map(l => U.fmtTime(l.t) + (l.valid ? '' : '*')).join(' '), 'offs', offs, 'walls', walls, 'spins', spins);
