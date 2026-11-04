// Procedural circuits, second generation: real elevation, and street circuits laid through a
// hillside city in the manner of Monaco. The Circuit generator screen builds these on the worker
// pool (js/gen2pool.js); the track lab (lab/trackgen.html) reviews them.
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
    city: { width: [9, 10], len: [2700, 5200], gMax: 0.14, gCorner: 0.09, gHair: 0.055, gGrid: 0.03, minR: 7.4, sep: 16, range: [4, 120], slope: 6, corners: [7, 32], looks: ['lucerne'] },
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
  // A harbour town laid out the way Monaco's real streets are (measured on its OpenStreetMap map
  // and terrain): a deep harbour basin with a flat valley district behind its side quay, a steep
  // amphitheatre hillside above its head and along the open coast, and a rocky headland across
  // its mouth. Its streets, as there:
  //   the quay roads round the basin and the coast road beyond it, through a tunnel where a
  //   promontory juts into the sea;
  //   a boulevard a block behind the side quay, and a grid of small blocks on the valley floor;
  //   on the hillside, terrace roads that hold to the contours (three quarters of the real
  //   town's road length runs within 30 degrees of them), stacked every 7 to 11 m of height,
  //   tied together by diagonal streets at 8 to 15 % and by switchbacks, meeting at T-junctions
  //   and sharp forks about equally;
  //   every hill road traced over the ground at its grade, the way real ones are engineered.
  // The lap uses the town's main streets: the start straight on the boulevard, a square corner at
  // the basin's head into a street that climbs the hillside diagonally at a steady grade, along
  // the top past a square, down a chain of streets with a sharp corner and a hairpin, onto the
  // coast road and through the tunnel, a chicane, the head quay and the side quay (the pool
  // section) and a U-turn round the end of the boulevard's block. Laid out with the coast along x
  // (the basin's side quay at x = 0, its head quay at y = 0, the hill inland at +y), then mirrored
  // half the time so the lap runs either way round.
  const pseg = (x, y, a, b) => { const vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy || 1, t = U.clamp(((x - a[0]) * vx + (y - a[1]) * vy) / l2, 0, 1); return Math.hypot(x - a[0] - vx * t, y - a[1] - vy * t); };
  // the steepest a street climbs over any 40 m of it
  // the site: the coastline, distance inland and the ground, on a 5 m raster
  function cityTerrain(r) {
    const L = (a, b) => a + (b - a) * r(), s = 1 + Math.floor(r() * 1e6);
    const D = L(500, 600), Wb = L(330, 470), th = L(0.25, 0.6), Wr = L(180, 520), Hr = r() < 0.6 ? L(120, 320) : 0, hTilt = L(-0.45, 0.45);   // a rocky headland across the basin's mouth, or open sea
    // the side quay leans off square to the head quay, as real basins' quays do
    const sx = Math.tan(L(8, 22) * Math.PI / 180);
    const pr = { x: Wb + L(10, 60), w: L(80, 120), d: L(40, 60) };
    const flat = L(30, 55), slope = L(0.17, 0.27), xv = -L(260, 420), vs = L(0.06, 0.1), rockH = L(48, 62);
    // ravines down the hillside to the sea, 20 to 60 m deep: the contours, and the roads on
    // them, bend deep into them and out round the spurs between
    const rav = [];
    for (let k = 0, n = 2 + Math.floor(r() * 3); k < 40 && rav.length < n; k++) { const x = L(-800, 1600); if (rav.every(q => Math.abs(q.x - x) > 320)) rav.push({ x, d: L(20, 60), w: L(50, 125), k: L(-0.3, 0.3), m: L(10, 35), l: L(120, 220) }); }
    // (and gullies between them, 6 to 18 m deep)
    for (let k = 0, n = 4 + Math.floor(r() * 5); k < 80 && rav.length < n + 4; k++) { const x = L(-900, 1700); if (rav.every(q => Math.abs(q.x - x) > 130)) rav.push({ x, d: L(6, 18), w: L(22, 45), k: L(-0.4, 0.4), m: L(8, 25), l: L(80, 160) }); }
    const soft = z => 40 * Math.log1p(Math.exp(U.clamp(z / 40, -30, 30)));
    // the open coast beyond the basin, and the promontory on it
    // (round the promontory the coast swings further inland: the coast road's long bend, through
    // the tunnel)
    const th2 = L(0.25, 0.6), bend = x => th2 * 90 * Math.log1p(Math.exp(U.clamp((x - pr.x) / 90, -30, 30)));
    // (the head quay bows out into the basin or back from it; the open coast bends every few
    // hundred metres)
    const bow = L(28, 45) * (r() < 0.5 ? 1 : -1);
    const cl = x => th * soft(x - Wb) + bend(x) + bow * Math.sin(Math.PI * U.clamp(x / Wb, 0, 1)) + (30 * Math.sin(x / 115 + s) + 7 * Math.sin(x / 70 + 2 * s)) * U.smooth((x - Wb - 100) / 200);
    const prom = x => pr.d * Math.exp(-(((x - pr.x) / (pr.w / 2)) ** 4));
    // the headland's tip is rounded, its far shore and the coast beyond wander
    const tipX = y => Wr * (0.5 + 0.5 * Math.sqrt(Math.max(0, 1 - ((y + D + Hr / 2) / (Hr / 2)) ** 2)));
    const seaRaw0 = (x, y) => {
      // (the headland's frame is turned about its root on the side quay's foot)
      const hy = -D + (y + D) * Math.cos(hTilt) - x * Math.sin(hTilt);
      if (hy < -D - Hr + 25 * Math.sin(x / 260 + s) + 15 * Math.sin(x / 97 + 2 * s)) return true;
      if (x > sx * y && y < cl(x) - prom(x)) return hy > -D || x > tipX(hy);
      return false;
    };
    // natural shores wander; the basin's quays are built straight
    const seaRaw = (x, y) => {
      // (the coast road's seawall too: the open coast keeps its line)
      const dq = Math.min(pseg(x, y, [-sx * D, -D], [0, 0]), pseg(x, y, [0, 0], [Wb, 0]), x > 0 ? Math.abs(y - cl(x)) : Infinity);
      const a = 48 * U.clamp((dq - 40) / 160, 0, 1);
      return seaRaw0(x + a * fbm(x / 230, y / 230, s + 5, 3) + a * 0.45 * fbm(x / 45, y / 45, s + 21, 2), y + a * fbm(x / 230, y / 230, s + 11, 3) + a * 0.45 * fbm(x / 45, y / 45, s + 23, 2));
    };
    const C = 5, X0 = -1100, X1 = 2000, Y0 = -1250, Y1 = 1150, nx = Math.round((X1 - X0) / C) + 1, ny = Math.round((Y1 - Y0) / C) + 1;
    const n = nx * ny, sea = new Uint8Array(n);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) sea[j * nx + i] = seaRaw(X0 + i * C, Y0 + j * C) ? 1 : 0;
    // distance to the shore both ways (two-pass chamfer), signed: + inland, - out to sea
    const dist = (inside) => {
      const d = new Float32Array(n);
      for (let k = 0; k < n; k++) d[k] = inside(k) ? 1e9 : 0;
      const a = C, b = C * Math.SQRT2;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i; if (!d[k]) continue;
        let v = d[k];
        if (i > 0) v = Math.min(v, d[k - 1] + a);
        if (j > 0) { v = Math.min(v, d[k - nx] + a); if (i > 0) v = Math.min(v, d[k - nx - 1] + b); if (i < nx - 1) v = Math.min(v, d[k - nx + 1] + b); }
        d[k] = v;
      }
      for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
        const k = j * nx + i; if (!d[k]) continue;
        let v = d[k];
        if (i < nx - 1) v = Math.min(v, d[k + 1] + a);
        if (j < ny - 1) { v = Math.min(v, d[k + nx] + a); if (i < nx - 1) v = Math.min(v, d[k + nx + 1] + b); if (i > 0) v = Math.min(v, d[k + nx - 1] + b); }
        d[k] = v;
      }
      return d;
    };
    const dl = dist(k => !sea[k]), ds = dist(k => sea[k]);
    const u = new Float32Array(n);
    for (let k = 0; k < n; k++) u[k] = sea[k] ? -ds[k] + C / 2 : dl[k] - C / 2;
    // rounded off a little, as a real shore is
    const u2 = new Float32Array(n);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let t = 0, w = 0;
      for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) { const ii = U.clamp(i + a, 0, nx - 1), jj = U.clamp(j + b, 0, ny - 1); t += u[jj * nx + ii]; w++; }
      u2[j * nx + i] = t / w;
    }
    // a far smoother distance inland for the hillside (separable box blur, about 60 m): contours
    // that follow the coast's every bend at a fixed offset crease like folded paper
    const ub = new Float32Array(u2), tmp = new Float32Array(n), R = 12;
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < ny; j++) { let acc = 0; for (let i = -R; i <= R; i++) acc += ub[j * nx + U.clamp(i, 0, nx - 1)]; for (let i = 0; i < nx; i++) { tmp[j * nx + i] = acc / (2 * R + 1); acc += ub[j * nx + U.clamp(i + R + 1, 0, nx - 1)] - ub[j * nx + U.clamp(i - R, 0, nx - 1)]; } }
      for (let i = 0; i < nx; i++) { let acc = 0; for (let j = -R; j <= R; j++) acc += tmp[U.clamp(j, 0, ny - 1) * nx + i]; for (let j = 0; j < ny; j++) { ub[j * nx + i] = acc / (2 * R + 1); acc += tmp[U.clamp(j + R + 1, 0, ny - 1) * nx + i] - tmp[U.clamp(j - R, 0, ny - 1) * nx + i]; } }
    }
    // the ground: valley floor, hillside, headland
    const h = new Float32Array(n);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, x = X0 + i * C, y = Y0 + j * C, uu = u2[k], us = Math.max(ub[k], 0) * U.smooth(uu / 60) + uu * (1 - U.smooth(uu / 60));
      if (uu < 0) { h[k] = Math.max(-14, uu * 0.08) - 1; continue; }
      // (the headland rises gently from the land behind it, in cliffs from the sea)
      const hy = -D + (y + D) * Math.cos(hTilt) - x * Math.sin(hTilt);
      const wr = Hr > 0 ? U.smooth((x + 200) / 230) * U.smooth((Wr + 20 - x) / 50) * U.smooth((-D + 10 - hy) / 40) * U.smooth((hy + D + Hr + 30) / 40) : 0;
      const wv = U.smooth((sx * y - x - 10) / 70) * U.smooth((140 - y) / 140) * U.smooth((y + D + Hr) / 60);
      const det = fbm(x / 420, y / 420, s, 2);
      const hill = 2 + 0.03 * Math.min(uu, flat) + slope * Math.max(0, us - flat) * (1 + 0.12 * det) + (170 + 90 * ridged(x / 520, y / 520, s + 9, 3)) * U.smooth((us - 900) / 800) + 6 * fbm(x / 130, y / 130, s + 13, 3) * U.smooth((us - flat) / 120);
      const valley = 2 + 0.012 * uu + vs * Math.max(0, xv - x) * (1 + 0.3 * det) + 1.5 * det;
      const rock = 2 + rockH * (0.8 + 0.2 * fbm(x / 140, y / 140, s + 3, 2)) * U.smooth((uu - 1) / 14) + 6 * fbm(x / 70, y / 70, s + 7, 2) * U.smooth(uu / 30);   // cliffs to the water, an uneven top
      let hh = wr * rock + (1 - wr) * (wv * valley + (1 - wv) * hill);
      for (const q of rav) hh -= q.d * Math.exp(-(((x - q.x - q.k * y - q.m * Math.sin(y / q.l + q.x)) / q.w) ** 2)) * U.smooth((uu - flat - 20) / 160) * (1 - wr);
      h[k] = Math.max(hh, 2 + 0.02 * uu);
    }
    const bil = (f, x, y) => {
      const fx = U.clamp((x - X0) / C, 0, nx - 1.001), fy = U.clamp((y - Y0) / C, 0, ny - 1.001), i = Math.floor(fx), j = Math.floor(fy), a = fx - i, b = fy - j, k = j * nx + i;
      return (f[k] * (1 - a) + f[k + 1] * a) * (1 - b) + (f[k + nx] * (1 - a) + f[k + nx + 1] * a) * b;
    };
    const H = (x, y) => bil(h, x, y), inland = (x, y) => bil(u2, x, y);
    const grad = (x, y) => [(H(x + 6, y) - H(x - 6, y)) / 12, (H(x, y + 6) - H(x, y - 6)) / 12];
    return { L, s, D, Wb, th, Wr, Hr, hTilt, sx, rav, pr, flat, slope, xv, rockH, cl, prom, H, inland, grad, X0, X1, Y0, Y1, C, u: u2, h, nx, ny };
  }
  const polyLen = pl => { let l = 0; for (let i = 1; i < pl.length; i++) l += Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]); return l; };
  // the polyline again with its points every step metres
  function resample(pl, step) {
    const out = [pl[0].slice()];
    let carry = 0;
    for (let i = 1; i < pl.length; i++) {
      const a = pl[i - 1], b = pl[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      let t = step - carry;
      for (; t <= l; t += step) out.push([a[0] + (b[0] - a[0]) * t / l, a[1] + (b[1] - a[1]) * t / l]);
      carry = l - (t - step);
    }
    const z = pl[pl.length - 1], q = out[out.length - 1];
    if (Math.hypot(z[0] - q[0], z[1] - q[1]) > step * 0.4) out.push(z.slice()); else out[out.length - 1] = z.slice();
    return out;
  }
  function citySite(r, town, xf) {
    const { T, S } = town, W = xf.toWorld, Lc = xf.toLocal;
    const mirror = pts => pts.map(W);
    // the breakwaters: one from the head quay's far corner out across the basin's mouth, one
    // from the headland's tip
    const L = T.L, pierW = L(18, 32);
    const pa = [T.Wb + 20, T.cl(T.Wb + 20) - 4], kind = r();
    let armA;
    if (kind < 0.3) { const pa1 = [pa[0] + L(-30, 10), pa[1] - T.D * L(0.45, 0.6)]; armA = [pa, pa1, [pa1[0] - L(60, 110), pa1[1] - L(20, 50)]]; }
    else if (kind < 0.55) armA = [pa, [pa[0] + L(-60, 40), pa[1] - T.D * L(0.5, 0.75)]];
    else { const a0 = L(-0.3, 0.2), bendA = L(0.5, 1.0), len = T.D * L(0.5, 0.8); armA = [pa]; for (let k = 1; k <= 4; k++) { const ang = -Math.PI / 2 + a0 - bendA * k / 4, q = armA[armA.length - 1]; armA.push([q[0] + Math.cos(ang) * len / 4, q[1] + Math.sin(ang) * len / 4]); } }
    let pb = T.Hr > 0 ? [T.Wr * 0.5, -T.D + (-T.Hr * 0.5 + T.Wr * 0.5 * Math.sin(T.hTilt)) / Math.cos(T.hTilt)] : [T.sx * -T.D + 6, -T.D - 4];
    { const a = L(15, 45) * Math.PI / 180; for (let k = 0; k < 200 && T.inland(pb[0], pb[1]) > 3; k++) pb = [pb[0] + Math.cos(a) * 4, pb[1] + Math.sin(a) * 4]; }
    const pbA = L(20, 50) * Math.PI / 180, pbL = L(90, 150), pb1 = [pb[0] + Math.cos(pbA) * pbL, pb[1] + Math.sin(pbA) * pbL];
    let piers = [armA];
    {
      // the second mole runs out to leave a narrow mouth at the first one's head
      const E = armA[armA.length - 1], dx = pb[0] - E[0], dy = pb[1] - E[1], dl = Math.hypot(dx, dy), mouth = L(60, 120);
      if (dl > mouth + 60 && dl < 700) piers = [armA, [pb, [E[0] + dx / dl * mouth, E[1] + dy / dl * mouth]]];
      else piers = [armA, [pb, pb1]];
    }
    // pontoons off the quays into the basin
    const pontoons = [];
    const fingers = [];
    const crossesP = (a, b) => pontoons.some(([c, d]) => segDist(a, b, c, d) < 25);
    for (let k = 0, n = 6 + Math.floor(r() * 6), t = 0; pontoons.length < n && t < 60; t++) {
      const onSide = r() < 0.5;
      let a, b;
      if (onSide) { const y = -T.D * L(0.12, 0.88), x = T.sx * y; a = [x + 1, y]; b = [x + L(60, 140), y + L(-10, 10)]; }
      else { const x = T.Wb * L(0.1, 0.9), yq = T.cl(x) - T.prom(x); a = [x, yq - 1]; b = [x + L(-10, 10), yq - L(70, 170)]; }
      if (crossesP(a, b) || T.inland(b[0], b[1]) > -8) continue;
      pontoons.push([a, b]);
      // berths either side every 12 to 16 m
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / l, uy = (b[1] - a[1]) / l, fl = L(9, 14);
      for (let t = 18; t < l - 4; t += L(12, 16)) for (const sd of [-1, 1]) { const q = [a[0] + ux * t, a[1] + uy * t]; fingers.push([q, [q[0] - uy * sd * fl, q[1] + ux * sd * fl]]); }
    }
    const pierDist = (x, y) => { let best = Infinity; for (const pl of piers) for (let k = 0; k < pl.length - 1; k++) best = Math.min(best, pseg(x, y, pl[k], pl[k + 1])); return best; };
    const H = (x, y) => { const q = Lc(x, y); let h = T.H(q[0], q[1]); if (h < 2.6 && pierDist(q[0], q[1]) < pierW / 2) h = 2.6; return h; };
    const inland = (x, y) => { const q = Lc(x, y); return T.inland(q[0], q[1]); };
    const roads = S.roads.filter(rd => !rd.dead).map(rd => ({ pts: mirror(rd.pts), w: rd.w, kind: rd.kind, lap: !!rd.lap, cls: rd.cls }));
    return {
      H, inland, roads, piers: piers.map(mirror), pierW, pontoons: pontoons.map(mirror), fingers: fingers.map(mirror), plaza: W(town.plaza), townEdge: 900,
      rail: (town.rail || []).map(q => ({ pts: mirror(q.pts), tunnel: q.tunnel })),
      park: (x, y) => { const q = Lc(x, y); return fbm(q[0] / 230, q[1] / 230, T.s + 21, 2) < -0.42 && T.inland(q[0], q[1]) > 60; },
      sea: (x, y) => inland(x, y) < 0, xf,
      squares: (town.squares || []).map(q => { const w = W(q); return [w[0], w[1], q[2]]; }),
    };
  }
  // the route as corner vertices for the track builder: the polyline simplified (within 0.8 m),
  // each vertex given the radius the street turns at there, no wider than a street corner of
  // that angle is. Corners whose arcs would overlap (their tangent lengths adding up to more than
  // the straight between them) are one corner of the street, merged at the meeting point of the
  // straights either side; a hairpin's corners, too sharp to merge, and a chicane's, turning
  // opposite ways, are tightened to fit.
  function routeVertices(pts) {
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const dp = (a, b) => {
      let best = -1, bd = 0.8;
      const ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1], l = Math.hypot(bx - ax, by - ay) || 1;
      for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i][0] - ax) * (by - ay) - (pts[i][1] - ay) * (bx - ax)) / l; if (d > bd) { bd = d; best = i; } }
      if (best > 0) { keep[best] = 1; dp(a, best); dp(best, b); }
    };
    // a closed loop is simplified as two halves, split at its point farthest from the start
    let far = 0, fd = -1;
    pts.forEach((p, i) => { const d = Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]); if (d > fd) { fd = d; far = i; } });
    keep[far] = 1; dp(0, far); dp(far, pts.length - 1);
    const v = pts.filter((_, i) => keep[i]).map(p => [p[0], p[1], 0, 0, 0]);
    if (Math.hypot(v[0][0] - v[v.length - 1][0], v[0][1] - v[v.length - 1][1]) < 1) v.pop();
    const n = () => v.length, at = k => v[(k + n()) % n()], len = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);
    const shape = k => {
      const a = at(k - 1), p = at(k), c = at(k + 1);
      const sturn = U.wrapAngle(Math.atan2(c[1] - p[1], c[0] - p[0]) - Math.atan2(p[1] - a[1], p[0] - a[0])), turn = Math.abs(sturn), t = turn * 180 / Math.PI;
      p[4] = Math.sign(sturn);
      const geo = Math.min(len(a, p), len(p, c)) / Math.max(turn, 1e-3);   // a smooth bend's own radius; its arcs then never overlap
      p[2] = Math.max(10, Math.min(t > 70 ? 15 : t > 35 ? 17 : t > 12 ? 60 : 250, geo)); p[3] = turn;
    };
    const tl = p => p[2] * Math.tan(Math.min(p[3], 3) / 2);
    for (let k = 0; k < n(); k++) shape(k);
    for (let pass = 0; pass < 400; pass++) {
      let worst = -1, wo = 0.6;
      for (let k = 0; k < n(); k++) { const o = tl(at(k)) + tl(at(k + 1)) - len(at(k), at(k + 1)); if (o > wo) { wo = o; worst = k; } }
      if (worst < 0) break;
      const k = worst, a = at(k - 1), p = at(k), q = at(k + 1), b = at(k + 2), l = len(p, q);
      // where the straights before and after meet
      const dx1 = p[0] - a[0], dy1 = p[1] - a[1], dx2 = q[0] - b[0], dy2 = q[1] - b[1], den = dx1 * dy2 - dy1 * dx2;
      const tt = Math.abs(den) > 1e-6 ? ((b[0] - a[0]) * dy2 - (b[1] - a[1]) * dx2) / den : NaN;
      const X = [a[0] + dx1 * tt, a[1] + dy1 * tt, 0, 0, 0];
      const merged = Math.abs(U.wrapAngle(Math.atan2(b[1] - q[1], b[0] - q[0]) - Math.atan2(p[1] - a[1], p[0] - a[0])));
      if (p[4] === q[4] && isFinite(tt) && tt > 0.2 && merged < 2.2 && len(X, p) < l * 2 + 20 && len(X, q) < l * 2 + 20) {
        v.splice((k + n()) % n(), 1, X);
        v.splice((k + 1 + n()) % n(), 1);
        const j = v.indexOf(X);
        shape(j - 1); shape(j); shape(j + 1);
      } else {
        // too sharp to merge (a hairpin), or turning opposite ways (a chicane): both corners
        // tightened until they fit
        const f = Math.max(0.5, (l - 0.2) / (tl(p) + tl(q)));
        p[2] = Math.max(8.5, p[2] * f); q[2] = Math.max(8.5, q[2] * f);
        if (tl(p) + tl(q) > l + 1.5) { v.splice(v.indexOf(p[3] < q[3] ? p : q), 1); for (let j = k - 1; j <= k + 1; j++) shape(j); }
      }
    }
    return v.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, Math.round(p[2] * 10) / 10, p[3]]);
  }

  function segDist(p, q, s, t) {
    const d = (a, b, c) => { const vx = c[0] - b[0], vy = c[1] - b[1], l2 = vx * vx + vy * vy || 1, u = U.clamp(((a[0] - b[0]) * vx + (a[1] - b[1]) * vy) / l2, 0, 1); return Math.hypot(a[0] - b[0] - vx * u, a[1] - b[1] - vy * u); };
    const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.sign(cross(p, q, s)) !== Math.sign(cross(p, q, t)) && Math.sign(cross(s, t, p)) !== Math.sign(cross(s, t, q))) return 0;
    return Math.min(d(p, s, t), d(q, s, t), d(s, p, q), d(t, p, q));
  }

  // ---------- buildings (city) ----------
  // As on Monaco's map: the streets are walled with buildings, their long sides along the street
  // a pavement's width back from it, frontages 12 to 30 m, most four to twelve storeys, the odd
  // tower; a second row behind where the block is deep enough. None stands on a slope too steep
  // for its plinth, in the sea, in the square or within reach of the circuit or its pit lane.
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
  function cityBuildings(r, tr, site) {
    const out = cityBlocks(r, tr, site), cell = 12, g = new Map();
    for (const rd of site.roads) {
      if (rd.kind === 'steps' || rd.kind === 'rail') continue;
      for (let k = 0; k < rd.pts.length - 1; k++) {
        const a = rd.pts[k], b = rd.pts[k + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        for (let t = 0; t <= l; t += 2.5) { const x = a[0] + (b[0] - a[0]) * t / (l || 1), y = a[1] + (b[1] - a[1]) * t / (l || 1), c = Math.floor(x / cell) + ',' + Math.floor(y / cell); if (!g.has(c)) g.set(c, []); g.get(c).push([x, y, rd.w / 2 + 0.3]); }
      }
    }
    const inPoly = (pl, x, y) => { let c = false; for (let i = 0, j = pl.length - 1; i < pl.length; j = i++) if ((pl[i][1] > y) !== (pl[j][1] > y) && x < (pl[j][0] - pl[i][0]) * (y - pl[i][1]) / (pl[j][1] - pl[i][1]) + pl[i][0]) c = !c; return c; };
    const lapClear = pl => {
      for (let k = 0; k < pl.length; k++) {
        const a = pl[k], c = pl[(k + 1) % pl.length], l = Math.hypot(c[0] - a[0], c[1] - a[1]);
        for (let t = 0; t <= l; t += 3) {
          const x = a[0] + (c[0] - a[0]) * t / (l || 1), y = a[1] + (c[1] - a[1]) * t / (l || 1);
          let bi = -1, bd = 1e18;
          tr.hash.near(x, y, 30, i => { const q = (x - tr.x[i]) ** 2 + (y - tr.y[i]) ** 2; if (q < bd) { bd = q; bi = i; } });
          if (bi >= 0) { const dl = (x - tr.x[bi]) * tr.nx[bi] + (y - tr.y[bi]) * tr.ny[bi]; if (Math.abs(dl) < tr.barr[dl > 0 ? 1 : 0][bi] + 1.6) return false; }
        }
      }
      return true;
    };
    return out.filter(b => {
      for (const pl of b.parts || [b.poly]) {
        if (!lapClear(pl)) return false;
        let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
        for (const p of pl) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
        for (let i = Math.floor(x0 / cell) - 1; i <= Math.floor(x1 / cell) + 1; i++) for (let j = Math.floor(y0 / cell) - 1; j <= Math.floor(y1 / cell) + 1; j++) for (const q of g.get(i + ',' + j) || []) {
          if (q[0] < x0 - q[2] || q[0] > x1 + q[2] || q[1] < y0 - q[2] || q[1] > y1 + q[2]) continue;
          if (inPoly(pl, q[0], q[1])) return false;
        }
      }
      return true;
    });
  }
  function cityBlocks(r, tr, site) {
    const L = (a, b) => a + (b - a) * r();
    // the streets and the pit lane, as points with the half width to keep clear of
    const cell = 16, grid = new Map(), key = (x, y) => Math.floor(x / cell) + ',' + Math.floor(y / cell);
    const put = (x, y, hw) => { const k = key(x, y); if (!grid.has(k)) grid.set(k, []); grid.get(k).push([x, y, hw]); };
    for (const rd of site.roads) for (let k = 0; k < rd.pts.length - 1; k++) {
      const a = rd.pts[k], b = rd.pts[k + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let t = 0; t < l; t += 3) put(a[0] + (b[0] - a[0]) * t / l, a[1] + (b[1] - a[1]) * t / l, rd.w / 2);
    }
    for (let i = 0; i < tr.N; i += 2) {
      put(tr.x[i], tr.y[i], tr.hw + 2);
      if (!isNaN(tr.pit.off[i])) put(tr.x[i] + tr.nx[i] * tr.pit.off[i], tr.y[i] + tr.ny[i] * tr.pit.off[i], tr.pit.lane / 2 + 5);
    }
    // (only ever asked whether a street is within a metre or two: the search reaches 12 m, past the
    // widest street's half width)
    const street = (x, y) => {
      let best = 1e9;
      const c0 = Math.floor((x - 12) / cell), c1 = Math.floor((x + 12) / cell), r0 = Math.floor((y - 12) / cell), r1 = Math.floor((y + 12) / cell);
      for (let cx = c0; cx <= c1; cx++) for (let cy = r0; cy <= r1; cy++) { const a = grid.get(cx + ',' + cy); if (a) for (const q of a) best = Math.min(best, Math.hypot(x - q[0], y - q[1]) - q[2]); }
      return best;
    };
    // placed footprints, for overlap tests (separating axes)
    const bgrid = new Map(), bkey = (x, y) => Math.floor(x / 40) + ',' + Math.floor(y / 40);
    const axes = q => q.map((a, k) => { const b = q[(k + 1) % q.length]; return [b[1] - a[1], a[0] - b[0]]; });
    const overlap = (a, b) => {
      for (const ax of axes(a).concat(axes(b))) {
        let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
        for (const p of a) { const d = p[0] * ax[0] + p[1] * ax[1]; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
        for (const p of b) { const d = p[0] * ax[0] + p[1] * ax[1]; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
        const l = Math.hypot(ax[0], ax[1]) || 1;
        if (a1 <= b0 + 0.15 * l || b1 <= a0 + 0.15 * l) return false;
      }
      return true;
    };
    const out = [], segs = [];
    for (const rd of site.roads) for (let k = 0; k < rd.pts.length - 1; k += 2) { const a = rd.pts[k], b = rd.pts[Math.min(k + 2, rd.pts.length - 1)], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l > 1) segs.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (b[0] - a[0]) / l, (b[1] - a[1]) / l]); }
    const sgrid = new Map();
    for (const q of segs) { const k = Math.floor(q[0] / 60) + ',' + Math.floor(q[1] / 60); if (!sgrid.has(k)) sgrid.set(k, []); sgrid.get(k).push(q); }
    const facing = (x, y) => { let best = null, bd = 90; for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const q of sgrid.get((Math.floor(x / 60) + a) + ',' + (Math.floor(y / 60) + b)) || []) { const d = Math.hypot(q[0] - x, q[1] - y); if (d < bd) { bd = d; best = q; } } return best; };
    // a lot's footprint (any convex quad), if it is clear of the streets, the sea, the circuit and
    // every building already standing
    const placePoly = (poly, lv) => {
      const cx = poly.reduce((a, q) => a + q[0], 0) / poly.length, cy = poly.reduce((a, q) => a + q[1], 0) / poly.length;
      const probe = [[cx, cy]];
      poly.forEach((a, k) => { const b = poly[(k + 1) % poly.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]); for (let t = 0; t < l; t += 3) probe.push([a[0] + (b[0] - a[0]) * t / l, a[1] + (b[1] - a[1]) * t / l]); });
      for (const q of probe) if (street(q[0], q[1]) < 0.4 || site.inland(q[0], q[1]) < 3) return null;
      let rad = 0; for (const q of poly) rad = Math.max(rad, Math.hypot(q[0] - cx, q[1] - cy));
      if (Math.hypot(cx - site.plaza[0], cy - site.plaza[1]) < 30 + rad) return null;
      if (site.squares && site.squares.some(q => Math.hypot(cx - q[0], cy - q[1]) < q[2] + rad * 0.7)) return null;
      const hs = poly.map(q => site.H(q[0], q[1]));
      const nearT = distToTrack(tr, cx, cy, 90) < 90;
      if (Math.max(...hs) - Math.min(...hs) > (nearT ? 24 : rad > 25 ? 18 : 13)) return null;   // (a block steps down its slope)
      const k0 = Math.floor(cx / 40), k1 = Math.floor(cy / 40);
      for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (const o of bgrid.get((k0 + a) + ',' + (k1 + b)) || []) if (Math.hypot(o.c[0] - cx, o.c[1] - cy) < o.rad + rad && overlap(o.poly, poly)) return null;
      if (!polyClear(tr, poly, tr.hw + 4.5)) return null;
      // (the blocks on the circuit are four to eight storeys; a tower needs a broad plot set back from it)
      if (lv > 8) {
        let mn = Infinity; poly.forEach((a, k) => { const b = poly[(k + 1) % poly.length]; mn = Math.min(mn, Math.hypot(b[0] - a[0], b[1] - a[1])); });
        const dt = distToTrack(tr, cx, cy, 60);
        if (dt < 30 || (lv >= 13 && (mn < 16 || dt < 60))) lv = 5 + Math.floor(r() * 4);
      }
      const bd = { poly, h: Math.round(lv * 3.1 + 1.5), tone: r(), c: [cx, cy], rad, tower: lv >= 16, levels: lv };
      out.push(bd);
      const kk = bkey(cx, cy);
      if (!bgrid.has(kk)) bgrid.set(kk, []);
      bgrid.get(kk).push(bd);
      return bd;
    };
    const tryPlace = (cx, cy, ax, ay, f, d, lv) => {
      const bx = -ay, by = ax;
      const poly = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([p, q]) => [cx + ax * p * f / 2 + bx * q * d / 2, cy + ay * p * f / 2 + by * q * d / 2]);
      const probe = poly.concat([[cx, cy], [(poly[0][0] + poly[1][0]) / 2, (poly[0][1] + poly[1][1]) / 2], [(poly[2][0] + poly[3][0]) / 2, (poly[2][1] + poly[3][1]) / 2]]);
      for (const p of probe) if (street(p[0], p[1]) < 1.5 || site.inland(p[0], p[1]) < 10) return false;
      if (Math.hypot(cx - site.plaza[0], cy - site.plaza[1]) < 30 + Math.max(f, d) / 2) return false;
      const hs = poly.map(p => site.H(p[0], p[1]));
      if (Math.max(...hs) - Math.min(...hs) > (f * d > 1200 ? 14 : 10)) return false;   // (a big block steps down its slope)
      const k0 = Math.floor(cx / 40), k1 = Math.floor(cy / 40), sh = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([p, q]) => [cx + ax * p * (f / 2 - 0.9) + bx * q * (d / 2 - 0.9), cy + ay * p * (f / 2 - 0.9) + by * q * (d / 2 - 0.9)]);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const o of bgrid.get((k0 + a) + ',' + (k1 + b)) || []) if (overlap(o.poly, sh)) return false;
      if (!polyClear(tr, poly, tr.hw + 4.5)) return false;
      const bd = { poly, h: Math.round(lv * 3.1 + 1.5), tone: r(), c: [cx, cy], rad: Math.hypot(f, d) / 2, tower: lv >= 16, levels: lv };
      out.push(bd);
      const kk = bkey(cx, cy);
      if (!bgrid.has(kk)) bgrid.set(kk, []);
      bgrid.get(kk).push(bd);
      return true;
    };
    // the old town by the harbour and on the lower slopes is a continuous street wall; higher up
    // the slopes are villas in gardens; the steepest ground (ravine walls) and a few parks stay green
    const gauss = () => Math.sqrt(-2 * Math.log(1 - r() * 0.999)) * Math.cos(6.2832 * r());
    const villa = (x, y) => site.H(x, y) > 210 || site.inland(x, y) > 1100;
    const green = (x, y) => { const e = 3, g = Math.hypot(site.H(x + e, y) - site.H(x - e, y), site.H(x, y + e) - site.H(x, y - e)) / (2 * e); return g > 0.42 || (site.park && site.park(x, y)); };
    const storeys = (x, y) => {
      if (villa(x, y)) return 2 + Math.floor(r() * 3);
      const q = r(), u = site.inland(x, y);
      return q < 0.6 ? 4 + Math.floor(r() * 5) : q < 0.9 ? 8 + Math.floor(r() * 6) : q < 0.97 || u < 120 ? 12 + Math.floor(r() * 8) : 18 + Math.floor(r() * 18);
    };
    // the landmarks first: a casino and a grand hotel by the square, hotels on the seafront, sheds
    // on the quays, a station on the valley floor, a school
    const landmark = (cx, cy, f, d, lv) => { const q = facing(cx, cy); return q ? tryPlace(cx, cy, q[2], q[3], f, d, lv) : false; };
    {
      const P = site.plaza, spots = [[50, 34, 3], [70, 34, 9], [90, 30, 8], [64, 40, 7]];
      for (const [f, d, lv] of spots) for (let t = 0; t < 30; t++) { const a = r() * 6.283, R = 50 + r() * 70; if (landmark(P[0] + Math.cos(a) * R, P[1] + Math.sin(a) * R, f, d, lv)) break; }
      for (let n = 0, t = 0; n < 5 && t < 600; t++) {
        const rd = site.roads[Math.floor(r() * site.roads.length)]; if (!rd || !rd.lap) continue;
        const q = rd.pts[Math.floor(r() * rd.pts.length)], a = r() * 6.283, x = q[0] + Math.cos(a) * 35, y = q[1] + Math.sin(a) * 35, u = site.inland(x, y);
        if (u > 12 && u < 60 && landmark(x, y, L(50, 90), L(14, 20), 2)) n++;            // a shed on the quay
        else if (u > 40 && u < 300 && r() < 0.4 && landmark(x, y, L(70, 140), L(30, 60), L(5, 12) | 0)) n++;   // a hotel, a garage, a hall
      }
    }
    // The blocks, as on a real town's map: each street's frontage cut into lots (frontage
    // lognormal about 14 m), each lot running back to the middle of its block (or 35 m), the lots
    // on either side of a corner meeting at the same point so neighbours share their walls. In the
    // old town every lot is built over, wall to wall, a third of them merged into longer slabs and
    // big blocks; on the villa slopes each lot keeps a garden round its house. Main streets first.
    const order = site.roads.filter(rd => rd.kind !== 'steps' && rd.kind !== 'rail' && rd.cls !== 'service' && rd.pts.length > 1)
      .sort((a, b) => (b.lap ? 2 : 0) + (b.cls === 'primary' || b.cls === 'secondary' ? 1 : 0) - (a.lap ? 2 : 0) - (a.cls === 'primary' || a.cls === 'secondary' ? 1 : 0));
    for (const rd of order) {
      const pl = resample(rd.pts, 2), n = pl.length;
      if (n < 4) continue;
      const cum = [0];
      for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]));
      const total = cum[n - 1];
      const at = s => { let i = 1; while (i < n - 1 && cum[i] < s) i++; const a = pl[i - 1], b = pl[i], l = cum[i] - cum[i - 1] || 1, t = (s - cum[i - 1]) / l; return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
      for (const side of [-1, 1]) {
        // how deep the block is behind the street at s: to the middle of the way to the next street
        // (or the shore, or ground too steep to build on), at most 35 m (16 m for a villa plot)
        const back = rd.lap ? Math.max(rd.w * 0.65, tr.hw + 4.6) + L(1.5, 3) : rd.w / 2 + L(0.6, 1.6);   // (at the back of the pavement)
        const depthAt = s => {
          const p = at(s), nx = -p[3] * side, ny = p[2] * side, vil = villa(p[0], p[1]), dmax = vil ? 30 : L(34, 48);
          for (let d = 2; d <= dmax * 2; d += 2) {
            const x = p[0] + nx * (back + d), y = p[1] + ny * (back + d);
            if (d >= 4 && street(x, y) < 1) return Math.min(dmax, d / 2 - 0.5);
            if (site.inland(x, y) < 9 || (green(x, y) && distToTrack(tr, x, y, 90) >= 90)) return Math.min(dmax, d - 2);
          }
          return dmax;
        };
        const corner = (s, dep) => { const p = at(s), nx = -p[3] * side, ny = p[2] * side; return [[p[0] + nx * back, p[1] + ny * back], [p[0] + nx * (back + dep), p[1] + ny * (back + dep)]]; };
        let s0 = r() * 2, noSlab = -1;
        while (s0 < total - 6) {
          const p0 = at(s0), vil = villa(p0[0], p0[1]);
          // (districts differ: fine-grained old quarters, broad blocks of flats and hotels)
          const dist = fbm(p0[0] / 320, p0[1] / 320, 77, 2);
          const slab = !vil && dist > 0.2 && s0 > noSlab && r() < 0.7;   // (a big block that would not fit gives way to ordinary plots for 40 m)
          let f = vil ? L(14, 26) : slab ? L(30, 80) : U.clamp(16 * Math.exp(0.7 * dist + 0.6 * gauss()), 4, 46);
          // a run of lots merged into one long block on the old town's streets
          if (!vil && !slab && r() < 0.4 + 0.25 * dist) f = Math.min(f * L(2, 5), 110);
          let s1 = Math.min(total - 1, s0 + f);
          let d0 = depthAt(s0);
          const whole = d0 > 26 && (slab || r() < 0.35), dc = d0 > 26 && !whole ? 18 : d0;
          if (s1 - s0 > 3 * dc) s1 = s0 + 3 * Math.max(dc, 6);   // no range longer than three times its depth (a deep lot's front range is under 18 m)
          let d1 = depthAt(s1);
          if (Math.min(d0, d1) < (vil ? 9 : 6)) { s0 += 3; continue; }
          let [a0, b0] = corner(s0, d0), [a1, b1] = corner(s1, d1);
          if (!vil && r() < 0.75) {
            const ux = a1[0] - a0[0], uy = a1[1] - a0[1], ul = Math.hypot(ux, uy) || 1, mx = (b0[0] - a0[0]) + (b1[0] - a1[0]), my = (b0[1] - a0[1]) + (b1[1] - a1[1]);
            let nx = mx - (mx * ux + my * uy) / ul * ux / ul, ny = my - (mx * ux + my * uy) / ul * uy / ul;
            const nl = Math.hypot(nx, ny) || 1, dd = Math.min(d0, d1); nx /= nl; ny /= nl;
            b0 = [a0[0] + nx * dd, a0[1] + ny * dd]; b1 = [a1[0] + nx * dd, a1[1] + ny * dd]; d0 = d1 = dd;
          }
          let poly = side > 0 ? [a0, a1, b1, b0] : [a1, a0, b0, b1];
          if (vil) {
            // the house in its garden: set back from the street, clear of its neighbours, its own
            // size and anywhere on its plot; a plot in four is garden only
            if (r() < 0.25) { s0 = s1 + L(0, 6); continue; }
            const ox = L(-0.15, 0.15), oy = L(-0.1, 0.2), cx = (a0[0] + a1[0] + b0[0] + b1[0]) / 4 + (a1[0] - a0[0]) * ox + (b0[0] - a0[0]) * oy, cy = (a0[1] + a1[1] + b0[1] + b1[1]) / 4 + (a1[1] - a0[1]) * ox + (b0[1] - a0[1]) * oy, k0 = L(0.35, 0.72), k1 = k0 * L(0.75, 1.3);
            const ca = (a0[0] + a1[0] + b0[0] + b1[0]) / 4, cb = (a0[1] + a1[1] + b0[1] + b1[1]) / 4, uf = [(a1[0] - a0[0]), (a1[1] - a0[1])], ud = [(b0[0] - a0[0]), (b0[1] - a0[1])];
            poly = poly.map(q => { const dx = q[0] - ca, dy = q[1] - cb, lf = (dx * uf[0] + dy * uf[1]) / (uf[0] * uf[0] + uf[1] * uf[1]), ld = (dx * ud[0] + dy * ud[1]) / (ud[0] * ud[0] + ud[1] * ud[1]); return [cx + uf[0] * lf * k0 + ud[0] * ld * k1, cy + uf[1] * lf * k0 + ud[1] * ld * k1]; });
          }
          // the inside of a bend pinches the back of a lot: then it is shallower
          const crossed = Math.hypot(b1[0] - b0[0], b1[1] - b0[1]) < 0.55 * Math.hypot(a1[0] - a0[0], a1[1] - a0[1]);
          if (!crossed) {
            const area = Math.abs(poly.reduce((acc, q, k) => { const o = poly[(k + 1) % 4]; return acc + q[0] * o[1] - o[0] * q[1]; }, 0)) / 2;
            const cxy = [(a0[0] + b1[0]) / 2, (a0[1] + b1[1]) / 2];
            const lv = area > 2000 && !vil ? 5 + Math.floor(r() * 7) : storeys(cxy[0], cxy[1]);
            // a deep old-town lot: the range on the street, a yard, a lower range behind
            const dmin = Math.min(d0, d1);
            if (!vil && dmin > 26 && !whole) {
              const fr = L(12, 18), yard = L(4, 9), cut = (q0, q1, a, b) => [q0[0] + (q1[0] - q0[0]) * a / b, q0[1] + (q1[1] - q0[1]) * a / b];
              const f0 = cut(a0, b0, fr, d0), f1 = cut(a1, b1, fr, d1), r0 = cut(a0, b0, fr + yard, d0), r1 = cut(a1, b1, fr + yard, d1);
              const front = side > 0 ? [a0, a1, f1, f0] : [a1, a0, f0, f1], rear = side > 0 ? [r0, r1, b1, b0] : [r1, r0, b0, b1];
              const ok1 = placePoly(front, lv);
              if (ok1) {
                placePoly(rear, Math.max(2, lv - 1 - Math.floor(r() * 3)));
                // a shed or a kiosk in the yard
                if (r() < 0.6) { const c = cut(cut(a0, b0, fr + yard / 2, d0), cut(a1, b1, fr + yard / 2, d1), 1, 2), e = L(2, 3.5); placePoly([[c[0] - e, c[1] - e], [c[0] + e, c[1] - e], [c[0] + e, c[1] + e], [c[0] - e, c[1] + e]], 1); }
                s0 = s1; continue;
              }
            }
            if (placePoly(poly, lv)) { s0 = s1 + (vil ? L(0, 4) : 0); continue; }
          }
          if (slab) { noSlab = s0 + 40; continue; }
          s0 += 3;
        }
      }
    }
    // block interiors: whatever the street ranges leave open inside a block (more than 9 m from
    // any building, within 45 m of a street) is built over by back buildings, workshops and
    // garages, turned square to their nearest neighbour
    {
      const nearSt = new Set(), C = 10, ck = (x, y) => Math.floor(x / C) + ',' + Math.floor(y / C);
      for (const rd of site.roads) for (let k = 0; k < rd.pts.length - 1; k++) {
        const a = rd.pts[k], b = rd.pts[k + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        for (let t = 0; t < l; t += 8) { const x = a[0] + (b[0] - a[0]) * t / l, y = a[1] + (b[1] - a[1]) * t / l; for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) if (i * i + j * j <= 20) nearSt.add((Math.floor(x / C) + i) + ',' + (Math.floor(y / C) + j)); }
      }
      const pts = [];
      for (const kk of nearSt) { const [i, j] = kk.split(',').map(Number); pts.push([(i + r()) * C, (j + r()) * C]); }
      for (let i = pts.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)), t = pts[i]; pts[i] = pts[j]; pts[j] = t; }
      for (const [x, y] of pts) {
        if (site.inland(x, y) < 10 || green(x, y) || street(x, y) < 6) continue;
        let nb = null, nd = 1e9;
        const k0 = Math.floor(x / 40), k1 = Math.floor(y / 40);
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const o of bgrid.get((k0 + a) + ',' + (k1 + b)) || []) { const d = Math.hypot(o.c[0] - x, o.c[1] - y) - o.rad; if (d < nd) { nd = d; nb = o; } }
        if (!nb || nd < 6 || nd > 40) continue;
        const e = nb.poly, ux = e[1][0] - e[0][0], uy = e[1][1] - e[0][1], ul = Math.hypot(ux, uy) || 1, ax = ux / ul, ay = uy / ul, bx = -ay, by = ax;
        const shed = r() < 0.3, f = shed ? L(4, 7.5) : L(10, 26), d = shed ? L(3.5, 6) : L(9, 18), poly = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([p, q]) => [x + ax * p * f / 2 + bx * q * d / 2, y + ay * p * f / 2 + by * q * d / 2]);
        placePoly(poly, shed ? 1 : Math.max(2, storeys(x, y) - 2 - Math.floor(r() * 3)));
      }
    }
    // not every building a box: two in five of the larger ones notched at the back into a T, a U
    // round a light well, a stepped block or an L (their parts kept as boxes for the 3D town)
    for (const b of out) {
      const p = b.poly;
      if (p.length !== 4 || b.tower) continue;
      const fw = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]), dp = Math.hypot(p[3][0] - p[0][0], p[3][1] - p[0][1]);
      if (fw < 12 || dp < 10 || r() > 0.7) continue;
      const B = (s, v) => { const f = [p[0][0] + (p[1][0] - p[0][0]) * s, p[0][1] + (p[1][1] - p[0][1]) * s], k = [p[3][0] + (p[2][0] - p[3][0]) * s, p[3][1] + (p[2][1] - p[3][1]) * s]; return [f[0] + (k[0] - f[0]) * v, f[1] + (k[1] - f[1]) * v]; };
      const Q = (s0, s1, v0, v1) => [B(s0, v0), B(s1, v0), B(s1, v1), B(s0, v1)];
      const u = L(0.4, 0.62), kind = r() * 0.92, t1 = L(0.22, 0.38), t2 = L(0.62, 0.78);
      if (kind < 0.3) { b.poly = [B(0, 0), B(1, 0), B(1, u), B(t2, u), B(t2, 1), B(t1, 1), B(t1, u), B(0, u)]; b.parts = [Q(0, 1, 0, u), Q(t1, t2, u, 1)]; }
      else if (kind < 0.6) { b.poly = [B(0, 0), B(1, 0), B(1, 1), B(t2, 1), B(t2, u), B(t1, u), B(t1, 1), B(0, 1)]; b.parts = [Q(0, 1, 0, u), Q(0, t1, u, 1), Q(t2, 1, u, 1)]; }
      else if (kind < 0.8) { const u2 = Math.min(0.92, u + L(0.2, 0.35)); b.poly = [B(0, 0), B(1, 0), B(1, u), B(t2, u), B(t2, u2), B(t1, u2), B(t1, 1), B(0, 1)]; b.parts = [Q(0, 1, 0, u), Q(0, t2, u, u2), Q(0, t1, u2, 1)]; }
      else { const lf = r() < 0.5; b.poly = lf ? [B(0, 0), B(1, 0), B(1, 1), B(t1, 1), B(t1, u), B(0, u)] : [B(0, 0), B(1, 0), B(1, u), B(t2, u), B(t2, 1), B(0, 1)]; b.parts = lf ? [Q(0, 1, 0, u), Q(t1, 1, u, 1)] : [Q(0, 1, 0, u), Q(0, t2, u, 1)]; }
    }
    return out;
  }
  // the tunnel: where the lap runs under the promontory
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
    // (in a dense town the terrain model reads the buildings and the ground over tunnels as
    // climbs, which inflates the measured ascent: Monaco's surveyed profile climbs about 1.2
    // times its range, against the 1.74 measured; a town's lower bound allows for it)
    const ratioLo = style === 'city' ? Math.min(R.ratio[0], 1.15) : R.ratio[0];
    if (m.ratio < ratioLo || m.ratio > R.ratio[1]) out.push('ascent ratio ' + m.ratio.toFixed(2));
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

  // ---------- the town's road system ----------
  // A town has its roads before anyone races on them, so they are made first and for their own
  // reasons, and the circuit is only a loop through them, closed off by barriers. Roads run the
  // way a hillside town's do: along the contours and the shore, tied together by streets that
  // climb across the slope as steeply as a road may, with smaller streets filling the blocks.
  // Each new street ends where it meets another, so the result is a graph of real junctions:
  // nodes { x, y, e: edges }, edges { a, b, pts, w, cls } (cls 0 arterial, 1 collector, 2 local).
  function roadSystem(T, r) {
    const L = (a, b) => a + (b - a) * r(), s = 1 + Math.floor(r() * 1e5);
    const cx = T.Wb * 0.5, cy = -T.D * 0.3, reach = 1250;
    const nodes = [], edges = [], CELL = 24, grid = new Map(), STEP = 8;
    const ck = (x, y) => (Math.floor(x / CELL) + 4096) * 8192 + Math.floor(y / CELL) + 4096;
    const index = e => e.pts.forEach((p, i) => { const k = ck(p[0], p[1]); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(e, i); });
    const nearest = (x, y, R, skip) => {
      let best = null, bd = R * R;
      const c0 = Math.floor((x - R) / CELL), c1 = Math.floor((x + R) / CELL), r0 = Math.floor((y - R) / CELL), r1 = Math.floor((y + R) / CELL);
      for (let a = c0; a <= c1; a++) for (let b = r0; b <= r1; b++) {
        const A = grid.get((a + 4096) * 8192 + b + 4096);
        if (A) for (let k = 0; k < A.length; k += 2) {
          const e = A[k]; if (e.dead || e === skip) continue;
          const p = e.pts[A[k + 1]], d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
          if (d < bd) { bd = d; best = { e, i: A[k + 1], d: Math.sqrt(d) }; }
        }
      }
      return best;
    };
    const addNode = (x, y) => { const n = { x, y, e: [] }; nodes.push(n); return n; };
    const addEdge = (a, b, pts, w, cls, kind) => { const e = { a, b, pts, w, cls, kind }; a.e.push(e); b.e.push(e); edges.push(e); index(e); return e; };
    const unlink = e => { e.dead = true; e.a.e.splice(e.a.e.indexOf(e), 1); e.b.e.splice(e.b.e.indexOf(e), 1); };
    // the junction at a point of an edge: the edge cut in two there
    const nodeAt = (e, i) => {
      if (i <= 2) return e.a;
      if (i >= e.pts.length - 3) return e.b;
      const p = e.pts[i], n = addNode(p[0], p[1]);
      unlink(e);
      addEdge(e.a, n, e.pts.slice(0, i + 1), e.w, e.cls, e.kind); addEdge(n, e.b, e.pts.slice(i), e.w, e.cls, e.kind);
      return n;
    };
    const land = (x, y, m) => T.inland(x, y) > m && Math.hypot(x - cx, y - cy) < reach && x > T.X0 + 60 && x < T.X1 - 60 && y > T.Y0 + 60 && y < T.Y1 - 60;
    const unit = (x, y) => { const l = Math.sqrt(x * x + y * y) || 1; return [x / l, y / l]; };
    // Engines differ in the last bit of sin and cos, and a street tracer turns that into a different
    // town, so a seed would build one town in the browser and another in a worker or in Node. Every
    // heading and position is rounded as it is made, far above that noise.
    const QD = v => Math.round(v * 1e6) / 1e6, QP = v => Math.round(v * 256) / 256;
    const shoreN = (x, y) => unit(T.inland(x + 10, y) - T.inland(x - 10, y), T.inland(x, y + 10) - T.inland(x, y - 10));
    // the two directions streets take: along the slope, and across it at the steepest a street may
    // climb. Flat ground has no contours, so there the shore gives the grain, and every district
    // leans a little its own way.
    const along = (x, y, d) => {
      const g = T.grad(x, y), gl = Math.hypot(g[0], g[1]), n = shoreN(x, y), k = U.smooth((gl - 0.02) / 0.05);
      let c = gl > 1e-4 ? [-g[1] / gl, g[0] / gl] : [-n[1], n[0]], t = [-n[1], n[0]];
      if (c[0] * d[0] + c[1] * d[1] < 0) c = [-c[0], -c[1]];
      if (t[0] * d[0] + t[1] * d[1] < 0) t = [-t[0], -t[1]];
      const a = (vnoise2(x / 380, y / 380, s) - 0.5) * 0.7, q = unit(c[0] * k + t[0] * (1 - k), c[1] * k + t[1] * (1 - k));
      return [q[0] * Math.cos(a) - q[1] * Math.sin(a), q[0] * Math.sin(a) + q[1] * Math.cos(a)];
    };
    const across = gmax => (x, y, d) => {
      const q = along(x, y, d), g = T.grad(x, y), gl = Math.hypot(g[0], g[1]), th = gl <= gmax ? Math.PI / 2 : Math.asin(gmax / gl);
      const pick = sd => [q[0] * Math.cos(sd * th) - q[1] * Math.sin(sd * th), q[0] * Math.sin(sd * th) + q[1] * Math.cos(sd * th)];
      const p = pick(1), m = pick(-1);
      return p[0] * d[0] + p[1] * d[1] > m[0] * d[0] + m[1] * d[1] ? p : m;
    };
    // a street from a point, turning no faster than a street turns, until it meets another or runs
    // out of ground: { pts, hit, why }
    const crossing = (ax, ay, bx, by, skip) => {
      const c0 = Math.floor((Math.min(ax, bx) - 10) / CELL), c1 = Math.floor((Math.max(ax, bx) + 10) / CELL), r0 = Math.floor((Math.min(ay, by) - 10) / CELL), r1 = Math.floor((Math.max(ay, by) + 10) / CELL);
      for (let a = c0; a <= c1; a++) for (let b = r0; b <= r1; b++) {
        const A = grid.get((a + 4096) * 8192 + b + 4096);
        if (A) for (let k = 0; k < A.length; k += 2) {
          const e = A[k], i = A[k + 1];
          if (e.dead || e === skip || i >= e.pts.length - 1) continue;
          const p = e.pts[i], q = e.pts[i + 1], d1 = (bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax), d2 = (bx - ax) * (q[1] - ay) - (by - ay) * (q[0] - ax), d3 = (q[0] - p[0]) * (ay - p[1]) - (q[1] - p[1]) * (ax - p[0]), d4 = (q[0] - p[0]) * (by - p[1]) - (q[1] - p[1]) * (bx - p[0]);
          if (d1 * d2 < 0 && d3 * d4 < 0) return { e, i: d1 * d1 < d2 * d2 ? i : i + 1, d: 0 };
        }
      }
      return null;
    };
    const trace = (p0, h0, field, o) => {
      const pts = [p0.slice()], mt = o.turn || 0.17;
      let x = p0[0], y = p0[1], d = [QD(Math.cos(h0)), QD(Math.sin(h0))], len = 0, hit = null, why = 'length', bent = 0;
      while (len < o.max) {
        const q = field(x, y, d), a = U.clamp(Math.atan2(d[0] * q[1] - d[1] * q[0], d[0] * q[0] + d[1] * q[1]), -mt, mt), ca = Math.cos(a), sa = Math.sin(a);
        d = [QD(d[0] * ca - d[1] * sa), QD(d[0] * sa + d[1] * ca)];
        // (a street does not hook round to rejoin where it came from)
        bent += QD(a);
        if (o.bend && Math.abs(bent) > o.bend) { why = 'hook'; break; }
        const nx = QP(x + d[0] * STEP), ny = QP(y + d[1] * STEP);
        if (!land(nx, ny, o.shore || 12)) { why = 'edge'; break; }
        if (Math.abs(T.H(nx, ny) - T.H(x, y)) / STEP > o.gmax) { why = 'steep'; break; }
        if (len > (o.clear || 20)) {
          const cr = crossing(x, y, nx, ny, null);
          if (cr) { hit = cr; why = 'hit'; break; }
          const n = nearest(nx, ny, o.hit, null);
          if (n) {
            const pv = n.e.pts[Math.max(0, n.i - 1)], nv = n.e.pts[Math.min(n.e.pts.length - 1, n.i + 1)], tn = unit(nv[0] - pv[0], nv[1] - pv[1]);
            if (Math.abs(d[0] * tn[1] - d[1] * tn[0]) > 0.26) { hit = n; why = 'hit'; } else why = 'parallel';
            break;
          }
        }
        for (let k = pts.length - 8; k >= 0; k -= 2) if (Math.hypot(pts[k][0] - nx, pts[k][1] - ny) < 16) { why = 'self'; break; }
        if (why === 'self') break;
        x = nx; y = ny; pts.push([x, y]); len += STEP;
      }
      return { pts, hit, why, len };
    };
    const lay = (from, t, w, cls, kind) => {
      const end = t.hit ? nodeAt(t.hit.e, t.hit.i) : addNode(t.pts[t.pts.length - 1][0], t.pts[t.pts.length - 1][1]);
      const pts = t.pts.slice();
      if (t.hit) pts.push([end.x, end.y]); else pts[pts.length - 1] = [end.x, end.y];
      return addEdge(from, end, pts, w, cls, kind);
    };

    // the shore road: a steady distance inland all the way round the basin
    const off = L(34, 44);
    {
      const follow = (x, y, d) => {
        const n = shoreN(x, y); let t = [-n[1], n[0]];
        if (t[0] * d[0] + t[1] * d[1] < 0) t = [-t[0], -t[1]];
        const e = U.clamp((off - T.inland(x, y)) * 0.06, -0.8, 0.8);
        return unit(t[0] + n[0] * e, t[1] + n[1] * e);
      };
      const x0 = QP(T.Wb * 0.5), y0 = QP(T.cl(x0) + off), w = Math.round(L(11, 14) * 2) / 2, o = { max: 3200, gmax: 0.17, hit: 0, shore: 14, clear: 1e9, turn: 0.22 };
      const a = trace([x0, y0], 0, follow, o), b = trace([x0, y0], Math.PI, follow, o);
      const pts = b.pts.slice().reverse().concat(a.pts.slice(1));
      if (pts.length < 40) return null;
      const na = addNode(pts[0][0], pts[0][1]), nb = addNode(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      addEdge(na, nb, pts, w, 0, 'coast');
    }
    // long roads along the slope, in rows up the hill: every road offers a place for the next row
    // a street's distance to each side of it, so the town grows outward until the ground runs out
    const rows = (gap, budget, w0, w1, cls, kind, gmax) => {
      const ceiling = 240;
      let laid = 0;
      for (let q = 0; q < edges.length && laid < budget; q++) {
        const e = edges[q];
        if (e.dead || e.pts.length < 8) continue;
        for (let i = 4 + Math.floor(r() * 10); i < e.pts.length - 4 && laid < budget; i += Math.round(L(90, 170) / STEP)) {
          if (e.dead) break;
          const p = e.pts[i], o = e.pts[i + 1], u = unit(o[0] - p[0], o[1] - p[1]);
          for (const sd of [-1, 1]) {
            const g = gap * L(0.85, 1.2), x = QP(p[0] - u[1] * sd * g), y = QP(p[1] + u[0] * sd * g);
            if (!land(x, y, 40) || T.H(x, y) > ceiling || nearest(x, y, gap * 0.72, null)) continue;
            const d0 = along(x, y, u), h0 = QD(Math.atan2(d0[1], d0[0])), oo = { max: L(450, 1300), gmax, hit: gap * 0.5, shore: 28, clear: 0 };
            const fw = trace([x, y], h0, along, oo), bk = trace([x, y], h0 + Math.PI, along, oo);
            if (fw.len + bk.len < 120) continue;
            const pts = bk.pts.slice().reverse().concat(fw.pts.slice(1)), w = Math.round(L(w0, w1) * 2) / 2;
            const ns = bk.hit ? nodeAt(bk.hit.e, bk.hit.i) : addNode(pts[0][0], pts[0][1]);
            if (bk.hit) pts.unshift([ns.x, ns.y]);
            lay(ns, { pts, hit: fw.hit && !fw.hit.e.dead ? fw.hit : null }, w, cls, kind);
            laid += fw.len + bk.len;
          }
        }
      }
    };
    // streets off every road every so often, up and down the slope to the next one
    const links = (every, w0, w1, cls, gmax, hitAt, maxLen, keepDead, fromCls) => {
      for (const e of edges.slice()) {
        if (e.dead || e.cls > fromCls || e.pts.length < 6) continue;
        const pts = e.pts, cuts = [];
        for (let i = 3 + Math.floor(r() * (every / STEP)); i < pts.length - 3; i += Math.round(L(every * 0.8, every * 1.25) / STEP)) cuts.push(i);
        for (const i of cuts) for (const sd of [-1, 1]) {
          if (r() < 0.25) continue;
          const p = pts[i], q = pts[i + 1], h = QD(Math.atan2(q[1] - p[1], q[0] - p[0]) + sd * Math.PI / 2);
          if (!land(p[0] + Math.cos(h) * 16, p[1] + Math.sin(h) * 16, 12)) continue;
          const t = trace(p, h, across(gmax), { max: maxLen, gmax: gmax * 1.25, hit: hitAt, shore: 12, clear: 14, turn: 0.2, bend: 1.05 });
          if (t.len < 24 || t.why === 'parallel' || t.why === 'hook' || (!t.hit && !keepDead)) continue;
          if (e.dead) break;
          if (t.hit && t.hit.e === e) continue;
          const pe = e.pts[Math.min(i, e.pts.length - 1)], m = nearest(pe[0], pe[1], 3, null);
          if (!m) continue;
          lay(nodeAt(m.e, m.i), t, Math.round(L(w0, w1) * 2) / 2, cls, 'street');
        }
      }
    };
    // a road that stopped short goes on to the nearest road it can reach
    const close = maxCls => {
      for (const e of edges.slice()) {
        if (e.dead || e.cls > maxCls) continue;
        for (const n of [e.a, e.b]) {
          if (n.e.length !== 1) continue;
          const pts = n === e.a ? e.pts : e.pts.slice().reverse(), p = pts[0], q = pts[Math.min(3, pts.length - 1)];
          const h = QD(Math.atan2(p[1] - q[1], p[0] - q[0])), o = nearest(QP(p[0] + Math.cos(h) * 40), QP(p[1] + Math.sin(h) * 40), 150, e);
          if (!o) continue;
          const tgt = o.e.pts[o.i], to = (x, y, d) => unit(tgt[0] - x, tgt[1] - y);
          const t = trace(p, h, to, { max: 260, gmax: 0.14, hit: 11, shore: 12, clear: 10, turn: 0.26 });
          if (t.hit && t.hit.e !== e) lay(n, t, e.w, e.cls, 'street');
        }
      }
    };
    rows(L(140, 190), 9000, 9.5, 12, 0, 'boulevard', 0.09);
    links(L(150, 210), 8, 9.5, 1, 0.1, 10, 900, false, 0);
    rows(L(78, 96), 16000, 8, 9.5, 1, 'street', 0.1);
    links(L(100, 140), 8, 9, 1, 0.11, 10, 500, false, 1);
    close(1);
    links(L(70, 100), 5.5, 7, 2, 0.12, 9, 300, false, 1);
    rows(L(44, 54), 22000, 5.5, 6.5, 2, 'street', 0.12);
    links(L(60, 85), 5, 6.5, 2, 0.13, 8, 180, true, 2);
    links(L(130, 170), 5.5, 6.5, 2, 0.14, 8, 260, false, 2);
    // lanes: short, narrow, ending inside the blocks
    for (const e of edges.slice()) {
      if (e.dead || e.cls < 1 || e.pts.length < 7) continue;
      for (let i = 3 + Math.floor(r() * 5); i < e.pts.length - 3; i += Math.round(L(50, 95) / STEP)) {
        if (e.dead || r() < 0.35) continue;
        const p = e.pts[i], q = e.pts[i + 1], sd = r() < 0.5 ? -1 : 1, h = QD(Math.atan2(q[1] - p[1], q[0] - p[0]) + sd * (Math.PI / 2 + L(-0.25, 0.25)));
        const t = trace(p, h, (x, y, d) => d, { max: L(40, 80), gmax: 0.16, hit: 9, shore: 12, clear: 10 });
        if (t.len < 30 || t.hit || t.why === 'parallel') continue;
        lay(nodeAt(e, i), t, Math.round(L(3.5, 4.5) * 2) / 2, 3, 'street');
      }
    }
    close(2);
    // one network: a district cut off from the rest gets a road to it, or goes
    for (let pass = 0; pass < 6; pass++) {
      const comp = new Map(); let nc = 0; const size = [];
      for (const n of nodes) {
        if (comp.has(n) || !n.e.length) continue;
        const st = [n]; comp.set(n, nc); size[nc] = 0;
        while (st.length) { const q = st.pop(); for (const e of q.e) { size[nc] += e.pts.length; for (const o of [e.a, e.b]) if (!comp.has(o)) { comp.set(o, nc); st.push(o); } } }
        nc++;
      }
      if (nc < 2) break;
      const main = size.indexOf(Math.max(...size));
      for (let c = 0; c < nc; c++) {
        if (c === main) continue;
        const own = edges.filter(e => !e.dead && comp.get(e.a) === c);
        let best = null;
        for (const e of own) for (let k = 0; k < e.pts.length; k += 3) {
          const p = e.pts[k], o = nearest(p[0], p[1], 240, null);
          // (the search returns the nearest of all, so it is walked out from the road a little)
          for (const a of [0, 1, 2, 3, 4, 5, 6, 7]) {
            const ax = QP(p[0] + Math.cos(a * 0.785) * 60), ay = QP(p[1] + Math.sin(a * 0.785) * 60), q = nearest(ax, ay, 90, null);
            if (q && comp.get(q.e.a) === main) { const d = Math.hypot(q.e.pts[q.i][0] - p[0], q.e.pts[q.i][1] - p[1]); if (!best || d < best.d) best = { d, e, k, q }; }
          }
          void o;
        }
        if (best && !best.e.dead) {
          const p = best.e.pts[best.k], tgt = best.q.e.pts[best.q.i], to = (x, y) => unit(tgt[0] - x, tgt[1] - y);
          const t = trace(p, QD(Math.atan2(tgt[1] - p[1], tgt[0] - p[0])), to, { max: 320, gmax: 0.16, hit: 11, shore: 12, clear: 12, turn: 0.3 });
          if (t.hit && comp.get(t.hit.e.a) === main) { lay(nodeAt(best.e, best.k), t, 8, 1, 'street'); continue; }
        }
        if (pass === 5) for (const e of own) unlink(e);
      }
    }
    // short dead stubs are tidied away; the graph is what is left
    for (let pass = 0; pass < 3; pass++) for (const e of edges) {
      if (e.dead || e.cls !== 2) continue;
      if ((e.a.e.length === 1 || e.b.e.length === 1) && polyLen(e.pts) < 34) unlink(e);
    }
    // two junctions a few metres apart are one junction
    for (const e of edges) {
      if (e.dead || e.a === e.b || e.a.e.length < 3 || e.b.e.length < 3 || polyLen(e.pts) > 24 || e.cls === 0) continue;
      const m = { x: QP((e.a.x + e.b.x) / 2), y: QP((e.a.y + e.b.y) / 2) }, keep = e.a, gone = e.b;
      unlink(e);
      keep.x = m.x; keep.y = m.y;
      for (const q of gone.e.slice()) { if (q.a === gone) q.a = keep; if (q.b === gone) q.b = keep; keep.e.push(q); }
      gone.e.length = 0;
      for (const q of keep.e) {
        if (q.a === keep) q.pts[0] = [m.x, m.y];
        if (q.b === keep) q.pts[q.pts.length - 1] = [m.x, m.y];
      }
    }
    // some of the side streets that join two bigger roads carry traffic between them, and are
    // built wider for it
    for (const e of edges) {
      if (e.dead || e.cls !== 2) continue;
      const big = n => n.e.some(q => q.cls < 2);
      if (big(e.a) && big(e.b) && polyLen(e.pts) > 40 && r() < 0.5) { e.w = Math.round(L(8, 9) * 2) / 2; e.cls = 1; }
    }
    return { nodes: nodes.filter(n => n.e.length), edges: edges.filter(e => !e.dead) };
  }

  // The town's road markings, part of the town. Streets that carry straight on through a junction
  // are one road and share one paint; that road has priority there, its lines run on across the
  // junction, and the streets that meet it stop at a line. Crossings go where a town needs them.
  // None of this knows where any lap goes: a race drives over the paint the town already has.
  function roadMarks(net, seed) {
    const r = U.rng(seed);
    const up = new Map(), find = e => { let q = e; while (up.get(q) !== q) q = up.get(q); return q; };
    for (const e of net.edges) up.set(e, e);
    const heading = (n, e) => { const P = e.a === n ? e.pts : e.pts.slice().reverse(), q = P[Math.min(2, P.length - 1)]; return Math.atan2(q[1] - n.y, q[0] - n.x); };
    for (const n of net.nodes) {
      n.through = n.e.length === 2 && n.e[0] !== n.e[1] ? [n.e[0], n.e[1]] : null;
      let best = n.through ? Infinity : -1;
      for (let i = 0; i < n.e.length; i++) for (let j = i + 1; j < n.e.length; j++) {
        const a = n.e[i], b = n.e[j];
        if (a === b || Math.abs(U.wrapAngle(heading(n, a) - heading(n, b))) < 2.65 || Math.abs(a.w - b.w) > 2.2) continue;
        const sc = (4 - Math.max(a.cls, b.cls)) * 100 + a.w + b.w;
        if (sc > best) { best = sc; n.through = [a, b]; }
      }
      if (n.through) { const a = find(n.through[0]), b = find(n.through[1]); if (a !== b) up.set(a, b); }
    }
    const marks = new Map();
    for (const e of net.edges) {
      const k = find(e);
      if (!marks.has(k)) marks.set(k, { type: r(), mid: (r() - 0.5) * (e.w >= 9 ? 1.5 : 0.35), edge: r() < 0.42, bays: r() < 0.45 ? (r() < 0.5 ? -1 : 1) : 0 });
      e.mark = marks.get(k); e.zeb = [false, false];
    }
    for (const n of net.nodes) {
      if (n.e.length < 3) continue;
      for (const e of n.e) {
        const main = n.through && n.through.includes(e), end = e.a === n ? 0 : 1;
        if (e.w >= 6 && r() < (main ? 0.14 : 0.4)) e.zeb[end] = true;
      }
    }
  }

  // The roads wide enough to race on, as a planar map: its faces are the big blocks between them,
  // and the boundary of any solid group of faces is a loop along streets that never crosses or
  // touches itself. That is what a lap of a town is. Half edges keep their face on the left.
  function raceMap(net) {
    const alive = new Set(net.edges.filter(e => e.w >= 7.9));
    for (let again = true; again;) {
      again = false;
      for (const e of alive) {
        const deg = n => n.e.filter(q => alive.has(q)).length;
        if (deg(e.a) < 2 || deg(e.b) < 2) { alive.delete(e); again = true; }
      }
    }
    const hs = [], out = new Map();
    for (const e of alive) {
      const f = { e, from: e.a, to: e.b, pts: e.pts }, b = { e, from: e.b, to: e.a, pts: e.pts.slice().reverse() };
      f.twin = b; b.twin = f; hs.push(f, b);
      for (const h of [f, b]) {
        const p = h.pts[Math.min(2, h.pts.length - 1)];
        h.ang = Math.atan2(p[1] - h.from.y, p[0] - h.from.x);
        if (!out.has(h.from)) out.set(h.from, []);
        out.get(h.from).push(h);
      }
    }
    for (const a of out.values()) a.sort((p, q) => p.ang - q.ang);
    for (const h of hs) { const a = out.get(h.to), k = a.indexOf(h.twin); h.next = a[(k - 1 + a.length) % a.length]; }
    const faces = [];
    for (const h0 of hs) {
      if (h0.face != null) continue;
      const f = { hs: [], area: 0 };
      let h = h0, guard = 0;
      do {
        h.face = faces.length; f.hs.push(h);
        for (let k = 0; k < h.pts.length - 1; k++) f.area += h.pts[k][0] * h.pts[k + 1][1] - h.pts[k + 1][0] * h.pts[k][1];
        h = h.next;
      } while (h !== h0 && ++guard < 5000);
      f.area /= 2; faces.push(f);
    }
    return { hs, faces, ok: f => faces[f].area > 2000 && faces[f].area < 900000 };
  }
  // the loop round a set of faces, if it is one simple loop: { hs, pts, len }
  function loopOf(M, set) {
    const bd = [], from = new Map();
    for (const f of set) for (const h of M.faces[f].hs) if (!set.has(h.twin.face)) { if (from.has(h.from)) return null; from.set(h.from, h); bd.push(h); }
    if (!bd.length) return null;
    const hs = []; let h = bd[0], guard = 0;
    do { hs.push(h); h = from.get(h.to); } while (h && h !== bd[0] && ++guard < 2000);
    if (!h || hs.length !== bd.length) return null;
    const pts = [];
    for (const q of hs) for (let k = 0; k < q.pts.length - 1; k++) pts.push(q.pts[k]);
    pts.push(pts[0]);
    return { hs, pts, len: polyLen(pts) };
  }
  // Laps worth racing: a block grown outward from a long road. The loop is judged only as what it
  // is, a drive round some streets: long enough, with a straight to start on, and no corner a car
  // could not get round; a good one has plenty of corners and climbs the hill.
  function lapsOf(net, T, r, st) {
    const M = raceMap(net), found = [], usable = M.faces.map((f, k) => k).filter(M.ok);
    if (!usable.length) return found;
    const neigh = f => { const o = new Set(); for (const h of M.faces[f].hs) if (h.twin.face !== f && M.ok(h.twin.face)) o.add(h.twin.face); return [...o]; };
    const judge = lp => {
      if (lp.len < st.len[0] || lp.len > st.len[1]) return -1;
      let sharp = 0, turns = 0, zmin = Infinity, zmax = -Infinity;
      const n = lp.hs.length;
      for (let k = 0; k < n; k++) {
        const a = lp.hs[k], b = lp.hs[(k + 1) % n], p = a.pts[Math.max(0, a.pts.length - 3)], q = a.pts[a.pts.length - 1], c = b.pts[Math.min(2, b.pts.length - 1)];
        const t = Math.abs(U.wrapAngle(Math.atan2(c[1] - q[1], c[0] - q[0]) - Math.atan2(q[1] - p[1], q[0] - p[0])));
        if (t > 2.6) return -1;
        if (t > 0.5) turns++;
        if (t > 1.2) sharp++;
        zmin = Math.min(zmin, T.H(q[0], q[1])); zmax = Math.max(zmax, T.H(q[0], q[1]));
      }
      if (turns < 7) return -1;
      const hill = Math.min(1, (zmax - zmin) / 40);
      const area = Math.abs(lp.pts.reduce((s, p, k) => { const q = lp.pts[(k + 1) % lp.pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
      const fill = area / (lp.len * lp.len / (4 * Math.PI));   // a thin, winding shape over a plain ring
      let main = 0; for (const h of lp.hs) if (h.e.cls === 0) main += polyLen(h.pts);
      const perKm = turns / (lp.len / 1000);
      return 2 * hill + 3 * main / lp.len - Math.abs(perKm - 6) * 0.4 + Math.min(sharp, 8) / 8 - Math.abs(fill - 0.4) * 3 + 4;
    };
    for (let run = 0; run < 90; run++) {
      const set = new Set([usable[Math.floor(r() * usable.length)]]);
      for (let g = 0; g < 40; g++) {
        const lp = loopOf(M, set);
        if (lp) {
          if (lp.len > st.len[1]) break;
          const sc = judge(lp);
          if (sc > 0) found.push({ lp, sc: sc + r() * 0.3 });
        }
        const edge = []; for (const f of set) for (const q of neigh(f)) if (!set.has(q)) edge.push(q);
        if (!edge.length) break;
        const add = edge[Math.floor(r() * edge.length)];
        set.add(add);
        if (!loopOf(M, set)) { set.delete(add); if (r() < 0.3) break; }
      }
    }
    found.sort((p, q) => q.sc - p.sc);
    const seen = new Set(), best = [];
    for (const f of found) { const k = Math.round(f.lp.len); if (seen.has(k)) continue; seen.add(k); best.push(f.lp); if (best.length >= 6) break; }
    return best;
  }
  // A lap's corners, for the track builder: each junction's radius is what fits inside the
  // streets that meet there, so the racing road stays on the road.
  function lapVertices(lp) {
    const v = routeVertices(lp.pts), ends = lp.hs.map((h, k) => ({ x: h.to.x, y: h.to.y, w: Math.min(h.e.w, lp.hs[(k + 1) % lp.hs.length].e.w) }));
    for (const p of v) {
      if (p[3] < 0.5) continue;
      let w = 0, bd = 40;
      for (const q of ends) { const d = Math.hypot(q.x - p[0], q.y - p[1]); if (d < bd) { bd = d; w = q.w; } }
      if (w) p[2] = Math.min(p[2], Math.max(9, w / 2 + 6));
    }
    return v;
  }
  // The circuit's limits are the kerbs of the streets it runs on: every sample looks out to each
  // side until it leaves those streets. Past a junction that is the line of the kerb carried across
  // the mouth of the side road, where the barrier runs.
  function streetLimits(tr, lp, xf) {
    const N = tr.N, CELL = 16, grid = new Map(), segs = [];
    let s = 0;
    for (const h of lp.hs) for (let k = 0; k < h.pts.length - 1; k++) {
      const a = xf.toWorld(h.pts[k]), b = xf.toWorld(h.pts[k + 1]), l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const q = { a, b, l, ux: (b[0] - a[0]) / (l || 1), uy: (b[1] - a[1]) / (l || 1), R: h.e.w / 2, s };
      s += l; segs.push(q);
      for (let t = 0; t <= l; t += 8) { const c = Math.floor((a[0] + q.ux * t) / CELL) + ',' + Math.floor((a[1] + q.uy * t) / CELL); if (!grid.has(c)) grid.set(c, []); grid.get(c).push(q); }
    }
    const total = s;
    const inside = (x, y) => {
      const c0 = Math.floor(x / CELL), c1 = Math.floor(y / CELL);
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) for (const q of grid.get((c0 + i) + ',' + (c1 + j)) || []) {
        const dx = x - q.a[0], dy = y - q.a[1], t = U.clamp(dx * q.ux + dy * q.uy, 0, q.l);
        if (Math.hypot(dx - q.ux * t, dy - q.uy * t) < q.R) return true;
      }
      return false;
    };
    void total;
    for (const side of [0, 1]) {
      const sg = side ? 1 : -1, b = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        let d = tr.hw - 0.4;
        while (d < 40 && inside(tr.x[i] + tr.nx[i] * sg * d, tr.y[i] + tr.ny[i] * sg * d)) d += 0.3;
        b[i] = Math.max(tr.hw + 0.3, d - 0.7);
      }
      // the wall has no steps: it closes in on the road no faster than it can bend, both ways round
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < N; i++) b[(i + 1) % N] = Math.min(b[(i + 1) % N], b[i] + 0.45 * tr.ds);
        for (let i = N - 1; i >= 0; i--) b[i] = Math.min(b[i], b[(i + 1) % N] + 0.45 * tr.ds);
      }
      for (let i = 0; i < N; i++) b[i] = Math.max(b[i], tr.hw + 0.3);
      // a light smoothing; the pit lane's opening is left as built
      for (let i = 0; i < N; i++) {
        let m = 0; for (let q = -2; q <= 2; q++) m += b[(i + q + N) % N];
        const v = m / 5;
        if (isNaN(tr.pit.off[i])) { tr.barr[side][i] = v; tr.runT[side][i] = F1.SURF.TARMAC; tr.runW[side][i] = Math.max(0, v - tr.hw); }
      }
    }
  }

  // ---------- one candidate ----------
  function candidate(r, seed, style) {
    const st = STYLES[style];
    let lay, s0, town = null, m = 1, xf = null;
    if (style === 'city') {
      const T = cityTerrain(r), net = roadSystem(T, r);
      if (!net) return { fail: 'shore road' };
      roadMarks(net, T.s + 77);
      const laps = lapsOf(net, T, r, st);
      if (!laps.length) return { fail: 'no lap in the streets' };
      m = r() < 0.5 ? 1 : -1;
      const ang = r() * 2 * Math.PI, ca = Math.cos(ang), sa = Math.sin(ang);
      xf = { toWorld: p => [ca * m * p[0] - sa * p[1], sa * m * p[0] + ca * p[1]], toLocal: (x, y) => [(ca * x + sa * y) * m, -sa * x + ca * y] };
      // the first lap with a long enough easy stretch to line a grid up on: 240 m behind the line
      // and 90 ahead of it with no real corner
      for (const lp of laps) {
        // (a town races on the streets wide enough for it: the ones a lap uses are its broad ones)
        const was = lp.hs.map(h => h.e.w);
        for (const h of lp.hs) h.e.w = Math.max(h.e.w, 10.6);
        const vt0 = lapVertices(lp), n = vt0.length, ls = [];
        let tot = 0;
        for (let k = 0; k < n; k++) { const l = Math.hypot(vt0[(k + 1) % n][0] - vt0[k][0], vt0[(k + 1) % n][1] - vt0[k][1]); ls.push(l); tot += l; }
        // from every vertex, the turning met within the window round a point part way along it
        let best = null;
        for (let k = 0; k < n; k++) {
          let s0 = 0, turn = 0;
          for (let q = 1; q < n && s0 < 330; q++) { s0 += ls[(k + q - 1) % n]; if (s0 < 330) turn += Math.abs(vt0[(k + q) % n][3] * 1) * (vt0[(k + q) % n][3] > 0.35 ? 3 : 1); }
          if (!best || turn < best.turn) best = { k, turn };
        }
        if (!best || best.turn > 0.42) { lp.hs.forEach((h, k) => { h.e.w = was[k]; }); continue; }
        // the line 240 m on from the start of that stretch
        let i = best.k, left = 240;
        while (left > ls[i % n]) { left -= ls[i % n]; i++; }
        const j = i % n, vt = vt0.slice(j).concat(vt0.slice(0, j));
        lay = { v: vt.slice(1).concat([vt[0]]).map(q => { const w = xf.toWorld(q); return [Math.round(w[0] * 10) / 10, Math.round(w[1] * 10) / 10, q[2]]; }), startAt: Math.max(0.02, Math.min(0.95, left / ls[j])), pitSides: [1, -1], lp };
        void tot;
        break;
      }
      if (!lay) return { fail: 'no straight' };
      town = { T, net, lp: lay.lp };
      {
        const lapE = new Set(lay.lp.hs.map(h => h.e)), mouths = [];
        let s = 0;
        lay.lp.hs.forEach(h => {
          const n = h.to, a = h.pts[Math.max(0, h.pts.length - 3)], b = h.pts[h.pts.length - 1];
          s += polyLen(h.pts);
          for (const e of n.e) {
            if (lapE.has(e)) continue;
            const q = e.a === n ? e.pts[Math.min(2, e.pts.length - 1)] : e.pts[Math.max(0, e.pts.length - 3)];
            mouths.push({ s, e, side: Math.sign((b[0] - a[0]) * (q[1] - b[1]) - (b[1] - a[1]) * (q[0] - b[0])) });
          }
        });
        mouths.sort((p, q) => p.s - q.s);
        const last = {};
        for (const m0 of mouths) {
          const o = last[m0.side];
          if (o != null && m0.s - o < 30 && m0.e.cls >= 2) { m0.e.drop = true; continue; }
          last[m0.side] = m0.s;
        }
        for (const e of net.edges) if (e.drop) { e.a.e.splice(e.a.e.indexOf(e), 1); e.b.e.splice(e.b.e.indexOf(e), 1); }
        net.edges = net.edges.filter(e => !e.drop);
      }
    } else {
      lay = openLayout(r, style, st);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of lay.v) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      s0 = site(r, style, [x0, y0, x1, y1]);
    }
    let width = Math.round(U.lerp(st.width[0], st.width[1], r()));
    if (town) width = Math.min(width, Math.max(7.8, Math.min(...town.lp.hs.map(h => h.e.w)) - 0.6));
    const look = st.looks[Math.floor(r() * st.looks.length)];
    const city = style === 'city';
    const def = {
      id: 'gen2-' + style + '-' + seed, gen2: true, seed: seed % 100000 + 101, gen: seed, style: city ? 'street' : style === 'mountain' ? 'park' : style,
      style2: style, name: F1.TrackGen._word(r) + ' ' + (city ? 'Harbour Circuit' : style === 'mountain' ? 'Mountain Circuit' : style === 'modern' ? 'Grand Prix Circuit' : 'Park'),
      width, look, startAt: city ? +lay.startAt.toFixed(3) : 0.55, v: lay.v,
      pit: city ? { side: 1, entry: -200, exit: 140, offset: 15, lane: 9 } : { side: 1, entry: -400, exit: 240, offset: 22, lane: 12 },
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
      if (!g.ok) return { fail: g.fails[0].split(':')[0], detail: g.fails.join(' | ') };
    }
    // the circuit is the streets it runs on: the town's kerbs are its limits
    let role = null;
    if (city) {
      streetLimits(tr, town.lp, xf);
      for (const h of town.lp.hs) h.e.lap = true;
      const lapPt = town.lp.pts, kinds = e => (e.kind === 'coast' ? 'coast' : e.kind === 'boulevard' ? 'boulevard' : 'street');
      const S = { roads: town.net.edges.map(e => ({ pts: e.pts, w: e.w, kind: kinds(e), lap: !!e.lap, cls: e.cls === 0 ? 'primary' : e.cls === 1 ? 'secondary' : 'tertiary' })) };
      s0 = citySite(r, { T: town.T, S, plaza: lapPt[Math.floor(lapPt.length * 0.4)], rail: [], squares: [] }, xf);
      // (the graph itself, in the world, for the renderer's road mesh)
      const ids = new Map(); town.net.nodes.forEach((n, k) => ids.set(n, k));
      const eid = new Map(); town.net.edges.forEach((e, k) => eid.set(e, k));
      s0.net = { nodes: town.net.nodes.map(n => { const w = xf.toWorld([n.x, n.y]), th = n.through && eid.has(n.through[0]) && eid.has(n.through[1]) ? [eid.get(n.through[0]), eid.get(n.through[1])] : null; return { x: w[0], y: w[1], through: th }; }), edges: town.net.edges.map(e => ({ a: ids.get(e.a), b: ids.get(e.b), pts: e.pts.map(xf.toWorld), w: e.w, cls: e.cls, lap: !!e.lap, mark: e.mark, zeb: e.zeb })) };
      role = new Array(tr.N).fill('street');
    }
    // grade the road over the natural ground
    const raw = new Float64Array(tr.N);
    for (let i = 0; i < tr.N; i++) raw[i] = s0.H(tr.x[i], tr.y[i]);
    // a harbour town's quays and seafront stand a couple of metres above the water
    const tunnel = null;
    if (city) for (let i = 0; i < tr.N; i++) raw[i] = Math.max(raw[i], 2.5);
    const gr = grade(tr, raw, st);
    applyProfile(tr, gr.z, s0.H, st);
    tr.H2 = groundFn(tr, s0.H, st.slope);
    tr.H = s0.H;          // the natural ground (the renderer's outer terrain)
    tr.waterY = null;     // a town's sea comes from its coastline, not the first generator's harbour
    const res = { def, tr, style, st, site: s0, raw, gl: gr.gl, speed: gr.v, seed };
    if (city) {
      res.city = { buildings: F1.roadOnly ? [] : cityBuildings(r, tr, s0), roads: s0.roads };
      res.role = role;
      res.tunnel = tunnel;
    }
    tr.gen2 = res; // the town, the harbour and the tunnel, for the renderer
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
    if (dk > (style === 'city' ? 0.05 : 0.035)) fail('kink', dk.toFixed(3));   // a street corner turns in more abruptly
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
      if (Math.abs(tr.kap[i]) > (style === 'city' ? 1 / 200 : 1 / 900)) { fail('grid', 'start straight bends'); break; }
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
    if (style !== 'city' && (!slow || !fast)) fail('variety');
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
    if (style !== 'city') {
      const rl = realism(tr, style);
      info.real = rl.m;
      if (rl.out.length) fail('realism', rl.out.join(', '));
    }
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
      for (const b of B) if (!polyClear(tr, b.poly, tr.hw + 4) || b.poly.some(p => site.inland(p[0], p[1]) < 2.5)) { fail('building on the road'); break; }
      info.buildings = B.length;
      if (B.length < 150 && !F1.roadOnly) fail('too few buildings', String(B.length));
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
    if (res.fail) return { ok: false, why: [res.fail], detail: res.detail };
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

  // ---------- in the game ----------
  // A circuit's id carries its style, seed and winning candidate (gen2-city-1234-57), so any
  // thread, the AI learning workers included, rebuilds it from that one candidate, not a search.
  const NAMES = {
    city: { suf: ['Harbour Circuit', 'Street Circuit', 'Riviera Circuit', 'Marina Circuit'], regions: ['Riviera Coast', 'Harbour Coast', 'Corniche', 'Bay Province'], kind: 'Street circuit through a harbour town' },
    park: { suf: ['Park', 'Ring', 'Circuit', 'Raceway'], regions: ['Northern Isles', 'Midland Downs', 'Lakeland', 'Upper Plains'], kind: 'Parkland circuit' },
    mountain: { suf: ['Mountain Circuit', 'Ring', 'Hill Circuit'], regions: ['Highland Pass', 'Cedar Valley', 'Mountain Province'], kind: 'Mountain circuit' },
    modern: { suf: ['International Circuit', 'Autodrome', 'Grand Prix Circuit'], regions: ['Desert Gulf', 'Salt Plains', 'Coastal Plain'], kind: 'Modern circuit' },
  };
  const idOf = (style, seed, cand) => 'gen2-' + style + '-' + seed + '-' + cand;
  const parseId = id => { const m = /^gen2-(city|park|mountain|modern)-(\d+)-(\d+)$/.exec(id || ''); return m ? { style: m[1], seed: +m[2], cand: +m[3] } : null; };
  const defs = new Map(), fresh = new Map();
  // the game's definition for a finished circuit: name, country, flag and blurb, its id, and the
  // fields the track list and the AI learning look for
  function present(res) {
    const d = res.def, style = res.style, seed = res.seed, cand = res.cand, nm = NAMES[style];
    const r = U.rng(seed * 7919 + cand * 31 + 3);
    const word = F1.TrackGen._word(r), suf = nm.suf[Math.floor(r() * nm.suf.length)];
    const info = res.report.info, km = (res.tr.L / 1000).toFixed(2);
    Object.assign(d, {
      id: idOf(style, seed, cand), gen: seed, gen2: { style, seed, cand },
      name: word + ' ' + suf, country: nm.regions[Math.floor(r() * nm.regions.length)], flag: word.slice(0, 2).toUpperCase(),
      blurb: `${nm.kind} built from seed ${seed}. ${km} km, ${info.corners} corners, climbing ${Math.round(info.range)} m with ${(info.gMax * 100).toFixed(0)} % at its steepest.`,
    });
    res.tr.id = d.id; res.tr.name = d.name;
    defs.set(d.id, d);
    return d;
  }
  // a candidate rebuilt from an id
  function rebuild(id) {
    const p = parseId(id);
    if (!p) return null;
    const a = attempt(p.seed, p.style, p.cand);
    if (!a.ok) throw new Error('circuit ' + id + ' does not rebuild: ' + a.why.join(', '));
    a.res.tries = p.cand + 1;
    present(a.res);
    return a.res;
  }
  // a circuit just made (on the worker pool): its definition is known now and its built track is
  // handed over once, to save building it again
  function adopt(res) { const d = present(res); fresh.set(d.id, res.tr); return d; }
  function defById(id) { return defs.get(id) || (parseId(id) ? rebuild(id).def : null); }
  function trackById(id) {
    const t = fresh.get(id);
    if (t) { fresh.delete(id); return t; }
    return rebuild(id).tr;
  }

  F1.TrackGen2 = { _city: { cityTerrain, citySite, cityBuildings, routeVertices, roadSystem, raceMap, lapsOf }, idOf, parseId, adopt, defById, trackById, present, layoutStats, make, attempt, styleOf, MAX_TRIES, verify, STYLES, STYLE_LIST, REAL: () => REAL, realStats, gradeLimit, smoothLoop, loads };
})(typeof window !== 'undefined' ? window : globalThis);
