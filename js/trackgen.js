// Procedural circuits. A seed becomes a track definition in the same form as the
// hand-made ones in tracks.js (corner vertices [x, y, radius] plus width, style,
// pit and terrain settings), so everything downstream (kerbs, run-off, topography,
// racing line, AI, renderer) works unchanged. Layouts are rolled from the seed and
// rejected until they pass the same checks a circuit designer would make: a sane
// length, no part of the track close to another, a long start straight with room for
// the grid and the pit lane, at least one real overtaking straight, and a mix of
// slow, medium and fast corners.
(function simModule(G) {
  'use strict';
  (G.F1simMods = G.F1simMods || []).push(simModule); // the learning workers rebuild the sim from these
  const F1 = G.F1;
  const U = F1.U;

  const STYLES = {
    park: { width: [14, 15], len: [4300, 5800], clear: 58, looks: ['kestrel', 'varenna', 'hakone'] },
    street: { width: [11, 12], len: [3300, 4400], clear: 32, looks: ['lucerne'] },
    modern: { width: [15, 15], len: [4400, 5900], clear: 62, looks: ['rimal'] },
  };

  // ---------- names ----------
  const SYL = ['mar', 'ven', 'tor', 'al', 'ca', 'lis', 'ber', 'do', 'ran', 'sel', 'ko', 'va', 'mon', 'te', 'ri', 'sa', 'len', 'qua', 'dra', 'no', 'fel', 'ha', 'gro', 'zan', 'ci', 'pe', 'lo', 'mi', 'tar', 'es'];
  const SUFFIX = {
    park: ['Park', 'Ring', 'Circuit', 'Raceway', 'Motor Park'],
    street: ['Street Circuit', 'Harbour Circuit', 'City Circuit', 'Marina Circuit'],
    modern: ['International Circuit', 'Autodrome', 'Grand Prix Circuit'],
  };
  const REGION = {
    kestrel: ['Northern Isles', 'Midland Downs', 'West Moor'], varenna: ['Lakeland', 'Valle Alta', 'Upper Plains'],
    hakone: ['Highland Pass', 'Cedar Valley', 'Mountain Province'], lucerne: ['Riviera Coast', 'Harbour Coast', 'Bay Province'],
    rimal: ['Dune Coast', 'Desert Gulf', 'Salt Plains'],
  };
  const AWKWARD = /dope|poo|ass|sex|cum|tit|nazi|rape|piss|dick|anal|shit|fart|lol/i;
  function word(r) {
    for (;;) {
      let w = '';
      const n = 2 + Math.floor(r() * 2);
      for (let k = 0; k < n; k++) w += SYL[Math.floor(r() * SYL.length)];
      if (!AWKWARD.test(w) && !/(.{2,})\1/.test(w)) return w[0].toUpperCase() + w.slice(1); // no rude or stuttering names
    }
  }

  // ---------- layout ----------
  // A star-shaped polygon around the origin (sorted by angle, so it can never cross
  // itself), stretched and given a low-frequency wobble so it is not a blob, then
  // detail features on the long sides: chicanes and flowing esses.
  function layout(r, st) {
    const n = 7 + Math.floor(r() * 5);
    const ph = r() * 6.283, wob = 0.15 + r() * 0.3, lobes = 2 + Math.floor(r() * 2);
    const asp = 0.65 + r() * 0.75;
    // one or two deep bites into the outline, so the lap folds back on itself
    const bite = new Set();
    for (let b = r() < 0.75 ? 1 + (r() < 0.35 ? 1 : 0) : 0; b > 0; b--) bite.add(Math.floor(r() * n));
    let pts = [];
    for (let k = 0; k < n; k++) {
      const a = (k + (r() - 0.5) * 0.7) / n * Math.PI * 2;
      let rho = (0.55 + r() * 0.6) * (1 + wob * Math.sin(lobes * a + ph));
      if (bite.has(k)) rho *= 0.3 + r() * 0.25;
      pts.push([Math.cos(a) * rho * asp, Math.sin(a) * rho / asp]);
    }
    if (r() < 0.5) pts.reverse(); // clockwise or anticlockwise
    // scale so the polygon is roughly the target length (fillets cut a little off)
    const target = U.lerp(st.len[0], st.len[1], r()) * 1.04;
    const per = pts.reduce((s, p, k) => { const q = pts[(k + 1) % n]; return s + Math.hypot(q[0] - p[0], q[1] - p[1]); }, 0);
    pts = pts.map(p => [p[0] * target / per, p[1] * target / per]);
    // detail on long sides (never on the longest one: that becomes the start straight)
    const segs = pts.map((p, k) => { const q = pts[(k + 1) % pts.length]; return Math.hypot(q[0] - p[0], q[1] - p[1]); });
    const longest = segs.indexOf(Math.max(...segs));
    const out = [];
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k], q = pts[(k + 1) % pts.length], l = segs[k];
      out.push({ p, kind: 'corner' });
      if (k === longest || l < 520) continue;
      const dx = (q[0] - p[0]) / l, dy = (q[1] - p[1]) / l, nx = -dy, ny = dx;
      const roll = r();
      if (roll < 0.14 && l > 700) {
        // a hairpin loop pushed into the infield: down one leg, round, back up the other
        const mid = [p[0] + dx * l / 2, p[1] + dy * l / 2];
        const s = (nx * -mid[0] + ny * -mid[1]) > 0 ? 1 : -1; // toward the middle of the circuit
        const depth = 300 + r() * 200, gap = st.clear + 40 + r() * 50, t0 = 0.2 + r() * 0.3;
        const m1 = [p[0] + dx * l * t0, p[1] + dy * l * t0];
        const m2 = [m1[0] + nx * s * depth, m1[1] + ny * s * depth];
        const m3 = [m2[0] + dx * gap, m2[1] + dy * gap];
        const m4 = [m3[0] - nx * s * depth * (0.75 + r() * 0.2), m3[1] - ny * s * depth * (0.75 + r() * 0.2)];
        for (const m of [m1, m2, m3, m4]) out.push({ p: m, kind: m === m2 || m === m3 ? 'loop' : 'corner' });
      } else if (roll < 0.36) {
        // chicane: a quick left-right jog part-way down the straight
        const at = 0.35 + r() * 0.3, jog = (r() < 0.5 ? -1 : 1) * (22 + r() * 14), len = 28 + r() * 16;
        const m = [p[0] + dx * l * at, p[1] + dy * l * at];
        out.push({ p: m, kind: 'chicane' });
        out.push({ p: [m[0] + dx * len + nx * jog, m[1] + dy * len + ny * jog], kind: 'chicane' });
      } else if (roll < 0.62 && l > 700) {
        // esses: two or three alternating sweeps
        const m = 2 + Math.floor(r() * 2), amp = 26 + r() * 30;
        for (let j = 1; j <= m; j++) {
          const t = j / (m + 1), s = (j % 2 ? 1 : -1) * amp;
          out.push({ p: [p[0] + dx * l * t + nx * s, p[1] + dy * l * t + ny * s], kind: 'esses' });
        }
      } else if (roll < 0.78) {
        // a kink
        const t = 0.3 + r() * 0.4, s = (r() < 0.5 ? -1 : 1) * (18 + r() * 30);
        out.push({ p: [p[0] + dx * l * t + nx * s, p[1] + dy * l * t + ny * s], kind: 'kink' });
      }
    }
    return out;
  }

  // corner radius from how much the road turns there, with variety
  function radii(r, vs, st) {
    const n = vs.length;
    return vs.map((v, k) => {
      const a = vs[(k - 1 + n) % n].p, b = v.p, c = vs[(k + 1) % n].p;
      const h1 = Math.atan2(b[1] - a[1], b[0] - a[0]), h2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
      const deg = Math.abs(U.wrapAngle(h2 - h1)) * 180 / Math.PI;
      let rad;
      if (v.kind === 'chicane') rad = 14 + r() * 8;
      else if (v.kind === 'esses') rad = 70 + r() * 90;
      else if (v.kind === 'kink') rad = 180 + r() * 220;
      else if (v.kind === 'loop') rad = 22 + r() * 22;
      else if (deg > 115) rad = 12 + r() * 14;                       // hairpin
      else if (deg > 70) rad = r() < 0.35 ? 15 + r() * 15 : 30 + r() * 55; // slow or medium
      else if (deg > 35) rad = r() < 0.3 ? 25 + r() * 25 : 55 + r() * 110;
      else rad = 120 + r() * 260;                                   // fast sweeper
      if (st.street && deg > 35) rad = Math.min(rad, 30 + r() * 30); // street corners are tight, kinks stay gentle
      return [Math.round(b[0]), Math.round(b[1]), Math.round(rad)];
    });
  }

  function pointInPoly(x, y, v) {
    let inside = false;
    for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
      const a = v[i], b = v[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }

  function candidate(r, seed, id) {
    const styleRoll = r();
    const style = styleRoll < 0.5 ? 'park' : styleRoll < 0.75 ? 'street' : 'modern';
    const st = Object.assign({ street: style === 'street' }, STYLES[style]);
    const vs = layout(r, st);
    let v = radii(r, vs, st);
    // the longest straight becomes the start/finish straight (the last segment)
    let best = 0, bl = 0;
    for (let k = 0; k < v.length; k++) {
      const a = v[k], b = v[(k + 1) % v.length];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l > bl) { bl = l; best = k; }
    }
    v = v.slice(best + 1).concat(v.slice(0, best + 1));
    // pits on the outside of the loop
    const a = v[v.length - 1], b = v[0], sAt = 0.55;
    const mx = U.lerp(a[0], b[0], sAt), my = U.lerp(a[1], b[1], sAt);
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]), tx = (b[0] - a[0]) / l, ty = (b[1] - a[1]) / l;
    const side = pointInPoly(mx - ty * 40, my + tx * 40, v) ? -1 : 1; // n = (-ty, tx) is the driver's right
    const look = st.looks[Math.floor(r() * st.looks.length)];
    const width = Math.round(U.lerp(st.width[0], st.width[1], r()));
    const terrain = style === 'street' ? { amp: 2 + r() * 2, wl: 800 + r() * 300, climb: 0.02 + r() * 0.015, base: 3.5, bank: 0.012 }
      : style === 'modern' ? { amp: 0.8 + r() * 1.4, wl: 1300 + r() * 400, bank: 0.025 }
        : { amp: look === 'hakone' ? 7 + r() * 6 : 2.5 + r() * 4, wl: 900 + r() * 450, bank: 0.025 + r() * 0.017 };
    const name = word(r) + ' ' + SUFFIX[style][Math.floor(r() * SUFFIX[style].length)];
    const regions = REGION[look];
    const country = regions[Math.floor(r() * regions.length)];
    return {
      id, seed: seed % 100000 + 101, gen: seed, name, country, flag: name.slice(0, 2).toUpperCase(), blurb: '',
      width, style, look, terrain, startAt: sAt,
      pit: style === 'street' ? { side, entry: -300, exit: 200, offset: 16, lane: 10 } : { side, entry: -400, exit: 240, offset: 22, lane: 12 },
      v,
      clear: st.clear,
    };
  }

  // ---------- checks ----------
  function check(def) {
    const T = F1.Tracks;
    let tr;
    try { tr = T.build(def); } catch (e) { return { ok: false, why: 'build' }; }
    const N = tr.N, ds = tr.ds, st = STYLES[def.style];
    if (tr.L < st.len[0] * 0.9 || tr.L > st.len[1] * 1.1) return { ok: false, why: 'length' };
    let kmax = 0;
    for (let i = 0; i < N; i++) kmax = Math.max(kmax, Math.abs(tr.kap[i]));
    if (kmax > 1 / 10) return { ok: false, why: 'too tight' };
    // no part of the circuit near another (run-off, barriers and grandstands need room)
    const clear = def.clear, gap = Math.round(300 / ds);
    for (let i = 0; i < N; i += 3) {
      let bad = false;
      tr.hash.near(tr.x[i], tr.y[i], clear, j => {
        if (bad) return;
        let sep = Math.abs(i - j); sep = Math.min(sep, N - sep);
        if (sep < gap) return;
        if ((tr.x[j] - tr.x[i]) ** 2 + (tr.y[j] - tr.y[i]) ** 2 < clear * clear) bad = true;
      });
      if (bad) return { ok: false, why: 'crossing' };
    }
    // the pit lane must stay clear of the rest of the track too
    const p = tr.pit;
    for (let i = 0; i < N; i += 2) {
      if (isNaN(p.off[i])) continue;
      const x = tr.x[i] + tr.nx[i] * p.off[i], y = tr.y[i] + tr.ny[i] * p.off[i];
      let bad = false;
      tr.hash.near(x, y, 30, j => {
        let sep = Math.abs(i - j); sep = Math.min(sep, N - sep);
        if (sep * ds > 250 && (tr.x[j] - x) ** 2 + (tr.y[j] - y) ** 2 < 900) bad = true;
      });
      if (bad) return { ok: false, why: 'pit lane' };
    }
    // the grid and the start line sit on a real straight
    for (let s = tr.L - 210; s < tr.L + 60; s += ds) {
      const i = Math.floor(((s % tr.L) + tr.L) % tr.L / ds) % N;
      if (Math.abs(tr.kap[i]) > 1 / 900) return { ok: false, why: 'grid' };
    }
    if (tr.drs.length < 1) return { ok: false, why: 'no straight' };
    const nc = tr.apexes.length;
    if (nc < 8 || nc > 22) return { ok: false, why: 'corners ' + nc };
    // a mix: at least one slow corner and one quick one
    let slow = 0, fast = 0;
    const fastR = def.style === 'street' ? 45 : 90; // street corners are all tighter
    for (const a of tr.apexes) { const R = 1 / Math.abs(a.k); if (R < 35) slow++; else if (R > fastR) fast++; }
    if (!slow || !fast) return { ok: false, why: 'variety' };
    return { ok: true, tr };
  }

  function blurb(def, tr) {
    let longest = 0;
    {
      let run = 0;
      for (let k = 0; k < tr.N * 2; k++) {
        const i = k % tr.N;
        if (Math.abs(tr.kap[i]) < 1 / 700) { run += tr.ds; longest = Math.max(longest, run); } else run = 0;
      }
      longest = Math.min(longest, tr.L);
    }
    let tight = 0;
    for (const a of tr.apexes) if (1 / Math.abs(a.k) < 25) tight++;
    const kind = { park: 'Parkland circuit', street: 'Street circuit', modern: 'Modern circuit' }[def.style];
    const hills = def.terrain && (def.terrain.amp > 7 || def.terrain.climb) ? ', with real elevation change' : '';
    const st = longest > 1000 ? `a ${(longest / 1000).toFixed(1)} km straight` : `straights of up to ${Math.round(longest / 10) * 10} m`;
    return `${kind} built from seed ${def.gen}. ${tr.apexes.length} corners, ${st}${tight ? ` and ${tight} hairpin${tight > 1 ? 's' : ''}` : ''}${hills}.`;
  }

  const cache = new Map();
  // seed -> definition (the same seed always gives the same circuit)
  function make(seed) {
    seed = Math.max(1, Math.floor(Math.abs(seed)) % 1000000);
    if (cache.has(seed)) return cache.get(seed);
    const r = U.rng(seed * 2654435761 % 4294967296 || 1);
    for (let k = 0; k < 8; k++) r(); // warm up the generator: small seeds start weak
    const id = 'gen-' + seed;
    let def = null, tries = 0;
    for (; tries < 400 && !def; tries++) {
      const d = candidate(r, seed, id);
      const c = check(d);
      if (F1.TrackGen && F1.TrackGen.onCheck) F1.TrackGen.onCheck(d, c);
      if (c.ok) { d.blurb = blurb(d, c.tr); d.tries = tries + 1; def = d; }
    }
    if (!def) throw new Error('no valid circuit for seed ' + seed);
    cache.set(seed, def);
    return def;
  }
  const randomSeed = () => 1 + Math.floor(Math.random() * 999999);

  F1.TrackGen = { make, randomSeed, check };
})(typeof window !== 'undefined' ? window : globalThis);
