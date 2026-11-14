// The AI's look-ahead (Race.THINK, js/race.js) on worker threads, so a field of cars that each try a
// few futures several times a second does not cost the page its frame rate. Each worker keeps a copy
// of the race, made from the same settings, and for each question gets one car's state as it is now
// (its own objects as plain data and its dice), runs the same look-ahead on its copy of that car, and
// answers with the action's index. The workers are blob workers built from the sim modules already on
// the page (F1simMods), so this works from file:// too; the circuit's line and coached limits go over
// with the settings, as those files are data, not sim modules. With no workers, or a circuit the
// copies cannot rebuild exactly, the page thinks for itself (Race.step falls back to it).
(function (G) {
  'use strict';
  const F1 = G.F1;

  const WORKER_MAIN = `
    let race = null;
    self.onmessage = e => {
      const m = e.data, R = self.F1.Race;
      try {
        if (m.kind === 'init') {
          self.F1.Lines = self.F1.Lines || { stride: m.lineStride };
          if (m.line) { self.F1.Lines.stride = m.lineStride; self.F1.Lines[m.cfg.track] = m.line; }
          self.F1.Limits = self.F1.Limits || { stride: m.limStride };
          if (m.limits) { self.F1.Limits.stride = m.limStride; self.F1.Limits[m.cfg.track] = m.limits; }
          Object.assign(R.THINK, m.think);
          race = R.create(m.cfg);
          race.thinkPool = null;
          postMessage({ id: m.id, ok: true, N: race.track.N, L: race.track.L });
        } else if (m.kind === 'think') {
          const c = race.cars[m.car];
          Object.assign(race, m.race);
          if (m.rubber) race.track.rubber.set(m.rubber);
          if (m.prof) c.brain.prof = m.prof;
          R.thinkParts.setCarState(c, m.st);
          race.fx.length = 0; race.events.length = 0;
          postMessage({ id: m.id, k: R.thinkParts.decide(race, c) });
        }
      } catch (err) { postMessage({ id: m.id, err: String((err && err.stack) || err) }); }
    };`;

  let url = null, broken = false;
  function blobUrl() {
    if (url || broken) return url;
    try {
      const src = (G.F1simMods || []).map(m => '(' + m.toString() + ')(self);').join('\n') + WORKER_MAIN;
      url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    } catch (e) { broken = true; }
    return url;
  }

  class Pool {
    constructor(race, n) {
      this.race = race; this.ws = []; this.ready = 0; this.ok = true; this.seq = 0;
      this.waits = new Map(); this.busy = new Map(); this.sentProf = new Map(); this.rubberT = [];
      const tr = race.track, id = race.cfg.track;
      const msg = {
        kind: 'init', id: 0, cfg: JSON.parse(JSON.stringify(race.cfg)), think: plainThink(),
        line: F1.Lines && F1.Lines[id] || null, lineStride: F1.Lines && F1.Lines.stride,
        limits: F1.Limits && F1.Limits[id] || null, limStride: F1.Limits && F1.Limits.stride,
      };
      for (let w = 0; w < n; w++) {
        const wk = new Worker(blobUrl());
        wk.onmessage = e => this.onMessage(e.data);
        wk.onerror = e => { if (e.preventDefault) e.preventDefault(); this.fail('worker: ' + (e.message || 'failed')); };
        wk.postMessage(msg);
        this.ws.push(wk);
      }
      this.N = tr.N; this.L = tr.L;
    }
    fail(why) {
      if (!this.ok) return;
      this.ok = false; console.warn('thinkpool: thinking on the page from now on (' + why + ')');
      this.close();
    }
    close() { this.ws.forEach(w => w.terminate()); this.ws = []; this.waits.clear(); this.busy.clear(); }
    onMessage(m) {
      if (m.err) { this.fail(m.err); return; }
      if (m.ok) {
        // a copy that does not match the circuit (a map the worker could not rebuild) is no use
        if (m.N !== this.N || Math.abs(m.L - this.L) > 0.01) { this.fail('the circuit differs on the workers'); return; }
        this.ready++; return;
      }
      const q = this.waits.get(m.id);
      if (!q) return;
      this.waits.delete(m.id); this.busy.delete(q.car); this.answered = (this.answered || 0) + 1;
      const T = F1.Race.THINK;
      if (q.race !== this.race || q.car.retired) return;
      F1.Race.thinkParts.took(q.race, q.car, m.k >= 0 ? T.acts[m.k] : null, q.t);
    }
    // true when the question went to a worker (the answer arrives later), false to think on the page
    ask(race, c) {
      if (!this.ok || this.ready < this.ws.length || race !== this.race) return false;
      if (this.busy.has(c)) return true; // still working on the last one: keep what it has
      const P = F1.Race.thinkParts, b = c.brain, id = ++this.seq, w = this.ws[c.id % this.ws.length];
      // (one worker sees each car every time, so the profile it was sent stays its own)
      const raceVals = {};
      for (const k in race) { const v = race[k]; if (v === null || typeof v !== 'object' && typeof v !== 'function') raceVals[k] = v; }
      raceVals.sc = race.sc ? { state: race.sc.state } : null;
      const msg = { kind: 'think', id, car: race.cars.indexOf(c), st: P.carState(race, c), race: raceVals };
      if (this.sentProf.get(c) !== b.prof) { msg.prof = b.prof; this.sentProf.set(c, b.prof); }
      // (the rubber on the road, now and then: every worker keeps its own copy of the track)
      const wi = c.id % this.ws.length;
      if (!(race.time - (this.rubberT[wi] == null ? -1e9 : this.rubberT[wi]) < 4)) { this.rubberT[wi] = race.time; msg.rubber = race.track.rubber; }
      this.waits.set(id, { car: c, race, t: race.time }); this.busy.set(c, id);
      w.postMessage(msg); this.asked = (this.asked || 0) + 1;
      return true;
    }
  }
  // the look-ahead's settings as plain data (its log hook stays here)
  function plainThink() { const o = {}; const T = F1.Race.THINK; for (const k in T) if (typeof T[k] !== 'function') o[k] = T[k]; return o; }

  // a pool for this race, or null to think on the page
  function forRace(race) {
    if (typeof Worker === 'undefined' || !G.F1simMods || !G.Blob || !G.URL || !F1.Race.THINK.on) return null;
    if (!(race.diff && race.diff.pace >= F1.Race.THINK.minPace)) return null;
    if (!blobUrl()) return null;
    const n = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 2));
    try { return new Pool(race, n); } catch (e) { return null; }
  }
  F1.ThinkPool = { forRace };
})(typeof self !== 'undefined' ? self : this);
