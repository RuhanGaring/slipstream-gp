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
    city: { width: [10, 11], len: [3000, 4000], gMax: 0.14, gCorner: 0.09, gHair: 0.055, gGrid: 0.03, minR: 9, sep: 19, range: [16, 80], slope: 6, corners: [11, 24], looks: ['lucerne'] },
    park: { width: [14, 15], len: [4300, 5800], gMax: 0.11, gCorner: 0.08, gHair: 0.05, gGrid: 0.02, minR: 10, sep: 58, range: [8, 60], slope: 0.55, corners: [8, 22], looks: ['kestrel', 'varenna', 'hakone'] },
    mountain: { width: [13, 14], len: [4300, 6200], gMax: 0.17, gCorner: 0.12, gHair: 0.06, gGrid: 0.025, minR: 10, sep: 58, range: [35, 170], slope: 1.3, walls: 0.02, corners: [8, 22], looks: ['sierra', 'hakone'] },
    modern: { width: [15, 15], len: [4400, 5900], gMax: 0.11, gCorner: 0.08, gHair: 0.05, gGrid: 0.015, minR: 10, sep: 62, range: [3, 35], slope: 0.45, corners: [8, 22], looks: ['rimal', 'lonestar'] },
  };
  const STYLE_LIST = ['city', 'park', 'mountain', 'modern'];
  // <layout> (written by tools/f1layout_prep.js from the real centrelines; do not edit by hand)
  const LAYOUT = {"city":{"from":"Circuit de Monaco","cpk":[3.62,6.27],"square":[0,0.56],"hairpins":[1,3],"sweep":[0.22,0.59],"bendy":[0.18,0.44],"grid":[0,0.88],"aspect":[1.89,5.83]}};
  // </layout>
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
  // A harbour town circuit in the manner of Monaco: not Monaco, but put together the way it is.
  // The lap is written as a sequence of sections, each with the kind of corners it has there.
  // Its lower side runs along the water: a long seafront curving with the coast (partly a tunnel),
  // a chicane, a bend onto the harbourside, two sets of esses along the quay, a tight corner
  // complex, and the start straight on the quay. At its end a tight first corner turns inland and
  // the road climbs the hillside, with a kink or two, to a long sweeping bend at the top; a plaza
  // jog, a road along the hill, and the descent: a tight corner, a switchback hairpin, and three
  // more tight corners zig-zagging down onto the seafront.
  // Every angle, radius and length is rolled from the style's ranges and the direction of the
  // lap is either way round. The turns are trimmed to make a whole turn exactly, and the climb's
  // first straight and the road along the top of the hill are solved so the lap closes.
  function harbourLayout(r) {
    const L = (a, b) => a + (b - a) * r(), sg = () => (r() < 0.5 ? -1 : 1);
    const it = [];
    // ang: degrees, positive with the lap's own turning; adj: may be trimmed for the closure
    const add = (ang, R, after, role, adj) => it.push({ ang, R, after, role, adj: !!adj });
    add(L(70, 110), L(15, 24), 0, 'climb', true);                        // first corner, inland
    for (let k = 1 + (r() < 0.6 ? 1 : 0); k > 0; k--) add(sg() * L(10, 28), L(160, 320), L(50, 130), 'climb');
    add(L(70, 120), L(80, 150), L(40, 100), 'top', true);               // the long sweep at the top
    add(L(35, 65), L(26, 40), L(30, 70), 'plaza'); add(-L(35, 65), L(26, 40), 0, 'top'); // the plaza jog, then the road along the hill
    const topRoad = it.length - 1;
    for (let k = 1 + (r() < 0.5 ? 1 : 0); k > 0; k--) add(sg() * L(12, 32), L(150, 320), L(50, 140), 'top'); // the road bends along the hill
    if (r() < 0.7) { const a = L(30, 60); add(a, L(28, 50), L(30, 70), 'top'); add(-a * L(0.8, 1.2), L(28, 50), L(40, 110), 'top'); } // a corner pair in the old town
    add(L(95, 125), L(16, 22), L(60, 120), 'descent', true);
    add(-L(170, 190), L(9.6, 11.5), L(20, 45), 'hairpin');               // the switchback
    add(L(80, 105), L(15, 22), L(40, 90), 'descent', true);
    add(L(80, 105), L(15, 24), L(40, 100), 'descent', true);
    add(L(80, 105), L(16, 26), L(50, 110), 'sea', true);                 // down onto the seafront
    for (let k = 1 + (r() < 0.6 ? 1 : 0); k > 0; k--) add(sg() * L(15, 40), L(240, 450), L(60, 150), 'sea'); // curving with the coast
    if (r() < 0.45) { add(L(30, 50), L(25, 40), L(8, 20), 'sea'); add(-L(30, 50), L(25, 40), L(60, 140), 'sea'); } // a second chicane
    add(-L(35, 60), L(22, 34), L(8, 22), 'chicane');
    add(L(35, 60), L(22, 34), L(40, 90), 'harbour');
    add(-L(30, 55), L(55, 110), L(50, 100), 'harbour');                  // onto the harbourside
    add(L(20, 38), L(35, 60), L(10, 25), 'harbour'); add(-L(20, 38), L(35, 60), L(40, 80), 'harbour');
    add(-L(25, 45), L(25, 40), L(8, 20), 'harbour'); add(L(25, 45), L(25, 40), L(30, 70), 'harbour');
    add(L(95, 130), L(15, 22), L(20, 45), 'harbour', true);             // the tight complex
    add(-L(40, 75), L(22, 40), L(320, 440), 'harbour', true);            // onto the start straight
    // a whole turn exactly: the difference is shared by the corners allowed to take it
    let sum = it.reduce((s, c) => s + c.ang, 0);
    const adj = it.filter(c => c.adj), aw = adj.reduce((s, c) => s + c.ang, 0);
    for (const c of adj) {
      const na = c.ang + (360 - sum) * c.ang / aw;
      if (na / c.ang < 0.72 || na / c.ang > 1.3) return { fail: 'turning' };
      c.ang = na;
    }
    // corners of 150 degrees or more become two half corners (a vertex cannot turn that far)
    // the road along the hill takes its solved length either side of its first bend, so it is
    // never one long straight
    it[topRoad].flex = true; it[topRoad + 1].flex = true;
    const items = [];
    for (const c of it) {
      if (Math.abs(c.ang) >= 150) { items.push(Object.assign({}, c, { ang: c.ang / 2, after: 0 })); items.push(Object.assign({}, c, { ang: c.ang / 2 })); }
      else items.push(c);
    }
    const n = items.length, sense = sg(), h0 = r() * Math.PI * 2;
    const tan = items.map(c => c.R * Math.tan(Math.abs(c.ang) * Math.PI / 360));
    const head = [];
    let hh = h0;
    for (const c of items) { hh += sense * c.ang * Math.PI / 180; head.push(hh); }
    // vertex k to k+1: tangent, straight, tangent. The first straight (the climb) and the road
    // along the top are solved so the lap closes
    // the straights along the water are scaled together by f (0.6 to 1.5): with the two solved
    // lengths that gives the closure a third freedom, so few layouts are thrown away
    const along = items.map(c => c.role === 'sea' || c.role === 'chicane' || (c.role === 'harbour' && c !== items[n - 1]));
    const D0 = items.map((c, k) => tan[k] + (along[k] ? 0 : c.after) + tan[(k + 1) % n]);
    let kx0 = 0, ky0 = 0, kx1 = 0, ky1 = 0;
    for (let k = 0; k < n; k++) {
      kx0 += D0[k] * Math.cos(head[k]); ky0 += D0[k] * Math.sin(head[k]);
      if (along[k]) { kx1 += items[k].after * Math.cos(head[k]); ky1 += items[k].after * Math.sin(head[k]); }
    }
    const a = 0, fl = items.map((c, k) => (c.flex ? k : -1)).filter(k => k >= 0), ax = Math.cos(head[a]), ay = Math.sin(head[a]);
    const bx = fl.reduce((t, k) => t + Math.cos(head[k]), 0) / fl.length, by = fl.reduce((t, k) => t + Math.sin(head[k]), 0) / fl.length;
    const det = ax * by - ay * bx;
    if (Math.abs(det) < Math.sin(35 * Math.PI / 180) * Math.hypot(bx, by)) return { fail: 'closure' };
    // la and lb are linear in f: the f range that keeps both in bounds, then the f nearest 1
    const sol = (kx, ky) => [(-kx * by + ky * bx) / det, (-ax * ky + ay * kx) / det];
    const [la0, lb0] = sol(kx0, ky0), [la1, lb1] = sol(kx1, ky1);
    let f0 = 0.6, f1 = 1.5;
    const keep = (c0, c1, lo, hi) => { // lo <= c0 + c1 f <= hi
      if (Math.abs(c1) < 1e-9) { if (c0 < lo || c0 > hi) f0 = Infinity; return; }
      const p = (lo - c0) / c1, q = (hi - c0) / c1;
      f0 = Math.max(f0, Math.min(p, q)); f1 = Math.min(f1, Math.max(p, q));
    };
    keep(la0, la1, 60, 280); keep(lb0, lb1, 60, 900);
    if (!(f0 <= f1)) return { fail: 'closure' };
    const f = U.clamp(1, f0, f1), la = la0 + la1 * f, lb = lb0 + lb1 * f;
    for (let k = 0; k < n; k++) if (along[k]) items[k].after *= f;
    const D = items.map((c, k) => tan[k] + c.after + tan[(k + 1) % n]);
    D[a] += la; items[a].after += la;
    for (const k of fl) { D[k] += lb / fl.length; items[k].after += lb / fl.length; }
    const v = [];
    let x = 0, y = 0;
    for (let k = 0; k < n; k++) { v.push([x, y, items[k].R]); x += D[k] * Math.cos(head[k]); y += D[k] * Math.sin(head[k]); }
    // the vertex polygon must not cross or crowd itself (the corners cut inside it a little)
    for (let i = 0; i < n; i++) for (let j = i + 4; j < n; j++) {
      if (j - i > n - 4) continue; // neighbours within three corners (a switchback's legs are close by design)
      const p = v[i], q = v[(i + 1) % n], s = v[j], t = v[(j + 1) % n];
      if (segDist(p, q, s, t) < 26) return { fail: 'crowded' };
    }
    // the start line: 235 m of straight behind it for the grid, at least 70 m after it
    const z = n - 1, Ls = D[z], startAt = (tan[z] + 235) / Ls;
    if (startAt > 0.85 || Ls * (1 - startAt) - tan[0] < 70) return { fail: 'start straight' };
    return {
      v: v.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, Math.round(p[2] * 10) / 10]),
      roles: items.map(c => c.role), sense, startAt, pitSides: [1, -1],
    };
  }
  function segDist(p, q, s, t) {
    const d = (a, b, c) => { const vx = c[0] - b[0], vy = c[1] - b[1], l2 = vx * vx + vy * vy || 1, u = U.clamp(((a[0] - b[0]) * vx + (a[1] - b[1]) * vy) / l2, 0, 1); return Math.hypot(a[0] - b[0] - vx * u, a[1] - b[1] - vy * u); };
    const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.sign(cross(p, q, s)) !== Math.sign(cross(p, q, t)) && Math.sign(cross(s, t, p)) !== Math.sign(cross(s, t, q))) return 0;
    return Math.min(d(p, s, t), d(q, s, t), d(s, p, q), d(t, p, q));
  }

  // The town's site, built around its lap once the lap exists. The coastline runs outside the
  // seafront, the chicane and the harbourside (a promenade along the sea, a quay along the
  // harbour), carried on past both ends. Inland the ground climbs an amphitheatre hillside and
  // then the mountains behind; seaward the bed shelves away. Two breakwaters enclose the harbour
  // and a rocky headland may stand across it.
  function harbourSite(r, tr, lay) {
    const N = tr.N, L = (a, b) => a + (b - a) * r(), s = 1 + Math.floor(r() * 1e6);
    // each corner vertex's place on the lap (its nearest sample), and each sample's section
    const at = lay.v.map(p => { let best = 0, bd = Infinity; for (let i = 0; i < N; i++) { const d = (tr.x[i] - p[0]) ** 2 + (tr.y[i] - p[1]) ** 2; if (d < bd) { bd = d; best = i; } } return best; });
    const role = new Array(N);
    for (let k = 0; k < at.length; k++) {
      const i0 = at[k], i1 = at[(k + 1) % at.length];
      for (let i = i0; i !== i1; i = (i + 1) % N) role[i] = lay.roles[k];
    }
    for (let i = 0; i < N; i++) if (!role[i]) role[i] = 'final';
    const out = -lay.sense; // the side away from the lap's inside (n is the driver's right)
    const coastal = i => role[i] === 'sea' || role[i] === 'chicane' || role[i] === 'harbour';
    // the coastal run: from the first seafront sample to the last harbourside one
    let i0 = -1;
    for (let i = 0; i < N; i++) if (coastal(i) && !coastal((i - 1 + N) % N)) { i0 = i; break; }
    if (i0 < 0) return { fail: 'coast' };
    const run = [];
    for (let q = 0, i = i0; q < N && coastal(i); q++, i = (i + 1) % N) run.push(i);
    const prom = L(22, 34), quay = L(12, 20);
    const raw = run.map(i => { const off = tr.hw + (role[i] === 'sea' ? prom : quay); return [tr.x[i] + tr.nx[i] * off * out, tr.y[i] + tr.ny[i] * off * out]; });
    // smoothed, so the bends' inside does not knot the offset line, then every 15 m
    const pts = [];
    for (let k = 0; k < raw.length; k += 7) {
      let sx = 0, sy = 0, w = 0;
      for (let d = -12; d <= 12; d++) { const q = U.clamp(k + d, 0, raw.length - 1), ww = Math.exp(-0.5 * (d / 6) ** 2); sx += raw[q][0] * ww; sy += raw[q][1] * ww; w += ww; }
      pts.push([sx / w, sy / w]);
    }
    if (pts.length < 6) return { fail: 'coast' };
    for (const p of pts) {
      for (let it = 0; it < 4; it++) {
        let bi = -1, bd = Infinity;
        tr.hash.near(p[0], p[1], 60, i => { const d = Math.hypot(p[0] - tr.x[i], p[1] - tr.y[i]); if (d < bd) { bd = d; bi = i; } });
        const need = tr.hw + quay * 0.9;
        if (bi < 0 || bd >= need) break;
        p[0] += tr.nx[bi] * out * (need - bd + 1); p[1] += tr.ny[bi] * out * (need - bd + 1);
      }
    }
    // carried on 4 km past both ends, straight along their last direction
    const ext = (p, q) => { const dx = p[0] - q[0], dy = p[1] - q[1], l = Math.hypot(dx, dy) || 1; return [p[0] + dx / l * 4000, p[1] + dy / l * 4000]; };
    const line = [ext(pts[0], pts[2])].concat(pts, [ext(pts[pts.length - 1], pts[pts.length - 3])]);
    // the seaward normal of each segment: the side the road is not on
    const segs = [];
    for (let k = 0; k < line.length - 1; k++) {
      const p = line[k], q = line[k + 1], dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1;
      segs.push({ p, dx: dx / l, dy: dy / l, l, nx: -dy / l, ny: dx / l });
    }
    // orient: the lap's coastal samples must be on the land side
    const probe = run[Math.floor(run.length / 2)];
    let acc = 0;
    for (const g of segs) { g.t0 = acc; acc += g.l; }
    // nearest point of the coastline: distance, side, and how far along the coast it is
    const signAt = (x, y) => { let best = Infinity, sgn = 1, t = 0; for (const g of segs) { const u = U.clamp((x - g.p[0]) * g.dx + (y - g.p[1]) * g.dy, 0, g.l), qx = g.p[0] + g.dx * u, qy = g.p[1] + g.dy * u, d = Math.hypot(x - qx, y - qy); if (d < best) { best = d; sgn = Math.sign((x - qx) * g.nx + (y - qy) * g.ny) || 1; t = g.t0 + u; } } return { d: best, sgn, t }; };
    const flip = signAt(tr.x[probe], tr.y[probe]).sgn; // + means the normal points inland
    // signed distance inland of the coastline (negative out at sea)
    // signed distance inland of the coastline (negative out at sea) and the distance along it,
    // read from a 10 m raster over the town (exact further out)
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let i = 0; i < N; i += 5) { bx0 = Math.min(bx0, tr.x[i]); by0 = Math.min(by0, tr.y[i]); bx1 = Math.max(bx1, tr.x[i]); by1 = Math.max(by1, tr.y[i]); }
    const C = 10, gx0 = bx0 - 1000, gy0 = by0 - 1000, gnx = Math.ceil((bx1 - bx0 + 2000) / C) + 1, gny = Math.ceil((by1 - by0 + 2000) / C) + 1;
    const RU = new Float32Array(gnx * gny), RT = new Float32Array(gnx * gny);
    for (let j = 0; j < gny; j++) for (let i = 0; i < gnx; i++) { const q = signAt(gx0 + i * C, gy0 + j * C); RU[j * gnx + i] = q.d * q.sgn * flip; RT[j * gnx + i] = q.t; }
    const look = (R, x, y) => {
      const fx = (x - gx0) / C, fy = (y - gy0) / C, i = Math.floor(fx), j = Math.floor(fy);
      if (i < 0 || j < 0 || i >= gnx - 1 || j >= gny - 1) return null;
      const a = fx - i, b = fy - j, k = j * gnx + i;
      return (R[k] * (1 - a) + R[k + 1] * a) * (1 - b) + (R[k + gnx] * (1 - a) + R[k + gnx + 1] * a) * b;
    };
    const inland = (x, y) => { const v = look(RU, x, y); if (v != null) return v; const q = signAt(x, y); return q.d * q.sgn * flip; };
    const along = (x, y) => { const v = look(RT, x, y); return v != null ? v : signAt(x, y).t; };
    // breakwaters: from the coast at each end of the harbourside, out and round toward each other
    const hs = run.filter(i => role[i] === 'harbour');
    const piers = [];
    if (hs.length > 20) {
      const rootAt = i => { const off = tr.hw + quay; return [tr.x[i] + tr.nx[i] * off * out, tr.y[i] + tr.ny[i] * off * out]; };
      const A = rootAt(hs[0]), B = rootAt(hs[hs.length - 1]);
      const seaDir = p => { const e = 6, gx = inland(p[0] + e, p[1]) - inland(p[0] - e, p[1]), gy = inland(p[0], p[1] + e) - inland(p[0], p[1] - e), l = Math.hypot(gx, gy) || 1; return [-gx / l, -gy / l]; };
      const reach = L(200, 320), mouth = L(60, 110);
      const dA = seaDir(A), dB = seaDir(B);
      const A1 = [A[0] + dA[0] * reach, A[1] + dA[1] * reach], B1 = [B[0] + dB[0] * reach * 0.8, B[1] + dB[1] * reach * 0.8];
      const mx = (A1[0] + B1[0]) / 2, my = (A1[1] + B1[1]) / 2, gx = B1[0] - A1[0], gy = B1[1] - A1[1], gl = Math.hypot(gx, gy) || 1;
      const A2 = [mx - gx / gl * mouth / 2, my - gy / gl * mouth / 2], B2 = [mx + gx / gl * mouth / 2, my + gy / gl * mouth / 2];
      piers.push([A, A1, A2], [B, B1, B2]);
    }
    const pierW = L(14, 20);
    const pierDist = (x, y) => { let best = Infinity; for (const pl of piers) for (let k = 0; k < pl.length - 1; k++) best = Math.min(best, segDist([x, y], [x, y], pl[k], pl[k + 1])); return best; };
    // a rocky headland across the harbour, now and then
    let head = null;
    if (piers.length && r() < 0.55) {
      const B = piers[1][0], dB = [piers[1][1][0] - B[0], piers[1][1][1] - B[1]], l = Math.hypot(dB[0], dB[1]) || 1;
      const along = [segs[segs.length - 1].dx, segs[segs.length - 1].dy];
      const c = [B[0] + along[0] * L(250, 420) + dB[0] / l * L(120, 220), B[1] + along[1] * L(250, 420) + dB[1] / l * L(120, 220)];
      head = { c, R: L(170, 260), h: L(45, 70) };
      for (let i = 0; i < N; i += 4) if (Math.hypot(tr.x[i] - c[0], tr.y[i] - c[1]) < head.R + 110) { head = null; break; }
    }
    // the ground: amphitheatre hillside, mountains behind, the bed shelving away at sea
    // ravines run down the hillside to the sea (the road along the hill dips through them) and a
    // spur may reach the shore (the seafront climbs over it), as on the real Riviera
    // the mountains rise right behind the town's highest street, an amphitheatre round the bay
    let topU = 0;
    for (let i = 0; i < N; i += 6) topU = Math.max(topU, inland(tr.x[i], tr.y[i]));
    const Hs = L(32, 60), lam = L(260, 420), M = L(260, 460), U0 = topU + L(90, 220), W = L(450, 750), und = L(14, 24), uwl = L(170, 280);
    const tc0 = 4000 - 150, tc1 = segs[segs.length - 1].t0 - 150;
    const rav = [];
    for (let k = 2 + Math.floor(r() * 3); k > 0; k--) rav.push({ t: L(tc0, tc1), d: L(12, 28), w: L(50, 110) });
    const spur = r() < 0.7 ? { t: L(tc0 + 150, tc1), h: L(8, 18), w: L(90, 180) } : null;
    const H = (x, y) => {
      const u = inland(x, y);
      let h = u < 0 ? Math.max(-14, u * 0.06) - 1 : 1.6 + Hs * (1 - Math.exp(-u / lam)) + M * U.smooth((u - U0) / W) + fbm(x / uwl, y / uwl, s, 3) * und * U.smooth((u - 30) / 80);
      if (u > 0) {
        const t = along(x, y);
        for (const g of rav) h -= g.d * Math.exp(-(((t - g.t) / g.w) ** 2)) * U.smooth((u - 40) / 70) * (1 - U.smooth((u - 450) / 250));
        if (spur) h += spur.h * Math.exp(-(((t - spur.t) / spur.w) ** 2)) * U.smooth(u / 20) * Math.exp(-Math.max(0, u - 40) / 260);
      }
      if (piers.length && pierDist(x, y) < pierW / 2) h = Math.max(h, 2.6);
      if (head) { const d = Math.hypot(x - head.c[0], y - head.c[1]); if (d < head.R + 40) h = Math.max(h, head.h * U.smooth((head.R + 40 - d) / 70) * (0.85 + 0.15 * fbm(x / 90, y / 90, s + 5, 2)) - 2); }
      return h;
    };
    const plaza = lay.v[lay.roles.indexOf('plaza')];
    return { H, inland, along, role, coastal, run, coastLine: pts, piers, pierW, head, out, plaza, harbour: hs, townEdge: U0 + 40 };
  }

  // ---------- buildings (city) ----------
  // Dense, like a Riviera town: on every piece of land not taken by the road, its pavements,
  // the promenade, the quays and the plaza, a building, turned along the street it faces (or
  // along the hillside's contour further from the circuit), with gaps for the side streets.
  // Most are six to fifteen storeys, a few are towers, the ones higher up the hill a little
  // taller. Any that would come within reach of the circuit is dropped.
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
  function harbourBuildings(r, tr, site) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < tr.N; i += 5) { x0 = Math.min(x0, tr.x[i]); y0 = Math.min(y0, tr.y[i]); x1 = Math.max(x1, tr.x[i]); y1 = Math.max(y1, tr.y[i]); }
    const M = 420, G = 31, out = [], placed = new Map();
    const key = (x, y) => Math.floor(x / 60) + ',' + Math.floor(y / 60);
    for (let gy = y0 - M; gy <= y1 + M; gy += G) for (let gx = x0 - M; gx <= x1 + M; gx += G) {
      const cx = gx + (r() - 0.5) * 12, cy = gy + (r() - 0.5) * 12;
      const u = site.inland(cx, cy);
      if (u < 14 || u > site.townEdge || r() < 0.08) continue; // the sea, the promenade, the mountains, the odd gap
      if (site.plaza && Math.hypot(cx - site.plaza[0], cy - site.plaza[1]) < 55) continue; // the plaza and its gardens
      if (site.head && Math.hypot(cx - site.head.c[0], cy - site.head.c[1]) < site.head.R + 30) continue;
      // along the street it faces, or the hillside's contour
      let best = -1, bd = 75;
      tr.hash.near(cx, cy, 75, i => { const d = Math.hypot(cx - tr.x[i], cy - tr.y[i]); if (d < bd) { bd = d; best = i; } });
      let ax, ay;
      if (best >= 0) { ax = tr.tx[best]; ay = tr.ty[best]; }
      else { const e = 8, gx2 = site.inland(cx + e, cy) - site.inland(cx - e, cy), gy2 = site.inland(cx, cy + e) - site.inland(cx, cy - e), l = Math.hypot(gx2, gy2) || 1; ax = -gy2 / l; ay = gx2 / l; }
      const tower = u > 120 && r() < 0.02;
      const wa = tower ? 18 + r() * 12 : 16 + r() * 24, wb = tower ? 18 + r() * 12 : 12 + r() * 14;
      const bx = -ay, by = ax;
      const poly = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([p, q]) => [cx + ax * p * wa / 2 + bx * q * wb / 2, cy + ay * p * wa / 2 + by * q * wb / 2]);
      if (poly.some(p => site.inland(p[0], p[1]) < 10)) continue;
      // none on cliffs: the ground under it may fall no more than about two storeys
      { const hs = poly.map(p => site.H(p[0], p[1])); if (Math.max(...hs) - Math.min(...hs) > 7) continue; }
      const rad = Math.hypot(wa, wb) / 2;
      let clash = false;
      for (let ox = -1; ox <= 1 && !clash; ox++) for (let oy = -1; oy <= 1 && !clash; oy++) {
        const list = placed.get((Math.floor(cx / 60) + ox) + ',' + (Math.floor(cy / 60) + oy));
        if (list) for (const b of list) if (Math.hypot(b.c[0] - cx, b.c[1] - cy) < (b.rad + rad) * 0.82) { clash = true; break; }
      }
      if (clash || !polyClear(tr, poly, tr.hw + 4.5)) continue;
      const up = U.clamp(u / 380, 0, 1);
      const h = tower ? 60 + r() * 90 : Math.round(14 + r() * 18 + r() * 26 * up);
      const b = { poly, h, tone: r(), c: [cx, cy], rad, tower };
      out.push(b);
      const k = key(cx, cy);
      if (!placed.has(k)) placed.set(k, []);
      placed.get(k).push(b);
    }
    return out;
  }
  // a covered stretch on the seafront: 200 to 380 m of it, away from its ends
  function seafrontTunnel(r, tr, site) {
    if (r() < 0.2) return null;
    const N = tr.N, ds = tr.ds, sea = [];
    for (let i = 0; i < N; i++) if (site.role[i] === 'sea' && isNaN(tr.pit.off[i])) sea.push(i);
    const len = Math.round((200 + r() * 180) / ds), spare = sea.length - len - Math.round(40 / ds) * 2;
    if (spare < 0) return null;
    const i0 = sea[Math.round(40 / ds) + Math.floor(r() * (spare + 1))];
    return { i0, i1: i0 + len };
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

  // ---------- layout realism ----------
  // The shape of a lap, measured the same way for a generated circuit and for the real ones
  // (tools/f1layout_prep.js runs this on the real centrelines): the line resampled every 5 m and
  // smoothed over 12 m (the real lines are traced every 20 to 70 m), corners as stretches tighter
  // than 120 m radius (same-way stretches less than 20 m apart are one corner), straights as
  // stretches gentler than 500 m radius.
  //   cpk       corners of more than 25 degrees per km
  //   square    share of those corners between 65 and 115 degrees (city-block turns)
  //   hairpins  corners of 140 degrees or more
  //   longest   the longest straight (m); long: straights of 250 m or more
  //   sweep     share of the lap in sweeping curves (120 to 600 m radius)
  //   bendy     share of the lap in corners (under 120 m radius)
  //   grid      share of the straight length within 10 degrees of one pair of perpendicular
  //             directions (a street grid scores high, a coast road low)
  //   aspect    the lap's length against its width (principal axes)
  function layoutStats(xs, ys) {
    const n0 = xs.length;
    let L = 0;
    const cum = [0];
    for (let i = 1; i <= n0; i++) { L += Math.hypot(xs[i % n0] - xs[i - 1], ys[i % n0] - ys[i - 1]); cum.push(L); }
    const n = Math.max(40, Math.round(L / 5)), X = new Float64Array(n), Yv = new Float64Array(n);
    for (let k = 0, j = 0; k < n; k++) {
      const s = k * L / n;
      while (cum[j + 1] < s) j++;
      const t = (s - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j]), a = j, b = (j + 1) % n0;
      X[k] = xs[a] + (xs[b] - xs[a]) * t; Yv[k] = ys[a] + (ys[b] - ys[a]) * t;
    }
    const sx = smoothLoop(X, 12 / 5), sy = smoothLoop(Yv, 12 / 5), ds = L / n;
    const hd = new Float64Array(n), k = new Float64Array(n);
    for (let i = 0; i < n; i++) hd[i] = Math.atan2(sy[(i + 1) % n] - sy[(i - 1 + n) % n], sx[(i + 1) % n] - sx[(i - 1 + n) % n]);
    for (let i = 0; i < n; i++) k[i] = U.wrapAngle(hd[(i + 1) % n] - hd[(i - 1 + n) % n]) / (2 * ds);
    // corners: runs tighter than 120 m, starting the walk on a straight so none is split
    let st = 0;
    for (let i = 0; i < n; i++) if (Math.abs(k[i]) < 1 / 500) { st = i; break; }
    const runs = [];
    let cur = null;
    for (let q = 0; q < n; q++) {
      const i = (st + q) % n, c = Math.abs(k[i]) > 1 / 120;
      if (c) {
        const sg = Math.sign(k[i]);
        if (cur && cur.sg === sg && q - cur.end <= 20 / ds) { cur.end = q; cur.ang += k[i] * ds; }
        else { if (cur) runs.push(cur); cur = { sg, start: q, end: q, ang: k[i] * ds }; }
      } else if (cur) cur.ang += k[i] * ds * (q - cur.end <= 20 / ds ? 1 : 0);
    }
    if (cur) runs.push(cur);
    const corners = runs.map(r => Math.abs(r.ang) * 180 / Math.PI).filter(a => a > 25);
    let bendy = 0, sweep = 0, longest = 0, long = 0, run = 0, stLen = 0;
    const hist = new Float64Array(18); // straight length by heading, 5-degree bins over 90 degrees
    for (let q = 0; q <= n; q++) {
      const i = (st + q) % n, a = Math.abs(k[i]);
      if (q < n) { if (a > 1 / 120) bendy++; else if (a > 1 / 600) sweep++; }
      if (a < 1 / 500 && q < n) {
        run += ds; stLen += ds;
        const h = ((hd[i] * 180 / Math.PI) % 90 + 90) % 90;
        hist[Math.floor(h / 5) % 18] += ds;
      } else { if (run >= 250) long++; longest = Math.max(longest, run); run = 0; }
    }
    let gbest = 0;
    for (let b = 0; b < 18; b++) { let g = 0; for (const o of [-2, -1, 0, 1, 2]) g += hist[(b + o + 18) % 18]; gbest = Math.max(gbest, g); }
    // principal axes of the line
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += sx[i]; my += sy[i]; }
    mx /= n; my /= n;
    let cxx = 0, cyy = 0, cxy = 0;
    for (let i = 0; i < n; i++) { const dx = sx[i] - mx, dy = sy[i] - my; cxx += dx * dx; cyy += dy * dy; cxy += dx * dy; }
    const tr0 = cxx + cyy, det = cxx * cyy - cxy * cxy, l1 = tr0 / 2 + Math.sqrt(Math.max(0, tr0 * tr0 / 4 - det)), l2 = tr0 / 2 - Math.sqrt(Math.max(0, tr0 * tr0 / 4 - det));
    return {
      L, cpk: corners.length / (L / 1000), square: corners.length ? corners.filter(a => a >= 65 && a <= 115).length / corners.length : 0,
      hairpins: corners.filter(a => a >= 140).length, longest, long, sweep: sweep / n, bendy: bendy / n,
      grid: stLen ? gbest / stLen : 0, aspect: Math.sqrt(l1 / Math.max(1e-9, l2)),
    };
  }

  // what of the lap's layout falls outside the city envelope (LAYOUT), or '' when nothing does
  function layoutMiss(tr, info) {
    const ls = layoutStats(Array.from(tr.x), Array.from(tr.y)), E = LAYOUT.city, lo = [];
    if (info) info.layout = ls;
    for (const k of ['cpk', 'square', 'hairpins', 'sweep', 'bendy', 'grid', 'aspect']) if (ls[k] < E[k][0] || ls[k] > E[k][1]) lo.push(k + ' ' + (+ls[k].toFixed(2)));
    return lo.join(', ');
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
      lay = harbourLayout(r);
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
      width, look, startAt: city ? +lay.startAt.toFixed(3) : 0.55, v: lay.v,
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
    // the town is built around its lap, once the lap is laid out like a real harbour circuit
    if (city) {
      const lo = layoutMiss(tr);
      if (lo) return { fail: 'layout' };
      s0 = harbourSite(r, tr, lay); if (s0.fail) return { fail: s0.fail };
    }
    // grade the road over the natural ground
    const raw = new Float64Array(tr.N);
    for (let i = 0; i < tr.N; i++) raw[i] = s0.H(tr.x[i], tr.y[i]);
    // a harbour town's quays and seafront stand a couple of metres above the water
    if (city) for (let i = 0; i < tr.N; i++) raw[i] = Math.max(raw[i], 2.5);
    const gr = grade(tr, raw, st);
    applyProfile(tr, gr.z, s0.H, st);
    tr.H2 = groundFn(tr, s0.H, st.slope);
    const res = { def, tr, style, st, site: s0, raw, gl: gr.gl, speed: gr.v, seed };
    if (city) {
      res.city = { buildings: harbourBuildings(r, tr, s0) };
      res.tunnel = seafrontTunnel(r, tr, s0);
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
      // the road on land: the seafront and quays at least a promenade from the water, the rest
      // well inland
      const site = res.site;
      for (let i = 0; i < N; i += 2) {
        const u = site.inland(tr.x[i], tr.y[i]);
        if (u < tr.hw + 8) { fail('in the sea', 'sample ' + i + ' only ' + u.toFixed(0) + ' m inland'); break; }
        if (tr.z[i] < 1.0) { fail('below sea level', tr.z[i].toFixed(1) + ' m'); break; }
      }
      const B = res.city.buildings;
      for (const b of B) if (!polyClear(tr, b.poly, tr.hw + 4) || b.poly.some(p => site.inland(p[0], p[1]) < 8)) { fail('building on the road'); break; }
      info.buildings = B.length;
      if (B.length < 150) fail('too few buildings', String(B.length));
      // laid out like the real harbour circuit (see LAYOUT)
      const lo = layoutMiss(tr, info);
      if (lo) fail('layout', lo);
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
  const MAX_TRIES = 800;
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

  F1.TrackGen2 = { layoutStats, make, attempt, styleOf, MAX_TRIES, verify, STYLES, STYLE_LIST, REAL: () => REAL, realStats, gradeLimit, smoothLoop, loads };
})(typeof window !== 'undefined' ? window : globalThis);
