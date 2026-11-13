// The crash structures (js/softbody.js) solved on worker threads, off the main thread.
// Every crashed car's structure is independent of every other, so each is solved on one of a small
// pool of workers (js/softthread.js), a car always on the same one. The main thread keeps a copy of
// each structure, which everything else reads as before (damage figures, wheels, steering,
// colliders, the 3D model), and gets each new shape back a frame or so after asking for it.
// What the main thread does to a structure (a new contact from a hit, a torn corner, a pit repair)
// it does to its copy at once, as before, and sends along with the next step, so the worker's
// structure does the same; a result that left any of it out is not taken. A flashback, which
// puts the copies back to an earlier moment, sends each one whole again.
// Only in a browser with workers; the offline tools and tests load softbody.js alone and solve on
// the spot, as before. window.__softSync = true does that in the game too.
(function () {
  'use strict';
  const F1 = window.F1, Soft = F1 && F1.Soft;
  if (!Soft || typeof Worker === 'undefined') return;
  const me = document.currentScript && document.currentScript.src;
  if (!me) return;
  const url = me.replace(/softworker\.js/, 'softthread.js');
  const N = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
  const pool = [], byId = new Map();
  let nextId = 1, epoch = 0, failed = false;
  const orig = { step: Soft.step, impact: Soft.impact, tear: Soft.tear, repair: Soft.repair };
  const FIELDS = ['p', 'q', 'L0', 'broken', 'off', 'gp', 'toe', 'camber', 'hubOff', 'noSteer', 'cc', 'ver', 'offVer', 'awake', 'idle', 'age', 'energy', 'acc'];

  function worker(i) {
    if (pool[i]) return pool[i];
    const w = new Worker(url);
    w.onmessage = e => receive(e.data);
    w.onerror = () => { failed = true; }; // (a worker that cannot start: everything is solved here again)
    w.postMessage({ type: 'init', cc: F1.Race && F1.Race.CC ? F1.Race.CC : null, src: me.replace(/softworker\.js/, 'softbody.js') });
    return (pool[i] = w);
  }
  const on = s => !failed && !window.__softSync && s && s.wid !== 0;
  function ensure(s) {
    if (!s.wid) { s.wid = nextId++; byId.set(s.wid, new WeakRef(s)); s.wops = []; s.mseq = 0; s.wseq = 0; s.wepoch = -1; s.wdt = 0; s.wbusy = false; }
  }
  // the whole structure, for a worker that has not got it (or has an older one)
  function whole(s) {
    const o = { kind: s.kind, planes: [] };
    for (const k of FIELDS) { const v = s[k]; o[k] = v && v.slice ? v.slice() : v; }
    return o;
  }
  function send(s) {
    const msg = { type: 'step', id: s.wid, dt: s.wdt, ops: s.wops, mseq: s.mseq, epoch };
    if (s.wepoch !== epoch) { msg.state = whole(s); s.wepoch = epoch; }
    s.wops = []; s.wdt = 0; s.wbusy = true;
    worker(s.wid % N).postMessage(msg);
  }
  function receive(r) {
    const ref = byId.get(r.id), s = ref && ref.deref();
    if (!s) { byId.delete(r.id); return; }
    s.wbusy = false;
    // (anything done to the copy since this was asked for, or a flashback since: wait for the next)
    if (r.mseq !== s.mseq || r.epoch !== epoch) return;
    for (const k of FIELDS) {
      const v = r[k];
      if (v === undefined) continue;
      if (s[k] && s[k].set && v && v.length === s[k].length) s[k].set(v); else s[k] = v;
    }
    s.planes = [];
  }
  const enqueue = (s, op) => { ensure(s); s.wops.push(op); s.mseq++; };

  Soft.step = function (s, dt) {
    if (!on(s)) return orig.step(s, dt);
    ensure(s);
    if (!s.awake) return false;
    s.wdt += dt;
    // (one request at a time per structure, about every frame)
    if (!s.wbusy && (s.wdt >= 1 / 120 || s.wops.length)) send(s);
    return false;
  };
  Soft.impact = function (s, ...a) {
    if (!on(s)) return orig.impact(s, ...a);
    const n0 = s.planes.length, E = orig.impact(s, ...a);
    if (E != null) {
      // the new contact goes to the worker; the copy here only wakes
      for (const P of s.planes.splice(n0)) { const Q = Object.assign({}, P); delete Q.cand; enqueue(s, ['plane', Q]); }
    }
    return E;
  };
  Soft.tear = function (s, k) {
    const r = orig.tear(s, k);
    if (on(s) && r) enqueue(s, ['tear', k]);
    return r;
  };
  Soft.repair = function (s, g) {
    orig.repair(s, g);
    if (on(s)) enqueue(s, ['repair', g]);
  };
  // after a flashback the copies are as they were: each goes to its worker whole again
  F1.SoftAsync = { restored() { epoch++; for (const [, ref] of byId) { const s = ref.deref(); if (s) { s.wbusy = false; s.wops = []; s.planes = []; } } }, get workers() { return pool.length; }, get failed() { return failed; } };
})();
