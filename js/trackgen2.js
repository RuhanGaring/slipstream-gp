// Procedural circuits, second generation: real elevation, and street circuits laid through a
// hillside city in the manner of Monaco. Under review in the track lab (lab/trackgen.html);
// the game still uses js/trackgen.js.
//
// Order of work for every candidate:
//   1. The site: a natural height field rolled from the seed. Real circuits sit on mostly even
//      ground with one or two big landforms (Spa's valley, the hill at COTA's first corner, the
//      Red Bull Ring's slope), not on uniform noise, so a site is a gentle tilt and a little
//      undulation plus one or two landforms (a hill, a hollow, an escarpment, a valley) placed
//      where the lap crosses them. City sites are a harbour town on a hill rising from the sea.
//      The sizes are fitted to the measured elevation of 40 real F1 circuits (see REAL below).
//   2. The layout. Open circuits reuse the first generator's outlines. A city circuit is the
//      outline of a random set of city blocks on a warped street grid (a polyomino): the outline
//      of a connected set of cells with no holes and no corner-only contacts is a single simple
//      loop, so the lap can never cross itself by construction. Narrow terrace strips between
//      streets give hairpins; chicanes go on the long straights; a covered stretch becomes a
//      tunnel.
//   3. The road is graded like a real one: the height field sampled along the lap, smoothed,
//      then held to a gradient limit that is lower through corners, on the grid and in the pit
//      lane (an exact Lipschitz projection around the loop, so the limit always holds and the
//      lap always closes), and smoothed until no crest unloads the car and no dip bottoms it.
//   4. The ground is cut and filled to meet the road: banks at a fixed slope rise or fall from
//      just past the barriers to the natural ground. Where two stretches pass close at
//      different heights the banks meet; in a city that is a retaining wall, elsewhere the
//      candidate is rejected.
//   5. verify() checks the finished circuit independently of how it was made, and only a
//      circuit that passes every check is returned. One of the checks is realism: the lap's
//      climb, steepest 100 m, share of the lap steeper than 4 %, ascent per metre of climb,
//      number of separate climbs and sharpest crest, measured exactly as tools/f1elev_prep.py
//      measures the real circuits, must fall inside the envelope of the real circuits its style
//      is matched to.
(function simModule(G) {
  'use strict';
  (G.F1simMods = G.F1simMods || []).push(simModule);
  const F1 = G.F1;
  const U = F1.U;

  // per style: width, lap length, gradient limits (straight / corner / hairpin / grid and pit),
  // minimum radius, clearance between unrelated parts of the lap, total climb range, bank slope
  const STYLES = {
    city: { width: [10, 11], len: [3000, 4300], gMax: 0.14, gCorner: 0.09, gHair: 0.055, gGrid: 0.03, minR: 9, sep: 19, range: [16, 80], slope: 6, corners: [11, 24], looks: ['lucerne'] },
    park: { width: [14, 15], len: [4300, 5800], gMax: 0.11, gCorner: 0.08, gHair: 0.05, gGrid: 0.02, minR: 10, sep: 58, range: [8, 60], slope: 0.55, corners: [8, 22], looks: ['kestrel', 'varenna', 'hakone'] },
    mountain: { width: [13, 14], len: [4300, 6200], gMax: 0.17, gCorner: 0.12, gHair: 0.06, gGrid: 0.025, minR: 10, sep: 58, range: [35, 170], slope: 1.3, walls: 0.02, corners: [8, 22], looks: ['sierra', 'hakone'] },
    modern: { width: [15, 15], len: [4400, 5900], gMax: 0.11, gCorner: 0.08, gHair: 0.05, gGrid: 0.015, minR: 10, sep: 62, range: [3, 35], slope: 0.45, corners: [8, 22], looks: ['rimal', 'lonestar'] },
  };
  const STYLE_LIST = ['city', 'park', 'mountain', 'modern'];
  // <real> (written by tools/f1elev_fit.py from tools/data/f1_elevation.json; do not edit by hand)
  const REAL = {"city": {"from": ["Circuit de Monaco", "Baku City Circuit", "Circuito de Madring"], "range": [26.95, 47.04], "g100": [4.05, 14.69], "share4": [7.86, 62.45], "ratio": [1.48, 2.69], "climbs": [2, 5], "crestR": 444}, "park": {"from": ["Circuit de Barcelona-Catalunya", "Silverstone Circuit", "Hockenheimring", "Hungaroring", "Autodromo Nazionale Monza", "Autodromo Enzo e Dino Ferrari", "Aut\u00f3dromo Internacional do Algarve", "Circuit Zandvoort", "Circuit de Nevers Magny-Cours", "Aut\u00f3dromo do Estoril", "Aut\u00f3dromo Internacional Nelson Piquet", "Indianapolis Motor Speedway"], "range": [2.89, 42.9], "g100": [0.5, 11.88], "share4": [0.0, 33.82], "ratio": [1.17, 3.79], "climbs": [1, 7], "crestR": 972}, "mountain": {"from": ["Red Bull Ring", "Circuit de Spa-Francorchamps", "Suzuka International Racing Course", "Aut\u00f3dromo Jos\u00e9 Carlos Pace - Interlagos", "N\u00fcrburgring", "Autodromo Internazionale del Mugello", "Kyalami Grand Prix Circuit", "Watkins Glen International"], "range": [36.38, 117.49], "g100": [4.25, 20.3], "share4": [11.34, 62.57], "ratio": [1.03, 2.7], "climbs": [1, 7], "crestR": 529}, "modern": {"from": ["Bahrain International Circuit", "Shanghai International Circuit", "Circuit Paul Ricard", "Circuit of the Americas", "Yas Marina Circuit", "Sepang International Circuit", "Intercity Istanbul Park", "Losail International Circuit"], "range": [4.17, 45.47], "g100": [1.75, 11.56], "share4": [0.0, 49.8], "ratio": [1.33, 6.13], "climbs": [1, 7], "crestR": 798}};
  // </real>
  const GRAV = 9.81;

  // ---------- noise ----------
  function hash2(ix, iy, s) {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(s, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function vnoise2(x, y, s) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s), c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s);
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy - 0.5;
  }
  function fbm(x, y, s, oct) {
    let v = 0, a = 1, f = 1, n = 0;
    for (let k = 0; k < oct; k++) { v += vnoise2(x * f, y * f, s + k * 31) * a; n += a; a *= 0.5; f *= 2.03; }
    return v / n * 2; // about -1 to 1
  }
  function ridged(x, y, s, oct) {
    let v = 0, a = 1, f = 1, n = 0;
    for (let k = 0; k < oct; k++) { v += (1 - Math.abs(vnoise2(x * f, y * f, s + k * 17) * 2)) * a; n += a; a *= 0.5; f *= 2.1; }
    return v / n; // 0 to 1
  }

  // ---------- loops of samples ----------
  function smoothLoop(a, sig) {
    const n = a.length;
    if (sig < 0.5) return Float64Array.from(a);
    const R = Math.ceil(sig * 3), w = [];
    let ws = 0;
    for (let k = -R; k <= R; k++) { const v = Math.exp(-0.5 * (k / sig) ** 2); w.push(v); ws += v; }
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let k = -R; k <= R; k++) s += a[((i + k) % n + n) % n] * w[k + R]; out[i] = s / ws; }
    return out;
  }
  function minFilter(a, r) {
    const n = a.length, out = new Float64Array(n);
    for (let i = 0; i < n; i++) { let m = Infinity; for (let k = -r; k <= r; k++) m = Math.min(m, a[((i + k) % n + n) % n]); out[i] = m; }
    return out;
  }
  function maxFilter(a, r) {
    const n = a.length, out = new Float64Array(n);
    for (let i = 0; i < n; i++) { let m = -Infinity; for (let k = -r; k <= r; k++) m = Math.max(m, a[((i + k) % n + n) % n]); out[i] = m; }
    return out;
  }
  // The nearest profile to z that climbs no faster than g[i] per metre anywhere around the loop:
  // the mean of the tightest upper and lower envelopes (each is g-Lipschitz along the loop, so
  // their mean is too). Two sweeps each way round the loop make the envelopes exact.
  function gradeLimit(z, g, ds) {
    const n = z.length, up = Float64Array.from(z), lo = Float64Array.from(z);
    const w = i => (g[i] + g[(i + 1) % n]) * 0.5 * ds; // allowed climb from i to i+1
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 1; k <= n; k++) {
        const i = k % n, h = (k - 1) % n;
        up[i] = Math.min(up[i], up[h] + w(h)); lo[i] = Math.max(lo[i], lo[h] - w(h));
      }
      for (let k = n - 1; k >= 0; k--) {
        const i = k, j = (k + 1) % n;
        up[i] = Math.min(up[i], up[j] + w(i)); lo[i] = Math.max(lo[i], lo[j] - w(i));
      }
    }
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = (up[i] + lo[i]) / 2;
    return out;
  }

  // ---------- sites ----------
  // natural ground height (m) for a style; city sites also return the coastline
  function site(r, style, box) {
    const s = 1 + Math.floor(r() * 1e6);
    if (style === 'city') {
      // a harbour town: the sea along y < coast(x), the hill rising inland, with terraces of noise
      const Hs = 30 + r() * 32, lam = 220 + r() * 200, ca = 10 + r() * 22, cl = 600 + r() * 700, cp = r() * 6.283, und = 12 + r() * 10, uwl = 220 + r() * 120;
      const coast = x => -38 + Math.sin(x / cl + cp) * ca;
      return {
        coast, sea: 0,
        H: (x, y) => {
          const u = y - coast(x);
          if (u < 0) return Math.max(-8, u * 0.4) - 0.5; // the sea floor shelves away
          return 1.6 + Hs * (1 - Math.exp(-u / lam)) + fbm(x / uwl, y / uwl, s, 3) * und * U.smooth(u / 80);
        },
      };
    }
    const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2, wx = box[2] - box[0], wy = box[3] - box[1];
    const L = (a, b) => a + (b - a) * r();
    // somewhere the lap will cross: inside the middle 70 % of the layout's box
    const spot = () => [cx + (r() - 0.5) * 0.7 * wx, cy + (r() - 0.5) * 0.7 * wy];
    const forms = [];
    // landforms: a round hill (or hollow), an escarpment (a long sustained climb from one level to
    // another) and a valley (a trough the road dips into and climbs out of)
    const hill = (h, R) => { const [px, py] = spot(); forms.push((x, y) => h * Math.exp(-((x - px) ** 2 + (y - py) ** 2) / (R * R))); };
    const scarp = (h, W) => {
      const [px, py] = spot(), a = r() * 6.283, c = Math.cos(a), sn = Math.sin(a);
      forms.push((x, y) => h * (0.5 + 0.5 * Math.tanh(((x - px) * c + (y - py) * sn) / W)));
    };
    const valley = (d, W) => {
      const [px, py] = spot(), a = r() * 6.283, c = Math.cos(a), sn = Math.sin(a);
      forms.push((x, y) => -d * Math.exp(-((((x - px) * -sn + (y - py) * c)) ** 2) / (W * W)));
    };
    let tilt, small, swl;
    if (style === 'mountain') {
      // Spa, the Red Bull Ring, Suzuka, Interlagos: a hillside with one or two big landforms
      tilt = L(0.012, 0.035); small = L(1.8, 3.8); swl = L(170, 320);
      const n = r() < 0.55 ? 2 : 1;
      for (let k = 0; k < n; k++) { const t = r(); if (t < 0.45) scarp(L(22, 62) * (r() < 0.5 ? -1 : 1), L(160, 420)); else if (t < 0.75) valley(L(18, 48), L(110, 260)); else hill(L(18, 45), L(300, 650)); }
    } else if (style === 'modern') {
      // Bahrain, Shanghai, Abu Dhabi, Qatar are near flat; COTA and Istanbul have one big hill
      tilt = L(0, 0.006); small = L(1.0, 2.6); swl = L(150, 300);
      if (r() < 0.45) { if (r() < 0.5) hill(L(10, 30), L(220, 520)); else scarp(L(10, 30) * (r() < 0.5 ? -1 : 1), L(140, 360)); }
    } else {
      // Silverstone, Monza, Barcelona, Imola, the Hungaroring: gentle ground, one or two landforms
      tilt = L(0, 0.012); small = L(1.0, 2.8); swl = L(150, 320);
      const n = r() < 0.4 ? 2 : 1;
      for (let k = 0; k < n; k++) { const t = r(); if (t < 0.4) hill(L(4, 24) * (r() < 0.75 ? 1 : -1), L(380, 1100)); else if (t < 0.75) scarp(L(4, 26) * (r() < 0.5 ? -1 : 1), L(180, 520)); else valley(L(4, 18), L(150, 380)); }
    }
    const a = r() * 6.283, tc = Math.cos(a) * tilt, ts = Math.sin(a) * tilt;
    // (fbm's typical value is about 0.4 of its nominal amplitude: `small` is the typical size of the
    // undulation, as the real profiles' small-scale spread measures it)
    return { H: (x, y) => { let h = (x - cx) * tc + (y - cy) * ts + fbm(x / swl, y / swl, s, 2) * small * 2.5; for (const f of forms) h += f(x, y); return h; } };
  }

  // ---------- open circuits ----------
  function openLayout(r, style, st) {
    const TG = F1.TrackGen;
    const vs = TG._layout(r, { len: st.len, clear: st.sep, street: false });
    let v = TG._radii(r, vs, { street: false });
    let best = 0, bl = 0;
    for (let k = 0; k < v.length; k++) {
      const a = v[k], b = v[(k + 1) % v.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l > bl) { bl = l; best = k; }
    }
    v = v.slice(best + 1).concat(v.slice(0, best + 1));
    return { v, pitSides: [1, -1], features: [] };
  }

  // ---------- city circuits ----------
  // A warped street grid: column lines across the hill, row lines along it (row 0 is the
  // harbour front). Some row gaps are narrow terrace strips (no buildings, a steep bank).
  function cityGrid(r, coast) {
    const nc = 10 + Math.floor(r() * 4), nr = 6 + Math.floor(r() * 3);
    const X = [0];
    for (let i = 1; i <= nc; i++) X.push(X[i - 1] + 95 + r() * 85);
    const Y = [0], narrow = [false];
    for (let j = 1; j <= nr; j++) {
      const nar = j >= 2 && !narrow[j - 1] && r() < 0.32;
      narrow.push(nar);
      Y.push(Y[j - 1] + (nar ? 27 + r() * 7 : 72 + r() * 60));
    }
    const x0 = -X[nc] / 2, bend = 14 + r() * 26, bl = 500 + r() * 500, bp = r() * 6.283, shear = (r() - 0.5) * 0.25;
    const P = [];
    for (let i = 0; i <= nc; i++) {
      P.push([]);
      for (let j = 0; j <= nr; j++) {
        const xb = x0 + X[i] + (j ? (r() - 0.5) * 14 : (r() - 0.5) * 4) + shear * Y[j];
        // the front follows the coast; streets above follow the hill's contours, bent a little
        const y = coast(xb) + 34 + (j ? Y[j] + Math.sin(xb / bl + bp + j * 0.4) * bend * Math.min(1, j / 2) + (r() - 0.5) * 8 : 0);
        P[i].push([xb, y]);
      }
    }
    return { nc, nr, P, narrow };
  }
  // cell (i, j) spans columns i..i+1 and rows j..j+1; its corners in loop order
  const cellKey = (i, j) => i + ',' + j;
  // the outline of a set of cells as one loop of grid vertices, or null when it is not one
  // simple loop (a hole, or two cells touching only at a corner)
  function outline(set, g) {
    const edges = new Map(); // directed boundary edges, keyed by start vertex
    const vk = (i, j) => i + ':' + j;
    const add = (a, b) => { const k = vk(a[0], a[1]); if (edges.has(k)) return false; edges.set(k, b); return true; };
    for (const key of set) {
      const [i, j] = key.split(',').map(Number);
      // counter-clockwise in grid index space: (i,j) -> (i+1,j) -> (i+1,j+1) -> (i,j+1)
      const sides = [[[i, j], [i + 1, j], cellKey(i, j - 1)], [[i + 1, j], [i + 1, j + 1], cellKey(i + 1, j)], [[i + 1, j + 1], [i, j + 1], cellKey(i, j + 1)], [[i, j + 1], [i, j], cellKey(i - 1, j)]];
      for (const [a, b, nb] of sides) if (!set.has(nb)) { if (!add(a, b)) return null; }
    }
    // walk the loop; every boundary vertex must have exactly one outgoing edge, all on one loop
    const start = edges.keys().next().value;
    const loop = [];
    let k = start;
    for (let n = 0; n <= edges.size; n++) {
      const [i, j] = k.split(':').map(Number);
      loop.push([i, j]);
      const b = edges.get(k);
      if (!b) return null;
      k = vk(b[0], b[1]);
      if (k === start) break;
    }
    if (loop.length !== edges.size) return null;
    // a vertex visited twice is a pinch (cells meeting at a corner)
    if (new Set(loop.map(p => p[0] + ':' + p[1])).size !== loop.length) return null;
    return loop;
  }
  function loopLen(loop, g) {
    let L = 0;
    for (let k = 0; k < loop.length; k++) { const a = g.P[loop[k][0]][loop[k][1]], b = g.P[loop[(k + 1) % loop.length][0]][loop[(k + 1) % loop.length][1]]; L += Math.hypot(b[0] - a[0], b[1] - a[1]); }
    return L;
  }
  function cityLayout(r, st, coast) {
    const g = cityGrid(r, coast);
    const target = U.lerp(st.len[0] + 150, st.len[1] - 250, r());
    // start on the harbour front: a run of front cells for the long straight
    const set = new Set();
    const i0 = 1 + Math.floor(r() * (g.nc - 5)), run = 3 + Math.floor(r() * 3);
    for (let i = i0; i < Math.min(g.nc - 1, i0 + run); i++) set.add(cellKey(i, 0));
    let loop = outline(set, g);
    for (let step = 0; step < 400 && loop && loopLen(loop, g) < target; step++) {
      // grow by a neighbouring cell, weighted toward the hill (climbs) and away from the edges
      const cand = [];
      for (const key of set) {
        const [i, j] = key.split(',').map(Number);
        for (const [a, b] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
          if (a < 0 || b < 0 || a >= g.nc || b >= g.nr || set.has(cellKey(a, b))) continue;
          let w = 1 + (b > j ? 1.4 : 0) + (b === 0 ? 0.6 : 0);
          if (g.narrow[b + 1] || g.narrow[b]) w *= 0.8;
          if (a === 0 || a === g.nc - 1) w *= 0.4;
          cand.push([cellKey(a, b), w]);
        }
      }
      if (!cand.length) break;
      let tot = cand.reduce((s, c) => s + c[1], 0), pick = r() * tot, chosen = cand[0][0];
      for (const [k, w] of cand) { pick -= w; if (pick <= 0) { chosen = k; break; } }
      set.add(chosen);
      const lp = outline(set, g);
      if (!lp || loopLen(lp, g) > st.len[1] - 100) { set.delete(chosen); continue; }
      loop = lp;
    }
    if (!loop) return null;
    const pts = loop.map(([i, j]) => g.P[i][j].slice());
    // drop vertices the road runs straight through
    let v = [];
    for (let k = 0; k < pts.length; k++) {
      const a = pts[(k - 1 + pts.length) % pts.length], b = pts[k], c = pts[(k + 1) % pts.length];
      const d = Math.abs(U.wrapAngle(Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0])));
      if (d > 0.07) v.push({ p: b, deg: d * 180 / Math.PI });
    }
    if (v.length < 8) return null;
    // radii: street corners tight, bends gentler, kinks wide
    v = v.map(({ p, deg }) => {
      const rad = deg > 70 ? 11 + r() * 10 : deg > 35 ? 22 + r() * 30 : deg > 15 ? 70 + r() * 90 : 220 + r() * 250;
      return [p[0], p[1], rad];
    });
    // chicanes on long straights (the harbour front gets one, as at Monaco's swimming pool)
    const segs = v.map((p, k) => { const q = v[(k + 1) % v.length]; return [k, Math.hypot(q[0] - p[0], q[1] - p[1])]; }).sort((a, b) => b[1] - a[1]);
    const longest = segs[0][0], add = [];
    for (const [k, l] of segs.slice(1, 4)) {
      if (l < 300 || r() < 0.35) continue;
      const p = v[k], q = v[(k + 1) % v.length], dx = (q[0] - p[0]) / l, dy = (q[1] - p[1]) / l;
      const at = 0.4 + r() * 0.2, jog = (r() < 0.5 ? -1 : 1) * (7 + r() * 5), len = 32 + r() * 14;
      const m = [p[0] + dx * l * at, p[1] + dy * l * at];
      add.push([k, [[m[0], m[1], 15 + r() * 6], [m[0] + dx * len - dy * jog, m[1] + dy * len + dx * jog, 15 + r() * 6]]]);
    }
    add.sort((a, b) => b[0] - a[0]).forEach(([k, ms]) => v.splice(k + 1, 0, ...ms));
    // the longest straight becomes the start straight (the last segment)
    let best = 0, bl = 0;
    for (let k = 0; k < v.length; k++) {
      const a = v[k], b = v[(k + 1) % v.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l > bl) { bl = l; best = k; }
    }
    v = v.slice(best + 1).concat(v.slice(0, best + 1));
    v = v.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, Math.round(p[2])]);
    void longest;
    const pre = cornerPrecheck(v, st);
    if (pre) return { fail: pre };
    return { v, grid: g, cells: set, pitSides: [1, -1] };
  }

  // The fillet's radius shrink (as Tracks.build does it) and the hairpin test, worked out on the
  // corner list alone: a layout that would fail either is dropped before the circuit is built
  function cornerPrecheck(v, st) {
    const n = v.length, dirs = [], th = [], rad = v.map(p => p[2]);
    for (let i = 0; i < n; i++) { const a = v[i], b = v[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]); dirs.push([(b[0] - a[0]) / l, (b[1] - a[1]) / l, l]); }
    for (let i = 0; i < n; i++) { const di = dirs[(i - 1 + n) % n], dout = dirs[i]; th.push(Math.atan2(di[0] * dout[1] - di[1] * dout[0], di[0] * dout[0] + di[1] * dout[1])); }
    for (let it = 0; it < 20; it++) for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, ta = rad[i] * Math.tan(Math.abs(th[i]) / 2), tb = rad[j] * Math.tan(Math.abs(th[j]) / 2), l = dirs[i][2];
      if (ta + tb > l * 0.98) { const k = l * 0.98 / (ta + tb); rad[i] *= k; rad[j] *= k; }
    }
    for (let i = 0; i < n; i++) if (Math.abs(th[i]) > 0.05 && rad[i] < st.minR + 0.3) return 'radius';
    // a hairpin: one turn of 150 degrees, or two same-way turns adding to it within 45 m
    for (let i = 0; i < n; i++) {
      if (Math.abs(th[i]) > 2.62) return null;
      const j = (i + 1) % n;
      if (Math.sign(th[i]) === Math.sign(th[j]) && Math.abs(th[i] + th[j]) > 2.62 && dirs[i][2] < 45) return null;
    }
    return 'no hairpin';
  }

  // ---------- buildings (city) ----------
  // Each block that is not a terrace strip gets one to four buildings, set back from its streets;
  // any that would come within reach of the circuit are shrunk or dropped.
  function shrinkQuad(q, d) {
    // move each edge inward by d (quads are convex)
    const n = q.length, cx = q.reduce((s, p) => s + p[0], 0) / n, cy = q.reduce((s, p) => s + p[1], 0) / n;
    return q.map(p => { const dx = cx - p[0], dy = cy - p[1], l = Math.hypot(dx, dy) || 1; return [p[0] + dx / l * d * 1.41, p[1] + dy / l * d * 1.41]; });
  }
  function quadArea(q) { let a = 0; for (let k = 0; k < q.length; k++) { const p = q[k], o = q[(k + 1) % q.length]; a += p[0] * o[1] - o[0] * p[1]; } return Math.abs(a) / 2; }
  function distToTrack(tr, x, y, R) {
    let best = R;
    tr.hash.near(x, y, R, i => { const d = Math.hypot(x - tr.x[i], y - tr.y[i]); if (d < best) best = d; });
    return best;
  }
  function polyClear(tr, poly, need) {
    // corners, edge midpoints and the centre must all be clear of the track
    const pts = poly.slice();
    for (let k = 0; k < poly.length; k++) { const a = poly[k], b = poly[(k + 1) % poly.length]; for (const t of [0.25, 0.5, 0.75]) pts.push([U.lerp(a[0], b[0], t), U.lerp(a[1], b[1], t)]); }
    pts.push([poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length]);
    return pts.every(p => distToTrack(tr, p[0], p[1], need + 1) >= need);
  }
  function cityBuildings(r, lay, tr, coast) {
    const g = lay.grid, out = [];
    for (let i = 0; i < g.nc; i++) for (let j = 0; j < g.nr; j++) {
      if (g.narrow[j + 1]) continue; // terrace strip
      const q = [g.P[i][j], g.P[i + 1][j], g.P[i + 1][j + 1], g.P[i][j + 1]];
      let lot = shrinkQuad(q, 7);
      if (quadArea(lot) < 600) continue;
      // split along the longer side into one to three buildings
      const e1 = Math.hypot(lot[1][0] - lot[0][0], lot[1][1] - lot[0][1]), e2 = Math.hypot(lot[3][0] - lot[0][0], lot[3][1] - lot[0][1]);
      const parts = Math.max(1, Math.min(3, Math.round(Math.max(e1, e2) / 55)));
      for (let k = 0; k < parts; k++) {
        const t0 = k / parts + 0.02, t1 = (k + 1) / parts - 0.02;
        const L = (a, b, t) => [U.lerp(a[0], b[0], t), U.lerp(a[1], b[1], t)];
        let poly = e1 >= e2 ? [L(lot[0], lot[1], t0), L(lot[0], lot[1], t1), L(lot[3], lot[2], t1), L(lot[3], lot[2], t0)]
          : [L(lot[0], lot[3], t0), L(lot[1], lot[2], t0), L(lot[1], lot[2], t1), L(lot[0], lot[3], t1)];
        let ok = false;
        for (let s = 0; s < 4 && !ok; s++) {
          if (polyClear(tr, poly, tr.hw + 5.5) && poly.every(p => p[1] > coast(p[0]) + 6)) ok = true;
          else poly = shrinkQuad(poly, 4);
          if (quadArea(poly) < 250) break;
        }
        if (!ok) continue;
        const inland = (j + 1) / g.nr;
        out.push({ poly, h: Math.round(10 + r() * 18 + inland * r() * 30), tone: r() });
      }
    }
    return out;
  }

  // ---------- grading ----------
  // a speed for every sample: cornering on grip, then accelerating and braking between corners
  function speedProfile(tr) {
    const N = tr.N, ds = tr.ds, v = new Float64Array(N);
    for (let i = 0; i < N; i++) v[i] = Math.min(92, Math.sqrt(32 / Math.max(1e-5, Math.abs(tr.kap[i]))));
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 1; k <= N; k++) { const i = k % N, h = k - 1; v[i] = Math.min(v[i], Math.sqrt(v[h] * v[h] + 2 * 11 * ds)); }
      for (let k = N - 1; k >= 0; k--) { const j = (k + 1) % N; v[k] = Math.min(v[k], Math.sqrt(v[j] * v[j] + 2 * 38 * ds)); }
    }
    return v;
  }
  function localGrade(tr, st) {
    const N = tr.N, ds = tr.ds, g = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const R = 1 / Math.max(1e-6, Math.abs(tr.kap[i]));
      g[i] = R < 25 ? st.gHair : R < 70 ? st.gCorner : st.gMax;
      const s = i * ds;
      if (s > tr.L - 280 || s < 90 || !isNaN(tr.pit.off[i])) g[i] = Math.min(g[i], st.gGrid);
    }
    // the limit changes gradually: the tightest value within 30 m, softened over 20 m
    return smoothLoop(minFilter(g, Math.round(30 / ds)), 20 / ds / 2);
  }
  function grade(tr, raw, st) {
    const ds = tr.ds, gl = localGrade(tr, st), v = speedProfile(tr);
    let z = smoothLoop(raw, 30 / ds), sig = 10, ok = false, n = null;
    for (let tries = 0; tries < 9 && !ok; tries++) {
      for (let it = 0; it < 3; it++) { z = gradeLimit(z, gl, ds); z = smoothLoop(z, sig / ds); }
      z = gradeLimit(z, gl.map(x => x * 0.985), ds);
      z = smoothLoop(z, 3 / ds);
      n = loads(z, v, ds);
      ok = n.min >= 0.3 && n.max <= 3.0;
      sig *= 1.6;
    }
    return { z, gl, v, n };
  }
  // vertical load factor from the profile's curvature at speed (1 = level road)
  function loads(z, v, ds) {
    const N = z.length, dd = new Float64Array(N);
    for (let i = 0; i < N; i++) dd[i] = (z[(i + 1) % N] - 2 * z[i] + z[(i - 1 + N) % N]) / (ds * ds);
    const ddz = smoothLoop(dd, 4 / ds);
    let mn = Infinity, mx = -Infinity, at = 0;
    for (let i = 0; i < N; i++) { const n = 1 + v[i] * v[i] * ddz[i] / GRAV; if (n < mn) { mn = n; at = i; } mx = Math.max(mx, n); }
    return { min: mn, max: mx, at, ddz };
  }

  // ---------- realism ----------
  // The lap's elevation statistics, measured as tools/f1elev_prep.py measures the real circuits:
  // the profile every 5 m, smoothed over 30 m, gradients over 100 m, climbs counted with 4 m of
  // hysteresis, the sharpest crest's vertical radius over 100 m
  function realStats(tr) {
    const n = Math.round(tr.L / 5), z0 = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const f = (k * tr.L / n) / tr.ds, i = Math.floor(f) % tr.N, j = (i + 1) % tr.N, t = f - Math.floor(f);
      z0[k] = tr.z[i] + (tr.z[j] - tr.z[i]) * t;
    }
    const z = smoothLoop(z0, 6), z100 = smoothLoop(z0, 10);
    let lo = Infinity, hi = -Infinity, ascent = 0, g100 = 0, steep = 0, zpp = 0;
    for (let k = 0; k < n; k++) {
      lo = Math.min(lo, z[k]); hi = Math.max(hi, z[k]);
      const d = z[(k + 1) % n] - z[k]; if (d > 0) ascent += d;
      const g = (z[(k + 10) % n] - z[(k - 10 + n) % n]) / 100;
      g100 = Math.max(g100, Math.abs(g)); if (Math.abs(g) > 0.04) steep++;
      zpp = Math.min(zpp, (z100[(k + 10) % n] - 2 * z100[k] + z100[(k - 10 + n) % n]) / 2500);
    }
    let climbs = 0, state = 'down', a = z[0], b = z[0];
    for (let k = 0; k < 2 * n; k++) {
      const v = z[k % n];
      if (state === 'down') { a = Math.min(a, v); if (v - a > 4) { state = 'up'; b = v; climbs++; } }
      else { b = Math.max(b, v); if (b - v > 4) { state = 'down'; a = v; } }
    }
    const range = hi - lo;
    return { range, ascent, ratio: ascent / Math.max(1, range), g100: g100 * 100, share4: steep / n * 100, climbs: Math.max(1, Math.round(climbs / 2)), crestR: 1 / Math.max(1e-6, -zpp) };
  }
  function realism(tr, style) {
    const R = REAL[style], m = realStats(tr), out = [];
    if (m.range < R.range[0] || m.range > R.range[1]) out.push('climb ' + m.range.toFixed(0) + ' m');
    if (m.g100 > R.g100[1] || m.g100 < R.g100[0]) out.push('steepest ' + m.g100.toFixed(1) + ' %');
    if (m.share4 < R.share4[0] || m.share4 > R.share4[1]) out.push('steep share ' + m.share4.toFixed(0) + ' %');
    if (m.ratio < R.ratio[0] || m.ratio > R.ratio[1]) out.push('ascent ratio ' + m.ratio.toFixed(2));
    if (m.climbs < R.climbs[0] || m.climbs > R.climbs[1]) out.push(m.climbs + ' climbs');
    if (m.crestR < R.crestR) out.push('crest radius ' + m.crestR.toFixed(0) + ' m');
    return { m, out };
  }

  // ---------- ground ----------
  // The natural ground cut and filled to meet the road: from just past each barrier the ground
  // may sit no higher than road + slope * e and no lower than road - slope * e (e = distance past
  // the barrier), taken over every stretch of road within reach, so the banks are continuous.
  // Where the banks of two stretches cross the higher one wins (a retaining wall) and the point
  // is reported.
  const REACH = 170;
  function groundFn(tr, H, slope) {
    const N = tr.N, edge = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      edge[i] = Math.max(tr.barr[0][i], tr.barr[1][i], isNaN(tr.pit.off[i]) ? 0 : Math.abs(tr.pit.off[i]) + tr.pit.lane / 2 + 1) + 4;
    }
    tr.edge2 = edge;
    const fn = (x, y, info) => {
      const nat = H(x, y);
      let lo = -Infinity, hi = Infinity, onRoad = null, best = Infinity;
      tr.hash.near(x, y, REACH, i => {
        const dx = x - tr.x[i], dy = y - tr.y[i], dist = Math.hypot(dx, dy);
        if (dist > REACH) return;
        const d = dx * tr.nx[i] + dy * tr.ny[i];
        const road = tr.z[i] + tr.bank[i] * U.clamp(d, -edge[i], edge[i]);
        const e = Math.max(0, dist - edge[i]);
        if (dist < best) { best = dist; onRoad = e === 0 ? road : null; }
        lo = Math.max(lo, road - e * slope); hi = Math.min(hi, road + e * slope);
      });
      if (onRoad != null) { if (info) info.road = true; return onRoad; }
      if (lo > hi) { if (info) info.wall = lo - hi; return lo; }
      return U.clamp(nat, lo, hi);
    };
    return fn;
  }

  // ---------- one candidate ----------
  function candidate(r, seed, style) {
    const st = STYLES[style];
    let lay, s0;
    if (style === 'city') {
      s0 = site(r, 'city');
      lay = cityLayout(r, st, s0.coast);
      if (!lay) return { fail: 'city layout' };
      if (lay.fail) return { fail: lay.fail };
    } else {
      lay = openLayout(r, style, st);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of lay.v) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      s0 = site(r, style, [x0, y0, x1, y1]);
    }
    const width = Math.round(U.lerp(st.width[0], st.width[1], r()));
    const look = st.looks[Math.floor(r() * st.looks.length)];
    const city = style === 'city';
    const def = {
      id: 'gen2-' + style + '-' + seed, gen2: true, seed: seed % 100000 + 101, gen: seed, style: city ? 'street' : style === 'mountain' ? 'park' : style,
      style2: style, name: F1.TrackGen._word(r) + ' ' + (city ? 'Harbour Circuit' : style === 'mountain' ? 'Mountain Circuit' : style === 'modern' ? 'Grand Prix Circuit' : 'Park'),
      width, look, startAt: city ? 0.5 : 0.55, v: lay.v,
      pit: city ? { side: 1, entry: -300, exit: 200, offset: 16, lane: 10 } : { side: 1, entry: -400, exit: 240, offset: 22, lane: 12 },
      terrain: { amp: 0, wl: 1000, bank: city ? 0.012 : 0.03 },
    };
    // build with each pit side and keep the one whose lane is clear
    let tr = null, why = 'build';
    for (const side of lay.pitSides) {
      def.pit.side = side;
      try { tr = F1.Tracks.build(def); } catch (e) { tr = null; why = 'build: ' + e.message; continue; }
      if (pitClear(tr, city ? 12 : 30)) break;
      tr = null; why = 'pit lane';
    }
    if (!tr) return { fail: why };
    {
      const g = verify({ tr, st, style, geomOnly: true });
      if (!g.ok) return { fail: g.fails[0].split(':')[0] };
    }
    // grade the road over the natural ground
    const raw = new Float64Array(tr.N);
    for (let i = 0; i < tr.N; i++) raw[i] = s0.H(tr.x[i], tr.y[i]);
    const gr = grade(tr, raw, st);
    applyProfile(tr, gr.z, s0.H, st);
    tr.H2 = groundFn(tr, s0.H, st.slope);
    const res = { def, tr, style, st, site: s0, raw, gl: gr.gl, speed: gr.v, seed };
    if (city) {
      res.city = { grid: lay.grid, cells: lay.cells, buildings: cityBuildings(r, lay, tr, s0.coast) };
      res.tunnel = tunnelRange(r, tr);
    }
    return res;
  }
  // the profile replaces the first generator's topography (kept field names, so physics and
  // renderer read it unchanged)
  function applyProfile(tr, z, H, st) {
    const N = tr.N, ds = tr.ds, dz = new Float64Array(N), dd = new Float64Array(N), bank0 = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = z[(i - 1 + N) % N], b = z[(i + 1) % N];
      dz[i] = (b - a) / (2 * ds); dd[i] = (b - 2 * z[i] + a) / (ds * ds);
      // banking toward the inside of real corners, plus the hillside's own camber (off-camber
      // corners happen), kept within 6 %
      const k = tr.kap[i], gk = U.smooth((Math.abs(k) - 1 / 450) / (1 / 130 - 1 / 450));
      const side = (H(tr.x[i] + tr.nx[i] * 8, tr.y[i] + tr.ny[i] * 8) - H(tr.x[i] - tr.nx[i] * 8, tr.y[i] - tr.ny[i] * 8)) / 16;
      bank0[i] = U.clamp(-Math.sign(k) * (tr.def.terrain.bank) * gk + U.clamp(side, -1, 1) * 0.25, -0.06, 0.06);
    }
    tr.z = z; tr.dz = dz; tr.ddz = smoothLoop(dd, 8 / ds); tr.bank = smoothLoop(bank0, 25 / ds);
  }
  function pitClear(tr, need) {
    const N = tr.N, ds = tr.ds, p = tr.pit;
    for (let i = 0; i < N; i += 2) {
      if (isNaN(p.off[i])) continue;
      const x = tr.x[i] + tr.nx[i] * p.off[i], y = tr.y[i] + tr.ny[i] * p.off[i];
      let bad = false;
      tr.hash.near(x, y, need + p.lane, j => {
        let sep = Math.abs(i - j); sep = Math.min(sep, N - sep);
        if (sep * ds > 150 && Math.hypot(tr.x[j] - x, tr.y[j] - y) < need + p.lane / 2) bad = true;
      });
      if (bad) return false;
    }
    return true;
  }
  // a covered stretch (city): 220 to 420 m of gentle road away from the start and the pits
  function tunnelRange(r, tr) {
    if (r() < 0.25) return null;
    const N = tr.N, ds = tr.ds, len = Math.round((220 + r() * 200) / ds);
    const okAt = i => Math.abs(tr.kap[i]) < 1 / 70 && isNaN(tr.pit.off[i]) && i * ds > 300 && i * ds < tr.L - 400;
    const starts = [];
    for (let i = 0; i < N - len; i += 10) { let ok = true; for (let k = 0; k < len && ok; k += 2) ok = okAt(i + k); if (ok) starts.push(i); }
    if (!starts.length) return null;
    const i0 = starts[Math.floor(r() * starts.length)];
    return { i0, i1: i0 + len };
  }

  // ---------- verification ----------
  // Independent checks of a finished circuit. Every failure names itself.
  function verify(res) {
    const { tr, st, style } = res, N = tr.N, ds = tr.ds, fails = [], info = {};
    const fail = (k, msg) => fails.push(k + (msg ? ': ' + msg : ''));
    // finite geometry and profile
    for (let i = 0; i < N; i++) if (!isFinite(tr.x[i] + tr.y[i] + tr.z[i] + tr.dz[i] + tr.bank[i])) { fail('nan', 'sample ' + i); break; }
    if (tr.L < st.len[0] * 0.92 || tr.L > st.len[1] * 1.08) fail('length', Math.round(tr.L) + ' m');
    // curvature: no corner tighter than the minimum, no kinks
    let kmax = 0, dk = 0;
    for (let i = 0; i < N; i++) { kmax = Math.max(kmax, Math.abs(tr.kap[i])); dk = Math.max(dk, Math.abs(tr.kap[(i + 1) % N] - tr.kap[i])); }
    info.minR = 1 / kmax;
    if (1 / kmax < st.minR - 0.01) fail('radius', (1 / kmax).toFixed(1) + ' m');
    if (dk > 0.035) fail('kink', dk.toFixed(3));
    // separation: no two unrelated parts of the lap within reach of each other
    let minSep = Infinity;
    const far = Math.round((style === 'city' ? 90 : 300) / ds);
    for (let i = 0; i < N; i += 2) {
      tr.hash.near(tr.x[i], tr.y[i], st.sep + 2, j => {
        let sep = Math.abs(i - j); sep = Math.min(sep, N - sep);
        if (sep < far) return;
        const d = Math.hypot(tr.x[j] - tr.x[i], tr.y[j] - tr.y[i]);
        if (d < minSep) minSep = d;
      });
    }
    info.minSep = minSep;
    if (minSep < st.sep) fail('separation', minSep.toFixed(1) + ' m');
    // grid straight and pit lane
    for (let s = tr.L - 210; s < tr.L + 60; s += ds) {
      const i = Math.floor(((s % tr.L) + tr.L) % tr.L / ds) % N;
      if (Math.abs(tr.kap[i]) > (style === 'city' ? 1 / 600 : 1 / 900)) { fail('grid', 'start straight bends'); break; }
    }
    if (!pitClear(tr, style === 'city' ? 12 : 30)) fail('pit lane');
    if (tr.drs.length < 1) fail('no straight');
    // corners and variety
    const nc = tr.apexes.length;
    const geomOnly = res.geomOnly;
    info.corners = nc;
    if (nc < st.corners[0] || nc > st.corners[1]) fail('corners', String(nc));
    let slow = 0, fast = 0;
    for (const a of tr.apexes) { const R = 1 / Math.abs(a.k); if (R < 35) slow++; else if (R > (style === 'city' ? 45 : 90)) fast++; }
    if (!slow || (!fast && style !== 'city')) fail('variety');
    if (fails.length || geomOnly) return { ok: !fails.length, fails, info };
    // gradients against the local limit (the limit itself, a little loose for rounding)
    const glx = maxFilter(res.gl, Math.round(6 / ds));
    let gmax = 0, gworst = 0, zmin = Infinity, zmax = -Infinity;
    for (let i = 0; i < N; i++) {
      const g = Math.abs(tr.z[(i + 1) % N] - tr.z[i]) / ds;
      gmax = Math.max(gmax, g); gworst = Math.max(gworst, g / glx[i]);
      zmin = Math.min(zmin, tr.z[i]); zmax = Math.max(zmax, tr.z[i]);
    }
    info.gMax = gmax; info.range = zmax - zmin;
    if (gworst > 1.03) fail('gradient', (gmax * 100).toFixed(1) + ' %');
    // like the real circuits of its kind (see REAL)
    const rl = realism(tr, style);
    info.real = rl.m;
    if (rl.out.length) fail('realism', rl.out.join(', '));
    // the lap closes on itself in height (the loop is continuous by construction; check anyway)
    if (Math.abs(tr.z[0] - tr.z[N - 1]) > glx[0] * ds * 1.05) fail('closure');
    // crests and dips at racing speed
    const ld = loads(tr.z, res.speed, ds);
    info.nMin = ld.min; info.nMax = ld.max;
    if (ld.min < 0.3) fail('crest', 'load ' + ld.min.toFixed(2) + ' g at ' + Math.round(ld.at * ds) + ' m');
    if (ld.max > 3.0) fail('dip', 'load ' + ld.max.toFixed(2) + ' g');
    // banking within limits
    let bmax = 0;
    for (let i = 0; i < N; i++) bmax = Math.max(bmax, Math.abs(tr.bank[i]));
    if (bmax > 0.065) fail('banking', (bmax * 100).toFixed(1) + ' %');
    // ground: banks meet the road everywhere around the lap; walls only in a city
    let walls = 0, probes = 0, edgeJump = 0;
    const gi = {};
    for (let i = 0; i < N; i += 5) {
      for (const sgn of [-1, 1]) {
        for (let e = 6; e <= REACH - 30; e += 12) {
          const d = sgn * (tr.edge2[i] + e), x = tr.x[i] + tr.nx[i] * d, y = tr.y[i] + tr.ny[i] * d;
          gi.wall = 0; gi.road = false;
          const h = tr.H2(x, y, gi);
          probes++;
          if (!isFinite(h)) { fail('ground', 'not finite'); break; }
          if (gi.wall > 0.6) walls++;
        }
        // where the banks give way to the natural ground there must be no step
        const d = sgn * (tr.edge2[i] + REACH - 8), x = tr.x[i] + tr.nx[i] * d, y = tr.y[i] + tr.ny[i] * d;
        const a = tr.H2(x, y), b = tr.H2(x + tr.nx[i] * sgn * 14, y + tr.ny[i] * sgn * 14);
        edgeJump = Math.max(edgeJump, Math.abs(a - b) - 14 * st.slope);
      }
    }
    info.walls = walls / probes;
    if (style !== 'city' && walls / probes > (st.walls || 0)) fail('retaining walls', walls + ' probes');
    if (edgeJump > 0.5) fail('bank reach', 'a cut deeper than the banks reach (' + edgeJump.toFixed(1) + ' m)');
    // city: above the sea, buildings clear of the road and of each other, tunnel sound
    if (style === 'city') {
      const coast = res.site.coast;
      for (let i = 0; i < N; i++) {
        if (tr.y[i] < coast(tr.x[i]) + 10) { fail('in the sea', 'sample ' + i); break; }
        if (tr.z[i] < 1.0) { fail('below sea level', tr.z[i].toFixed(1) + ' m'); break; }
      }
      const B = res.city.buildings;
      for (const b of B) if (!polyClear(tr, b.poly, tr.hw + 5)) { fail('building on the road'); break; }
      info.buildings = B.length;
      if (B.length < 20) fail('too few buildings', String(B.length));
      if (res.tunnel) {
        const t = res.tunnel;
        for (let i = t.i0; i < t.i1; i++) if (!isNaN(tr.pit.off[i % N])) { fail('tunnel', 'over the pit lane'); break; }
      }
      // at least one hairpin-like turn: 150 degrees within 60 m
      let hair = 0;
      const w = Math.round(60 / ds);
      for (let i = 0; i < N; i += 3) {
        const h0 = Math.atan2(tr.ty[i], tr.tx[i]), h1 = Math.atan2(tr.ty[(i + w) % N], tr.tx[(i + w) % N]);
        if (Math.abs(U.wrapAngle(h1 - h0)) > 150 * Math.PI / 180) { hair++; i += w; }
      }
      info.hairpins = hair;
      if (!hair) fail('no hairpin');
    }
    return { ok: !fails.length, fails, info };
  }

  // ---------- seed to circuit ----------
  // Candidate k of a seed draws from its own random stream, so candidates can be tried in any
  // order and on any number of threads (js/gen2pool.js, tools/gen2batch.js): the circuit for a
  // seed is always its lowest-numbered candidate that passes every check.
  const MAX_TRIES = 160;
  const normSeed = seed => Math.max(1, Math.floor(Math.abs(seed)) % 1000000);
  function stream(seed, k) {
    const r = U.rng(((Math.imul(seed, 2654435761) ^ Math.imul(k + 7, 0x9e3779b1)) >>> 0) || 1);
    for (let i = 0; i < 8; i++) r();
    return r;
  }
  const styleOf = (seed, style) => style || STYLE_LIST[Math.floor(stream(normSeed(seed), -1)() * STYLE_LIST.length)];
  // one candidate, built and verified: { ok, res, rep } or { ok: false, why: [reasons] }
  function attempt(seed, style, k) {
    seed = normSeed(seed); style = styleOf(seed, style);
    let res;
    try { res = candidate(stream(seed, k), seed, style); } catch (e) { res = { fail: 'exception: ' + e.message }; }
    if (res.fail) return { ok: false, why: [res.fail] };
    const rep = verify(res);
    if (!rep.ok) return { ok: false, why: rep.fails.map(f => f.split(':')[0]), res, rep };
    res.report = rep; res.cand = k;
    return { ok: true, res, rep };
  }
  // the circuit for a seed, on this thread (opt.from: first candidate to try, when the lowest
  // passing one is already known)
  function make(seed, style, opt = {}) {
    seed = normSeed(seed); style = styleOf(seed, style);
    const reasons = {}, t0 = Date.now();
    for (let k = opt.from || 0; k < (opt.maxTries || MAX_TRIES); k++) {
      const a = attempt(seed, style, k);
      if (a.ok) { a.res.tries = k + 1; a.res.reasons = opt.reasons || reasons; a.res.ms = Date.now() - t0; return a.res; }
      for (const w of a.why) reasons[w] = (reasons[w] || 0) + 1;
      if (opt.onReject && a.res) opt.onReject(a.res, a.rep);
    }
    const e = new Error('no valid circuit for seed ' + seed + ' (' + style + ')');
    e.reasons = reasons;
    throw e;
  }

  F1.TrackGen2 = { make, attempt, styleOf, MAX_TRIES, verify, STYLES, STYLE_LIST, REAL: () => REAL, realStats, gradeLimit, smoothLoop, loads };
})(typeof window !== 'undefined' ? window : globalThis);
