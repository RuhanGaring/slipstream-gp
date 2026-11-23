// Teaches the AI a procedural circuit in the background (js/learncore.js) while the
// player picks a team: a pool of Web Workers, one per spare CPU thread. The workers are
// built from the sim modules already loaded on the page (each registers itself in
// F1simMods), so they always run the same code as the game and also work when the game
// is opened straight from disk, where a worker cannot load script files. If workers are
// not available at all, the same job runs on the page itself in small time slices.
// Results are kept in localStorage per circuit, so a seed is only ever learned once.
// Deep training (startDeep, shown by js/trainlab.js) goes further: a longer line and limits
// search, then the coach (js/learncore.js coachTrack) that drives the plan stretch by stretch, as
// the hand-made circuits were trained offline. Its result replaces the quick one.
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
    // (the workers share one browser process: they build the road alone, not a town each)
    const src = G.F1simMods.map(m => '(' + m.toString() + ')(self);').join('\n') + '\nself.F1.roadOnly = true;\n' + WORKER_MAIN;
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
    if (restoreDeep(id)) return true;
    try {
      const raw = G.localStorage && G.localStorage.getItem(key(id));
      if (!raw) { restoreLine(id); return false; }
      const res = JSON.parse(raw);
      if (res.version !== LC().VERSION || res.id !== id) return false;
      LC().apply(res);
      return true;
    } catch (e) { return false; }
  }
  // a line learned on an earlier visit whose limits were not finished
  function restoreLine(id) {
    if (F1.Lines && F1.Lines[id]) return;
    try {
      const raw = G.localStorage && G.localStorage.getItem(key(id) + '.line');
      const res = raw && JSON.parse(raw);
      if (res && res.version === LC().VERSION && res.id === id) LC().applyLine(id, res.line);
    } catch (e) { /* nothing kept */ }
  }
  function saveLine(id, line) {
    try { G.localStorage.setItem(key(id) + '.line', JSON.stringify({ version: LC().VERSION, id, line })); } catch (e) { /* storage full or blocked */ }
  }
  function save(res) {
    try { G.localStorage.setItem(key(res.id), JSON.stringify({ version: res.version, id: res.id, N: res.N, line: res.line, limits: res.limits })); } catch (e) { /* storage full or blocked: it is learned again next time */ }
  }

  // ---------- jobs ----------
  function status(id) {
    if (restore(id)) return { id, state: 'done', p: 1 };
    const j = jobs.get(id);
    return j ? { id, state: j.state, p: j.p, stage: j.stage, kind: j.kind, lineReady: !!j.lineReady } : { id, state: 'idle', p: 0, lineReady: !!(F1.Lines && F1.Lines[id]) };
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
    if (deepJob && deepJob.state === 'running') stopDeep();
    cancel();
    const job = { id, state: 'running', p: 0, stage: 'line', cancelled: false, t0: performance.now() };
    jobs.set(id, job);
    active = job;
    const run = pool => {
      job.pool = pool; job.kind = pool.kind;
      return LC().learnTrack(pool, id, {
        progress: (p, stage) => { job.p = p; job.stage = stage; emit(job); },
        cancelled: () => job.cancelled,
        // the line is ready long before the limits: race on it already if asked to
        onLine: line => { if (job.cancelled) return; LC().applyLine(id, line); saveLine(id, line); job.lineReady = true; emit(job); },
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

  // ---------- deep training ----------
  const dkey = id => 'slipstream.deep.' + LC().VERSION + '.' + id;
  const PRESETS = {
    short: { label: 'Short', gens: 4, checks: 5, coachRounds: 8 },
    standard: { label: 'Standard', gens: 5, checks: 6, coachRounds: 16 },
    thorough: { label: 'Thorough', gens: 7, checks: 8, coachRounds: 32 },
  };
  let deepJob = null;
  const dlisteners = new Set();
  const infos = new Map(); // id to the summary of what is stored (null: nothing)
  const demit = () => { dlisteners.forEach(fn => { try { fn(deepJob); } catch (e) { /* a listener's problem */ } }); if (deepJob) emit(deepJob); };
  function readDeep(id) {
    try {
      const raw = G.localStorage && G.localStorage.getItem(dkey(id));
      if (!raw) return null;
      const res = JSON.parse(raw);
      return res.version === LC().VERSION && res.id === id ? res : null;
    } catch (e) { return null; }
  }
  function restoreDeep(id) {
    const res = readDeep(id);
    if (!res) return false;
    try { LC().apply(res); infos.set(id, res.deep || {}); return true; } catch (e) { return false; }
  }
  function saveDeep(res) {
    try { G.localStorage.setItem(dkey(res.id), JSON.stringify({ version: res.version, id: res.id, N: res.N, line: res.line, limits: res.limits, stats: res.stats, deep: res.deep })); infos.set(res.id, res.deep || {}); return true; }
    catch (e) { return false; /* storage full or blocked: the result lives until the page closes */ }
  }
  // what a circuit has had: { first, best, rounds, none, at, partial } or null
  function deepInfo(id) {
    if (!infos.has(id)) { const r = readDeep(id); infos.set(id, r ? r.deep || {} : null); }
    return infos.get(id);
  }
  const deepOf = id => (deepJob && deepJob.id === id ? deepJob : null);
  function forgetDeep(id) {
    try { G.localStorage.removeItem(dkey(id)); } catch (e) { /* nothing kept */ }
    infos.set(id, null);
  }
  const note = (job, text, kind) => { job.log.push({ t: performance.now() - job.t0, text, kind: kind || '' }); if (job.log.length > 60) job.log.shift(); };
  // cfg: { preset | lineRounds, gens, checks, coachRounds, resume: true to carry on from what is stored }
  function startDeep(id, cfg = {}) {
    if (deepJob && deepJob.state === 'running') return deepJob.promise;
    cancel();
    const P = Object.assign({}, PRESETS[cfg.preset] || PRESETS.standard, cfg);
    const stored = cfg.resume ? readDeep(id) : null;
    const job = deepJob = {
      id, kind: 'deep', state: 'running', cfg: P, resume: !!stored, phase: stored ? 'coach' : 'line', t0: performance.now(), laps: 0, threads: 0,
      lineP: stored ? 1 : 0, modeP: {}, limP: stored ? 1 : 0, coachP: 0, p: 0, log: [], cancelled: false,
      line: [], coach: [], gens: {}, checks: {}, off: null, quick: stored,
    };
    job.first0 = stored && stored.deep ? stored.deep.first0 : null;
    note(job, stored ? 'Carrying on from the saved plan.' : 'Training starts: first the racing line.');
    const total = () => {
      const lim = (job.modeP.sim || 0) / 2 + (job.modeP.arcade || 0) / 2;
      job.limP = job.phase === 'line' ? 0 : Math.max(job.limP, lim);
      job.p = job.resume ? 0.97 * job.coachP + (job.verify ? 0.03 : 0) : 0.22 * job.lineP + 0.2 * job.limP + 0.55 * job.coachP + (job.verify ? 0.03 : 0);
    };
    const checkpoint = (res, text) => { if (saveDeep(res)) { try { LC().apply(res); } catch (e) { /* stride mismatch: not installed */ } job.saved = true; if (text) note(job, text, 'ok'); } };
    const on = e => {
      if (job.cancelled) return;
      switch (e.type) {
        case 'phase': job.phase = e.phase; if (e.phase === 'coach') { job.limP = 1; job.lineP = 1; } break;
        case 'line': job.lineP = Math.min(1, (e.round + e.b / e.batches) / e.rounds); job.lineT = e.t; job.lineT0 = e.t0; break;
        case 'lineRound': {
          job.lineT = e.t; job.off = e.off;
          const prev = job.line.length ? job.line[job.line.length - 1].t : e.t0;
          job.line.push({ round: e.round, t: e.t });
          note(job, 'Line round ' + e.round + ': model lap ' + e.t.toFixed(2) + ' s (' + (e.t - prev <= 0 ? '' : '+') + (e.t - prev).toFixed(2) + ').');
          break;
        }
        case 'lineDone': job.off = e.off; job.lineP = 1; job.lineFrom = e.from; job.lineTo = e.to; job.lineKept = Math.abs(e.from - e.to) < 1e-6; note(job, job.lineKept ? 'Racing line kept as learned (model lap ' + e.to.toFixed(2) + ' s).' : 'Racing line done: model lap ' + e.from.toFixed(2) + ' to ' + e.to.toFixed(2) + ' s.', 'ok'); job.phase = 'limits'; break;
        case 'gen': job.phase = 'limits'; job.lineP = 1; job.gens[e.mode] = e; job.modeP[e.mode] = e.gen / (e.gens + (P.checks || 4)); if (e.mode === 'sim') note(job, 'Limits search ' + e.gen + '/' + e.gens + ': ' + e.bad.reduce((a, b) => a + b, 0) + ' trouble spots.'); break;
        case 'check': job.checks[e.mode] = e; job.modeP[e.mode] = ((P.gens || 3) + e.chk) / ((P.gens || 3) + e.checks); if (e.mode === 'sim') note(job, 'Check lap ' + e.chk + '/' + e.checks + ': ' + e.backed + ' places eased off.'); break;
        case 'quick':
          job.quick = e.res;
          checkpoint(Object.assign({}, e.res, { deep: { first: null, best: null, rounds: 0, none: true, partial: true, at: Date.now() } }), 'Line and limits saved.');
          break;
        case 'repair': note(job, 'Easing ' + e.stretches + ' stretch' + (e.stretches > 1 ? 'es' : '') + ' that ran past the white line' + (e.bad ? '...' : ': clean now.'), e.bad ? 'warn' : 'ok'); break;
        case 'coachBase':
          job.phase = 'coach'; job.coachInfo = { first: e.first, n: e.n, segEnd: e.segEnd, rounds: e.rounds }; job.coachBase = e.lap; job.lap = e.lap; if (job.first0 == null) job.first0 = e.first;
          job.coach.push({ round: 0, tot: e.first, best: e.first });
          note(job, 'Baseline lap: ' + e.first.toFixed(2) + ' s over ' + e.n + ' stretches.');
          break;
        case 'coach': {
          job.coachP = e.round / e.rounds; job.C = e.C; job.B = e.B; job.moves = e.moves; job.lap = e.lap || job.lap;
          job.coach.push({ round: e.round, tot: e.tot, best: e.best, moved: e.moved, bad: e.bad });
          note(job, 'Coach round ' + e.round + '/' + e.rounds + ': ' + e.moved + ' of ' + e.n + ' stretches changed, best lap ' + e.best.toFixed(2) + ' s.', e.kept ? 'ok' : '');
          if (e.plan && job.quick) {
            checkpoint({ version: job.quick.version, id, N: job.quick.N, line: job.quick.line, stats: job.quick.stats,
              limits: { sim: e.plan.g, arcade: job.quick.limits.arcade },
              deep: { first: job.first0, first0: job.first0, best: e.plan.best, rounds: e.round, n: e.n, none: false, partial: true, at: Date.now() } });
          }
          break;
        }
        case 'verify': job.phase = 'verify'; job.verify = { tot: e.tot, bad: e.bad, first: e.first }; job.lap = e.lap; note(job, 'Final check lap: ' + e.tot.toFixed(2) + ' s' + (e.bad ? ', ' + e.bad + ' trouble spots.' : ', clean.')); break;
        default: break;
      }
      total(); demit();
    };
    const run = pool => {
      job.pool = pool; job.kind2 = pool.kind; job.threads = pool.size;
      const counted = { size: pool.size, kind: pool.kind, close: () => pool.close(), call: (w, msg) => { if (msg.cmd === 'lap' || msg.cmd === 'cLap') job.laps++; return pool.call(w, msg); } };
      return LC().deepTrack(counted, id, Object.assign({}, P, { on, cancelled: () => job.cancelled, resume: stored || undefined, lineIters: pool.kind === 'local' ? 12000 : undefined }));
    };
    job.promise = run(workerPool() || localPool(2))
      .catch(err => {
        if (job.cancelled || job.pool.kind !== 'workers') throw err;
        job.pool.close();
        note(job, 'Worker threads refused: running on the page instead (slow).', 'warn');
        return run(localPool(2));
      })
      .then(res => {
        if (job.pool) job.pool.close();
        job.ms = performance.now() - job.t0;
        if (job.cancelled || !res) { job.state = job.saved ? 'stopped' : 'idle'; note(job, job.saved ? 'Stopped: the best plan so far is kept.' : 'Stopped: nothing changed.', 'warn'); }
        else {
          saveDeep(res); LC().apply(res);
          job.result = res.deep; job.state = 'done'; job.p = 1;
          note(job, res.deep.none ? 'No coaching gain found: the learned line and limits are kept.' : 'Done: lap ' + res.deep.first.toFixed(2) + ' s to ' + res.deep.best.toFixed(2) + ' s.', 'ok');
        }
        demit();
        return job.state === 'done';
      }, err => {
        if (job.pool) job.pool.close();
        job.ms = performance.now() - job.t0;
        if (job.cancelled) { job.state = job.saved ? 'stopped' : 'idle'; note(job, job.saved ? 'Stopped: the best plan so far is kept.' : 'Stopped: nothing changed.', 'warn'); }
        else { job.state = 'failed'; job.error = String(err && err.message || err); note(job, 'Failed: ' + job.error, 'bad'); }
        demit();
        return false;
      });
    demit();
    return job.promise;
  }
  // stop at once, keeping the best plan found (it is stored after every round that beat the last)
  function stopDeep() {
    const j = deepJob;
    if (!j || j.state !== 'running') return;
    j.cancelled = true;
    if (j.pool) j.pool.close();
  }
  // throw away the deep result: back to what quick learning found (or to nothing, to be learned again)
  function resetDeep(id) {
    if (deepJob && deepJob.id === id && deepJob.state === 'running') return;
    forgetDeep(id);
    if (F1.Limits) delete F1.Limits[id];
    if (F1.Lines) delete F1.Lines[id];
    if (deepJob && deepJob.id === id) deepJob = null;
    F1.Race.forgetTrack(id);
    restore(id);
    emit({ id, state: 'idle', p: 0 });
  }
  const onDeep = fn => { dlisteners.add(fn); return () => dlisteners.delete(fn); };

  F1.LearnJob = { start, status, restore, cancel, onChange, startDeep, stopDeep, onDeep, deepInfo, deepOf, forgetDeep, resetDeep, PRESETS };
})(typeof window !== 'undefined' ? window : globalThis);
