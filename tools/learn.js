// Teaches the AI each circuit's real limit. A reference car runs hot laps on its
// own; the grip it plans with is a per-sample multiplier. Clean sections get pushed
// harder, sections where the car slides, runs wide, leaves the track or hits a
// wall get pulled back with a halving step (bisection toward the limit).
// Writes js/limits.js.   usage: node tools/learn.js [track|all] [laps]
const fs = require('fs');
const path = require('path');
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'data.js', 'ai.js', 'race.js']);
const ids = process.argv[2] && process.argv[2] !== 'all' ? [process.argv[2]] : F1.Tracks.DEFS.map(d => d.id);
const LAPS = +process.argv[3] || 36;
const DT = 1 / 240;
const STRIDE = 5; // stored every 5 samples (10 m)
const outFile = path.join(__dirname, '..', 'js', 'limits.js');
let existing = {};
if (fs.existsSync(outFile)) {
  delete globalThis.F1.Limits;
  require('vm').runInThisContext(fs.readFileSync(outFile, 'utf8'));
  existing = globalThis.F1.Limits || {};
}

function smooth(a, r) {
  const N = a.length, o = new Float64Array(N);
  for (let i = 0; i < N; i++) { let s = 0; for (let k = -r; k <= r; k++) s += a[(i + k + N) % N]; o[i] = s / (2 * r + 1); }
  return o;
}

function learn(id, mode) {
  const race = F1.Race.create({ track: id, mode, laps: 999, difficulty: 4, team: 0, driver: 0, field: 1, seed: 3 });
  race.cars = [race.player]; race.order = [race.player];
  race.autoPlayer = true;
  const c = race.player, tr = race.track, N = tr.N;
  c.wearRate = 1e-9; // (0 would read as the default rate)
  c.assist.damage = false; // a damaged car drives slowly ever after and would teach soft limits
  const gripK = mode === 'sim' ? 1 : 1.12;
  const g = new Float64Array(N).fill(1.0);
  const step = new Float64Array(N).fill(0.04);
  const rebuild = () => { c.brain.prof = F1.Raceline.speedProfile(tr, tr.line, c.spec, { pace: gripK, grip: g }); };
  rebuild();
  let fail = new Uint8Array(N);
  let rec = 0, wall = 0;
  race.recover = (orig => car => { rec++; fail[car.loc.i] = 1; orig(car); })(race.recover);
  let lastLap = 0, best = Infinity, lapsDone = 0, slideT = 0;
  const hist = [];
  const dbg = new Set();
  while (lapsDone < LAPS && race.time < 60 * 200) {
    c.fuel = 20; // limits are learned at a reference fuel load; the AI scales for the rest
    F1.Race.step(race, DT);
    for (const f of race.fx) if (f.type === 'wall' && f.power > 2) { fail[c.loc.i] = 1; wall++; }
    race.fx.length = 0;
    if (!race.green) continue;
    const i = c.loc.i;
    const err = Math.abs(c.loc.d - tr.line.off[i]);
    // a failure is the car actually sliding: rear past its lateral peak or the body yawing out,
    // front washing wide; ABS-managed lockups and TC-managed wheelspin are the systems working
    // (a slide only counts when it is held: a kerb or crest twitch the car catches in a
    // tenth of a second is part of the lap, not a mistake to brake for)
    const sliding = c.satR != null ? c.satR > 1.5 || (Math.abs(c.beta) > 0.13 && c.speed > 15) : false;
    slideT = sliding ? slideT + DT : 0;
    const rs = c.satR != null ? (slideT > 0.12 || Math.abs(c.beta) > 0.3 ? 1 : 0) : Math.max(c.wheels[2].slide, c.wheels[3].slide);
    const fs = c.satF != null ? (c.satF > 1.75 ? 2 : 0) : Math.max(c.wheels[0].slide, c.wheels[1].slide);
    const why = err > 4 ? 'err' : rs > 0.55 ? 'rear' : fs > 1.1 ? 'front' : c.wheels.every(w => w.outside) ? 'limits' : '';
    if (why) { fail[i] = 1; if (process.env.DBG && lapsDone >= LAPS - 3) dbg.add(`${why}@${Math.round(i * tr.ds / 20) * 20}`); }
    if (c.lapTimes.length > lastLap) {
      lastLap = c.lapTimes.length;
      const lt = c.lapTimes[lastLap - 1];
      if (lastLap === 1) { fail = new Uint8Array(N); continue; } // standing-start lap: just warm up
      lapsDone++;
      const clean = !fail.some(x => x);
      if (clean) best = Math.min(best, lt.t);
      hist.push(F1.U.fmtTime(lt.t) + (clean ? '' : '*') + (process.env.T ? '[' + c.wheels.map(w => w.temp.toFixed(0) + '/' + (w.wear * 100).toFixed(0)).join(' ') + ' f' + c.fuel.toFixed(0) + ' dmg' + c.wingDmg.toFixed(2) + ']' : ''));
      // failure regions: from the braking zone before the problem to just after it
      const bad = new Uint8Array(N);
      for (let k = 0; k < N; k++) if (fail[k]) for (let q = -Math.round(140 / tr.ds); q <= Math.round(16 / tr.ds); q++) bad[(k + q + N) % N] = 1;
      for (let k = 0; k < N; k++) {
        if (bad[k]) { g[k] -= step[k] * 1.5; step[k] = Math.max(0.004, step[k] * 0.5); }
        else g[k] += step[k];
        g[k] = Math.min(1.4, Math.max(0.8, g[k]));
      }
      const gs = smooth(g, 6);
      for (let k = 0; k < N; k++) g[k] = Math.min(g[k], gs[k] + 0.01);
      rebuild();
      fail = new Uint8Array(N);
    }
  }
  // final margin, then a verification stint at the stored values
  // street circuits get a bigger margin: the walls are a car's width away, not a gravel trap
  const margin = tr.def.style === 'street' ? 0.955 : 0.985;
  for (let k = 0; k < N; k++) g[k] *= margin;
  const out = [];
  for (let k = 0; k < N; k += STRIDE) out.push(+g[k].toFixed(3));
  const mean = out.reduce((a, b) => a + b, 0) / out.length;
  if (process.env.DBG) console.log([...dbg].join(' '));
  console.log(`${id} ${mode}: laps ${hist.join(' ')}  best clean ${F1.U.fmtTime(best)}  mean grip x${mean.toFixed(3)}  recoveries ${rec} walls ${wall}`);
  return out;
}

const res = existing;
for (const id of ids) {
  res[id] = res[id] || {};
  for (const mode of ['sim', 'arcade']) res[id][mode] = learn(id, mode);
}
let js = '// Generated by tools/learn.js: per-circuit grip multipliers the AI has learned it\n// can use, stored every ' + STRIDE + ' samples (10 m). Do not edit by hand.\n';
js += '(function (G) {\n  G.F1 = G.F1 || {};\n  G.F1.Limits = { stride: ' + STRIDE + ',\n';
for (const id of Object.keys(res)) {
  if (id === 'stride') continue;
  js += `    ${/^[A-Za-z_$][\w$]*$/.test(id) ? id : JSON.stringify(id)}: {\n`;
  for (const m of Object.keys(res[id])) js += `      ${m}: [${res[id][m].join(',')}],\n`;
  js += '    },\n';
}
js += '  };\n})(typeof window !== \'undefined\' ? window : globalThis);\n';
fs.writeFileSync(outFile, js);
console.log('wrote', outFile);
