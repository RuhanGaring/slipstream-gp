// A pool of Web Workers for the circuit generator (js/trackgen2.js). Every candidate of a seed has
// its own random stream, so the pool tries them in parallel, a round of one per worker at a time,
// and the circuit is the lowest-numbered candidate that passes: the same one a single thread
// finds. The workers are blob workers built from the sim modules already on the page (the
// F1simMods list), so the pool also works from file://; without workers it falls back to the
// page's own thread.
(function (G) {
  'use strict';
  const F1 = G.F1;
  let pool = null, seq = 0;
  const waiting = new Map();

  function start() {
    if (pool) return pool;
    pool = [];
    try {
      const mods = (G.F1simMods || []).map(fn => '(' + fn.toString() + ')(self);').join('\n');
      const body = mods + `
        self.onmessage = e => {
          const m = e.data, T = self.F1.TrackGen2;
          if (m.kind === 'attempt') {
            const a = T.attempt(m.seed, m.style, m.k);
            postMessage({ id: m.id, ok: a.ok, why: a.why || [] });
          } else if (m.kind === 'make') {
            // a whole seed, for batch tests: a summary only (functions cannot cross threads)
            const out = { id: m.id, seed: m.seed, style: m.style };
            try {
              const res = T.make(m.seed, m.style), rep = T.verify(res);
              Object.assign(out, { ok: rep.ok, tries: res.tries, ms: res.ms, fails: rep.fails, reasons: res.reasons });
            } catch (err) { Object.assign(out, { ok: false, fails: [err.message], reasons: err.reasons || {} }); }
            postMessage(out);
          }
        };`;
      const url = URL.createObjectURL(new Blob([body], { type: 'text/javascript' }));
      const n = Math.max(1, Math.min(16, (navigator.hardwareConcurrency || 4) - 1));
      for (let i = 0; i < n; i++) {
        const w = new Worker(url);
        w.onmessage = e => { const f = waiting.get(e.data.id); if (f) { waiting.delete(e.data.id); f(e.data); } };
        pool.push(w);
      }
    } catch (e) { console.warn('gen2pool: no workers, generating on the page', e); pool = []; }
    return pool;
  }
  const ask = (w, msg) => new Promise(res => { const id = ++seq; waiting.set(id, res); w.postMessage(Object.assign({ id }, msg)); });

  // The circuit for a seed, built in parallel; resolves to the same result as TrackGen2.make.
  // Candidates are handed out in order to whichever worker is free; once one passes, nothing
  // above it is started, and the answer is ready when every candidate below it has failed.
  function make(seed, style, onProgress) {
    const T = F1.TrackGen2, P = start();
    style = T.styleOf(seed, style);
    if (!P.length) return Promise.resolve().then(() => T.make(seed, style));
    const t0 = performance.now(), reasons = {}, failed = new Set();
    let next = 0, best = Infinity, settled = false;
    return new Promise((resolve, reject) => {
      const finish = () => {
        if (settled) return;
        for (let k = 0; k < best; k++) if (!failed.has(k)) return; // a lower one may still pass
        settled = true;
        if (best === Infinity) { const e = new Error('no valid circuit for seed ' + seed + ' (' + style + ')'); e.reasons = reasons; reject(e); return; }
        // rebuild the winner here (its result holds functions that cannot cross threads)
        const res = T.make(seed, style, { from: best, maxTries: best + 1, reasons });
        res.ms = Math.round(performance.now() - t0); res.threads = P.length;
        resolve(res);
      };
      const feed = w => {
        if (settled || next >= T.MAX_TRIES || next > best) return finish();
        const k = next++;
        ask(w, { kind: 'attempt', seed, style, k }).then(o => {
          if (o.ok) best = Math.min(best, k);
          else { failed.add(k); if (k < best) for (const why of o.why) reasons[why] = (reasons[why] || 0) + 1; }
          if (onProgress) onProgress(failed.size + (best < Infinity ? 1 : 0));
          feed(w);
        });
      };
      P.forEach(feed);
    });
  }
  // many seeds at once, one per worker at a time; onEach gets every summary as it arrives
  function batch(jobs, onEach) {
    const P = start();
    if (!P.length) return Promise.reject(new Error('no workers'));
    let next = 0;
    const run = w => (next < jobs.length ? ask(w, Object.assign({ kind: 'make' }, jobs[next++])).then(o => { onEach(o); return run(w); }) : Promise.resolve());
    return Promise.all(P.map(run));
  }

  F1.Gen2Pool = { make, batch, start, threads: () => start().length };
})(typeof window !== 'undefined' ? window : globalThis);
