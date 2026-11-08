// A first-time driver: throttle always flat, never touches the brake, steers with on/off keys
// and a human reaction. Shows what the driving helps do for someone with no feel for the car.
// usage: node tools/helpbot.js [track] [arcade|sim] [brakeHelp 0-2] [steerHelp 0-2] [secs] [difficulty]
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'damage.js', 'softbody.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js']);
const U = F1.U;
const id = process.argv[2] || 'kestrel', mode = process.argv[3] || 'arcade', bh = +process.argv[4] || 0, sh = +process.argv[5] || 0, secs = +process.argv[6] || 240, diff = +(process.argv[7] || 5);
const sim = mode === 'sim', DT = 1 / 240;
const assists = sim ? { abs: true, tc: 2, autoGear: true, steerAssist: 1, stability: 0, damage: false, gripMul: 1, brakeHelp: bh, steerHelp: sh } : { abs: true, tc: 2, autoGear: true, steerAssist: 1, stability: 1, gripMul: 1.12, damage: false, brakeHelp: bh, steerHelp: sh };
const race = F1.Race.create({ track: id, mode: sim ? 'sim' : 'arcade', laps: 30, difficulty: diff, team: 0, driver: 0, field: 20, grid: 'back', seed: 5, safetyCar: 'off', mandatory: false, assists, adaptive: !!process.env.ADAPT });
const p = race.player, tr = race.track, inp = { steer: 0 };
let lastWall = -9, react = 0, key = 0, walls = 0, offs = 0, wasOff = false, stuckMax = 0, resets = 0;
while (race.time < secs) {
  react -= DT;
  if (react <= 0 && race.green) {
    react = 0.1;
    const look = 10 + p.speed * 0.42, j = (p.loc.i + Math.round(look / tr.ds)) % tr.N;
    const ang = U.wrapAngle(Math.atan2(tr.y[j] + tr.ny[j] * tr.line.off[j] - p.y, tr.x[j] + tr.nx[j] * tr.line.off[j] - p.x) - p.h);
    key = ang > 0.04 ? 1 : ang < -0.04 ? -1 : 0;
  }
  inp.steer = U.approach(inp.steer, key, (key === 0 ? 7 : 4) * DT);
  p.ctl.steer = inp.steer; p.ctl.throttle = race.green ? 1 : 0; p.ctl.brake = 0; p.ctl.steerDirect = null;
  F1.Race.step(race, DT);
  for (const f of race.fx) if (f.type === 'wall' && f.car === p && f.power > 3 && race.time - lastWall > 1.5) { walls++; lastWall = race.time; }
  race.fx.length = 0;
  const off = Math.abs(p.loc.d) > tr.hw + 1;
  if (off && !wasOff) offs++;
  wasOff = off;
  stuckMax = Math.max(stuckMax, p.stuckT || 0);
  if ((p.stuckT || 0) > 3) { race.recover(p); p.stuckT = 0; resets++; } // (the game offers R when stuck)
}
const laps = p.lapTimes.map(l => l.t).sort((a, b) => a - b);
console.log(`${id} ${mode} brake ${bh} steer ${sh}: laps ${laps.length}, best ${laps.length ? U.fmtTime(laps[0]) : '-'}, median ${laps.length ? U.fmtTime(laps[laps.length >> 1]) : '-'}, walls ${walls}, offs ${offs}, resets ${resets}, P${p.pos}, field k ${race.adapt ? race.adapt.k.toFixed(2) : '-'}`);
