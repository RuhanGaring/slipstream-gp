// Flashback: take a race back a few seconds after a mistake and drive it again.
// A race is a graph of plain objects, arrays, maps and typed arrays, so a snapshot is simple:
// walk everything that can change and keep a flat copy of each object beside the object itself.
// Copies hold references to the original objects, not to copies of them, so putting a snapshot
// back writes every object in place: the graph keeps its identity (race.order still holds the
// cars the renderer knows, a brain's rival is still the car it was) and cycles need no care.
// Tables that never change in a race (the track, plans, specs) are left out and stay shared.
// Random generators are closures and are not rewound, so the race plays out differently the
// second time, which is the point. DOM-free, so tools/fbtest.js runs it in Node.
(function (G) {
  'use strict';
  const F1 = G.F1;

  // Keys never walked. Their value is still copied, as a reference: these objects are shared
  // constants, big derived tables, or recording state that has its own way back.
  const SHARED = new Set(['track', 'cfg', 'diff', 'rng', 'spec', 'team', 'driver', 'compound', 'prof', 'style', 'profFor',
    'rec', 'ghost', 'ghostRec', 'assistProf', 'cornerMarks', 'fb', 'player']);
  const DROP = new Set(['fx', 'events']); // the frame's effect and event buffers: emptied on the way back

  const isTyped = ArrayBuffer.isView;
  function isPlain(o) { const p = Object.getPrototypeOf(o); return p === Object.prototype || p === null; }

  function take(race, memo) {
    const seen = new Set(), list = [];
    const walk = o => {
      if (o === null || typeof o !== 'object' || seen.has(o)) return;
      seen.add(o);
      if (isTyped(o)) {
        // a resting soft body keeps its arrays from the last snapshot: only a crash changes them
        const m = memo && memo.get(o);
        if (m && m.owner.awake === 0 && m.owner.ver === m.ver) { list.push(o, m.copy); return; }
        const copy = o.slice();
        list.push(o, copy);
        if (memo && walk.owner) memo.set(o, { owner: walk.owner, ver: walk.owner.ver, copy });
        return;
      }
      if (Array.isArray(o)) {
        const copy = o.slice();
        list.push(o, copy);
        for (let k = 0; k < copy.length; k++) { const v = copy[k]; if (v !== null && typeof v === 'object') walk(v); }
        return;
      }
      if (o instanceof Map) {
        const copy = Array.from(o);
        list.push(o, copy);
        for (const e of copy) { walk(e[0]); walk(e[1]); }
        return;
      }
      if (o instanceof Set) {
        const copy = Array.from(o);
        list.push(o, copy);
        for (const e of copy) walk(e);
        return;
      }
      if (!isPlain(o)) return; // anything else is treated as a constant
      const copy = {};
      const soft = typeof o.ver === 'number' && typeof o.awake === 'number';
      const was = walk.owner;
      if (soft) walk.owner = o;
      for (const k in o) {
        const v = o[k];
        copy[k] = v;
        if (v !== null && typeof v === 'object' && !SHARED.has(k) && !DROP.has(k)) walk(v);
      }
      if (soft) walk.owner = was;
      list.push(o, copy);
    };
    for (const k in race) {
      const v = race[k];
      if (v !== null && typeof v === 'object' && !SHARED.has(k) && !DROP.has(k)) walk(v);
    }
    const top = {};
    for (const k in race) if (typeof race[k] !== 'object' || race[k] === null || !DROP.has(k)) top[k] = race[k];
    return { t: race.time, list, top };
  }

  function put(race, snap) {
    const L = snap.list;
    for (let i = 0; i < L.length; i += 2) {
      const o = L[i], c = L[i + 1];
      if (isTyped(o)) o.set(c);
      else if (Array.isArray(o)) { o.length = c.length; for (let k = 0; k < c.length; k++) o[k] = c[k]; }
      else if (o instanceof Map) { o.clear(); for (const e of c) o.set(e[0], e[1]); }
      else if (o instanceof Set) { o.clear(); for (const e of c) o.add(e); }
      else {
        for (const k in o) if (!(k in c)) delete o[k]; // (fields that appeared after the snapshot)
        for (const k in c) o[k] = c[k];
      }
    }
    for (const k in race) if (!(k in snap.top) && !DROP.has(k) && !SHARED.has(k)) delete race[k];
    for (const k in snap.top) if (!SHARED.has(k)) race[k] = snap.top[k];
    race.fx.length = 0; race.events.length = 0;
  }

  // the ring of snapshots a race keeps: `span` seconds at one every `step` seconds
  function Ring(race, o = {}) {
    this.race = race;
    this.step = o.step || 0.25;
    this.span = o.span || 30;
    this.snaps = [];
    this.next = 0;
    this.memo = new WeakMap();
  }
  Ring.prototype.capture = function () {
    const r = this.race;
    if (r.time < this.next) return false;
    this.next = r.time + this.step;
    this.snaps.push(take(r, this.memo));
    const old = r.time - this.span;
    while (this.snaps.length > 2 && this.snaps[1].t < old) this.snaps.shift();
    return true;
  };
  Ring.prototype.oldest = function () { return this.snaps.length ? this.snaps[0].t : Infinity; };
  // the newest snapshot at or before time t, and everything after it forgotten
  Ring.prototype.rollback = function (t) {
    let k = this.snaps.length - 1;
    while (k > 0 && this.snaps[k].t > t) k--;
    const s = this.snaps[k];
    if (!s) return null;
    put(this.race, s);
    this.snaps.length = k + 1;
    this.next = s.t + this.step;
    return s;
  };

  F1.Flashback = { Ring, take, put };
})(typeof window !== 'undefined' ? window : globalThis);
