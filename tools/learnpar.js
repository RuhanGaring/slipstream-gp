// Learns a circuit (racing line + AI grip limits) in parallel with js/learncore.js, the
// same code the game runs in Web Workers for procedural circuits.
// usage: node tools/learnpar.js <track|gen-SEED> [threads]   (WRITE=1 stores the result
// into js/lines.js and js/limits.js; NO_STORED=1 ignores a stored racing line)
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'data.js', 'ai.js', 'race.js', 'learncore.js']);
if (process.env.NO_STORED) { F1.Lines = { stride: 2 }; }
const id = process.argv[2] || 'gen-1';
const n = +process.argv[3] || Math.max(2, os.cpus().length - 2);

const workers = [], waits = new Map();
let seq = 0;
for (let w = 0; w < n; w++) {
  const wk = new Worker(path.join(__dirname, 'learnpar-worker.js'), { env: process.env });
  wk.on('message', ({ k, res, err }) => { const p = waits.get(k); waits.delete(k); err ? p.rej(new Error(err)) : p.res(res); });
  workers.push(wk);
}
const pool = { size: n, call: (w, msg) => new Promise((res, rej) => { const k = ++seq; waits.set(k, { res, rej }); workers[w].postMessage({ k, msg }); }) };

(async () => {
  const t0 = Date.now();
  let last = -1;
  const out = await F1.LearnCore.learnTrack(pool, id, { watch: process.env.WATCH ? Math.round(+process.env.WATCH / F1.Race.getTrack(id).ds) : null, lineIters: +process.env.ITERS || undefined, lineBatch: +process.env.BATCH || undefined, debug: process.env.DBG ? (r, b, m, s) => console.log('round', r, 'base', b.toFixed(2), 'merged', m.toFixed(2), 'best single', s.toFixed(2)) : null, line: process.env.LINEFROM ? JSON.parse(require('fs').readFileSync(process.env.LINEFROM, 'utf8')).line : undefined, converge: process.env.CONVERGE ? +process.env.CONVERGE : undefined, onRound: process.env.CONVERGE ? (r, t) => process.stdout.write(`
 round ${r + 1} model lap ${F1.U.fmtTime(t)}  `) : undefined, modes: process.env.LINEONLY || process.env.SIMONLY ? ['sim'] : undefined, gens: process.env.LINEONLY ? 1 : undefined, checks: process.env.LINEONLY ? 0 : undefined, progress: (p, stage) => { const q = Math.floor(p * 10); if (q !== last) { last = q; process.stdout.write(`${stage} ${Math.round(p * 100)}%  `); } } });
  console.log(`\n${id}: ${((Date.now() - t0) / 1000).toFixed(1)} s on ${n} threads`);
  console.log(' line model lap', F1.U.fmtTime(out.stats.line.from), '->', F1.U.fmtTime(out.stats.line.to), 'in', (out.stats.line.ms / 1000).toFixed(1), 's');
  for (const m of Object.keys(out.stats.modes)) { const s = out.stats.modes[m]; console.log(` ${m}: mean grip x${s.mean.toFixed(3)} from ${s.laps} test laps on ${s.cars} cars`); }
  if (process.env.WRITE) {
    const fs = require('fs');
    const put = (file, name, obj, stride) => {
      const fp = path.join(__dirname, '..', 'js', file);
      delete globalThis.F1[name];
      require('vm').runInThisContext(fs.readFileSync(fp, 'utf8'));
      const all = globalThis.F1[name]; all[id] = obj;
      let js = fs.readFileSync(fp, 'utf8').split('\n').slice(0, 2).join('\n') + '\n(function (G) {\n  G.F1 = G.F1 || {};\n  G.F1.' + name + ' = { stride: ' + stride + ',\n';
      for (const k of Object.keys(all)) {
        if (k === 'stride') continue;
        const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
        if (Array.isArray(all[k])) js += `    ${key}: [${all[k].join(',')}],\n`;
        else { js += `    ${key}: {\n`; for (const m of Object.keys(all[k])) js += `      ${m}: [${all[k][m].join(',')}],\n`; js += '    },\n'; }
      }
      js += "  };\n})(typeof window !== 'undefined' ? window : globalThis);\n";
      fs.writeFileSync(fp, js);
    };
    put('lines.js', 'Lines', out.line, 2);
    put('limits.js', 'Limits', out.limits, 5);
    console.log(' wrote js/lines.js and js/limits.js');
  }
  if (process.env.OUT) require('fs').writeFileSync(process.env.OUT, JSON.stringify(out));
  workers.forEach(w => w.terminate());
})().catch(e => { console.error(e); process.exit(1); });
