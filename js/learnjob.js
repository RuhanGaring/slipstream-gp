// Teaches the AI a procedural circuit in the background (js/learncore.js) while the
// player picks a team: a pool of Web Workers, one per spare CPU thread. The workers are
// built from the sim modules already loaded on the page (each registers itself in
// F1simMods), so they always run the same code as the game and also work when the game
// is opened straight from disk, where a worker cannot load script files. If workers are
// not available at all, the same job runs on the page itself in small time slices.
// Results are kept in localStorage per circuit, so a seed is only ever learned once.
(function (G) {
  'use strict';
  const F1 = G.F1;
  const LC = () => F1.LearnCore;
  const key = id => 'slipstream.learn.' + LC().VERSION + '.' + id;
  const jobs = new Map();
  const listeners = new Set();
  let active = null; // the job currently running (one at a time: it uses every thread)

  const emit = job => listeners.forEach(fn => { try { fn(job); } catch (e) { /* a listener's problem */ } });

  // ---------- pools ----------
  const WORKER_MAIN = `
    self.onmessage = e => {
      const { k, msg } = e.data;
      try {
        const g = self.F1.LearnCore.handle(msg);
        let r = g.next();
        while (!r.done) r = g.next();
        self.postMessage({ k, res: r.value });
      } catch (err) { self.postMessage({ k, err: String((err && err.stack) || err) }); }
    };`;
  function workerPool() {
    if (typeof Worker === 'undefined' || !G.F1simMods || !G.Blob || !G.URL) return null;
    const src = G.F1simMods.map(m => '(' + m.toString() + ')(self);').join('\n') + WORKER_MAIN;
    let url;
    try { url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' })); } catch (e) { return null; }
    const n = Math.max(2, Math.min(14, (navigator.hardwareConcurrency || 4) - 2));
    const ws = [], waits = new Map();
    let seq = 0;
    const failAll = err => { waits.forEach(p => p.rej(err)); waits.clear(); };
    try {
      for (let w = 0; w < n; w++) {
        const wk = new Worker(url);
        wk.onmessage = e => { const { k, res, err } = e.data, p = waits.get(k); if (!p) return; waits.delete(k); err ? p.rej(new Error(err)) : p.res(res); };
        wk.onerror = e => { e.preventDefault && e.preventDefault(); failAll(new Error('worker: ' + (e.message || 'failed'))); };
        ws.push(wk);
      }
    } catch (e) { ws.forEach(w => w.terminate()); URL.revokeObjectURL(url); return null; }
    return {
      size: n, kind: 'workers',
      call: (w, msg) => new Promise((res, rej) => { const k = ++seq; waits.set(k, { res, rej }); ws[w].postMessage({ k, msg }); }),
      close: () => { ws.forEach(w => w.terminate()); failAll(new Error('cancelled')); URL.revokeObjectURL(url); },
    };
  }
  // fallback: the same work on the page, a few milliseconds per frame
  function localPool(size) {
    const ctxs = Array.from({ length: size }, () => ({ runners: {}, opt: {} }));
    const queue = [];
    let timer = null, closed = false;
    const pump = () => {
      timer = null;
      const t0 = performance.now();
      while (queue.length && performance.now() - t0 < 9) {
        const job = queue[0];
        let r;
        try { r = job.gen.next(); } catch (e) { queue.shift(); job.rej(e); continue; }
        if (r.done) { queue.shift(); job.res(r.value); } else queue.push(queue.shift());
      }
      if (queue.length && !closed) timer = setTimeout(pump, 6);
    };
    return {
      size, kind: 'local',
      call: (w, msg) => new Promise((res, rej) => {
        if (closed) { rej(new Error('cancelled')); return; }
        queue.push({ gen: LC().handle(msg, ctxs[w]), res, rej });
        if (!timer) timer = setTimeout(pump, 0);
      }),
      close: () => { closed = true; queue.splice(0).forEach(j => j.rej(new Error('cancelled'))); },
    };
  }

  // ---------- storage ----------
  function restore(id) {
    if (F1.Limits && F1.Limits[id]) return true;
    try {
      const raw = G.localStorage && G.localStorage.getItem(key(id));
      if (!raw) return false;
      const res = JSON.parse(raw);
      if (res.version !== LC().VERSION || res.id !== id) return false;
      LC().apply(res);
      return true;
    } catch (e) { return false; }
  }
  function save(res) {
    try { G.localStorage.setItem(key(res.id), JSON.stringify({ version: res.version, id: res.id, N: res.N, line: res.line, limits: res.limits })); } catch (e) { /* storage full or blocked: it is learned again next time */ }
  }

  // ---------- jobs ----------
  function status(id) {
    if (restore(id)) return { id, state: 'done', p: 1 };
    const j = jobs.get(id);
    return j ? { id, state: j.state, p: j.p, stage: j.stage, kind: j.kind } : { id, state: 'idle', p: 0 };
  }
  function cancel() {
    if (!active) return;
    const j = active;
    active = null;
    j.cancelled = true;
    if (j.pool) j.pool.close();
    j.state = 'idle'; j.p = 0;
    jobs.delete(j.id);
    emit(j);
  }
  // start (or join) learning a circuit; resolves when its line and limits are installed
  function start(id) {
    if (restore(id)) return Promise.resolve(true);
    const cur = jobs.get(id);
    if (cur && cur.state === 'running') return cur.promise;
    cancel();
    const job = { id, state: 'running', p: 0, stage: 'line', cancelled: false, t0: performance.now() };
    jobs.set(id, job);
    active = job;
    const run = pool => {
      job.pool = pool; job.kind = pool.kind;
      return LC().learnTrack(pool, id, {
        progress: (p, stage) => { job.p = p; job.stage = stage; emit(job); },
        cancelled: () => job.cancelled,
        lineIters: pool.kind === 'local' ? 12000 : undefined,
      });
    };
    job.promise = run(workerPool() || localPool(2))
      .catch(err => {
        if (job.cancelled || job.pool.kind !== 'workers') throw err;
        job.pool.close();
        return run(localPool(2)); // workers refused: do it on the page instead
      })
      .then(res => {
        if (job.pool) job.pool.close();
        if (!res || job.cancelled) return false;
        save(res);
        LC().apply(res);
        job.state = 'done'; job.p = 1; job.ms = performance.now() - job.t0;
        if (active === job) active = null;
        emit(job);
        return true;
      }, err => {
        if (job.pool) job.pool.close();
        if (active === job) active = null;
        if (!job.cancelled) { job.state = 'failed'; job.error = String(err && err.message || err); emit(job); }
        return false;
      });
    emit(job);
    return job.promise;
  }
  const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };

  F1.LearnJob = { start, status, restore, cancel, onChange };
})(typeof window !== 'undefined' ? window : globalThis);
