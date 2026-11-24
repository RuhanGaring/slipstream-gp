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
// On by default (Settings > Advanced graphics > Physics thread; ?simw=1 forces it). When the worker cannot start or fails,
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
    function put(o, v, race) { for (const k in v) putKey(o, k, v[k], race); }
    function putKey(o, k, x, race) {
      {
        const y = o[k];
        // (only what changed is written: a string written again is a new string every frame, kept
        // alive by the long-lived car it hangs on, and so promoted to the old heap sixty times a second)
        if (x === null || typeof x !== 'object') { if (y !== x) o[k] = x; return; }
        if ('$c' in x || '$k' in x) { o[k] = dec(x, race); return; }
        if (ArrayBuffer.isView(x)) { if (ArrayBuffer.isView(y) && y.length === x.length && y.constructor === x.constructor) y.set(x); else o[k] = x; if (x.length > LARGE) race._fromW.add(o[k]); return; }
        if (Array.isArray(x)) {
          if (Array.isArray(y)) {
            y.length = x.length;
            for (let i = 0; i < x.length; i++) {
              const xi = x[i], yi = y[i];
              if (xi !== null && typeof xi === 'object' && !Array.isArray(xi) && !ArrayBuffer.isView(xi) && !('$c' in xi) && !('$k' in xi) && yi && typeof yi === 'object' && !Array.isArray(yi) && Object.getPrototypeOf(yi) === Object.prototype && !race._carSetW.has(yi)) put(yi, xi, race);
              else if (xi === null || typeof xi !== 'object') { if (yi !== xi) y[i] = xi; }
              else y[i] = dec(xi, race);
            }
          } else o[k] = dec(x, race);
          if (x.length > LARGE) race._fromW.add(o[k]);
          return;
        }
        if (y && typeof y === 'object' && !Array.isArray(y) && !ArrayBuffer.isView(y) && Object.getPrototypeOf(y) === Object.prototype && !race._carSetW.has(y)) put(y, x, race);
        else o[k] = dec(x, race);
      }
    }
    // The parts a car has lost, as a set of keys (dm.off): put() writes keys that are in the source
    // and never takes one away, so a part that came off before a flashback stayed in the other
    // side's copy, and came back from it as soon as the race ran again: the wheels went again
    // right after the rewind. Keys the source no longer has are taken away here.
    function exactOff(c, e) {
      const d = c.dm, s = e.s && e.s.dm;
      if (d && d.off && s && s.off && typeof s.off === 'object') for (const k in d.off) if (!(k in s.off)) delete d.off[k];
    }
    function applyCar(race, c, e) {
      if (!race._carSetW) { race._carSetW = new Set(race.cars); race._fromW = new WeakSet(); }
      put(c, e.s, race);
      exactOff(c, e);
      if (e.rng != null && c.brain && c.brain.rng && c.brain.rng.set) c.brain.rng.set(e.rng);
    }
    function applyRace(race, e) {
      if (!race._carSetW) { race._carSetW = new Set(race.cars); race._fromW = new WeakSet(); }
      put(race, e, race);
    }

    // ---------- the answer as one block of numbers ----------
    // The same content as encCar and encRace, but as one Float64Array (handed over, not copied) and a
    // short list of everything that is not a plain number (names, nulls, the parts that change shape):
    // the page unpacked and copied some 8000 values a frame as a tree of objects, 2.7 ms of it. The
    // layout (a "shape") of each car and of the race is worked out by the worker from the live objects
    // and sent once, and again for the car whose objects have come to look different. Anything whose
    // shape keeps changing (a list of cars nearby, a value that is sometimes null) is marked loose and
    // goes as a small tree of its own from then on.
    // A shape: { t: 'O', k: keys, c: what each is }, { t: 'A', c }, { t: 'Y', y: array type, n } or a
    // letter: n number, b true or false, s text or null, C a car or null, K a tyre compound, V a large
    // array or a structure with a version counter (sent when new), T a loose part, and not sent: X (an
    // object sent elsewhere, or not plain data), F function, U undefined, P left out.
    const UNDEF = '\u0000u';
    const plainObj = y => y !== null && typeof y === 'object' && !Array.isArray(y) && !ArrayBuffer.isView(y) && Object.getPrototypeOf(y) === Object.prototype;
    // the worker's side
    function Packer(race, X) {
      const loose = new Map([['car.dm.off', 'T']]); // path -> 'C' or 'T' (the parts lost: a key that goes must go on the page too)
      // (an object that gains and loses keys, as the AI's brain does: every key it has ever had, each
      // looked up by name; the ones that come and go are loose)
      const dict = new Map(), misses = new Map();
      let st = null, buf = new Float64Array(16384), p = 0, vals = [], bad = null, shapes = [], jS = [], jV = [];
      this.rebuilt = 0; // (for tests)
      // (what the large parts have been sent, with a way back: a car whose shape turns out to have
      // changed is packed again from its start)
      const memo2 = () => { const sent = new WeakSet(), ver = new WeakMap(); return { sent: { has: v => sent.has(v), add: v => { sent.add(v); jS.push(v); }, del: v => sent.delete(v) }, ver: { get: v => ver.get(v), set: (v, n) => { jV.push(v, ver.get(v)); ver.set(v, n); }, back: (v, n) => { if (n === undefined) ver.delete(v); else ver.set(v, n); } } }; };
      this.reset = () => { st = memo2(); shapes = []; };
      this.reset();
      const tree = v => { const e = enc(v, X, st, false, null, new Set()); return e === undefined ? UNDEF : e; };
      function build(v, path, skip, seen) {
        const l = loose.get(path); if (l) return l;
        if (v === undefined) return 'U';
        if (typeof v === 'function') return 'F';
        if (typeof v === 'number') return 'n';
        if (typeof v === 'boolean') return 'b';
        if (v === null || typeof v !== 'object') return 's';
        if (X.cars.has(v)) return 'C';
        if (X.comps.has(v)) return 'K';
        if (seen.has(v)) return 'X';
        seen.add(v);
        if (ArrayBuffer.isView(v)) return v.length > LARGE ? 'V' : { t: 'Y', y: v.constructor.name, n: v.length, p: path };
        if (Array.isArray(v)) {
          if (v.length > LARGE) return 'V';
          const c = []; for (let i = 0; i < v.length; i++) c.push(build(v[i], path + '[]', null, seen));
          return { t: 'A', c, p: path };
        }
        const pr = Object.getPrototypeOf(v);
        if (pr !== Object.prototype && pr !== null) return 'X';
        if (typeof v.ver === 'number') return 'V';
        return keysOf(v, path, null, seen);
      }
      function keysOf(v, path, skip, seen) {
        const k = [], c = [], D = dict.get(path);
        if (D) for (const q in v) D.add(q);
        for (const q of D || Object.keys(v)) {
          if (D && !(q in v)) loose.set(path + '.' + q, 'T');
          k.push(q); c.push(skip && skip.has(q) ? 'P' : build(v[q], path + '.' + q, null, seen));
        }
        return { t: 'O', k, c, p: path, d: !!D };
      }
      const count = s => (typeof s === 'string' ? 1 : s.t === 'Y' ? s.n : s.c.reduce((a, x) => a + count(x), 0));
      function miss(path, how, node) { bad = [path, how, node]; return false; }
      // one value against its shape: written, or false where it no longer fits
      function leaf(v, s, path) {
        switch (s) {
          case 'n': if (typeof v !== 'number') return miss(path, v === undefined ? 0 : 'T'); buf[p++] = v; return true;
          case 'b': if (typeof v !== 'boolean') return miss(path, v === undefined ? 0 : 'T'); buf[p++] = v ? 1 : 0; return true;
          case 's': if (v !== null && typeof v !== 'string') return miss(path, v !== undefined && X.cars.has(v) ? 'C' : v === undefined ? 0 : 'T'); vals.push(v); return true;
          case 'C': { if (v === null) { buf[p++] = -1; return true; } const i = X.cars.get(v); if (i === undefined) return miss(path, v === undefined ? 0 : 'T'); buf[p++] = i; return true; }
          case 'K': { const i = X.comps.get(v); if (i === undefined) return miss(path, 'T'); vals.push(i); return true; }
          case 'V': if (v === null || typeof v !== 'object') return miss(path, 'T'); vals.push(tree(v)); return true;
          case 'T': vals.push(tree(v)); return true;
          case 'X': return v !== null && typeof v === 'object' && !X.cars.has(v) ? true : miss(path, 0);
          case 'F': return typeof v === 'function' ? true : miss(path, 0);
          case 'U': return v === undefined ? true : miss(path, 0);
        }
        return true;
      }
      function walk(v, s) {
        if (s.t === 'O') {
          const K = s.k, C = s.c;
          let i = 0;
          if (s.d) {
            let n = 0, has = 0;
            for (const q in v) n++;
            for (; i < K.length; i++) {
              const q = K[i], c = C[i], x = v[q];
              if (x !== undefined || q in v) has++; else if (c !== 'T' && c !== 'P') return miss(s.p + '.' + q, 'T');
              if (typeof c === 'string') {
                if (c === 'P') continue;
                if (c === 'n' && typeof x === 'number') { buf[p++] = x; continue; }
                if (!leaf(x, c, s.p + '.' + q)) return false;
              } else {
                if (x === null || typeof x !== 'object') return miss(c.p, 'T');
                if (!walk(x, c)) return false;
              }
            }
            return n === has ? true : miss(s.p, 1, s);
          }
          for (const q in v) {
            if (K[i] !== q) return miss(s.p, 1, s);
            const c = C[i++];
            if (typeof c === 'string') {
              if (c === 'P') continue;
              const x = v[q];
              if (c === 'n' && typeof x === 'number') { buf[p++] = x; continue; }
              if (!leaf(x, c, s.p + '.' + q)) return false;
            } else {
              const x = v[q];
              if (x === null || typeof x !== 'object') return miss(c.p, x === undefined ? 0 : 'T');
              if (!walk(x, c)) return false;
            }
          }
          return i === K.length ? true : miss(s.p, 1, s);
        }
        if (s.t === 'A') {
          if (!Array.isArray(v) || v.length !== s.c.length) return miss(s.p, 'T');
          for (let i = 0; i < v.length; i++) {
            const c = s.c[i], x = v[i];
            if (typeof c === 'string') { if (!leaf(x, c, s.p + '[]')) return bad[1] === 0 ? miss(s.p, 'T') : false; } else {
              if (x === null || typeof x !== 'object') return miss(s.p, 'T');
              if (!walk(x, c)) return false;
            }
          }
          return true;
        }
        // (a small typed array)
        if (!ArrayBuffer.isView(v) || v.length !== s.n || v.constructor.name !== s.y) return miss(s.p, 'T');
        for (let i = 0; i < s.n; i++) buf[p++] = v[i];
        return true;
      }
      const strip = s => (typeof s === 'string' ? s : s.t === 'Y' ? { t: 'Y', y: s.y, n: s.n } : { t: s.t, k: s.k, c: s.c.map(strip) });
      // one root object (a car, or the race), whatever has become of its shape; newly made shapes go to out
      function root(i, v, skip, path, out, self) {
        for (let tries = 0; ; tries++) {
          let s = shapes[i];
          if (!s) {
            const seen = i < 0 ? new Set(X.cars.keys()) : new Set([v]);
            s = shapes[i] = keysOf(v, path, skip, seen);
            s.room = count(s);
            out.set(i, strip(s));
            self.rebuilt++;
          }
          if (p + s.room + 64 > buf.length) { const b = new Float64Array((p + s.room) * 2 + 4096); b.set(buf.subarray(0, p)); buf = b; }
          const p0 = p, v0 = vals.length;
          jS.length = 0; jV.length = 0;
          bad = null;
          if (walk(v, s)) return;
          if (tries > 60) throw new Error('simworker: ' + bad[0] + ' does not settle');
          p = p0; vals.length = v0;
          for (const o of jS) st.sent.del(o);
          for (let q = jV.length - 2; q >= 0; q -= 2) st.ver.back(jV[q], jV[q + 1]);
          const [bp, how] = bad;
          if (how === 'C' || how === 'T') loose.set(bp, how);
          else {
            const n = (misses.get(bp) || 0) + 1; misses.set(bp, n);
            if (n > 3 && how === 1) { if (!dict.has(bp)) dict.set(bp, new Set(bad[2].k)); } else if (n > 12 && bp !== path) loose.set(bp, 'T');
          }
          shapes[i] = null;
        }
      }
      // everything: the cars in order (each then its dice), then the race
      this.pack = function (spare) {
        if (spare && spare.length >= buf.length) buf = spare; else if (!buf.buffer.byteLength) buf = new Float64Array(16384);
        p = 0; vals = [];
        const out = new Map();
        race.cars.forEach((c, i) => {
          root(i, c, SKIP_CAR, 'car', out, this);
          const r = c.brain && c.brain.rng && c.brain.rng.get ? c.brain.rng.get() : null;
          vals.push(r);
        });
        root(-1, race, SKIP_RACE, 'race', out, this);
        const res = { buf, vals, shapes: out.size ? [...out] : null };
        buf = new Float64Array(0); // (handed over)
        return res;
      };
    }
    // the page's side: written into the same objects where they are plain data of the same shape, as put() does
    function Unpacker(race) {
      const shapes = new Map(), TA = { Float64Array, Float32Array, Int32Array, Int16Array, Int8Array, Uint32Array, Uint16Array, Uint8Array, Uint8ClampedArray };
      let B = null, p = 0, vals = null;
      const H = { vi: 0, vals: null, cars: null, TA, plain: y => plainObj(y) && !isCar.has(y), one: (o, k, c, inArr, p0) => { p = p0; one(o, k, c, inArr); return p; } };
      if (!race._carSetW) { race._carSetW = new Set(race.cars); race._fromW = new WeakSet(); }
      const cars = race.cars, isCar = race._carSetW;
      H.cars = cars;
      this.reset = () => shapes.clear();
      function one(o, k, s, inArr) {
        switch (s) {
          case 'n': { const x = B[p++]; if (o[k] !== x) o[k] = x; return; }
          case 'b': { const x = B[p++] === 1; if (o[k] !== x) o[k] = x; return; }
          case 's': { const x = vals[H.vi++]; if (o[k] !== x) o[k] = x; return; }
          case 'C': { const i = B[p++], x = i < 0 ? null : cars[i]; if (o[k] !== x) o[k] = x; return; }
          case 'K': { const x = F1.Car.COMPOUNDS[vals[H.vi++]]; if (o[k] !== x) o[k] = x; return; }
          case 'V': case 'T': {
            const x = vals[H.vi++];
            if (x === UNDEF) { if (inArr) o[k] = null; return; }
            if (x === null || typeof x !== 'object') { if (o[k] !== x) o[k] = x; return; }
            // (the parts a car has lost: a key its source no longer has is taken away, as exactOff does)
            if (k === 'off' || k === 'dm') { const was = k === 'off' ? o.off : o.dm && o.dm.off, now = k === 'off' ? x : x.off; if (plainObj(was) && plainObj(now)) for (const q in was) if (!(q in now)) delete was[q]; }
            if (inArr) { const y = o[k]; if (plainObj(x) && !('$c' in x) && !('$k' in x) && plainObj(y) && !isCar.has(y)) put(y, x, race); else o[k] = dec(x, race); } else putKey(o, k, x, race);
            return;
          }
          default: if (inArr && o[k] !== null) o[k] = null; // (a thing that is not sent stands as null in a list)
        }
      }
      // Each distinct shape is compiled to a function of its own that names its fields outright: read
      // by a general walk (a field name in a variable, thousands of them over every kind of object)
      // the browser looks each one up the slow way, and the copy cost 0.8 ms a frame.
      const made = new Map();
      function fn(s) {
        const id = JSON.stringify(s);
        let f = made.get(id);
        if (f) return f;
        const kids = [], L = [];
        const arr = s.t === 'A', N = arr ? s.c.length : s.k.length;
        if (arr) L.push(`if (y.length !== ${N}) y.length = ${N};`);
        for (let i = 0; i < N; i++) {
          const c = s.c[i], k = arr ? String(i) : JSON.stringify(s.k[i]), at = `y[${k}]`;
          if (c === 'n') L.push(`x = B[p++]; if (${at} !== x) ${at} = x;`);
          else if (c === 'b') L.push(`x = B[p++] === 1; if (${at} !== x) ${at} = x;`);
          else if (c === 's') L.push(`x = H.vals[H.vi++]; if (${at} !== x) ${at} = x;`);
          else if (c === 'C') L.push(`x = B[p++]; x = x < 0 ? null : H.cars[x]; if (${at} !== x) ${at} = x;`);
          else if (typeof c === 'string') { if (arr || !'PXFU'.includes(c)) L.push(`p = H.one(y, ${k}, '${c}', ${arr}, p);`); } else if (c.t === 'Y') {
            L.push(`x = ${at}; if (!ArrayBuffer.isView(x) || x.length !== ${c.n} || x.constructor.name !== '${c.y}') x = ${at} = new H.TA.${c.y}(${c.n}); for (let i = 0; i < ${c.n}; i++) x[i] = B[p++];`);
          } else {
            const j = kids.push(fn(c)) - 1;
            L.push(c.t === 'A' ? `x = ${at}; if (!Array.isArray(x)) x = ${at} = []; p = F${j}(x, B, p);` : `x = ${at}; if (!H.plain(x)) x = ${at} = {}; p = F${j}(x, B, p);`);
          }
        }
        f = new Function('H', ...kids.map((_, j) => 'F' + j), `return function (y, B, p) { let x; ${L.join('\n')} return p; };`)(H, ...kids);
        made.set(id, f);
        return f;
      }
      this.unpack = function (m) {
        if (m.shapes) for (const [i, s] of m.shapes) { s.f = fn(s); shapes.set(i, s); }
        B = m.buf; vals = H.vals = m.vals; p = 0; H.vi = 0;
        for (let i = 0; i < cars.length; i++) {
          const c = cars[i], off = c.dm && c.dm.off ? c.dm : null;
          const s = shapes.get(i); if (!s) throw new Error('no shape for car ' + i);
          if (off) exactShape(c, s);
          p = s.f(c, B, p);
          const r = vals[H.vi++];
          if (r != null && c.brain && c.brain.rng && c.brain.rng.set) c.brain.rng.set(r);
        }
        const s = shapes.get(-1); if (!s) throw new Error('no shape for the race');
        p = s.f(race, B, p);
      };
      // (the parts a car has lost: a key its source no longer has is taken away here, as exactOff does)
      function exactShape(c, s) {
        const di = s.k.indexOf('dm'), d = di >= 0 ? s.c[di] : null;
        if (!d || d.t !== 'O') return;
        const oi = d.k.indexOf('off'), o = oi >= 0 ? d.c[oi] : null;
        if (o && o.t === 'O' && c.dm.off) for (const k in c.dm.off) if (!o.k.includes(k)) delete c.dm.off[k];
      }
    }
    F1.SimCodec = { LARGE, ctx, memo, encCar, encRace, enc, applyCar, applyRace, dec, Packer, Unpacker };
  }
  (G.F1workerMods = G.F1workerMods || []).push(codecModule);
  codecModule(G);

  // ---------- the worker ----------
  const WORKER_MAIN = `
    const F1 = self.F1, R = F1.Race, K = F1.SimCodec, DT = 1 / 240;
    let race = null, gen = 0, X = null, pk = null, spare = null;
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
    function snapshot(rid, ms, chk) {
      const ev = race.events.map(e => K.enc(e, X, K.memo(), true, null, new Set()));
      const fx = race.fx.map(f => K.enc(f, X, K.memo(), true, null, new Set()));
      race.events.length = 0; race.fx.length = 0;
      const pp = new Float64Array(race.cars.length * 6);
      race.cars.forEach((c, i) => { const q = c._pp || c; for (let k = 0; k < 6; k++) pp[i * 6 + k] = q[POSE[k]]; });
      const f = pk.pack(spare); spare = null;
      const out = { k: 'snap', gen, rid, buf: f.buf, vals: f.vals, shapes: f.shapes, ev, fx, pp, ms, soft: T.soft, acts: T.acts, rebuilt: pk.rebuilt };
      // (tests: the same answer as a tree beside it, to compare)
      if (chk) { out.cars = race.cars.map(c => K.encCar(race, c, X, K.memo(), true)); out.race = K.encRace(race, X, K.memo(), true); }
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
          X = K.ctx(race); pk = new K.Packer(race, X);
          postMessage({ k: 'ready', gen, N: race.track.N, L: race.track.L, look: !!race.thinkPool });
        } else if (m.k === 'sync') {
          // the page's race is the race: everything it holds goes into this one
          m.cars.forEach((c, i) => K.applyCar(race, race.cars[i], c));
          K.applyRace(race, m.race);
          race.autoPlayer = m.auto; race.physLod = m.physLod; race.physLodDist = m.physLodDist;
          race.events.length = 0; race.fx.length = 0;
          pk.reset(); // (what the page holds now is what it was just sent; the shapes go over again)
        } else if (m.k === 'step') {
          const t0 = performance.now(), p = race.player;
          if (m.spare) spare = m.spare;
          race.autoPlayer = m.auto;
          race.lodFocus = m.focus >= 0 ? race.cars[m.focus] : null;
          for (const a of m.acts || []) { const c = race.cars[a[1]]; if (c && ACT[a[0]]) { ACT[a[0]](c, ...a.slice(2)); T.acts++; } }
          for (let s = 0; s < m.n; s++) {
            if (m.ctl && m.ctl[s]) Object.assign(p.ctl, m.ctl[s]);
            for (const c of race.cars) { const q = c._pp || (c._pp = {}); for (const k of POSE) q[k] = c[k]; }
            R.step(race, DT);
          }
          const a = snapshot(m.rid, performance.now() - t0, m.chk);
          postMessage(a, [a.buf.buffer, a.pp.buffer]);
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
      // steps asked for since the race last went live, the count at the request now out, and the
      // count the page's copy stands at (see drawAt)
      this.sent = 0; this.reqSent = 0; this.have = 0; this.vPrev = null; this.behind = null;
      this.un = new K.Unpacker(race); this.spare = null; // (the answer's block of numbers goes back with the next request, to be filled again)
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
      this.un.reset();
      this.held = false; this.inbox = null; this.wait = null; this.acts.length = 0;
      this.sent = this.reqSent = this.have = 0; this.vPrev = null; this.behind = null;
    }
    // the race stops running live: the page's copy is the race from now (an answer still on its way
    // is dropped: the page has drawn what it has)
    hold() { if (this.held) return; this.held = true; this.inbox = null; this.wait = null; this.acts.length = 0; }
    act(name, car, ...args) { if (this.held) return false; this.acts.push([name, this.race.cars.indexOf(car), ...args]); return true; }
    // this frame: take in the last answer (into the page's race), ask for the steps this frame owes
    frame(n, ctls) {
      const race = this.race;
      let took = 0;
      if (this.inbox) { took = this.take(this.inbox); this.inbox = null; this.have = this.reqSent; }
      if (this.wait == null) {
        if (n > 0 || this.acts.length) {
          const fo = race.lodFocus || race.player;
          this.wait = ++this.rid;
          this.sent += n; this.reqSent = this.sent;
          const sp = this.spare; this.spare = null;
          this.w.postMessage({ k: 'step', gen: this.gen, rid: this.rid, n, ctl: ctls, auto: !!race.autoPlayer, focus: fo ? race.cars.indexOf(fo) : -1, acts: this.acts.splice(0), spare: sp, chk: !!Link.check }, sp ? [sp.buffer] : []);
          return { sent: n, took };
        }
      }
      return { sent: -1, took }; // (still waiting: the steps are owed to the next request)
    }
    // Where between the page's last two steps this frame is drawn (0 the step before the last, 1 the
    // last, over 1 past it), given what is left of this frame's time after its request (left, in
    // steps). The page's copy is the answer to an earlier frame, so the cars are drawn a fixed time
    // behind the page's clock (the steps asked for so far plus what is left): about a frame, held
    // steady, following the frame rate only slowly. Each frame then moves the cars by that frame's
    // own time, whatever the copy on hand: between its last two steps when it is fresh, carried on
    // along its last step when the answer is late or the frame was long. Drawn with this frame's
    // leftover against the last answer, as it was, each frame's motion was out by up to a step
    // either way (a quarter of a frame's travel at 60 fps), and a late answer stood the cars still
    // for a frame and then moved them two.
    drawAt(left) {
      const v = this.sent + left, was = this.vPrev;
      this.vPrev = v;
      if (was == null) { this.behind = null; return 1; }
      const d = Math.max(0, v - was); // this frame's time, in steps
      // (a hitch does not move it: a frame over twice or under half the usual counts as that much)
      this.behind = this.behind == null ? d : this.behind + (Math.max(this.behind * 0.5, Math.min(this.behind * 2, d)) - this.behind) * 0.05;
      return Math.max(0, Math.min(12, v - (this.behind - 0.5) - this.have));
    }
    take(m) {
      const race = this.race;
      const gears = race.cars.map(c => c.gear);
      try { this.un.unpack(m); } catch (e) { this.fail(String((e && e.stack) || e)); return 0; }
      this.spare = m.buf;
      if (Link.check && m.cars) Link.check(this, m);
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
