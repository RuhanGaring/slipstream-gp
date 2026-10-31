// Loads the game's DOM-free modules into Node for headless tests.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const CORE = ['util.js', 'tracks.js', 'car.js', 'damage.js', 'softbody.js', 'raceline.js', 'ai.js', 'race.js'];
module.exports = function load(files = CORE) {
  // generated circuits ride along with the track module everywhere
  if (files.includes('tracks.js') && !files.includes('trackgen.js')) files = files.flatMap(f => (f === 'tracks.js' ? [f, 'trackgen.js'] : [f]));
  for (const f of files) {
    const p = path.join(__dirname, '..', 'js', f);
    if (!fs.existsSync(p)) continue;
    vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: p });
  }
  // driving-technique overrides for tuning runs (tools/drivetune.js), workers included
  if (process.env.AIP && globalThis.F1 && globalThis.F1.AI) Object.assign(globalThis.F1.AI.P, JSON.parse(process.env.AIP));
  return globalThis.F1;
};
