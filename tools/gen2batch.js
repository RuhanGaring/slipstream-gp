// Headless test of the elevation-aware generator (js/trackgen2.js), on every core: makes many
// circuits per style across worker threads, re-verifies each one independently, rebuilds it to
// check the same seed gives the same circuit, and reports failures, rejection reasons and timing.
// usage: node tools/gen2batch.js [count per style] [styles comma-separated] [first seed] [threads]
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');
const load = require('./load');

if (!isMainThread) {
  // a worker: one seed at a time, as the main thread hands them out
  const F1 = load(['util.js', 'tracks.js', 'trackgen.js', 'trackgen2.js']);
  parentPort.on('message', ({ style, seed }) => {
    const out = { style, seed };
    try {
      const res = F1.TrackGen2.make(seed, style);
      const rep = F1.TrackGen2.verify(res);
      out.reasons = res.reasons;
      if (!rep.ok) out.fail = 're-verify: ' + rep.fails.join(', ');
      else {
        // the same seed must give the same circuit, whichever candidate the search started from
        const again = F1.TrackGen2.make(seed, style, { from: res.cand });
        if (again.tr.N !== res.tr.N || Math.abs(again.tr.z[7] - res.tr.z[7]) > 1e-9) out.fail = 'not deterministic';
        out.tries = res.tries; out.ms = res.ms;
        out.stats = { len: res.tr.L, range: rep.info.range, gMax: rep.info.gMax * 100, corners: rep.info.corners, minR: rep.info.minR };
      }
    } catch (e) { out.fail = e.message; out.reasons = e.reasons || {}; }
    parentPort.postMessage(out);
  });
  return;
}

const n = +(process.argv[2] || 50), styles = (process.argv[3] || 'city,park,mountain,modern').split(','), s0 = +(process.argv[4] || 1);
const threads = Math.max(1, +(process.argv[5] || os.cpus().length - 1));
const jobs = [];
for (const style of styles) for (let seed = s0; seed < s0 + n; seed++) jobs.push({ style, seed });
const per = {};
for (const st of styles) per[st] = { ok: 0, tries: 0, ms: 0, failed: [], reasons: {}, stats: { len: [], range: [], gMax: [], corners: [], minR: [] } };
const t0 = Date.now();
let next = 0, done = 0;
const pool = [];
for (let w = 0; w < Math.min(threads, jobs.length); w++) {
  const wk = new Worker(__filename);
  pool.push(wk);
  wk.on('message', m => {
    const p = per[m.style];
    for (const [k, v] of Object.entries(m.reasons || {})) p.reasons[k] = (p.reasons[k] || 0) + v;
    if (m.fail) p.failed.push(m.seed + ' ' + m.fail);
    else { p.ok++; p.tries += m.tries; p.ms += m.ms; for (const k of Object.keys(p.stats)) p.stats[k].push(m.stats[k]); }
    done++;
    if (next < jobs.length) wk.postMessage(jobs[next++]); else wk.terminate();
    if (done === jobs.length) report();
  });
  wk.postMessage(jobs[next++]);
}
function report() {
  let bad = 0;
  const rng = a => (a.length ? Math.min(...a).toFixed(0) + '-' + Math.max(...a).toFixed(0) : '-');
  for (const style of styles) {
    const p = per[style], s = p.stats;
    console.log(`${style}: ${p.ok}/${n} ok, ${(p.tries / Math.max(1, p.ok)).toFixed(1)} tries and ${(p.ms / Math.max(1, p.ok)).toFixed(0)} ms each; length ${rng(s.len)} m, climb ${rng(s.range)} m, max grade ${rng(s.gMax)} %, corners ${rng(s.corners)}, min radius ${rng(s.minR)} m`);
    console.log('  rejected candidates:', Object.entries(p.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v).join(', ') || 'none');
    if (p.failed.length) { bad += p.failed.length; console.log('  FAILED:', p.failed.slice(0, 8).join(' | ')); }
  }
  console.log(`${jobs.length} circuits on ${pool.length} threads in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(bad ? `${bad} FAILURES` : 'all circuits valid');
  process.exitCode = bad ? 1 : 0;
}
