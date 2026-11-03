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
    city: { width: [10, 11], len: [3000, 4000], gMax: 0.14, gCorner: 0.09, gHair: 0.055, gGrid: 0.03, minR: 8, sep: 19, range: [16, 80], slope: 6, corners: [11, 28], looks: ['lucerne'] },
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
  const cfail = {}, no = w => { cfail[w] = (cfail[w] || 0) + 1; return null; };
  // the steepest a street climbs over any 40 m of it
  const steepest = (T, pts) => { const q = resample(pts, 4); let g = 0; for (let k = 10; k < q.length; k++) g = Math.max(g, Math.abs(T.H(q[k][0], q[k][1]) - T.H(q[k - 10][0], q[k - 10][1])) / 40); return g; };
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
  // the town's streets, segments hashed so each new one is kept clear of the rest
  function streetIndex() {
    const roads = [], cell = 40, grid = new Map();
    // (each street keeps the cells it is filed in, so it can be refiled)
    const file = rd => {
      const keys = rd._cells = new Set();
      for (let k = 0; k < rd.pts.length - 1; k++) {
        const a = rd.pts[k], b = rd.pts[k + 1];
        for (let cx = Math.floor(Math.min(a[0], b[0]) / cell); cx <= Math.floor(Math.max(a[0], b[0]) / cell); cx++) {
          for (let cy = Math.floor(Math.min(a[1], b[1]) / cell); cy <= Math.floor(Math.max(a[1], b[1]) / cell); cy++) {
            const kk = cx + ',' + cy;
            if (!grid.has(kk)) grid.set(kk, []);
            grid.get(kk).push([rd, a, b]); keys.add(kk);
          }
        }
      }
    };
    const add = rd => { roads.push(rd); file(rd); return rd; };
    // the nearest street edge to (x, y) within R: { d, rd, p } (p: the nearest point on it)
    const near = (x, y, R, skip) => {
      let best = R, brd = null, bp = null, bdir = null;
      const e = R + 12;
      for (let cx = Math.floor((x - e) / cell); cx <= Math.floor((x + e) / cell); cx++) {
        for (let cy = Math.floor((y - e) / cell); cy <= Math.floor((y + e) / cell); cy++) {
          const list = grid.get(cx + ',' + cy);
          if (list) for (const [rd, a, b] of list) {
            if (skip && skip.indexOf(rd) >= 0) continue;
            const d = pseg(x, y, a, b) - rd.w / 2;
            if (d < best) {
              best = d; brd = rd;
              const vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy || 1, t = U.clamp(((x - a[0]) * vx + (y - a[1]) * vy) / l2, 0, 1);
              bp = [a[0] + vx * t, a[1] + vy * t];
              const l = Math.sqrt(l2); bdir = [vx / l, vy / l];
            }
          }
        }
      }
      return { d: best, rd: brd, p: bp, dir: bdir };
    };
    const reset = (rd, pts) => {
      for (const kk of rd._cells || []) { const list = grid.get(kk); if (list) grid.set(kk, list.filter(e => e[0] !== rd)); }
      rd.pts = pts; file(rd);
    };
    return { roads, add, near, reset };
  }
  // a smooth street from P (heading h0) to Q (arriving at heading h1): a cubic Hermite curve,
  // its tangents three quarters of the chord, finely sampled
  function hermite(P, h0, Q, h1) {
    const c = Math.hypot(Q[0] - P[0], Q[1] - P[1]) * 0.75, n = Math.max(6, Math.ceil(c / 1.1)), out = [];
    const t0x = Math.cos(h0) * c, t0y = Math.sin(h0) * c, t1x = Math.cos(h1) * c, t1y = Math.sin(h1) * c;
    for (let i = 0; i <= n; i++) {
      const s = i / n, s2 = s * s, s3 = s2 * s, a = 2 * s3 - 3 * s2 + 1, b = s3 - 2 * s2 + s, e = -2 * s3 + 3 * s2, f = s3 - s2;
      out.push([a * P[0] + b * t0x + e * Q[0] + f * t1x, a * P[1] + b * t0y + e * Q[1] + f * t1y]);
    }
    return out;
  }
  const polyLen = pl => { let l = 0; for (let i = 1; i < pl.length; i++) l += Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]); return l; };
  // the tightest radius a polyline turns at (more than trim metres from its ends)
  function minRadius(pl, trim = 0) {
    let best = Infinity, s = 0;
    const tot = trim ? polyLen(pl) : 0;
    for (let i = 1; i < pl.length - 1; i++) {
      s += Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]);
      if (trim && (s < trim || tot - s < trim)) continue;
      const a = Math.atan2(pl[i][1] - pl[i - 1][1], pl[i][0] - pl[i - 1][0]), b = Math.atan2(pl[i + 1][1] - pl[i][1], pl[i + 1][0] - pl[i][0]);
      const t = Math.abs(U.wrapAngle(b - a)), l = (Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]) + Math.hypot(pl[i + 1][0] - pl[i][0], pl[i + 1][1] - pl[i][1])) / 2;
      if (t > 1e-6) best = Math.min(best, l / t);
    }
    return best;
  }
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
  // A road traced over the ground the way hill roads are engineered: at every step it heads
  // along the contour, turned up (or down) the slope just enough to climb at its grade (no more
  // than maxA off the contour, so on gentle ground it climbs less), and turns no tighter than
  // Rmin. hold: a height it keeps to instead (a terrace). Stops when it reaches toH, runs maxLen,
  // reaches the sea or the edge, or comes within reach of another street (where it meets it).
  function trace(T, S, p0, hd, o) {
    const step = 4, out = [[p0[0], p0[1]]], skip = o.skip || [];
    let x = p0[0], y = p0[1], len = 0, why = 'length', hit = null;
    const p0hd = hd;
    const maxA = o.maxA || 0.9, Rmin = o.Rmin || 30;
    while (len < o.maxLen) {
      const g = T.grad(x, y), sl = Math.hypot(g[0], g[1]);
      let want = o.straight && o.bend ? p0hd + o.bend * Math.sin(len / 140 + (o.bendP || 0)) : hd;
      if (sl > 0.015 && !o.straight) {
        let tdir = Math.atan2(g[0], -g[1]);                      // along the contour
        if (Math.cos(tdir - hd) < 0) tdir += Math.PI;
        let gr = o.grade;
        if (o.hold != null) gr = U.clamp((o.hold + (o.holdW ? o.holdW(len) : 0) - T.H(x, y)) * 0.04, -0.06, 0.06) + (o.grade || 0);
        const a = Math.asin(U.clamp(gr / sl, -1, 1)), sgn = Math.sign(U.wrapAngle(Math.atan2(g[1], g[0]) - tdir)) || 1;
        want = tdir + sgn * U.clamp(a, -maxA, maxA);
      }
      hd += U.clamp(U.wrapAngle(want - hd), -step / Rmin, step / Rmin);
      x += Math.cos(hd) * step; y += Math.sin(hd) * step; len += step;
      out.push([x, y]);
      if (o.toH != null && (o.grade > 0 ? T.H(x, y) >= o.toH : T.H(x, y) <= o.toH)) { why = 'height'; break; }
      if (x < T.X0 + 80 || x > T.X1 - 80 || y < T.Y0 + 80 || y > T.Y1 - 80) { why = 'edge'; break; }
      if (T.inland(x, y) < (o.shore || 14)) { why = 'sea'; break; }
      if (len > (o.free || 10)) {
        const nr = S.near(x, y, Math.max(30, (o.sep || 0) + 10), skip);
        if (nr.d < (o.w || 9) / 2 + 2) { why = 'hit'; hit = nr; out[out.length - 1] = nr.p; break; }
        // running alongside another street: stop short of it (a dead end), never braid into it
        if (o.sep && nr.d < o.sep && nr.dir && Math.abs(Math.cos(hd) * nr.dir[0] + Math.sin(hd) * nr.dir[1]) > 0.82) { why = 'close'; break; }
      }
      if (o.closeLoop && len > 120 && Math.hypot(x - p0[0], y - p0[1]) < 10) { why = 'loop'; out.push([p0[0], p0[1]]); break; }
      if (o.avoid && o.avoid(x, y)) { why = 'avoid'; break; }
    }
    return { pts: out, why, hit, hd, len };
  }
  // a bend of radius R through angle ang, turning the given way (+1 left, -1 right) from heading
  // hd at P
  function arc(P, hd, R, turn, ang) {
    const nx = -Math.sin(hd) * turn, ny = Math.cos(hd) * turn, C = [P[0] + nx * R, P[1] + ny * R], out = [], n = Math.max(3, Math.ceil(ang * R / 3));
    const a0 = Math.atan2(P[1] - C[1], P[0] - C[0]);
    for (let k = 1; k <= n; k++) { const a = a0 + turn * ang * k / n; out.push([C[0] + Math.cos(a) * R, C[1] + Math.sin(a) * R]); }
    return { pts: out, hd: hd + turn * ang, end: out[out.length - 1] };
  }
  // a hairpin of radius R turning the given way (+1 left, -1 right) from heading hd at P
  function hairpin(P, hd, R, turn) {
    const nx = -Math.sin(hd) * turn, ny = Math.cos(hd) * turn, C = [P[0] + nx * R, P[1] + ny * R], out = [];
    const a0 = Math.atan2(P[1] - C[1], P[0] - C[0]);
    for (let k = 1; k <= 14; k++) { const a = a0 + turn * Math.PI * k / 14; out.push([C[0] + Math.cos(a) * R, C[1] + Math.sin(a) * R]); }
    return { pts: out, hd: hd + turn * Math.PI };
  }
  // ---------- the town and its lap ----------
  function cityTown(r) {
    const T = cityTerrain(r), L = T.L, D2 = Math.PI / 180, S = streetIndex();
    const qq = L(17, 22), qw = L(25, 30), sb = L(75, 110), R1 = L(28, 38), sx = T.sx, cs = Math.hypot(1, sx);
    const quayX = y => sx * y - qw * cs, blvdX = y => sx * y - (qw + sb) * cs, hs = Math.atan2(1, sx), xA = blvdX(0);
    const street = (pts, w, kind, extra) => S.add(Object.assign({ pts, w, kind }, extra || {}));
    // the coast road: off the open coast and the head quay, round the basin's corner and down the
    // side quay. One street from the side quay's south end to the east edge
    const yR = -T.D + L(42, 60);
    const coast = [];
    for (let y = yR - 20; y < qq - R1; y += 5) coast.push([quayX(y), y]);
    const c1 = [quayX(qq) + R1 * 0.9, qq];
    for (const q of resample(hermite([quayX(qq - R1), qq - R1], hs, c1, 0), 5).slice(1)) coast.push(q);
    for (let x = c1[0] + 5; x < T.X1 - 120; x += 5) {
      const d = (T.cl(x + 1) - T.cl(x - 1)) / 2, l = Math.hypot(1, d);
      coast.push([x - d / l * qq, T.cl(x) + qq / l]);
    }
    const coastRd = street(coast, L(11, 14), 'coast', { lap: true, cls: 'primary' });   // (the seafront: a dual carriageway)
    // the boulevard a block behind the side quay, from the headland's foot to the basin's head
    const yJ = qq + L(32, 44);
    const blvd = [];
    for (let y = -T.D + 20; y <= yJ + L(40, 90); y += 5) blvd.push([blvdX(y), y]);
    const blvdRd = street(blvd, L(10, 13), 'boulevard', { lap: true, cls: 'primary' });
    // ---- the lap ----
    const pieces = [];
    const add = (pts, role) => pieces.push([pts, role]);
    // the climb: from the square corner at the basin's head, diagonally up the hillside
    const Ttop = L(30, 36), gc = L(0.055, 0.08);
    const climb = trace(T, S, [blvdX(yJ), yJ], 0, { grade: gc, maxA: 0.6, Rmin: 70, toH: Ttop, maxLen: 900, skip: [blvdRd], w: 12, free: 30 });
    if (climb.why !== 'height' || climb.len < 250) return { fail: 'climb ' + climb.why };
    const climbRd = street(climb.pts, L(7, 8.5), 'street', { lap: true, cls: 'primary' });
    // along the top, holding its height round the hillside, to the square
    const top = trace(T, S, climb.pts[climb.pts.length - 1], climb.hd, { hold: Ttop, grade: 0, Rmin: 45, maxLen: L(140, 280), w: 12, skip: [climbRd] });
    if (top.why !== 'length') return { fail: 'top ' + top.why };
    // a long left up round the square's gardens, a short straight past them
    const ga = arc(top.pts[top.pts.length - 1], top.hd, L(40, 60), 1, L(20, 40) * D2), gs = [];
    for (let k = 1, n = Math.round(L(20, 40) / 4); k <= n; k++) gs.push([ga.end[0] + Math.cos(ga.hd) * k * 4, ga.end[1] + Math.sin(ga.hd) * k * 4]);
    top.pts = top.pts.concat(ga.pts, gs); top.hd = ga.hd;
    // the square: a right turn round its garden, then down the far side
    const cTurn = L(80, 110) * D2, pc = top.pts[top.pts.length - 1], ca = arc(pc, top.hd, L(16, 22), -1, cTurn);
    const hdc = ca.hd, sq = ca.pts.slice();
    const sqLen = L(25, 45);
    for (let k = 1; k <= Math.round(sqLen / 4); k++) sq.push([ca.end[0] + Math.cos(hdc) * k * 4, ca.end[1] + Math.sin(hdc) * k * 4]);
    const plaza = [pc[0] + Math.cos(top.hd - cTurn / 2 - Math.PI / 2) * 30, pc[1] + Math.sin(top.hd - cTurn / 2 - Math.PI / 2) * 30];
    const avoidPlaza = (x, y) => Math.hypot(x - plaza[0], y - plaza[1]) < 26;
    const sqEnd = sq[sq.length - 1], topRd = street(top.pts.concat(sq), L(6, 7.5), 'street', { lap: true, cls: 'primary' });
    // down the hill toward the coast, to a sharp corner
    const hCoast = 4;
    const d1 = trace(T, S, sqEnd, hdc, { grade: -L(0.08, 0.11), maxA: 0.8, Rmin: 40, toH: hCoast + L(24, 30), maxLen: L(150, 300), w: 11, skip: [topRd] });
    if (d1.why !== 'height' && d1.why !== 'length') return { fail: 'descent ' + d1.why };
    // the sharp corner, a short steep drop, and the hairpin
    const ma = arc(d1.pts[d1.pts.length - 1], d1.hd, L(12, 16), -1, L(95, 120) * D2), hm = ma.hd, p1 = ma.end;
    d1.pts = d1.pts.concat(ma.pts);
    const d1Rd = street(d1.pts, L(6, 7.5), 'street', { lap: true, cls: 'primary' });
    const drop = trace(T, S, p1, hm, { grade: -L(0.07, 0.095), maxA: 1.1, Rmin: 35, maxLen: L(30, 60), w: 11, free: 14, skip: [d1Rd] });
    if (drop.why !== 'length') return { fail: 'drop ' + drop.why };
    const hp = hairpin(drop.pts[drop.pts.length - 1], drop.hd, L(10.5, 12.5), 1);
    const dropRd = street(drop.pts.concat(hp.pts), L(5.5, 6.5), 'street', { lap: true, cls: 'primary' });
    // out of the hairpin, down to the coast road, and two right turns onto it
    const d2 = trace(T, S, hp.pts[hp.pts.length - 1], hp.hd, { grade: -L(0.05, 0.08), maxA: 0.9, Rmin: 35, maxLen: L(30, 60), w: 11, free: 14, skip: [dropRd] });
    if (d2.why !== 'length') return { fail: 'after hairpin ' + d2.why };   // room for two separate corners before the coast road
    let d3 = null;
    if (d2.why === 'length') {
      const pa = arc(d2.pts[d2.pts.length - 1], d2.hd, L(14, 20), -1, L(35, 55) * D2);
      d2.pts = d2.pts.concat(pa.pts);
      d3 = trace(T, S, pa.end, pa.hd, { grade: -0.12, maxA: 1.3, Rmin: 25, maxLen: 260, w: 11, free: 8, shore: 8, skip: [dropRd] });
      // it must meet the coast road squarely (60 degrees or more), as a junction, not merge into it
      const square = d3.why === 'hit' && d3.hit.dir && Math.abs(Math.cos(d3.hd) * d3.hit.dir[0] + Math.sin(d3.hd) * d3.hit.dir[1]) < 0.5;
      if (d3.why !== 'hit' || d3.hit.rd !== coastRd || d3.len < 40 || !square) {
        // no street leads down to it: lay one, the nearest that reaches the coast road at no
        // more than 14 %, clear of the other streets, at least 40 m long (two corners, not one)
        d3 = null;
        const cand = [];
        coast.forEach((q, k) => { if (k > 0 && k < coast.length - 1 && q[1] > qq + 5) { const d = Math.hypot(q[0] - pa.end[0], q[1] - pa.end[1]); if (d > 35 && d < 220) cand.push([d, k]); } });
        cand.sort((a, b) => a[0] - b[0]);
        for (const [, k] of cand) {
          const J = coast[k], hw = Math.atan2(coast[k - 1][1] - J[1], coast[k - 1][0] - J[0]);
          // arriving from the land side at 60 to 90 degrees to the coast road, heading seaward
          const inl = T.inland(J[0] + Math.cos(hw + Math.PI / 2) * 10, J[1] + Math.sin(hw + Math.PI / 2) * 10) > T.inland(J[0], J[1]) ? 1 : -1;
          const hJ = hw - inl * L(60, 90) * D2;
          const pl = resample(hermite(pa.end, pa.hd, J, hJ), 4), len = polyLen(pl);
          if (len < 40 || Math.abs(T.H(pa.end[0], pa.end[1]) - T.H(J[0], J[1])) / len > 0.14 || minRadius(pl, 12) < 22) continue;
          if (pl.slice(0, -4).some(q => S.near(q[0], q[1], 10, [dropRd, coastRd]).d < 7.5 || T.inland(q[0], q[1]) < 10)) continue;
          d3 = { pts: pl, len, hit: { rd: coastRd, p: J }, why: 'hit' };
          break;
        }
        if (!d3) return { fail: 'portier' };
      }
    } else if (d2.hit.rd !== coastRd) return { fail: 'portier road' };
    const join = (d3 || d2).hit.p;
    if (join[0] < T.pr.x + T.pr.w / 2 + 100) return { fail: 'portier west of the tunnel' };   // room to climb to it
    // the descent must not run back over the climb
    // the lap so far, as one polyline
    // the U-turn round the end of the boulevard's block: a sharp right, a short straight, a
    // second right onto the boulevard (two corners, as at the end of a real block)
    const ua = L(110, 130) * D2, R1u = L(10, 13), R2u = L(12, 16);
    const Lu = (sb - R1u * (1 - Math.cos(ua)) - R2u * (1 + Math.cos(ua))) / Math.sin(ua);
    if (Lu < 10) return { fail: 'u-turn' };
    const u1 = arc([quayX(yR), yR], hs + Math.PI, R1u, -1, ua), uS = [];
    for (let k = 1; k <= Math.round(Lu / 3); k++) uS.push([u1.end[0] + Math.cos(u1.hd) * Lu * k / Math.round(Lu / 3), u1.end[1] + Math.sin(u1.hd) * Lu * k / Math.round(Lu / 3)]);
    const u2 = arc(uS[uS.length - 1], u1.hd, R2u, -1, Math.PI - ua), uEnd = u2.end;
    const startStraight = [[blvdX(uEnd[1]), uEnd[1]]].concat(blvd.filter(p => p[1] > uEnd[1] + 2 && p[1] <= yJ));
    add(startStraight, 'harbour');
    add(climb.pts, 'climb');
    add(top.pts, 'top');
    add(sq, 'top');
    add(d1.pts, 'descent');
    add(drop.pts, 'descent');
    add(hp.pts, 'hairpin');
    add(d2.pts, 'descent');
    if (d3) add(d3.pts, 'descent');
    // along the coast road from the junction west, round the basin and down the side quay
    let jk = 0, jd = Infinity;
    coast.forEach((p, k) => { const d = Math.hypot(p[0] - join[0], p[1] - join[1]); if (d < jd) { jd = d; jk = k; } });
    const back = coast.slice(0, jk).reverse().filter(p => p[1] >= yR);
    const tunnelAt = p => p[0] > T.pr.x - T.pr.w / 2 - 10 && p[0] < T.pr.x + T.pr.w / 2 + 10 && p[1] > qq + 5;
    let run = [], runRole = null;
    for (const p of back) {
      const role = tunnelAt(p) ? 'tunnel' : 'sea';
      if (role !== runRole && run.length) { add(run, runRole); run = [run[run.length - 1]]; }
      runRole = role; run.push(p);
    }
    if (run.length) add(run, runRole);
    // the U-turn round the end of the boulevard's block onto the start straight
    add(u1.pts.concat(uS, u2.pts.slice(0, -1), [[blvdX(uEnd[1]), uEnd[1]]]), 'final');
    street([[quayX(yR), yR]].concat(u1.pts, uS, u2.pts), 11, 'street', { lap: true, cls: 'primary' });
    street(d2.pts.concat(d3 ? d3.pts : []), 11, 'street', { lap: true, cls: 'primary' });
    // one polyline every 3 m, its role at every point
    let pts = [], roles = [];
    for (const [pl, role] of pieces) for (const p of pl) {
      if (pts.length && Math.hypot(p[0] - pts[pts.length - 1][0], p[1] - pts[pts.length - 1][1]) < 0.8) continue;
      pts.push(p.slice()); roles.push(role);
    }
    {
      // every 3 m exactly, carrying the remainder from segment to segment
      const fine = [], fr = [];
      let carry = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        let t = carry;
        for (; t < l; t += 3) { fine.push([a[0] + (b[0] - a[0]) * t / l, a[1] + (b[1] - a[1]) * t / l]); fr.push(roles[i]); }
        carry = t - l;
      }
      pts = fine; roles = fr;
    }
    // the chicane after the tunnel and the swimming-pool section on the side quay: the lap flicks
    // inland off the street and back, a straight diagonal between each pair of corners
    const swing = (i0, Lt, P, amp, nxf) => {
      const n = Math.round((2 * Lt + P) / 3);
      for (let k = 0; k <= n; k++) {
        const i = i0 + k; if (i >= pts.length) break;
        const sd = k * 3, o = sd < Lt ? sd / Lt : sd < Lt + P ? 1 : U.clamp((2 * Lt + P - sd) / Lt, 0, 1);
        const nn = nxf(pts[i]); pts[i][0] += nn[0] * amp * o; pts[i][1] += nn[1] * amp * o;
      }
    };
    {
      const t1 = roles.lastIndexOf('tunnel'), seaAfter = [];
      for (let i = t1 + 1; i < pts.length && roles[i] === 'sea' && pts[i][1] > qq - 2; i++) seaAfter.push(i);
      if (t1 > 0 && seaAfter.length > 50) swing(seaAfter[Math.round(L(6, 14))], L(18, 22), L(10, 20), L(14, 17), p => { const d = (T.cl(p[0] + 1) - T.cl(p[0] - 1)) / 2, l = Math.hypot(1, d); return [-d / l, 1 / l]; });
      const side = roles.map((q, i) => (q === 'sea' && pts[i][0] < quayX(pts[i][1]) + 1 && pts[i][1] < qq - R1 - 10 ? i : -1)).filter(i => i >= 0);
      if (side.length > 70) swing(side[Math.round(side.length * L(0.15, 0.3))], L(20, 24), L(40, 90), L(16, 19), () => [-1 / cs, sx / cs]);
    }
    // the coast road climbs from the junction into the tunnel and drops to the chicane after it
    const xP = join[0] - L(15, 40), xTe = T.pr.x - T.pr.w / 2, xDn = xTe - L(200, 300), Bc = L(6, 9);
    const coastRise = x => x >= xP ? 0 : x > xTe ? Bc * U.smooth((xP - x) / Math.max(40, xP - xTe)) : Bc * U.smooth((x - xDn) / Math.max(40, xTe - xDn));
    return { T, S, rail: [], squares: [], pts, roles, plaza, avoidPlaza, coastRd, blvdRd, qq, qw, sb, xA, yJ, yR, R1, Ttop, blvdX, quayX, hs, coastRise, topDip: L(6, 9) };
  }
  // ---------- the rest of the town's streets ----------
  // As on a real hillside town's map: a few corniches along the contours at irregular heights
  // (40 to 150 m apart up the slope), bending only where the ground does (round the ravines);
  // between them switchback climbers, legs at 8 to 12 % joined by stacked hairpins, every 180 to
  // 400 m along each corniche; short steep ramps and stairs straight up where the gap is small;
  // on the valley floor a grid that ends at T-junctions on the first corniche; on the headland a
  // road round its top, lanes across it and a zig-zag up from the quay. Every street ends at a
  // junction (meeting the street square on, or at least 60 degrees off it) or in a turning
  // circle; none runs within 25 m of another alongside it, and none crosses the lap.
  function cityStreets(r, town) {
    const { T, S } = town, L = T.L, D2 = Math.PI / 180;
    const lapGrid = new Map(), cell = 30;
    town.pts.forEach(p => { const k = Math.floor(p[0] / cell) + ',' + Math.floor(p[1] / cell); if (!lapGrid.has(k)) lapGrid.set(k, []); lapGrid.get(k).push(p); });
    const nearLap = (x, y, R) => {
      let best = R;
      for (let cx = Math.floor((x - R) / cell); cx <= Math.floor((x + R) / cell); cx++) for (let cy = Math.floor((y - R) / cell); cy <= Math.floor((y + R) / cell); cy++) {
        const list = lapGrid.get(cx + ',' + cy);
        if (list) for (const p of list) best = Math.min(best, Math.hypot(x - p[0], y - p[1]));
      }
      return best;
    };
    const ok = (tr, minLen) => {
      if (tr.len < minLen) return false;
      const n = tr.pts.length;
      for (let i = 0; i < n; i++) {
        const p = tr.pts[i];
        if (town.avoidPlaza(p[0], p[1])) return false;
        if (i < n - 6 && i > 2 && nearLap(p[0], p[1], 18) < 18) return false;
      }
      if (tr.hit && tr.hit.rd.lap && tr.hit.rd.kind === 'coast' && T.prom(tr.hit.p[0]) > 5) return false; // not into the tunnel
      return true;
    };
    const avoid = (x, y) => town.avoidPlaza(x, y) || nearLap(x, y, 12) < 12;
    // a corniche may cross the lap (a junction closed for the race), squarely enough that it never
    // runs alongside it for more than 50 m
    const lapRoads = S.roads.filter(q => q.lap);
    for (const lr of [town.coastRd, town.blvdRd]) {
      const o = L(1.2, 3.2), pl = lr.pts, out = [];
      for (let k = 0; k < pl.length; k++) {
        const a = pl[Math.max(0, k - 1)], b = pl[Math.min(pl.length - 1, k + 1)], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / l, ny = (b[0] - a[0]) / l;
        const sd = T.inland(pl[k][0] + nx * 20, pl[k][1] + ny * 20) > T.inland(pl[k][0] - nx * 20, pl[k][1] - ny * 20) ? 1 : -1;
        out.push([pl[k][0] + nx * o * sd, pl[k][1] + ny * o * sd]);
      }
      S.reset(lr, out);
    }
    const crosses = t => {
      let run = 0;
      for (const p of t.pts) { if (nearLap(p[0], p[1], 18) < 18) { run += 4; if (run > 50) return false; } else run = 0; }
      return true;
    };
    const steep = (x, y) => { const g = T.grad(x, y); return Math.hypot(g[0], g[1]) > 0.14; };
    const upSide = (p, hd) => { const g = T.grad(p[0], p[1]); return Math.sign(U.wrapAngle(Math.atan2(g[1], g[0]) - hd)) || 1; };
    // a dead end gets a turning circle
    const turning = (pts, hd, R) => { const c = [pts[pts.length - 1][0] + Math.cos(hd) * R, pts[pts.length - 1][1] + Math.sin(hd) * R], out = []; for (let k = 0; k <= 12; k++) { const a = hd + Math.PI + k / 12 * 2 * Math.PI; out.push([c[0] + Math.cos(a) * R, c[1] + Math.sin(a) * R]); } return out; };
    const finish = (t, w, cls, kind) => {
      let pts = t.pts;
      if (t.why !== 'hit' && t.why !== 'edge' && t.why !== 'sea') pts = pts.concat(joinUp(pts, t.hd, w, []));
      return S.add({ pts, w, kind: kind || 'street', cls });
    };
    // a street that runs out is carried on to the nearest street ahead of it within 80 m, joining
    // it no more obliquely than 60 degrees off square; otherwise it simply ends
    const joinUp = (pts, hd, w, self) => {
      const e = pts[pts.length - 1];
      for (const R of [40, 80]) {
        const nr = S.near(e[0] + Math.cos(hd) * R * 0.5, e[1] + Math.sin(hd) * R * 0.5, R * 0.6, self);
        if (!nr.rd || !nr.p) continue;
        const dx = nr.p[0] - e[0], dy = nr.p[1] - e[1], l = Math.hypot(dx, dy);
        if (l < 3 || l > R || Math.cos(Math.atan2(dy, dx) - hd) < 0.5) continue;
        if (nr.dir && Math.abs((dx * nr.dir[0] + dy * nr.dir[1]) / l) > 0.87) continue;
        const link = resample([e, nr.p], 4).slice(1);
        if (link.slice(0, -2).some(q => S.near(q[0], q[1], 8, self).d < w / 2 + 1)) continue;
        return link;
      }
      return [];
    };
    // a contour street turning back on itself round a ravine head (a tongue at one level) is
    // cut across where its two arms pass within 40 m of each other, as a viaduct would
    const untongue = pts => {
      const out = [];
      for (let i = 0; i < pts.length; i++) {
        out.push(pts[i]);
        for (let j = Math.min(pts.length - 1, i + 160); j > i + 30; j--) {
          if (Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]) < 40) {
            let l = 0; for (let k = i + 1; k <= j; k++) l += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
            if (l > 120) { out.push(...resample([pts[i], pts[j]], 4).slice(1, -1)); i = j - 1; break; }
          }
        }
      }
      return out;
    };
    // ---- the seafront and the boulevard as dual carriageways: the lap on the one by the water, the
    // other a few metres inland across a planted median ----
    const dual = [];
    for (const lr of [town.coastRd, town.blvdRd]) {
      if (r() < (lr === town.coastRd ? 0.3 : 0.5)) continue;
      const w2 = L(9, 12), off = lr.w / 2 + L(2, 4) + w2 / 2, pl = resample(lr.pts, 4);
      let run = [];
      // (each end turned in to the nearest street, the lap's own most often)
      const flush = () => {
        if (run.length > 30) { const e0 = S.near(run[0][0], run[0][1], off + 6).p, e1 = S.near(run[run.length - 1][0], run[run.length - 1][1], off + 6).p; dual.push(S.add({ pts: (e0 ? [e0] : []).concat(run, e1 ? [e1] : []), w: w2, kind: 'street', cls: 'primary', dual: true })); }
        run = [];
      };
      for (let k = 1; k < pl.length - 1; k++) {
        const a = pl[k - 1], b = pl[k + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / l, ny = (b[0] - a[0]) / l;
        const sd = T.inland(pl[k][0] + nx * 20, pl[k][1] + ny * 20) > T.inland(pl[k][0] - nx * 20, pl[k][1] - ny * 20) ? 1 : -1;
        const q = [pl[k][0] + nx * off * sd, pl[k][1] + ny * off * sd];
        const fine = T.inland(q[0], q[1]) > 12 && !town.avoidPlaza(q[0], q[1]) && S.near(q[0], q[1], w2 / 2 + 4, [lr]).d > 3 && nearLap(q[0], q[1], off - 1) >= off - 1.5;
        if (!fine || (run.length && Math.hypot(q[0] - run[run.length - 1][0], q[1] - run[run.length - 1][1]) > 8)) flush();
        if (fine) run.push(q);
      }
      flush();
    }
    // ---- corniches ----
    const corn = [];
    for (let hh = L(9, 13); hh < 320; hh += L(10, 30)) {
      const main = r() < 0.35, w = main ? L(11, 14) : L(4.5, 7);
      for (let x0 = T.X0 + 200 + L(0, 300); x0 < T.X1 - 200; x0 += L(220, 420)) {
        let a = 0, b = T.Y1 - 100;
        if (T.H(x0, b) < hh || T.H(x0, a) > hh) continue;
        for (let it = 0; it < 30; it++) { const m = (a + b) / 2; if (T.H(x0, m) < hh) a = m; else b = m; }
        const y0 = (a + b) / 2, g = T.grad(x0, y0);
        if (Math.hypot(g[0], g[1]) < 0.05 || Math.hypot(g[0], g[1]) > 0.3 || T.inland(x0, y0) < 30) continue;
        if (S.near(x0, y0, 30).d < 30 || nearLap(x0, y0, 30) < 30) continue;
        const gr = (r() - 0.5) * 0.02, wa = L(0.8, 2.5), wp = L(45, 90), wph = r() * 6.28;
        const halves = [0, Math.PI].map(dir => trace(T, S, [x0, y0], dir, { hold: hh, holdW: l => wa * Math.sin((dir ? -l : l) / wp + wph), grade: gr * (dir ? -1 : 1), Rmin: 42, maxLen: L(150, 480), w, skip: lapRoads, avoid: (x, y) => town.avoidPlaza(x, y) || T.prom(x) > 3 && nearLap(x, y, 30) < 30 || (() => { const q = T.grad(x, y); return Math.hypot(q[0], q[1]) > 0.36; })(), sep: 25 }));
        if (halves.some(t => !crosses(t) || t.pts.some(p => town.avoidPlaza(p[0], p[1])))) continue;
        // one street: the westward half reversed, then the eastward one
        let pts = untongue(halves[1].pts.slice().reverse().concat(halves[0].pts.slice(1)));
        if (polyLen(pts) < 150) continue;
        const ends = halves.map(t => t.why !== 'hit' && t.why !== 'edge' && t.why !== 'sea' ? joinUp(t.pts, t.hd, w, []) : []);
        const through = halves.every((t, k) => t.why === 'hit' || t.why === 'edge' || ends[k].length);
        const ww = main && through ? w : Math.min(w, L(5, 6.5));
        corn.push(S.add({ pts: ends[1].slice().reverse().concat(pts, ends[0]), w: ww, kind: 'street', cls: main && through ? 'secondary' : 'residential', h: hh }));
      }
    }
    // ---- the valley floor's grid, ending at T-junctions on the first corniche ----
    {
      // its north edge: a street from the boulevard along the foot of the hill, the grid's
      // streets running down from it to the shore
      const sx = L(80, 140), sy = L(75, 130), valley = [], yTop = town.yJ - L(6, 16), jit = () => L(-6, 6) * D2;
      const edge = trace(T, S, [town.blvdX(yTop) - 9, yTop], town.hs + Math.PI / 2, { straight: true, Rmin: 400, maxLen: 900, w: 9, free: 2, skip: [town.blvdRd], avoid: steep });
      let xEnd = -Infinity;
      if (edge.len > 60) { edge.pts.unshift([town.blvdX(yTop), yTop]); valley.push(finish(edge, 9, 'secondary')); xEnd = edge.pts[edge.pts.length - 1][0]; }
      // (as far west as the ground stays gentle enough to lay out in blocks)
      const ym = (yTop + town.yR) / 2;
      for (let x = town.blvdX(ym) - sx, misses = 0; x > Math.max(xEnd + 20, T.X0 + 150) && misses < 2; x -= sx * L(0.75, 1.25)) {
        // traced both ways from the middle of the valley floor: up to the edge street (or the foot of
        // the hill) and down to the shore
        const hd = town.hs + jit(), w = L(6, 8);
        if (steep(x, ym) || T.inland(x, ym) < 20) { misses++; continue; }
        misses = 0;
        const bnd = L(0.05, 0.16), bp = r() * 6.28;
        const up = trace(T, S, [x, ym], hd, { straight: true, bend: bnd, bendP: bp, Rmin: 150, maxLen: L(160, 520), w, avoid: steep, free: 2 });
        const dn = trace(T, S, [x, ym], hd + Math.PI, { straight: true, bend: -bnd, bendP: bp + Math.PI, Rmin: 150, maxLen: L(160, 520), w, avoid: steep, free: 2 });
        if (up.len + dn.len > 80) {
          const run = t => t.why === 'length' || t.why === 'avoid' ? joinUp(t.pts, t.hd, w, []) : [], eu = run(up), ed = run(dn);
          valley.push(S.add({ pts: ed.slice().reverse().concat(dn.pts.slice().reverse(), up.pts.slice(1), eu), w, kind: 'street', cls: 'residential' }));
        }
      }
      // a diagonal avenue across the grid
      { const y = (town.yJ + town.yR) / 2 + L(-80, 80), t = trace(T, S, [town.blvdX(y) - 9, y], town.hs + Math.PI / 2 + L(30, 50) * D2 * (r() < 0.5 ? 1 : -1), { straight: true, Rmin: 400, maxLen: 900, w: 9, free: 2, skip: valley.concat([town.blvdRd]), avoid: steep }); if (t.len > 120) { t.pts.unshift([town.blvdX(y), y]); S.add({ pts: t.pts, w: 9, kind: 'street', cls: 'secondary' }); } }
      // a square or two where streets cross
      for (let k = 0, n = 1 + Math.floor(r() * 2); k < n && valley.length > 2; k++) { const v = valley[1 + Math.floor(r() * (valley.length - 1))], q = v.pts[Math.floor(v.pts.length * L(0.3, 0.7))]; town.squares.push([q[0], q[1], L(22, 34)]); }
      for (let y = town.yJ - sy; y > -T.D - 10; y -= sy * L(0.6, 1.4)) {
        const t = trace(T, S, [town.blvdX(y) - 9, y], town.hs + Math.PI / 2 + jit(), { straight: true, Rmin: 400, maxLen: 1600, w: 7, free: 2, skip: valley.slice(0, -1).concat([town.blvdRd]), avoid: steep });   // (across all but the last: they end on it)
        if (t.len > 40) { t.pts.unshift([town.blvdX(y), y]); finish(t, 7, 'residential'); }
      }
    }
    // ---- switchback climbers between the corniches ----
    const climber = (p0, hd0, w) => {
      let p = p0, hd = hd0, out = [p0.slice()], legs = 0, total = 0;
      while (legs < 3) {
        const g = L(0.08, 0.12), leg = trace(T, S, p, hd, { grade: g, maxA: 1.0, Rmin: 22, maxLen: L(100, 220), w, avoid, free: legs ? 6 : 12, skip: [] });
        out = out.concat(leg.pts.slice(1)); total += leg.len; legs++;
        if (leg.why === 'hit') return { pts: out, ok: legs > 0 && total > 40, hit: leg.hit };
        if (leg.why !== 'length') { no('climber ' + leg.why); return { ok: false }; }
        // the hairpin, turning uphill
        const end = out[out.length - 1], hp = hairpin(end, leg.hd, L(8, 13), upSide(end, leg.hd));
        if (hp.pts.some(q => S.near(q[0], q[1], 8).d < w / 2 + 2 || avoid(q[0], q[1]) || T.inland(q[0], q[1]) < 14)) {
          // no room to turn: the street above is close, so carry straight on up to it
          const ext = trace(T, S, end, leg.hd, { grade: g, maxA: 1.0, Rmin: 22, maxLen: 120, w, avoid, free: 2 });
          if (ext.why === 'hit') return { pts: out.concat(ext.pts.slice(1)), ok: true, hit: ext.hit };
          no('climber hairpin'); return { ok: false };
        }
        out = out.concat(hp.pts); p = hp.pts[hp.pts.length - 1]; hd = hp.hd;
      }
      return { ok: false };
    };
    for (const rd of corn) {
      const pl = resample(rd.pts, 4);
      for (let k = Math.round(L(15, 35)); k < pl.length - 10; k += Math.round(L(15, 35))) {
        const p = pl[k], q = pl[k + 1], hd = Math.atan2(q[1] - p[1], q[0] - p[0]), up = upSide(p, hd);
        if (nearLap(p[0], p[1], 40) < 40) continue;
        const w = L(4, 6), start = [p[0] - Math.sin(hd) * up * (rd.w / 2 + 1), p[1] + Math.cos(hd) * up * (rd.w / 2 + 1)];
        if (r() < 0.85) {
          // up to the next street: across the slope on a straight diagonal (leaving at 35 to 50
          // degrees) where it is close, round hairpins where it is far
          const gg = T.grad(p[0], p[1]), sl = Math.hypot(gg[0], gg[1]), g0 = L(0.09, 0.13);
          const diag = Math.max(Math.asin(U.clamp(g0 / Math.max(sl, 0.01), 0, 1)), L(35, 50) * D2);
          const straight = trace(T, S, start, hd + up * diag, { grade: g0, maxA: 1.0, Rmin: 30, maxLen: 160, w, free: 10, avoid });
          if (straight.why === 'hit' && straight.hit.rd !== rd && straight.len > 20 && ok(straight, 20)) { S.add({ pts: [p].concat(straight.pts), w, kind: 'street', cls: 'residential' }); continue; }
          const c = climber(start, hd + up * L(60, 95) * D2, w);
          if (!c.ok) no('climber notok'); else if (c.hit.rd === rd) no('climber same'); else if (!ok({ pts: c.pts, len: polyLen(c.pts), hit: c.hit }, 30)) no('climber ok()'); else S.add({ pts: [p].concat(c.pts), w, kind: 'street', cls: 'residential' });
        } else {
          // straight up: a ramp, or stairs where it is too steep to drive
          const g = T.grad(p[0], p[1]), t = trace(T, S, start, Math.atan2(g[1], g[0]), { straight: true, Rmin: 400, maxLen: 160, w: 4, free: 6, avoid });
          if (t.why !== 'hit' || t.hit.rd === rd || !ok(t, 20)) continue;
          const e = t.pts[t.pts.length - 1], grade = (T.H(e[0], e[1]) - T.H(p[0], p[1])) / t.len;
          S.add(grade < 0.18 ? { pts: [p].concat(t.pts), w: 5, kind: 'street', cls: 'residential' } : { pts: [p].concat(t.pts), w: 2.5, kind: 'steps', cls: 'steps' });
        }
      }
    }
    // ---- stairs straight up the slope between the streets, every 60 to 120 m ----
    for (const rd of corn) {
      const pl = resample(rd.pts, 4);
      for (let k = Math.round(L(10, 40)); k < pl.length - 4; k += Math.round(L(30, 70))) {
        const p = pl[k], g = T.grad(p[0], p[1]); if (Math.hypot(g[0], g[1]) < 0.08 || nearLap(p[0], p[1], 30) < 30) continue;
        const hd = Math.atan2(g[1], g[0]), st = [p[0] + Math.cos(hd) * (rd.w / 2 + 1), p[1] + Math.sin(hd) * (rd.w / 2 + 1)];
        const t = trace(T, S, st, hd, { straight: true, Rmin: 400, maxLen: L(40, 100), w: 2, free: 3, avoid });
        if (t.why === 'hit' && t.len > 25 && t.hit.rd !== rd) S.add({ pts: [p].concat(t.pts), w: 2, kind: 'steps', cls: 'steps' });
      }
    }
    // ---- cul-de-sacs: a ramp down off a corniche, then along the slope to a turning circle ----
    for (const rd of corn) {
      const pl = resample(rd.pts, 4);
      for (let k = Math.round(L(15, 40)); k < pl.length - 10; k += Math.round(L(20, 45))) {
        if (r() < 0.3) continue;
        const p = pl[k], q = pl[k + 1], hd = Math.atan2(q[1] - p[1], q[0] - p[0]), dn = -upSide(p, hd);
        if (nearLap(p[0], p[1], 40) < 40) continue;
        const w = L(4, 5), h0 = hd + dn * L(55, 80) * D2, st = [p[0] + Math.cos(h0) * (rd.w / 2 + 1), p[1] + Math.sin(h0) * (rd.w / 2 + 1)];
        const t1 = trace(T, S, st, h0, { straight: true, Rmin: 400, maxLen: L(18, 30), w, free: 3, avoid });
        if (t1.why !== 'length') continue;
        const t2 = trace(T, S, t1.pts[t1.pts.length - 1], r() < 0.5 ? hd : hd + Math.PI, { grade: -L(0.02, 0.06), maxA: 0.8, Rmin: 16, maxLen: L(30, 80), w, free: 6, avoid, sep: 12 });
        if (t2.why !== 'length') continue;
        const pts = [p].concat(t1.pts, t2.pts.slice(1)), Rt = L(5, 7), tc = turning(pts, t2.hd, Rt);
        if (!ok({ pts, len: polyLen(pts), hit: null }, 40) || steepest(T, pts) > 0.18 || tc.some(z => S.near(z[0], z[1], 12).d < Rt + 2 || T.inland(z[0], z[1]) < 10)) continue;
        S.add({ pts: pts.concat(tc), w, kind: 'street', cls: 'residential', cds: true });
      }
    }
    // ---- side streets off the coast road and the head quay, inland to the next street ----
    {
      const cr = town.coastRd, pl = resample(cr.pts, 4);
      for (let k = Math.round(L(5, 12)); k < pl.length - 2; k += Math.round(L(7, 16))) {
        const p = pl[k], q = pl[k + 1], hd = Math.atan2(q[1] - p[1], q[0] - p[0]) + Math.PI / 2;
        if (T.prom(p[0]) > 3 || T.inland(p[0] + Math.cos(hd) * 20, p[1] + Math.sin(hd) * 20) < T.inland(p[0], p[1])) continue;
        const w = L(5, 7.5), t = trace(T, S, [p[0] + Math.cos(hd) * (cr.w / 2 + 1), p[1] + Math.sin(hd) * (cr.w / 2 + 1)], hd + L(-8, 8) * D2, { straight: true, Rmin: 400, maxLen: 220, w, free: 3, skip: dual, avoid: (x, y) => town.avoidPlaza(x, y) });
        if (t.why === 'hit' && t.len > 15 && t.hit.rd !== cr) { const st = steepest(T, [p].concat(t.pts)); if (st < 0.18) S.add({ pts: [p].concat(t.pts), w, kind: 'street', cls: 'residential' }); else if (t.len < 150) S.add({ pts: [p].concat(t.pts), w: 2.5, kind: 'steps', cls: 'steps' }); }
      }
    }
    // ---- side streets off the lap's hill streets, up and down the slope to the next street ----
    for (const lr of S.roads.filter(q => q.lap && q.kind === 'street')) {
      const pl = resample(lr.pts, 4);
      for (let k = Math.round(L(4, 10)); k < pl.length - 3; k += Math.round(L(6, 14))) {
        const p = pl[k], q = pl[k + 1];
        for (const sd of [-1, 1]) {
          if (r() < 0.35) continue;
          const hd = Math.atan2(q[1] - p[1], q[0] - p[0]) + sd * (Math.PI / 2 + L(-12, 12) * D2), w = L(4.5, 6.5);
          const st = [p[0] + Math.cos(hd) * (lr.w / 2 + 1), p[1] + Math.sin(hd) * (lr.w / 2 + 1)];
          if (T.inland(st[0], st[1]) < 12 || town.avoidPlaza(st[0], st[1])) continue;
          const t = trace(T, S, st, hd, { straight: true, Rmin: 400, maxLen: 200, w, free: 3, avoid: (x, y) => town.avoidPlaza(x, y) });
          if (t.why === 'hit' && t.len > 12 && t.hit.rd !== lr) { const st = steepest(T, [p].concat(t.pts)); if (st < 0.18) S.add({ pts: [p].concat(t.pts), w, kind: 'street', cls: 'residential' }); else if (t.len < 150) S.add({ pts: [p].concat(t.pts), w: 2.5, kind: 'steps', cls: 'steps' }); }
        }
      }
    }
    // ---- the boulevard carries on up to the first street on the hill ----
    {
      const bp = town.blvdRd.pts, e = bp[bp.length - 1];
      const t = trace(T, S, e, town.hs, { grade: 0.08, maxA: 0.6, Rmin: 60, maxLen: 300, w: 10, free: 8, skip: [town.blvdRd], avoid: (x, y) => town.avoidPlaza(x, y) });
      if (t.why === 'hit') S.add({ pts: t.pts, w: 10, kind: 'street', cls: 'secondary' });
    }
    // ---- dead ends: a street running on past its last junction into nothing is cut back to it
    // (one that runs off the map, or to the shore, is not a dead end) ----
    const prune = (passes, maxTail) => { for (let pass = 0; pass < passes; pass++) for (const rd of S.roads.slice()) {
      if (rd.lap || rd.dead || rd.cds || rd.dual || rd.kind !== 'street' || rd.pts.length < 2) continue;
      let pts = rd.pts, changed = false;
      for (const end of [0, 1]) {
        const e = end ? pts[pts.length - 1] : pts[0];
        if (S.near(e[0], e[1], 4, [rd]).d < 1.5 || T.inland(e[0], e[1]) < 16 || e[0] < T.X0 + 100 || e[0] > T.X1 - 100 || e[1] < T.Y0 + 100 || e[1] > T.Y1 - 100) continue;
        const q = resample(end ? pts.slice().reverse() : pts, 4);
        let j = -1;
        for (let i = 1; i < q.length; i++) if (S.near(q[i][0], q[i][1], rd.w / 2 + 3, [rd]).d < rd.w / 2 + 1) { j = i; break; }
        if (j < 0) break;   // (touching nothing: the network pass deals with it)
        if (j * 4 < 8 || j * 4 > maxTail || (j * 4 > 40 && j * 4 < 150 && r() < 0.6)) continue;
        const keep = q.slice(j);
        pts = end ? keep.reverse() : keep; changed = true;
      }
      if (changed) { if (polyLen(pts) < 25) { rd.dead = true; S.reset(rd, []); } else S.reset(rd, pts); }
    } };
    prune(2, 1e9);
    // ---- infill: a street through every gap of more than 50 m from the nearest street ----
    {
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const p of town.pts) { bx0 = Math.min(bx0, p[0]); by0 = Math.min(by0, p[1]); bx1 = Math.max(bx1, p[0]); by1 = Math.max(by1, p[1]); }
      const townTop = L(260, 340), gap = L(30, 40), cand = [];
      for (let x = Math.max(T.X0 + 150, bx0 - 650); x < Math.min(T.X1 - 150, bx1 + 650); x += 15) for (let y = Math.max(T.Y0 + 150, by0 - 650); y < Math.min(T.Y1 - 150, by1 + 650); y += 15) {
        if (T.inland(x, y) < 25 || T.H(x, y) > townTop || town.avoidPlaza(x, y)) continue;
        const g = T.grad(x, y); if (Math.hypot(g[0], g[1]) > 0.6) continue;
        cand.push([x + L(-5, 5), y + L(-5, 5)]);
      }
      // (twice over: the first pass's streets are the second's to join)
      for (let pass = 0; pass < 2; pass++) {
      for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)), t = cand[i]; cand[i] = cand[j]; cand[j] = t; }
      for (const c of cand) {
        if (S.near(c[0], c[1], gap).d < gap || nearLap(c[0], c[1], gap) < gap) continue;
        const g = T.grad(c[0], c[1]), sl = Math.hypot(g[0], g[1]), w = r() < 0.3 ? L(3, 4.2) : L(4.5, 7.5);
        let o, hd0;
        if (sl > 0.06) {
          const wa = L(0.5, 2), wp = L(40, 80), wph = r() * 6.28, h0 = T.H(c[0], c[1]);
          hd0 = Math.atan2(g[0], -g[1]);
          o = d => ({ hold: h0, holdW: l => wa * Math.sin((d ? -l : l) / wp + wph), grade: 0, Rmin: 34, maxLen: 450, w, free: 2, avoid, sep: 18 });
        } else {
          const nr = S.near(c[0], c[1], 160);
          hd0 = nr.dir ? Math.atan2(nr.dir[1], nr.dir[0]) + (r() < 0.5 ? Math.PI / 2 : 0) + L(-6, 6) * D2 : r() * 6.28;
          const bnd = L(0.02, 0.08), bp = r() * 6.28;
          o = d => ({ straight: true, bend: d ? -bnd : bnd, bendP: d ? bp + Math.PI : bp, Rmin: 150, maxLen: 450, w, free: 2, avoid: (x, y) => avoid(x, y) || steep(x, y) });
        }
        const h2 = [0, Math.PI].map(d => trace(T, S, c, hd0 + d, o(d)));
        if (!h2.some(t => t.why === 'hit')) continue;
        const ends = h2.map(t => t.why === 'hit' || t.why === 'edge' || t.why === 'sea' ? [] : joinUp(t.pts, t.hd, w, []));
        // (a through street joined at both ends; or one end running on 150 m or more into open
        // ground, the way out of town that the next streets will join)
        const loose = h2.filter((t, k) => t.why !== 'hit' && t.why !== 'edge' && t.why !== 'sea' && !ends[k].length);
        if (loose.length && loose.some(t => t.len < 150)) continue;
        const pts = ends[1].slice().reverse().concat(h2[1].pts.slice().reverse(), h2[0].pts.slice(1), ends[0]);
        if (polyLen(pts) < 60 || steepest(T, pts) > 0.16 || pts.some(q => town.avoidPlaza(q[0], q[1]))) continue;
        S.add({ pts, w, kind: 'street', cls: w < 4.3 ? 'service' : 'residential' });
      }
      }
    }
    // ---- cross streets: from every street every 45 to 70 m, a short street square across to the
    // next one on either side (on the same line both ways, so they meet it as a crossroads), stairs
    // where it is too steep to drive ----
    for (const rd of S.roads.slice()) {
      if (rd.dead || rd.lap || rd.dual || rd.cds || rd.kind !== 'street' || rd.pts.length < 2) continue;
      const pl = resample(rd.pts, 4);
      for (let k = Math.round(L(6, 14)); k < pl.length - 4; k += Math.round(L(11, 18))) {
        const p = pl[k], q = pl[k + 1], hd = Math.atan2(q[1] - p[1], q[0] - p[0]);
        if (nearLap(p[0], p[1], 25) < 25 || town.avoidPlaza(p[0], p[1])) continue;
        { const gg = T.grad(p[0], p[1]); if (Math.hypot(gg[0], gg[1]) < 0.06) continue; }
        if (S.near(p[0], p[1], rd.w / 2 + 14, [rd]).d < rd.w / 2 + 9) continue;   // (a junction here already)
        const jit = L(-10, 10) * D2;
        for (const sd of [-1, 1]) {
          if (r() < 0.2) continue;
          const lane = r() < 0.5, h = hd + sd * Math.PI / 2 + jit, w = lane ? L(2.8, 4) : L(4.5, 7), st = [p[0] + Math.cos(h) * (rd.w / 2 + 1), p[1] + Math.sin(h) * (rd.w / 2 + 1)];
          if (T.inland(st[0], st[1]) < 12) continue;
          const t = trace(T, S, st, h, { straight: true, Rmin: 400, maxLen: 95, w, free: 3, skip: [rd], avoid });
          if (t.why !== 'hit' || t.len < 12 || t.hit.rd === rd || t.hit.rd.kind === 'rail') continue;
          const pts = [p].concat(t.pts), e = pts[pts.length - 1], g = Math.max(steepest(T, pts), Math.abs(T.H(e[0], e[1]) - T.H(p[0], p[1])) / Math.max(1, polyLen(pts)));
          if (g < 0.16) S.add({ pts, w, kind: 'street', cls: lane ? 'service' : 'residential' });
          else if (g < 0.7 && r() < 0.35) S.add({ pts, w: 2.5, kind: 'steps', cls: 'steps' });
        }
      }
    }
    prune(1, 60);
    // ---- driveways and yards: short dead-end spurs off the streets into the blocks ----
    for (const rd of S.roads.slice()) {
      if (rd.dead || rd.lap || rd.dual || rd.cds || rd.kind !== 'street' || rd.pts.length < 2) continue;
      const pl = resample(rd.pts, 4);
      for (let k = Math.round(L(8, 25)); k < pl.length - 4; k += Math.round(L(15, 30))) {
        if (r() < 0.45) continue;
        const p = pl[k], q = pl[k + 1], hd = Math.atan2(q[1] - p[1], q[0] - p[0]), sd = r() < 0.5 ? 1 : -1;
        if (nearLap(p[0], p[1], 25) < 25 || town.avoidPlaza(p[0], p[1])) continue;
        const h = hd + sd * (Math.PI / 2 + L(-15, 15) * D2), w = L(2.8, 3.6), st = [p[0] + Math.cos(h) * (rd.w / 2 + 1), p[1] + Math.sin(h) * (rd.w / 2 + 1)];
        const t = trace(T, S, st, h, { straight: true, Rmin: 400, maxLen: L(15, 40), w, free: 2, skip: [rd], avoid, sep: 8 });
        if (t.why !== 'length') continue;
        const e = t.pts[t.pts.length - 1];
        if (T.inland(e[0], e[1]) < 10 || Math.abs(T.H(e[0], e[1]) - T.H(p[0], p[1])) > 0.2 * t.len) continue;
        S.add({ pts: [p].concat(t.pts), w, kind: 'street', cls: 'service', cds: true });
      }
    }
    // ---- one network: a group of streets that cannot reach the rest is joined to it by a link
    // road, or left out ----
    {
      const R = S.roads.filter(q => !q.dead && q.pts.length > 1), id = new Map(); R.forEach((q, i) => id.set(q, i));
      const par = R.map((_, i) => i), find = i => (par[i] === i ? i : (par[i] = find(par[i]))), uni = (a, b) => { par[find(a)] = find(b); };
      for (const q of R) for (const e of resample(q.pts, 8)) { const nr = S.near(e[0], e[1], 4, [q]); if (nr.rd && nr.d < q.w / 2 + 1 && id.has(nr.rd)) uni(id.get(q), id.get(nr.rd)); }
      const main = find(id.get(town.coastRd));
      const comps = new Map();
      R.forEach((q, i) => { const c = find(i); if (c === main) return; if (!comps.has(c)) comps.set(c, []); comps.get(c).push(q); });
      for (const list of comps.values()) {
        let done = false;
        for (const q of list) {
          if (done) break;
          for (const e of [q.pts[0], q.pts[q.pts.length - 1]]) {
            const nr = S.near(e[0], e[1], 160, list);
            if (!nr.rd || find(id.get(nr.rd)) !== main) continue;
            const link = resample([e, nr.p], 4);
            if (link.slice(2, -2).some(z => S.near(z[0], z[1], 6, list.concat([nr.rd])).d < 3 || T.inland(z[0], z[1]) < 6 || nearLap(z[0], z[1], 8) < 8)) continue;
            S.add({ pts: link, w: 5, kind: 'street', cls: 'residential' });
            uni(id.get(q), main); done = true; break;
          }
        }
        if (!done) for (const q of list) q.dead = true;
      }
    }
    // ---- a railway along the hillside at a steady height, in tunnels under the spurs ----
    if (r() < 0.85) {
      const hr = L(16, 34), y0 = (() => { let a = 0, b = T.Y1 - 100; for (let it = 0; it < 30; it++) { const m = (a + b) / 2; if (T.H(T.X0 + 120, m) < hr) a = m; else b = m; } return (a + b) / 2; })();
      const t = trace(T, S, [T.X0 + 120, y0], 0, { hold: hr, grade: 0, Rmin: 400, maxLen: 4500, w: 6, free: 1e9, shore: -50 });   // (on a viaduct where it crosses an inlet)
      if (t.len > 800) {
        let run = [], tun = null;
        const flush = () => { if (run.length > 2) { town.rail.push({ pts: run, tunnel: !!tun }); if (!tun) S.add({ pts: run, w: 7, kind: 'rail', cls: 'rail' }); } };
        for (const q of t.pts) {
          const inside = T.H(q[0], q[1]) > hr + 5 || S.near(q[0], q[1], 8).d < 4;
          if (tun === null) tun = inside;
          if (inside !== tun) { run.push(q); flush(); run = [q]; tun = inside; } else run.push(q);
        }
        flush();
      }
    }
    // ---- the headland: a street along its top, narrow lanes off it, a zig-zag up from the quay ----
    if (T.Hr > 0) {
      const hP = (x, rel) => [x, -T.D + (rel + x * Math.sin(T.hTilt)) / Math.cos(T.hTilt)];   // (x, depth into the headland) to the town frame
      const smp = [];
      for (let a = 0.08; a < 0.95; a += 0.06) for (let b = 0.08; b < 0.95; b += 0.06) { const q = hP(T.Wr * a, -T.Hr * b); if (T.inland(q[0], q[1]) > 22) smp.push([q[0], q[1], T.H(q[0], q[1])]); }
      const hs = smp.map(q => q[2]).sort((a, b) => a - b), plat = hs.length > 8 ? hs[Math.floor(hs.length * 0.35)] : 0;
      const top = (x, y) => T.H(x, y) < plat * 0.7 || T.inland(x, y) < 16;
      // (it starts on its contour, found going out from the middle toward the basin)
      for (const f of plat > 20 ? [0.88, 0.78, 0.68] : []) {
        const hold = plat * f;
        let lp = hP(T.Wr * 0.5, -T.Hr * 0.5);
        for (let k = 0; k < 90 && T.H(lp[0], lp[1]) > hold; k++) lp = [lp[0], lp[1] + 4];
        const loop = trace(T, S, lp, 0, { hold, grade: 0, Rmin: 16, maxLen: 2600, w: 6, free: 40, closeLoop: true, avoid, shore: 5 });
        if (loop.why === 'loop') { S.add({ pts: loop.pts, w: 6, kind: 'street', cls: 'residential' }); break; }
      }
      // the streets along the middle, from the plateau's centre both ways
      const mid = smp.filter(q => q[2] > plat * 0.9), c = mid.length ? [mid.reduce((a, q) => a + q[0], 0) / mid.length, mid.reduce((a, q) => a + q[1], 0) / mid.length] : hP(T.Wr * 0.4, -T.Hr * 0.5);
      const along = (o, w) => {
        const st = [c[0] - Math.sin(T.hTilt) * o, c[1] + Math.cos(T.hTilt) * o];
        if (top(st[0], st[1]) || S.near(st[0], st[1], 12).d < 10) return null;
        const hd = T.hTilt + L(-0.1, 0.1), h2 = [0, Math.PI].map(d => trace(T, S, st, hd + d, { straight: true, bend: L(0.05, 0.15), bendP: r() * 6, Rmin: 120, maxLen: T.Wr, w, free: 4, avoid: top }));
        const pts = h2[1].pts.slice().reverse().concat(h2[0].pts.slice(1));
        return polyLen(pts) > 100 ? S.add({ pts, w, kind: 'street', cls: 'residential' }) : null;
      };
      const spine = along(0, 7);
      if (T.Hr > 180) { along(L(35, 50), 5); along(-L(35, 50), 5); }
      const sp = spine ? { pts: spine.pts, len: polyLen(spine.pts) } : { pts: [], len: 0 };
      if (sp.len > 120) {
        const pl = resample(sp.pts, 4);
        for (let k = Math.round(L(6, 12)); k < pl.length - 6; k += Math.round(L(9, 16))) {
          const sd = r() < 0.5 ? 1 : -1, p = pl[k], q = pl[k + 1], hd = Math.atan2(q[1] - p[1], q[0] - p[0]) + sd * L(75, 105) * D2;
          const t = trace(T, S, [p[0] + Math.cos(hd) * 5, p[1] + Math.sin(hd) * 5], hd, { straight: true, Rmin: 400, maxLen: 140, w: 4, free: 3, skip: [spine], avoid });
          if (t.why === 'hit' && t.len > 15) S.add({ pts: [p].concat(t.pts), w: 4, kind: 'street', cls: 'residential' });
        }
        // a road up from the foot of the boulevard to the street along the top, climbing the
        // headland's landward slope at 10 % round its contours (a hairpin where it must)
        const a = [town.blvdX(-T.D - 25) + 8, -T.D - 25], b = sp.pts[0];
        // (laid from the top down, at 10 % round the landward slope, to the first street it meets)
        let down = null;
        for (let t = 0; t < 4 && !(down && down.why === 'hit'); t++) {
          const hd0 = Math.atan2(a[1] - b[1], a[0] - b[0]) + (t - 1.5) * 0.5;
          down = trace(T, S, [b[0] + Math.cos(hd0) * 8, b[1] + Math.sin(hd0) * 8], hd0, { grade: -0.1, maxA: 1.1, Rmin: 25, maxLen: 1200, w: 6, free: 8, skip: [spine] });
        }
        if (down && down.why === 'hit') S.add({ pts: [b].concat(down.pts), w: 6, kind: 'street', cls: 'residential' });
        else S.add({ pts: resample(hermite(a, Math.atan2(b[1] - a[1], b[0] - a[0]), b, Math.atan2(sp.pts[1][1] - b[1], sp.pts[1][0] - b[0])), 4), w: 6, kind: 'street', cls: 'residential' });
      }
    }
    // (and the loose ends left by everything since)
    prune(2, 120);
  }
  // the town in the circuit's frame (mirrored when m is -1)
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
  function cityTunnel(r, tr, role) {
    let i0 = -1, i1 = -1;
    for (let i = 0; i < tr.N; i++) if (role[i] === 'tunnel') { if (i0 < 0) i0 = i; i1 = i; }
    if (i0 < 0 || (i1 - i0) * tr.ds < 60) return null;
    return { i0, i1: i1 + 1 };
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

  // ---------- one candidate ----------
  function candidate(r, seed, style) {
    const st = STYLES[style];
    let lay, s0, town = null, m = 1, xf = null;
    if (style === 'city') {
      town = cityTown(r);
      if (town.fail) return { fail: town.fail.split(' ')[0], detail: town.fail };
      m = r() < 0.5 ? 1 : -1;
      const ang = r() * 2 * Math.PI, ca = Math.cos(ang), sa = Math.sin(ang);
      xf = { toWorld: p => [ca * m * p[0] - sa * p[1], sa * m * p[0] + ca * p[1]], toLocal: (x, y) => [(ca * x + sa * y) * m, -sa * x + ca * y] };
      let vt = routeVertices(town.pts);
      // the start straight (the harbour boulevard, from the U-turn to the first corner) is the
      // last segment: 235 m of it behind the line for the grid, after the U-turn's arc
      let ks = -1, kl = 0;
      vt.forEach((p, k) => { const q = vt[(k + 1) % vt.length], l = q[1] - p[1]; if (Math.abs(p[0] - town.blvdX(p[1])) < 2 && Math.abs(q[0] - town.blvdX(q[1])) < 2 && l > kl) { kl = l; ks = k; } });
      if (ks < 0) return { fail: 'start straight' };
      vt = vt.slice(ks).concat(vt.slice(0, ks));
      const z = vt[0], o = vt[1], Ls = Math.hypot(o[0] - z[0], o[1] - z[1]), Tz = z[2] * Math.tan(Math.min(z[3], 3) / 2);
      const v = vt.slice(1).concat([vt[0]]).map(q => { const w = xf.toWorld(q); return [Math.round(w[0] * 10) / 10, Math.round(w[1] * 10) / 10, q[2]]; });
      lay = { v, startAt: (Tz + 235) / Ls, pitSides: [1, -1] };
      if (lay.startAt > 0.82 || Ls * (1 - lay.startAt) < 90) return { fail: 'start straight' };
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
    // the town is built around its lap, once the lap is laid out like a real harbour circuit
    let role = null;
    if (city) {
      const lo = layoutMiss(tr);
      if (lo) return { fail: 'layout', detail: lo };
      cityStreets(r, town);
      s0 = citySite(r, town, xf);
      // each track sample's part of the lap (seafront, climb, hairpin...), from the route
      const rp = town.pts.map(xf.toWorld), cellR = 20, grid = new Map();
      rp.forEach((q, k) => { const kk = Math.floor(q[0] / cellR) + ',' + Math.floor(q[1] / cellR); if (!grid.has(kk)) grid.set(kk, []); grid.get(kk).push(k); });
      role = new Array(tr.N);
      for (let i = 0; i < tr.N; i++) {
        let best = -1, bd = Infinity;
        const gx = Math.floor(tr.x[i] / cellR), gy = Math.floor(tr.y[i] / cellR);
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const k of grid.get((gx + a) + ',' + (gy + b)) || []) { const d = (rp[k][0] - tr.x[i]) ** 2 + (rp[k][1] - tr.y[i]) ** 2; if (d < bd) { bd = d; best = k; } }
        role[i] = best >= 0 ? town.roles[best] : 'climb';
      }
    }
    // grade the road over the natural ground
    const raw = new Float64Array(tr.N);
    for (let i = 0; i < tr.N; i++) raw[i] = s0.H(tr.x[i], tr.y[i]);
    // a harbour town's quays and seafront stand a couple of metres above the water, and the
    // tunnel runs level through its promontory
    let tunnel = null;
    if (city) {
      for (let i = 0; i < tr.N; i++) raw[i] = Math.max(raw[i], 2.5);
      tunnel = cityTunnel(r, tr, role);
      if (tunnel) {
        const N = tr.N, a = raw[(tunnel.i0 - 8 + N) % N], b = raw[(tunnel.i1 + 8) % N];
        for (let i = tunnel.i0 - 8; i < tunnel.i1 + 8; i++) raw[(i + N) % N] = U.lerp(a, b, (i - tunnel.i0 + 8) / (tunnel.i1 - tunnel.i0 + 16));
      }
      for (let i = 0; i < tr.N; i++) if (role[i] === 'sea' || role[i] === 'tunnel') raw[i] += town.coastRise(xf.toLocal(tr.x[i], tr.y[i])[0]);
      // (the street along the top keeps to the ground: a dip below it would cut a gorge through the town)
    }
    const gr = grade(tr, raw, st);
    applyProfile(tr, gr.z, s0.H, st);
    tr.H2 = groundFn(tr, s0.H, st.slope);
    tr.H = s0.H;          // the natural ground (the renderer's outer terrain)
    tr.waterY = null;     // a town's sea comes from its coastline, not the first generator's harbour
    const res = { def, tr, style, st, site: s0, raw, gl: gr.gl, speed: gr.v, seed };
    if (city) {
      res.city = { buildings: cityBuildings(r, tr, s0), roads: s0.roads };
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
      for (const b of B) if (!polyClear(tr, b.poly, tr.hw + 4) || b.poly.some(p => site.inland(p[0], p[1]) < 2.5)) { fail('building on the road'); break; }
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

  F1.TrackGen2 = { _city: { cfail, cityTerrain, cityTown, cityStreets, citySite, cityBuildings, routeVertices }, idOf, parseId, adopt, defById, trackById, present, layoutStats, make, attempt, styleOf, MAX_TRIES, verify, STYLES, STYLE_LIST, REAL: () => REAL, realStats, gradeLimit, smoothLoop, loads };
})(typeof window !== 'undefined' ? window : globalThis);
