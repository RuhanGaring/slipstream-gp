// The AI's look-ahead (Race.THINK, js/race.js) on worker threads, so a field of cars that each try a
// few futures several times a second does not cost the page its frame rate. Each worker keeps a copy
// of the race, made from the same settings, and for each question gets one car's state as it is now
// (its own objects as plain data and its dice), runs the same look-ahead on its copy of that car, and
// answers with the action's index. The workers are blob workers built from the sim modules already on
// the page (F1simMods), so this works from file:// too; the circuit's line and coached limits go over
// with the settings, as those files are data, not sim modules. With no workers, or a circuit the
// copies cannot rebuild exactly, the AI drives on its plan: the game never thinks on the page (one
// look-ahead is about 90 ms of work).
// (a named function, so the race's own sim worker, js/simworker.js, can run its look-ahead pool too)
function thinkPoolModule(G) {
  'use strict';
  const F1 = G.F1;

  const WORKER_MAIN = `
    let race = null;
    self.onmessage = e => {
      const m = e.data, R = self.F1.Race;
      if (m.kind === 'init') {
        try {
          self.F1.Lines = self.F1.Lines || { stride: m.lineStride };
          if (m.line) { self.F1.Lines.stride = m.lineStride; self.F1.Lines[m.cfg.track] = m.line; }
          self.F1.Limits = self.F1.Limits || { stride: m.limStride };
          if (m.limits) { self.F1.Limits.stride = m.limStride; self.F1.Limits[m.cfg.track] = m.limits; }
          Object.assign(R.THINK, m.think);
          race = R.create(m.cfg); // (the circuit itself is kept from the last race on it)
          race.thinkPool = null;
          postMessage({ gen: m.gen, ok: true, N: race.track.N, L: race.track.L });
        } catch (err) { race = null; postMessage({ gen: m.gen, err: String((err && err.stack) || err) }); }
      } else if (m.kind === 'think') {
        // (one question that goes wrong is answered with no choice: the car drives its plan)
        let k = -1, warn = null;
        try {
          const c = race.cars[m.car];
          Object.assign(race, m.race);
          if (m.rubber) race.track.rubber.set(m.rubber);
          if (m.prof) c.brain.prof = m.prof;
          R.thinkParts.setCarState(c, m.st);
          race.fx.length = 0; race.events.length = 0;
          k = R.thinkParts.decide(race, c);
        } catch (err) { warn = String((err && err.stack) || err); }
        postMessage({ gen: m.gen, id: m.id, k, warn });
      }
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

  // The workers outlive a race: the next race hands them its settings, and a circuit they have built
  // once (a generated city takes them seconds) is ready at once. One that breaks is replaced.
  const crew = [];
  let gens = 0;
  function hire() { const w = new Worker(blobUrl()); crew.push(w); return w; }

  class Pool {
    constructor(race, n) {
      this.race = race; this.ok = true; this.seq = 0; this.gen = ++gens; this.ready = 0; this.rehired = 0;
      this.waits = new Map(); this.busy = new Map(); this.want = new Map(); this.idle = [];
      while (crew.length > n) crew.pop().terminate();
      while (crew.length < n) hire();
      this.ws = crew.slice();
      // (what each worker already holds of each car: its profile and its style's waves)
      this.sentProf = this.ws.map(() => new Map()); this.sentArr = this.ws.map(() => new Map()); this.rubberT = [];
      const tr = race.track, id = race.cfg.track;
      this.init = {
        kind: 'init', gen: this.gen, cfg: JSON.parse(JSON.stringify(race.cfg)), think: plainThink(),
        line: F1.Lines && F1.Lines[id] || null, lineStride: F1.Lines && F1.Lines.stride,
        limits: F1.Limits && F1.Limits[id] || null, limStride: F1.Limits && F1.Limits.stride,
      };
      this.ws.forEach((w, wi) => this.engage(w, wi));
      this.N = tr.N; this.L = tr.L;
    }
    engage(w, wi) {
      w.onmessage = e => this.onMessage(e.data, wi);
      w.onerror = e => { if (e.preventDefault) e.preventDefault(); this.lost(wi, e.message || 'failed'); };
      w.postMessage(this.init);
    }
    // a worker that died is replaced (three times a race at most) and the others carry on meanwhile
    lost(wi, why) {
      if (!this.ok || this.closed) return;
      const old = this.ws[wi], ci = crew.indexOf(old);
      try { old.terminate(); } catch (e) { /* gone already */ }
      this.idle = this.idle.filter(x => x !== wi);
      for (const [id, q] of this.waits) if (q.wi === wi) { this.waits.delete(id); this.busy.delete(q.car); }
      if (++this.rehired > 3) { this.fail('workers keep failing: ' + why); return; }
      console.warn('thinkpool: replacing a worker (' + why + ')');
      const w = new Worker(blobUrl());
      if (ci >= 0) crew[ci] = w; else crew.push(w);
      this.ws[wi] = w; this.sentProf[wi] = new Map(); this.sentArr[wi] = new Map(); this.rubberT[wi] = null;
      this.engage(w, wi);
    }
    fail(why) {
      if (!this.ok) return;
      this.ok = false; console.warn('thinkpool: the AI drives without its look-ahead from now on (' + why + ')');
      // (workers that would not build this circuit are let go: the next race starts with fresh ones)
      crew.splice(0).forEach(w => w.terminate());
      this.close();
    }
    // the race is over: its questions are dropped, and the workers wait for the next one
    close() { this.closed = true; this.waits.clear(); this.busy.clear(); this.want.clear(); this.idle = []; }
    onMessage(m, wi) {
      if (m.gen !== this.gen || this.closed) return; // (an answer for an earlier race)
      if (m.err) { this.lost(wi, m.err); return; }
      if (m.ok) {
        // a copy that does not match the circuit is no use (every circuit rebuilds by its id; this
        // guards against one that some day does not)
        if (m.N !== this.N || Math.abs(m.L - this.L) > 0.01) { this.fail('the circuit differs on the workers'); return; }
        this.ready++; this.idle.push(wi); this.pump(); return;
      }
      if (m.warn && !this.warned) { this.warned = true; console.warn('thinkpool: a look-ahead failed, the car drove its plan (' + m.warn + ')'); }
      this.idle.push(wi);
      const q = this.waits.get(m.id);
      if (q) {
        this.waits.delete(m.id); this.busy.delete(q.car); this.answered = (this.answered || 0) + 1;
        if (!q.car.retired) F1.Race.thinkParts.took(this.race, q.car, m.k >= 0 ? F1.Race.THINK.acts[m.k] : null, q.t);
      }
      this.pump();
    }
    // true when the question is taken (the answer arrives later), false when there are no workers.
    // Questions wait for a free worker, and the free worker takes the car that matters most: one near
    // the camera or the player first, then whoever has waited longest. (Few workers keep the game's
    // frame rate; the cars on screen still think every time they ask.)
    ask(race, c) {
      if (!this.ok || this.closed || !this.ready || race !== this.race) return false;
      // (the run to the first corner: the look-ahead drives a car alone on the road, which nobody is
      // there, and the picture is at its heaviest, the whole field in view; the workers wait)
      if (race.time - race.startTime < 6) return true;
      if (!this.busy.has(c) && !this.want.has(c)) this.want.set(c, race.time);
      this.pump();
      return true;
    }
    pump() {
      const race = this.race, T = F1.Race.THINK;
      while (this.idle.length && this.want.size) {
        const fo = race.lodFocus || race.player;
        let best = null, bs = -1e18;
        for (const [c, t] of this.want) {
          if (c.retired || c.finished || c.inPit) { this.want.delete(c); continue; }
          let gap = fo && fo !== c ? Math.abs(c.loc.s - fo.loc.s) : 0; if (gap > race.track.L / 2) gap = race.track.L - gap;
          const sc = (gap > T.nearM ? 0 : 1e6) + (race.time - t);
          if (sc > bs) { bs = sc; best = c; }
        }
        if (!best) return;
        this.want.delete(best);
        this.send(best, this.idle.pop());
      }
    }
    send(c, wi) {
      const race = this.race, P = F1.Race.thinkParts, b = c.brain, id = ++this.seq;
      const raceVals = {};
      for (const k in race) { const v = race[k]; if (v === null || typeof v !== 'object' && typeof v !== 'function') raceVals[k] = v; }
      raceVals.sc = race.sc ? { state: race.sc.state } : null;
      const sp = this.sentProf[wi], sa = this.sentArr[wi];
      let sent = sa.get(c);
      if (!sent) sa.set(c, sent = new Set());
      const msg = { kind: 'think', id, car: race.cars.indexOf(c), st: P.carState(race, c, sent), race: raceVals };
      // (the style's waves go to each worker once: they are replaced, never changed in place)
      const st = b.style;
      if (st && !(sent.has(st.a) && sent.has(st.b))) { sent.clear(); if (st.a) sent.add(st.a); if (st.b) sent.add(st.b); }
      if (sp.get(c) !== b.prof) { msg.prof = b.prof; sp.set(c, b.prof); }
      // (the rubber on the road, now and then: every worker keeps its own copy of the track)
      if (!(race.time - (this.rubberT[wi] == null ? -1e9 : this.rubberT[wi]) < 4)) { this.rubberT[wi] = race.time; msg.rubber = race.track.rubber; }
      msg.gen = this.gen;
      this.waits.set(id, { car: c, wi, t: race.time }); this.busy.set(c, id);
      this.ws[wi].postMessage(msg); this.asked = (this.asked || 0) + 1;
    }
  }
  // the look-ahead's settings as plain data (its log hook stays here)
  function plainThink() { const o = {}; const T = F1.Race.THINK; for (const k in T) if (typeof T[k] !== 'function') o[k] = T[k]; return o; }

  // a pool for this race, or null (the AI then drives without the look-ahead)
  function forRace(race) {
    if (typeof Worker === 'undefined' || !G.F1simMods || !G.Blob || !G.URL || !F1.Race.THINK.on) return null;
    if (!(race.diff && race.diff.pace >= F1.Race.THINK.minPace)) return null;
    if (!blobUrl()) return null;
    // (two at most: every busy core slows the others on a laptop, the page's own among them, and
    // four workers on an eight-core i7 already cost the game a frame in twenty; the queue puts what
    // they can do where it shows)
    const n = (navigator.hardwareConcurrency || 4) >= 6 ? 2 : 1;
    try { return new Pool(race, n); } catch (e) { crew.splice(0).forEach(w => w.terminate()); return null; }
  }
  F1.ThinkPool = { forRace };
}
(function (G) { (G.F1workerMods = G.F1workerMods || []).push(thinkPoolModule); thinkPoolModule(G); })(typeof self !== 'undefined' ? self : this);
