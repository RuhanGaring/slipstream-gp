// The race simulation (F1.Race.step, 240 times a second) on a worker thread of its own.
// On the page it took 3 to 5.6 ms of every frame at 60 fps, and it spiralled: a slow frame needed
// more steps to catch up, which made the next frame slower. Here the page asks the worker each frame
// for the steps that frame owes (with the player's controls for each), and draws from the answer to
// the frame before: one frame of delay, the page's own time spent on the sim down to copying the
// answer in.
//
// The page keeps its race as a full replica: every car's state is sent back each frame (some 5 kB a
// car; the AI's large tables stay in the worker, the page never steps while the worker runs), and the
// race's events and contacts come with it. So everything that reads the race on the page (renderer,
// HUD, audio, replay recorder, flashback ring, camera) reads it as before. Whenever the race is not
// running live (paused, a flashback, the results, a replay) the page's copy is the race: the worker
// is put on hold, and when the race runs again the page's state goes back over first ("sync"), so
// anything done to the race meanwhile (a rewind, a pit choice, the pause menu) carries on in the
// worker. The few things the page does to a car while racing (a gear change, a reset, the pit menu)
// go over as commands (act).
//
// The worker is built like the look-ahead's (js/thinkpool.js): a blob made from the sim modules on
// the page (F1simMods), so it works from file:// too, and it runs the AI's look-ahead pool itself.
// Off unless Game.settings.simWorker (Settings) or ?simw=1. When the worker cannot start or fails,
// the page steps the race as before.
(function (G) {
  'use strict';
  const F1 = G.F1;

  // ---------- the codec, on both sides ----------
  // A car or the race as plain data: cars referred to by index ({$c: i}), the tyre compounds by id
  // ({$k: id}); the parts that never change (the track, the car's spec, team and driver) left out;
  // large arrays (the AI's tables, over LARGE items) only when they are new objects; anything with a
  // version counter (the crash structure) whole when its version moved.
  function codecModule(G) {
    const F1 = G.F1, LARGE = 256;
    const SKIP_CAR = new Set(['track', 'spec', 'team', 'driver', 'onShift', 'profFor', 'ghost', 'rec', '_pp', '_real', 'style', 'prof']);
    const SKIP_RACE = new Set(['cfg', 'track', 'cars', 'player', 'thinkPool', 'thinkPage', 'rec', 'stats', 'events', 'fx', '_carSet', '_thinking',
      'lodFocus', 'autoPlayer', 'physLod', 'physLodDist', 'ghost', 'ghostRec', 'handling', 'recover']);
    function ctx(race) {
      const cars = new Map(); race.cars.forEach((c, i) => cars.set(c, i));
      const comps = new Map(); const C = F1.Car && F1.Car.COMPOUNDS;
      if (C) for (const k in C) comps.set(C[k], k);
      return { cars, comps };
    }
    // o: the value; st: per-side memory of what was sent (sent large objects, versions); full: send all
    function enc(v, X, st, full, skip, seen) {
      if (v === null || typeof v !== 'object') return v;
      const ci = X.cars.get(v); if (ci !== undefined) return { $c: ci };
      const ck = X.comps.get(v); if (ck !== undefined) return { $k: ck };
      if (seen.has(v)) return undefined;
      seen.add(v);
      if (ArrayBuffer.isView(v)) {
        if (v.length <= LARGE || full) return v.slice();
        if (st.sent.has(v)) return undefined;
        st.sent.add(v); return v.slice();
      }
      if (Array.isArray(v)) {
        if (v.length > LARGE && !full) { if (st.sent.has(v)) return undefined; st.sent.add(v); }
        return v.map(x => { const e = enc(x, X, st, full, null, seen); return e === undefined ? null : e; });
      }
      const pr = Object.getPrototypeOf(v);
      if (pr !== Object.prototype && pr !== null) return undefined;
      // (a structure with a version counter goes whole when it moved, else not at all)
      let whole = full;
      if (typeof v.ver === 'number') { const last = st.ver.get(v); if (last === v.ver && !full) return undefined; st.ver.set(v, v.ver); whole = true; }
      const out = {};
      for (const k in v) {
        if (skip && skip.has(k)) continue;
        const x = v[k];
        if (typeof x === 'function') continue;
        const e = enc(x, X, st, whole, null, seen);
        if (e !== undefined) out[k] = e;
      }
      return out;
    }
    function memo() { return { sent: new WeakSet(), ver: new WeakMap() }; }
    function encCar(race, c, X, st, full) {
      // (the car's own fields: the car itself is not a reference here)
      const o = {}, seen = new Set([c]);
      for (const k in c) {
        if (SKIP_CAR.has(k)) continue;
        const v = c[k];
        if (typeof v === 'function') continue;
        const e = enc(v, X, st, full, null, seen);
        if (e !== undefined) o[k] = e;
      }
      // (the car's own dice)
      const rng = c.brain && c.brain.rng && c.brain.rng.get ? c.brain.rng.get() : null;
      return { s: o, rng };
    }
    function encRace(race, X, st, full) {
      const out = {}, seen = new Set(X.cars.keys());
      for (const k in race) {
        if (SKIP_RACE.has(k)) continue;
        const v = race[k];
        if (typeof v === 'function') continue;
        const e = enc(v, X, st, full, null, seen);
        if (e !== undefined) out[k] = e;
      }
      return out;
    }
    function dec(x, race) {
      if (x === null || typeof x !== 'object' || ArrayBuffer.isView(x)) return x;
      if (Array.isArray(x)) return x.map(e => dec(e, race));
      if ('$c' in x) return race.cars[x.$c];
      if ('$k' in x) return F1.Car.COMPOUNDS[x.$k];
      const o = {}; for (const k in x) o[k] = dec(x[k], race); return o;
    }
    // written into the same objects where they are plain data of the same shape, so references the
    // page holds (HUD, renderer caches) stay good
    function put(o, v, race) {
      for (const k in v) {
        const x = v[k], y = o[k];
        if (x === null || typeof x !== 'object') { o[k] = x; continue; }
        if ('$c' in x || '$k' in x) { o[k] = dec(x, race); continue; }
        if (ArrayBuffer.isView(x)) { if (ArrayBuffer.isView(y) && y.length === x.length && y.constructor === x.constructor) y.set(x); else o[k] = x; if (x.length > LARGE) race._fromW.add(o[k]); continue; }
        if (Array.isArray(x)) {
          if (Array.isArray(y)) {
            y.length = x.length;
            for (let i = 0; i < x.length; i++) {
              const xi = x[i], yi = y[i];
              if (xi !== null && typeof xi === 'object' && !Array.isArray(xi) && !ArrayBuffer.isView(xi) && !('$c' in xi) && !('$k' in xi) && yi && typeof yi === 'object' && !Array.isArray(yi) && Object.getPrototypeOf(yi) === Object.prototype && !race._carSetW.has(yi)) put(yi, xi, race);
              else y[i] = dec(xi, race);
            }
          } else o[k] = dec(x, race);
          if (x.length > LARGE) race._fromW.add(o[k]);
          continue;
        }
        if (y && typeof y === 'object' && !Array.isArray(y) && !ArrayBuffer.isView(y) && Object.getPrototypeOf(y) === Object.prototype && !race._carSetW.has(y)) put(y, x, race);
        else o[k] = dec(x, race);
      }
    }
    function applyCar(race, c, e) {
      if (!race._carSetW) { race._carSetW = new Set(race.cars); race._fromW = new WeakSet(); }
      put(c, e.s, race);
      if (e.rng != null && c.brain && c.brain.rng && c.brain.rng.set) c.brain.rng.set(e.rng);
    }
    function applyRace(race, e) {
      if (!race._carSetW) { race._carSetW = new Set(race.cars); race._fromW = new WeakSet(); }
      put(race, e, race);
    }
    F1.SimCodec = { LARGE, ctx, memo, encCar, encRace, enc, applyCar, applyRace, dec };
  }
  (G.F1workerMods = G.F1workerMods || []).push(codecModule);
  codecModule(G);

  // ---------- the worker ----------
  const WORKER_MAIN = `
    const F1 = self.F1, R = F1.Race, K = F1.SimCodec, DT = 1 / 240;
    let race = null, gen = 0, X = null, st = null, evAt = 0;
    // (where a request's time goes: the crash structures' share, for the overlay and tests)
    const T = { soft: 0, think: 0, acts: 0 };
    if (F1.Soft && F1.Soft.step) { const f = F1.Soft.step; F1.Soft.step = function () { const t = performance.now(); try { return f.apply(this, arguments); } finally { T.soft += performance.now() - t; } }; }
    const POSE = ['x', 'y', 'h', 'zh', 'pitch', 'roll'];
    // the page's commands on a car while racing
    const ACT = {
      shift: (c, d) => F1.Car.shift(c, d),
      recover: c => { race.recover(c); c.stuckT = 0; },
      set: (c, path, val) => { let o = c; for (let i = 0; i < path.length - 1; i++) o = o[path[i]]; o[path[path.length - 1]] = K.dec(val, race); },
    };
    function snapshot(rid, ms) {
      const cars = race.cars.map(c => K.encCar(race, c, X, st, false));
      const ev = race.events.map(e => K.enc(e, X, K.memo(), true, null, new Set()));
      const fx = race.fx.map(f => K.enc(f, X, K.memo(), true, null, new Set()));
      race.events.length = 0; race.fx.length = 0;
      const pp = new Float64Array(race.cars.length * 6);
      race.cars.forEach((c, i) => { const q = c._pp || c; for (let k = 0; k < 6; k++) pp[i * 6 + k] = q[POSE[k]]; });
      const out = { k: 'snap', gen, rid, cars, race: K.encRace(race, X, st, false), ev, fx, pp, ms, soft: T.soft, acts: T.acts };
      T.soft = 0;
      return out;
    }
    self.onmessage = e => {
      const m = e.data;
      try {
        if (m.k === 'init') {
          gen = m.gen;
          F1.Lines = F1.Lines || { stride: m.lineStride };
          if (m.line) { F1.Lines.stride = m.lineStride; F1.Lines[m.cfg.track] = m.line; }
          F1.Limits = F1.Limits || { stride: m.limStride };
          if (m.limits) { F1.Limits.stride = m.limStride; F1.Limits[m.cfg.track] = m.limits; }
          Object.assign(R.THINK, m.think);
          // (data files the page loads that are not sim modules: the grip model's trees, the AI's seed memory)
          if (m.grip) F1.GripModelData = m.grip;
          if (m.aimem) F1.AIMem = m.aimem;
          race = R.create(m.cfg);
          race.thinkPage = false;
          race.thinkPool = F1.ThinkPool ? F1.ThinkPool.forRace(race) : null;
          X = K.ctx(race); st = K.memo();
          postMessage({ k: 'ready', gen, N: race.track.N, L: race.track.L, look: !!race.thinkPool });
        } else if (m.k === 'sync') {
          // the page's race is the race: everything it holds goes into this one
          m.cars.forEach((c, i) => K.applyCar(race, race.cars[i], c));
          K.applyRace(race, m.race);
          race.autoPlayer = m.auto; race.physLod = m.physLod; race.physLodDist = m.physLodDist;
          race.events.length = 0; race.fx.length = 0;
          st = K.memo(); // (what the page holds now is what it was just sent)
        } else if (m.k === 'step') {
          const t0 = performance.now(), p = race.player;
          race.autoPlayer = m.auto;
          race.lodFocus = m.focus >= 0 ? race.cars[m.focus] : null;
          for (const a of m.acts || []) { const c = race.cars[a[1]]; if (c && ACT[a[0]]) { ACT[a[0]](c, ...a.slice(2)); T.acts++; } }
          for (let s = 0; s < m.n; s++) {
            if (m.ctl && m.ctl[s]) Object.assign(p.ctl, m.ctl[s]);
            for (const c of race.cars) { const q = c._pp || (c._pp = {}); for (const k of POSE) q[k] = c[k]; }
            R.step(race, DT);
          }
          postMessage(snapshot(m.rid, performance.now() - t0));
        } else if (m.k === 'stop') {
          if (race && race.thinkPool) race.thinkPool.close();
          race = null; close();
        }
      } catch (err) { postMessage({ k: 'err', gen, err: String((err && err.stack) || err) }); }
    };`;
  let url = null, broken = false;
  function blobUrl() {
    if (url || broken) return url;
    try {
      const mods = G.F1simMods || [], extra = G.F1workerMods || [];
      // (the sim modules again as a list, so the look-ahead pool inside can build its own workers)
      const src = 'self.F1simMods = [' + mods.map(m => m.toString()).join(',\n') + '];\nself.F1simMods.forEach(m => m(self));\n'
        + extra.map(m => '(' + m.toString() + ')(self);').join('\n') + '\n' + WORKER_MAIN;
      url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    } catch (e) { broken = true; }
    return url;
  }

  // ---------- the page side ----------
  const K = F1.SimCodec;
  const INPUT = ['steer', 'throttle', 'brake', 'drs', 'analog', 'steerDirect', 'wheelSteer', 'wheelDeg', 'wheelLock', 'byWheel'];
  let gens = 0;
  class Link {
    constructor(race) {
      this.race = race; this.gen = ++gens; this.ok = false; this.dead = false; this.held = true; this.wait = null; this.rid = 0;
      this.acts = []; this.inbox = null; this.ms = 0; this.lag = 0;
      Link.last = this; // (debug and tests)
      this.w = new Worker(blobUrl());
      this.w.onmessage = e => this.onMessage(e.data);
      this.w.onerror = e => { if (e.preventDefault) e.preventDefault(); this.fail(e.message || 'worker failed'); };
      const id = race.cfg.track;
      const plain = o => { const r = {}; for (const k in o) if (typeof o[k] !== 'function') r[k] = o[k]; return r; };
      this.w.postMessage({ k: 'init', gen: this.gen, cfg: JSON.parse(JSON.stringify(race.cfg)), think: plain(F1.Race.THINK),
        line: F1.Lines && F1.Lines[id] || null, lineStride: F1.Lines && F1.Lines.stride, limits: F1.Limits && F1.Limits[id] || null, limStride: F1.Limits && F1.Limits.stride,
        grip: F1.GripModelData || null, aimem: F1.AIMem || null });
    }
    onMessage(m) {
      if (m.gen !== this.gen || this.dead) return;
      if (m.k === 'err') { this.fail(m.err); return; }
      if (m.k === 'ready') {
        if (m.N !== this.race.track.N || Math.abs(m.L - this.race.track.L) > 0.01) { this.fail('the circuit differs in the worker'); return; }
        this.ok = true; this.look = m.look; return;
      }
      if (m.k === 'snap') { if (this.wait === m.rid) { this.wait = null; if (!this.held) this.inbox = m; } }
    }
    fail(why) {
      if (this.dead) return;
      console.warn('simworker: the page steps the race again (' + why + ')');
      this.dead = true; this.ok = false;
      try { this.w.terminate(); } catch (e) { /* gone */ }
      if (Link.onFail) Link.onFail(this);
    }
    close() { if (this.dead) return; this.dead = true; try { this.w.postMessage({ k: 'stop' }); } catch (e) { /* gone */ } setTimeout(() => { try { this.w.terminate(); } catch (e) { /* gone */ } }, 2000); }
    // ready to take the race over?
    get usable() { return this.ok && !this.dead; }
    // (one request at a time: while an answer is on its way the steps wait for the next frame)
    get canSend() { return this.wait == null; }
    // the race runs live: the page's state goes over first when the worker was on hold
    run() {
      if (!this.held) return;
      const race = this.race, X = K.ctx(race), st = K.memo();
      // (the large tables that came from the worker it has newer copies of; any the page made, or
      // made anew, go over)
      const fromW = race._fromW || new WeakSet(), big = { sent: { has: v => fromW.has(v), add() {} }, ver: new WeakMap() };
      const cars = race.cars.map(c => K.encCar(race, c, X, big, false));
      this.w.postMessage({ k: 'sync', gen: this.gen, cars, race: K.encRace(race, X, st, false), auto: !!race.autoPlayer, physLod: !!race.physLod, physLodDist: race.physLodDist });
      this.held = false; this.inbox = null; this.wait = null; this.acts.length = 0;
    }
    // the race stops running live: the page's copy is the race from now (an answer still on its way
    // is dropped: the page has drawn what it has)
    hold() { if (this.held) return; this.held = true; this.inbox = null; this.wait = null; this.acts.length = 0; }
    act(name, car, ...args) { if (this.held) return false; this.acts.push([name, this.race.cars.indexOf(car), ...args]); return true; }
    // this frame: take in the last answer (into the page's race), ask for the steps this frame owes
    frame(n, ctls) {
      const race = this.race;
      let took = 0;
      if (this.inbox) { took = this.take(this.inbox); this.inbox = null; }
      if (this.wait == null) {
        if (n > 0 || this.acts.length) {
          const fo = race.lodFocus || race.player;
          this.wait = ++this.rid;
          this.w.postMessage({ k: 'step', gen: this.gen, rid: this.rid, n, ctl: ctls, auto: !!race.autoPlayer, focus: fo ? race.cars.indexOf(fo) : -1, acts: this.acts.splice(0) });
          return { sent: n, took };
        }
      }
      return { sent: -1, took }; // (still waiting: the steps are owed to the next request)
    }
    take(m) {
      const race = this.race;
      const gears = race.cars.map(c => c.gear);
      m.cars.forEach((e, i) => K.applyCar(race, race.cars[i], e));
      K.applyRace(race, m.race);
      for (const e of m.ev) race.events.push(K.dec(e, race));
      for (const f of m.fx) race.fx.push(K.dec(f, race));
      // (the poses before the last step, for the page's blend between steps)
      race.cars.forEach((c, i) => { const q = c._pp || (c._pp = {}); q.x = m.pp[i * 6]; q.y = m.pp[i * 6 + 1]; q.h = m.pp[i * 6 + 2]; q.zh = m.pp[i * 6 + 3]; q.pitch = m.pp[i * 6 + 4]; q.roll = m.pp[i * 6 + 5]; });
      // (the gear-change sound is the page's: the worker's cars have no onShift)
      race.cars.forEach((c, i) => { if (c.onShift && c.gear !== gears[i] && gears[i] != null) c.onShift(c.gear > gears[i] ? 1 : -1); });
      this.ms = m.ms; this.softMs = m.soft; this.actsDone = m.acts;
      return 1;
    }
  }
  function input(p) { const o = {}; for (const k of INPUT) o[k] = p.ctl[k]; return o; }
  F1.SimWorker = {
    available: () => typeof Worker !== 'undefined' && !!G.F1simMods && !!G.Blob && !!G.URL && !!blobUrl(),
    link: race => { try { return new Link(race); } catch (e) { console.warn('simworker:', e); return null; } },
    input, Link,
  };
})(typeof self !== 'undefined' ? self : this);
