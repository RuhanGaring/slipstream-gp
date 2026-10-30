// Rolls procedural circuits and reports how they come out.
// usage: node tools/gentest.js [count] [firstSeed]
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'raceline.js', 'data.js', 'ai.js', 'race.js']);
const n = +process.argv[2] || 20, first = +process.argv[3] || 1;
const styles = {}, looks = {};
let tries = 0, ms = 0;
for (let s = first; s < first + n; s++) {
  const t0 = Date.now();
  const def = F1.TrackGen.make(s);
  const tr = F1.Race.getTrack(def.id);
  ms += Date.now() - t0; tries += def.tries;
  styles[def.style] = (styles[def.style] || 0) + 1; looks[def.look] = (looks[def.look] || 0) + 1;
  console.log(`${String(s).padStart(6)} ${def.name.padEnd(30)} ${def.style.padEnd(6)} ${def.look.padEnd(8)} ${(tr.L / 1000).toFixed(2)} km  ${String(tr.apexes.length).padStart(2)} corners  ${tr.drs.length} straights  ref ${F1.U.fmtTime(tr.refLap)}  tries ${def.tries}`);
}
console.log(`avg ${(ms / n).toFixed(0)} ms and ${(tries / n).toFixed(1)} tries per circuit`, styles, looks);
