// Circuit definitions and the geometry builder.
// A circuit is authored as a turtle path (straights and constant-radius arcs, the
// way real circuits are surveyed). The builder closes the loop exactly, smooths
// curvature transitions, then derives everything the game needs from the
// centreline: kerbs, run-off bands, barriers, pit lane, grid, sectors, DRS zones.
(function simModule(G) {
  'use strict';
  (G.F1simMods = G.F1simMods || []).push(simModule); // the learning workers rebuild the sim from these
  const F1 = G.F1;
  const U = F1.U;

  const DS = 2; // final sample spacing in metres

  // Each def: v = corner vertices [x, y, radius] in metres (y down). The circuit
  // runs straight between vertices and each vertex is rounded with a tangent arc,
  // which is how real circuits are drawn: straights, then a corner of known radius.
  const DEFS = [
    {
      id: 'kestrel', name: 'Kestrel Park', country: 'United Kingdom', flag: 'GB',
      blurb: 'Old airfield circuit. Fast sweepers, a flat-out esses complex and gravel that punishes greed.',
      width: 15, style: 'park', seed: 11,
      startAt: 0.5, pit: { side: 1, entry: -420, exit: 260, offset: 22, lane: 12 },
      v: [[1300, 0, 120], [1480, 170, 260], [1420, 340, 110], [1520, 490, 110], [1440, 640, 110],
        [1540, 790, 70], [1150, 1060, 55], [380, 1090, 85], [150, 860, 40], [230, 560, 150],
        [60, 330, 55], [-160, 0, 80]],
    },
    {
      id: 'varenna', name: 'Autodromo di Varenna', country: 'Italy', flag: 'IT',
      blurb: 'The cathedral of speed. Minimum downforce, maximum courage, and three chicanes that decide everything.',
      width: 14, style: 'park', seed: 23,
      startAt: 0.55, pit: { side: 1, entry: -380, exit: 220, offset: 22, lane: 12 },
      v: [[935, 0, 16], [968, 33, 16], [1394, 98, 350], [1468, 459, 22], [1509, 500, 22], [1525, 738, 70], [1394, 861, 60], [779, 918, 50], [697, 968, 50], [615, 959, 60], [-344, 836, 120], [-394, 246, 250], [-262, 0, 250]],
    },
    {
      id: 'lucerne', name: 'Port Lucerne', country: 'Riviera', flag: 'MC',
      blurb: 'Harbourfront street circuit. Walls a hand-width away, no room for mistakes, qualifying is everything.',
      width: 11, style: 'street', seed: 37,
      startAt: 0.55, pit: { side: 1, entry: -300, exit: 200, offset: 16, lane: 10 },
      v: [[760, 0, 20], [770, 220, 18], [960, 230, 18], [980, 520, 22], [420, 620, 11],
        [700, 760, 20], [690, 980, 22], [250, 1000, 25], [240, 700, 18], [60, 690, 18],
        [70, 420, 25], [20, 260, 25], [-10, 0, 20]],
    },
    {
      id: 'hakone', name: 'Hakone Ridge', country: 'Japan', flag: 'JP',
      blurb: 'A true driver\'s circuit. Rhythm through the esses, a brave fast left, and a hairpin that rewards patience.',
      width: 14, style: 'park', seed: 41,
      startAt: 0.5, pit: { side: -1, entry: -380, exit: 230, offset: 22, lane: 12 },
      v: [[1100, 0, 110], [1080, -190, 90], [1170, -350, 90], [1080, -510, 90], [1160, -670, 80],
        [1060, -880, 55], [760, -940, 160], [520, -860, 45], [-40, -900, 13], [300, -640, 70],
        [260, -330, 90], [80, -200, 45], [-120, 0, 60]],
    },
    {
      id: 'rimal', name: 'Qasr Al Rimal', country: 'Arabian Gulf', flag: 'AE',
      blurb: 'Modern desert venue. Two huge straights, big stops into hairpins and acres of painted run-off.',
      width: 15, style: 'modern', seed: 53,
      startAt: 0.55, pit: { side: 1, entry: -420, exit: 260, offset: 24, lane: 12 },
      v: [[1100, 0, 25], [1110, 180, 35], [1300, 220, 90], [1330, 700, 15], [350, 460, 22],
        [250, 560, 22], [-40, 700, 50], [10, 380, 40], [-60, 200, 40], [-40, 0, 45]],
    },
    // the second half of the calendar, laid out with tools/trackdesign.js (tools/designs.js)
    {
      id: 'ileverte', name: 'Circuit Île Verte', country: 'Canada', flag: 'CA', trees: 'broad',
      blurb: 'A lap of a river island. Long straights between concrete walls, a slow hairpin and a last chicane that bites anyone who clips it.',
      width: 12, style: 'street', seed: 61,
      startAt: 0.542, pit: { side: 1, entry: -320, exit: 220, offset: 17, lane: 10 },
      v: [[380, 0, 22], [425, -54, 24], [669, 35, 220], [884, 215, 60], [1053, 230, 35], [1100, 330, 15], [781, 415, 140],
        [381, 415, 22], [344, 441, 22], [-571, 441, 60], [-744, 341, 40], [-744, 29, 25], [-484, 29, 18], [-450, 0, 18]],
    },
    {
      id: 'sierra', name: 'Sierra Alta', country: 'Spain', flag: 'ES', trees: 'fir',
      blurb: 'High in the mountains. Climbing esses, a blind crest taken flat, a hairpin at the top and a long fast plunge back down.',
      width: 14, style: 'park', seed: 67,
      startAt: 0.45, pit: { side: 1, entry: -400, exit: 240, offset: 22, lane: 12 },
      v: [[900, 0, 25], [940, 190, 60], [1090, 310, 70], [1110, 480, 80], [1420, 720, 250], [1480, 1080, 16], [1080, 780, 60],
        [880, 960, 45], [480, 1120, 150], [100, 1000, 90], [-160, 700, 40], [-230, 330, 200], [-80, 0, 60]],
    },
    {
      id: 'bahia', name: 'Autódromo Bahia Dourada', country: 'Brazil', flag: 'BR', trees: 'broad',
      blurb: 'Anticlockwise in a natural bowl. A plunging left-right off the line, a knot of slow infield corners and a flat-out curving climb to the flag.',
      width: 14, style: 'park', seed: 71,
      startAt: 0.45, pit: { side: -1, entry: -380, exit: 230, offset: 22, lane: 12 },
      v: [[700, 0, 35], [830, -110, 40], [1100, -200, 220], [1180, -560, 300], [1100, -900, 45], [760, -960, 60], [520, -780, 22],
        [640, -520, 25], [380, -420, 30], [160, -640, 35], [-200, -560, 160], [-320, -220, 250], [-340, 0, 150]],
    },
    {
      id: 'nordwald', name: 'Nordwald Ring', country: 'Germany', flag: 'DE', trees: 'fir', banks: 11,
      blurb: 'Deep in the pine forest. A long run out through the trees, chicanes to break the slipstream, the great far curve, and a tight stadium in front of the stands.',
      width: 15, style: 'park', seed: 73,
      startAt: 0.5, pit: { side: 1, entry: -330, exit: 240, offset: 22, lane: 12 },
      v: [[560, 0, 60], [1300, 360, 600], [1656, 562, 18], [1699, 547, 18], [2088, 756, 150], [2124, 1008, 150], [1584, 900, 600],
        [1080, 756, 18], [1037, 778, 18], [648, 648, 250], [288, 590, 22], [144, 432, 20], [-72, 446, 18], [-180, 288, 40],
        [-216, 108, 90], [-252, 0, 70]],
    },
    {
      id: 'lonestar', name: 'Lone Star Motor Course', country: 'United States', flag: 'US', trees: 'broad',
      blurb: 'Big modern venue on the prairie. A steep climb to a first-corner hairpin, fast esses, a kilometre back straight and a stadium finish.',
      width: 15, style: 'modern', seed: 79,
      startAt: 0.45, pit: { side: -1, entry: -420, exit: 260, offset: 24, lane: 12 },
      v: [[780, 0, 22], [580, -160, 70], [540, -320, 80], [420, -420, 80], [380, -580, 70], [200, -700, 40], [-900, -760, 18],
        [-650, -560, 40], [-560, -380, 30], [-720, -300, 25], [-640, -150, 30], [-420, -120, 120], [-380, 0, 80]],
    },
  ];

  // ---------- filleted polygon ----------
  function fillet(v) {
    const n = v.length;
    const dirs = [];
    for (let i = 0; i < n; i++) {
      const a = v[i], b = v[(i + 1) % n];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      dirs.push([(b[0] - a[0]) / l, (b[1] - a[1]) / l, l]);
    }
    const arcs = [];
    let warn = 0, turn = 0;
    for (let i = 0; i < n; i++) {
      const din = dirs[(i - 1 + n) % n], dout = dirs[i];
      const th = Math.atan2(din[0] * dout[1] - din[1] * dout[0], din[0] * dout[0] + din[1] * dout[1]);
      turn += th;
      arcs.push({ th, r: v[i][2] });
    }
    // shrink radii whose tangent lengths overlap on a shared straight
    for (let it = 0; it < 20; it++) for (let i = 0; i < n; i++) {
      const a = arcs[i], b = arcs[(i + 1) % n];
      const ta = a.r * Math.tan(Math.abs(a.th) / 2), tb = b.r * Math.tan(Math.abs(b.th) / 2);
      const l = dirs[i][2];
      if (ta + tb > l * 0.98) { const k = l * 0.98 / (ta + tb); a.r *= k; b.r *= k; warn++; }
    }
    const pts = [];
    const step = 0.5;
    for (let i = 0; i < n; i++) {
      const a = arcs[i], din = dirs[(i - 1 + n) % n], dout = dirs[i];
      const t = a.r * Math.tan(Math.abs(a.th) / 2);
      const sx = v[i][0] - din[0] * t, sy = v[i][1] - din[1] * t;
      // arc
      const sg = Math.sign(a.th) || 1;
      const h0 = Math.atan2(din[1], din[0]);
      const cx = sx - Math.sin(h0) * a.r * sg, cy = sy + Math.cos(h0) * a.r * sg;
      const m = Math.max(2, Math.round(Math.abs(a.th) * a.r / step));
      for (let k = 0; k < m; k++) {
        const hh = h0 + a.th * k / m;
        pts.push([cx + Math.sin(hh) * a.r * sg, cy - Math.cos(hh) * a.r * sg]);
      }
      // straight to the next arc
      const b = arcs[(i + 1) % n];
      const ex = v[i][0] + dout[0] * t, ey = v[i][1] + dout[1] * t;
      const tb = b.r * Math.tan(Math.abs(b.th) / 2);
      const len = dirs[i][2] - t - tb;
      const ms = Math.max(1, Math.round(len / step));
      for (let k = 0; k < ms; k++) pts.push([ex + dout[0] * len * k / ms, ey + dout[1] * len * k / ms]);
    }
    return { pts, warn, dir: Math.sign(turn), startSeg: [arcs.length] };
  }

  function smoothClosed(pts, sigmaM, spacing) {
    const n = pts.length, sig = sigmaM / spacing, R = Math.ceil(sig * 3);
    const w = [];
    let ws = 0;
    for (let k = -R; k <= R; k++) { const v = Math.exp(-0.5 * (k / sig) ** 2); w.push(v); ws += v; }
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0;
      for (let k = -R; k <= R; k++) {
        const p = pts[(i + k + n) % n];
        sx += p[0] * w[k + R]; sy += p[1] * w[k + R];
      }
      out[i] = [sx / ws, sy / ws];
    }
    return out;
  }

  function resample(pts, ds) {
    const n = pts.length;
    const cum = [0];
    for (let i = 1; i <= n; i++) {
      const a = pts[i - 1], b = pts[i % n];
      cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const L = cum[n];
    const m = Math.round(L / ds);
    const step = L / m;
    const out = [];
    let j = 0;
    for (let k = 0; k < m; k++) {
      const s = k * step;
      while (cum[j + 1] < s) j++;
      const a = pts[j], b = pts[(j + 1) % n];
      const t = (s - cum[j]) / (cum[j + 1] - cum[j] || 1);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    return { out, L, step };
  }

  // ---------- spatial hash for proximity queries ----------
  function makeHash(xs, ys, cell) {
    const map = new Map();
    for (let i = 0; i < xs.length; i++) {
      const k = Math.floor(xs[i] / cell) + ',' + Math.floor(ys[i] / cell);
      let a = map.get(k); if (!a) map.set(k, a = []); a.push(i);
    }
    return {
      near(x, y, r, fn) {
        const c0 = Math.floor((x - r) / cell), c1 = Math.floor((x + r) / cell);
        const r0 = Math.floor((y - r) / cell), r1 = Math.floor((y + r) / cell);
        for (let cx = c0; cx <= c1; cx++) for (let cy = r0; cy <= r1; cy++) {
          const a = map.get(cx + ',' + cy);
          if (a) for (const i of a) fn(i);
        }
      },
    };
  }

  const SURF = F1.SURF = { ASPHALT: 0, KERB: 1, TARMAC: 2, GRASS: 3, GRAVEL: 4, PIT: 5, WALL: 6 };

  function build(def) {
    const tt = fillet(def.v);
    const sm = smoothClosed(tt.pts, def.style === 'street' ? 3 : 5, 0.5);
    let { out: P, L } = resample(sm, DS);
    const N = P.length;
    const ds = L / N;
    // Rotate so index 0 is the start line: a fraction along the straight that
    // ends at the first vertex (the last straight of the vertex loop).
    let startIdx = 0;
    {
      const vl = def.v[def.v.length - 1], v0 = def.v[0];
      const sx = U.lerp(vl[0], v0[0], def.startAt), sy = U.lerp(vl[1], v0[1], def.startAt);
      let best = 1e18;
      for (let i = 0; i < N; i++) { const d = (P[i][0] - sx) ** 2 + (P[i][1] - sy) ** 2; if (d < best) { best = d; startIdx = i; } }
    }
    P = P.slice(startIdx).concat(P.slice(0, startIdx));

    const x = new Float64Array(N), y = new Float64Array(N);
    const tx = new Float64Array(N), ty = new Float64Array(N);
    const nx = new Float64Array(N), ny = new Float64Array(N);
    const kap = new Float64Array(N);
    for (let i = 0; i < N; i++) { x[i] = P[i][0]; y[i] = P[i][1]; }
    for (let i = 0; i < N; i++) {
      const a = (i - 1 + N) % N, b = (i + 1) % N;
      let dx = x[b] - x[a], dy = y[b] - y[a];
      const l = Math.hypot(dx, dy); dx /= l; dy /= l;
      tx[i] = dx; ty[i] = dy; nx[i] = -dy; ny[i] = dx; // n points to the driver's right
    }
    for (let i = 0; i < N; i++) {
      const a = (i - 1 + N) % N, b = (i + 1) % N;
      const h1 = Math.atan2(ty[a], tx[a]), h2 = Math.atan2(ty[b], tx[b]);
      kap[i] = U.wrapAngle(h2 - h1) / (2 * ds);
    }
    const w = def.width, hw = w / 2;

    // --- kerbs: anywhere the corner is tighter than ~300 m radius ---
    const kerbL = new Uint8Array(N), kerbR = new Uint8Array(N);
    {
      const corner = new Uint8Array(N);
      for (let i = 0; i < N; i++) if (Math.abs(kap[i]) > 1 / 300) corner[i] = 1;
      const pre = Math.round(10 / ds), post = Math.round(22 / ds);
      for (let i = 0; i < N; i++) if (corner[i]) {
        const inside = kap[i] > 0 ? 1 : -1; // right-hand corner: inside is the right
        for (let k = -pre; k <= post; k++) {
          const j = (i + k + N) % N;
          // inside kerb around the apex, outside kerb on entry and exit
          if (k <= Math.round(8 / ds)) (inside > 0 ? kerbR : kerbL)[j] = 1;
          (inside > 0 ? kerbL : kerbR)[j] = 1;
        }
      }
    }
    const kerbW = def.style === 'street' ? 0.9 : 1.6;

    // --- run-off and barriers, per side ---
    const runT = [new Uint8Array(N), new Uint8Array(N)]; // 0 = left, 1 = right
    const runW = [new Float64Array(N), new Float64Array(N)];
    const barr = [new Float64Array(N), new Float64Array(N)];
    const absK = new Float64Array(N);
    // corner intensity looking 60 m around the sample, used to size gravel traps
    for (let i = 0; i < N; i++) {
      let m = 0;
      for (let k = -Math.round(40 / ds); k <= Math.round(70 / ds); k++) m = Math.max(m, Math.abs(kap[(i - k + N) % N]));
      absK[i] = m;
    }
    // kerb heights: refined from the corner speeds once the racing line exists (Raceline.prepare)
    const kerbH = new Float32Array(N).fill(0.035);
    for (let i = 0; i < N; i++) {
      for (let side = 0; side < 2; side++) {
        const sgn = side ? 1 : -1;
        // signed curvature of the corner we are in or approaching (scan ahead + behind)
        let kk = 0;
        for (let k = -Math.round(20 / ds); k <= Math.round(70 / ds); k++) {
          const v = kap[(i - k + N) % N]; if (Math.abs(v) > Math.abs(kk)) kk = v;
        }
        const outside = Math.abs(kk) > 1 / 500 && Math.sign(kk) !== sgn;
        const kb = (side ? kerbR : kerbL)[i] ? kerbW : 0;
        let t, rw, extra;
        if (def.style === 'street') {
          t = SURF.TARMAC; rw = 0.6; extra = 0;
        } else if (def.style === 'modern') {
          if (outside) { t = SURF.TARMAC; rw = 14 + Math.min(26, absK[i] * 900); extra = 6; }
          else { t = SURF.TARMAC; rw = 5; extra = 8; }
        } else {
          if (outside && absK[i] > 1 / 260) { t = SURF.GRAVEL; rw = 12 + Math.min(26, absK[i] * 900); extra = 4; }
          else { t = SURF.GRASS; rw = 4; extra = 8; }
        }
        runT[side][i] = t; runW[side][i] = kb + rw;
        barr[side][i] = hw + kb + rw + extra;
      }
    }
    // Smooth barrier distance (max-filter then box blur) so walls run in long lines.
    for (let side = 0; side < 2; side++) {
      const b = barr[side];
      const r = Math.round((def.style === 'street' ? 10 : 30) / ds);
      const mx = new Float64Array(N);
      for (let i = 0; i < N; i++) { let m = 0; for (let k = -r; k <= r; k++) m = Math.max(m, b[(i + k + N) % N]); mx[i] = m; }
      for (let i = 0; i < N; i++) { let s = 0; for (let k = -r; k <= r; k++) s += mx[(i + k + N) % N]; b[i] = s / (2 * r + 1); }
    }

    // --- pit lane geometry (offset curve on one side of the centreline) ---
    const pit = Object.assign({}, def.pit);
    pit.sIn = (pit.entry + L) % L; pit.sOut = pit.exit; pit.len = (pit.sOut - pit.sIn + L) % L;
    const blend = 140;
    const pitOff = new Float64Array(N).fill(NaN);
    for (let i = 0; i < N; i++) {
      const s = i * ds;
      const u = (s - pit.sIn + L) % L; // distance along the pit lane
      if (u > pit.len) continue;
      let o = pit.offset;
      if (u < blend) o = U.lerp(hw - 1, pit.offset, U.smooth(u / blend));
      else if (u > pit.len - blend) o = U.lerp(pit.offset, hw - 1, U.smooth((u - (pit.len - blend)) / blend));
      pitOff[i] = o * pit.side;
    }
    pit.off = pitOff;
    pit.boxS = []; // 10 team boxes before the line
    for (let b = 0; b < 10; b++) pit.boxS.push((L - 40 - b * 16) % L);
    pit.limit = 80 / 3.6;
    pit.limitIn = (pit.sIn + blend * 0.7) % L; pit.limitOut = (pit.sOut - blend * 0.6 + L) % L;
    // Barriers beside the pit: outer barrier beyond the garages, pit wall between.
    const ps = pit.side > 0 ? 1 : 0;
    const pitWall = new Float64Array(N).fill(NaN);
    for (let i = 0; i < N; i++) {
      if (isNaN(pitOff[i])) continue;
      const o = Math.abs(pitOff[i]);
      barr[ps][i] = Math.max(barr[ps][i], o + pit.lane / 2 + 1.0);
      if (o > hw + pit.lane / 2 + 1.5) pitWall[i] = Math.min(o - pit.lane / 2 - 0.4, hw + 4.5);
      runT[ps][i] = SURF.GRASS;
    }
    pit.wall = pitWall;

    // --- clamp barriers so neighbouring parts of the circuit never overlap ---
    const hash = makeHash(x, y, 40);
    for (let i = 0; i < N; i++) {
      for (let side = 0; side < 2; side++) {
        const sgn = side ? 1 : -1;
        let lim = barr[side][i];
        hash.near(x[i], y[i], 160, j => {
          let sep = Math.abs(i - j); sep = Math.min(sep, N - sep) * ds;
          if (sep < 120) return;
          const dx = x[j] - x[i], dy = y[j] - y[i];
          const along = dx * tx[i] + dy * ty[i];
          if (Math.abs(along) > 25) return;
          const lat = (dx * nx[i] + dy * ny[i]) * sgn;
          if (lat <= 0) return;
          const half = lat / 2;
          if (half < lim) lim = Math.max(hw + 1.2, half);
        });
        barr[side][i] = lim;
        runW[side][i] = Math.min(runW[side][i], lim - hw - 0.5);
      }
    }

    // --- sectors, DRS zones ---
    const sectors = [0, L * (def.s1 || 0.33), L * (def.s2 || 0.68)];
    const straightRuns = [];
    {
      let i0 = -1;
      // find a starting index inside a corner so runs do not wrap awkwardly
      let start = 0;
      for (let i = 0; i < N; i++) if (Math.abs(kap[i]) > 1 / 300) { start = i; break; }
      for (let k = 0; k <= N; k++) {
        const i = (start + k) % N;
        const st = Math.abs(kap[i]) < 1 / 700;
        if (st && i0 < 0) i0 = k;
        if ((!st || k === N) && i0 >= 0) {
          const len = (k - i0) * ds;
          if (len > 380) straightRuns.push({ s0: ((start + i0) % N) * ds, len });
          i0 = -1;
        }
      }
    }
    straightRuns.sort((a, b) => b.len - a.len);
    const drs = straightRuns.slice(0, 2).map(r => ({
      act: (r.s0 + 90) % L,
      end: (r.s0 + r.len - 60) % L,
      det: (r.s0 - 140 + L) % L,
    }));

    // --- grid slots (s measured backwards from the start line) ---
    const grid = [];
    for (let k = 0; k < 22; k++) {
      const back = 14 + k * 8;
      grid.push({ s: L - back, d: (k % 2 === 0 ? -1 : 1) * 3.2 * (def.poleSide || -pit.side) });
    }

    const tr = {
      def, id: def.id, name: def.name, N, L, ds, x, y, tx, ty, nx, ny, kap,
      w, hw, kerbL, kerbR, kerbW, kerbH, runT, runW, barr, pit, sectors, drs, grid,
      filletWarn: tt.warn, dir: tt.dir,
      corners: 0,
    };
    // corner count for the menu card
    {
      let n = 0, inC = false;
      for (let i = 0; i < N; i++) {
        const c = Math.abs(kap[i]) > 1 / 220;
        if (c && !inC) n++;
        inC = c;
      }
      tr.corners = n;
    }
    // apexes for corner numbering: local curvature peaks, merged when close
    {
      const ap = [];
      const r = Math.round(30 / ds);
      for (let i = 0; i < N; i++) {
        const k = Math.abs(kap[i]);
        if (k < 1 / 260) continue;
        let peak = true;
        for (let q = -r; q <= r && peak; q++) if (q && Math.abs(kap[(i + q + N) % N]) > k) peak = false;
        if (peak) ap.push({ i, k: kap[i] });
      }
      const merged = [];
      for (const a of ap) {
        const last = merged[merged.length - 1];
        if (last && (a.i - last.i) * ds < 70 && Math.sign(a.k) === Math.sign(last.k)) { if (Math.abs(a.k) > Math.abs(last.k)) merged[merged.length - 1] = a; }
        else merged.push(a);
      }
      tr.apexes = merged;
      tr.corners = merged.length;
    }
    tr.hash = hash;
    topography(tr);
    return tr;
  }

  // ---------- topography ----------
  // Each venue sits on a smooth terrain height field; the circuit is draped over it and
  // smoothed the way a road is graded. Corners get banking toward the inside, kerbs get
  // a raised profile with ridges, and every surface gets its own roughness. The physics
  // reads all of this through roadZ(); the renderer through surfZ() and groundAt().
  const TERRAIN = {
    kestrel: { amp: 3.5, wl: 1100, bank: 0.03 },              // old airfield, gently rolling
    varenna: { amp: 5, wl: 1300, bank: 0.035 },               // parkland
    lucerne: { amp: 3, wl: 900, climb: 0.03, base: 3.5, bank: 0.012 }, // climbs away from the harbour
    hakone: { amp: 12, wl: 950, bank: 0.04 },                 // hillside
    rimal: { amp: 1.2, wl: 1500, bank: 0.025 },               // desert flat
    ileverte: { amp: 1.2, wl: 1300, bank: 0.012 },            // river island, nearly flat
    sierra: { amp: 22, wl: 1500, bank: 0.04 },                // mountainside
    bahia: { amp: 14, wl: 1100, bank: 0.045 },                // a natural bowl
    nordwald: { amp: 6, wl: 1400, bank: 0.03 },               // forest, rolling
    lonestar: { amp: 9, wl: 1600, bank: 0.03 },               // prairie hill
  };
  function terrainFn(def, minY) {
    const T = def.terrain || TERRAIN[def.id] || { amp: 2, wl: 1200 };
    const r = U.rng(def.seed * 7 + 3);
    const waves = [];
    for (let k = 0; k < 4; k++) {
      const a = r() * Math.PI * 2, f = 2 * Math.PI / (T.wl * (1 - k * 0.17));
      waves.push([Math.cos(a) * f, Math.sin(a) * f, r() * 6.283, 1 / (1 + k * 0.7)]);
    }
    const norm = waves.reduce((s, w) => s + w[3], 0);
    return (x, y) => {
      let h = 0;
      for (const [fx, fy, ph, w] of waves) h += Math.sin(x * fx + y * fy + ph) * w;
      h = h / norm * T.amp + (T.base || 0);
      if (T.climb) h += Math.max(0, y - minY) * T.climb;
      return h;
    };
  }
  function smoothLoop(a, sigmaSamples) {
    const n = a.length, R = Math.ceil(sigmaSamples * 3), w = [];
    let ws = 0;
    for (let k = -R; k <= R; k++) { const v = Math.exp(-0.5 * (k / sigmaSamples) ** 2); w.push(v); ws += v; }
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let k = -R; k <= R; k++) s += a[(i + k + n) % n] * w[k + R]; out[i] = s / ws; }
    return out;
  }
  // smooth value noise (deterministic)
  function hash1(i) { let h = (i * 374761393) ^ 0x5bd1e995; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  function vnoise(x) { const i = Math.floor(x), f = x - i, t = f * f * (3 - 2 * f); return hash1(i) * (1 - t) + hash1(i + 1) * t - 0.5; }

  function topography(tr) {
    const def = tr.def, N = tr.N, T = def.terrain || TERRAIN[def.id] || { bank: 0.02 };
    let minY = 1e9; for (let i = 0; i < N; i++) minY = Math.min(minY, tr.y[i]);
    tr.H = terrainFn(def, minY);
    tr.waterY = def.style === 'street' ? minY - 34 : null;
    const raw = new Float64Array(N);
    for (let i = 0; i < N; i++) raw[i] = tr.H(tr.x[i], tr.y[i]);
    const z = smoothLoop(raw, 30 / tr.ds);
    const dz = new Float64Array(N), ddz0 = new Float64Array(N), bank0 = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = z[(i - 1 + N) % N], b = z[(i + 1) % N];
      dz[i] = (b - a) / (2 * tr.ds);
      ddz0[i] = (b - 2 * z[i] + a) / (tr.ds * tr.ds);
      // banking toward the inside of real corners
      const k = tr.kap[i], g = U.smooth((Math.abs(k) - 1 / 450) / (1 / 130 - 1 / 450));
      bank0[i] = -Math.sign(k) * T.bank * g;
    }
    tr.z = z; tr.dz = dz; tr.ddz = smoothLoop(ddz0, 8 / tr.ds); tr.bank = smoothLoop(bank0, 25 / tr.ds);
    tr.rough = def.style === 'street' ? 0.007 : 0.004; // asphalt bump amplitude (m)
    // straight-line (X-mode) aero zones: no real corner within the next 120 m
    tr.xzone = new Uint8Array(N);
    const look = Math.round(120 / tr.ds);
    for (let i = 0; i < N; i++) {
      let ok = 1;
      for (let k = 0; k <= look && ok; k++) if (Math.abs(tr.kap[(i + k) % N]) > 1 / 600) ok = 0;
      tr.xzone[i] = ok;
    }
    tr.rubber = new Float32Array(N).fill(0.3);         // grip build-up on the racing line
  }

  // cross-slope with banking, tapering back to level beyond the kerbs
  function crossZ(tr, i, d) {
    const E = tr.hw + tr.kerbW, b = tr.bank[i], ad = Math.abs(d);
    if (ad <= E) return b * d;
    const e = Math.min(ad - E, 12);
    return Math.sign(d) * b * (E + e - e * e / 24);
  }
  // raised kerb: ramps up over the inner 30 %, flat top with ridges, drops at the outer edge
  function kerbZ(tr, i, d) {
    const side = d > 0 ? tr.kerbR : tr.kerbL;
    if (!side[i]) return 0;
    const e = Math.abs(d) - tr.hw;
    if (e < -0.05 || e > tr.kerbW) return 0;
    const kw = tr.kerbW, t = (e + 0.05) / (0.3 * kw + 0.05);
    return (tr.kerbH ? tr.kerbH[i] : 0.035) * Math.min(1, Math.max(0, t)) * (e > kw - 0.1 ? (kw - e) / 0.1 : 1);
  }
  function surfZ(tr, i, d) { return tr.z[i] + crossZ(tr, i, d) + kerbZ(tr, i, d); }
  // the same surface, interpolated continuously along the lap (for anything that moves)
  function surfS(tr, s, d) {
    const f = (((s % tr.L) + tr.L) % tr.L) / tr.ds, i = Math.floor(f) % tr.N, j = (i + 1) % tr.N, t = f - Math.floor(f);
    const a = tr.z[i] + crossZ(tr, i, d), b = tr.z[j] + crossZ(tr, j, d);
    return a + (b - a) * t + kerbZ(tr, t < 0.5 ? i : j, d);
  }
  // what a tyre feels: surface height plus fine roughness by surface type (physics only)
  function roadZ(tr, i, along, d, surf, s) {
    const j = (i + 1) % tr.N, f = U.clamp(along / tr.ds, -1, 1);
    let h = surfZ(tr, i, d) + (f > 0 ? (tr.z[j] - tr.z[i]) * f : (tr.z[i] - tr.z[(i - 1 + tr.N) % tr.N]) * f);
    let amp = tr.rough, wl = 7;
    if (surf === SURF.KERB) { h += 0.004 * Math.sin(s * Math.PI * 2 / 0.9); amp = 0.004; }
    else if (surf === SURF.GRASS) { amp = 0.02; wl = 3; }
    else if (surf === SURF.GRAVEL) { amp = 0.028; wl = 1.6; }
    h += amp * (vnoise(s / wl + d * 0.17) + 0.5 * vnoise(s / (wl * 0.37) - d * 0.29 + 40));
    return h;
  }
  // ground height anywhere: the road surface near the circuit, blended out to the terrain
  function groundAt(tr, x, y) {
    let best = -1, bd = 1e18;
    tr.hash.near(x, y, 160, i => { const dd = (x - tr.x[i]) ** 2 + (y - tr.y[i]) ** 2; if (dd < bd) { bd = dd; best = i; } });
    const Ht = tr.H(x, y);
    if (best < 0) return Ht;
    const d = (x - tr.x[best]) * tr.nx[best] + (y - tr.y[best]) * tr.ny[best];
    const side = d > 0 ? 1 : 0;
    const edge = Math.max(tr.barr[side][best], Math.abs(tr.pit.off[best]) + tr.pit.lane || 0) + 6;
    const road = tr.z[best] + crossZ(tr, best, d);
    const e = Math.abs(d) - edge, w = U.smooth(e / 60);
    // def.banks (m): the circuit runs in a cutting through wooded hills, as at Spa or the old
    // Nurburgring: earth banks climb from just past the barriers, higher in some stretches
    // than others, and ease back into the terrain further out
    const bank = tr.def.banks ? tr.def.banks * (0.35 + 0.65 * (0.5 + 0.5 * vnoise(best * tr.ds / 260 + side * 17))) * U.smooth(e / 28) * (1 - U.smooth((e - 70) / 110)) : 0;
    return U.lerp(road, Ht, w) + bank;
  }

  // ---------- queries ----------
  // Project a world point onto the centreline starting from a hint index.
  // Returns {i, s, d, u} where d is signed lateral offset (+ right).
  function locate(tr, px, py, hint, out) {
    const N = tr.N, x = tr.x, y = tr.y;
    let i = hint;
    if (i == null || i < 0) {
      let best = 1e18;
      for (let j = 0; j < N; j += 2) {
        const d = (x[j] - px) ** 2 + (y[j] - py) ** 2;
        if (d < best) { best = d; i = j; }
      }
    }
    const dist2 = j => (x[j] - px) ** 2 + (y[j] - py) ** 2;
    let d0 = dist2(i);
    for (let it = 0; it < 400; it++) {
      const a = (i + 1) % N, b = (i - 1 + N) % N;
      const da = dist2(a), db = dist2(b);
      if (da < d0 && da <= db) { i = a; d0 = da; }
      else if (db < d0) { i = b; d0 = db; }
      else break;
    }
    // refine on the segment toward the next sample
    const dx = px - x[i], dy = py - y[i];
    const along = dx * tr.tx[i] + dy * tr.ty[i];
    const d = dx * tr.nx[i] + dy * tr.ny[i];
    let s = i * tr.ds + along;
    if (s < 0) s += tr.L; else if (s >= tr.L) s -= tr.L;
    out = out || {};
    out.i = i; out.s = s; out.d = d; out.along = along;
    return out;
  }

  function surfaceAt(tr, i, d) {
    const ad = Math.abs(d);
    const side = d > 0 ? 1 : 0;
    const po = tr.pit.off[i];
    if (!isNaN(po) && Math.abs(d - po) < tr.pit.lane / 2) return SURF.PIT;
    if (ad <= tr.hw) return SURF.ASPHALT;
    const e = ad - tr.hw;
    const kerb = side ? tr.kerbR[i] : tr.kerbL[i];
    if (kerb && e < tr.kerbW) return SURF.KERB;
    if (e < tr.runW[side][i]) return tr.runT[side][i];
    return tr.def.style === 'street' ? SURF.TARMAC : (tr.def.style === 'modern' ? SURF.GRAVEL : SURF.GRASS);
  }

  function pointAt(tr, s, d) {
    const L = tr.L;
    s = ((s % L) + L) % L;
    const f = s / tr.ds;
    const i = Math.floor(f) % tr.N, j = (i + 1) % tr.N, t = f - Math.floor(f);
    const px = U.lerp(tr.x[i], tr.x[j], t), py = U.lerp(tr.y[i], tr.y[j], t);
    const nxv = U.lerp(tr.nx[i], tr.nx[j], t), nyv = U.lerp(tr.ny[i], tr.ny[j], t);
    return [px + nxv * d, py + nyv * d, Math.atan2(U.lerp(tr.ty[i], tr.ty[j], t), U.lerp(tr.tx[i], tr.tx[j], t))];
  }

  // Forward distance from s1 to s2 around the lap.
  const fwd = (tr, s1, s2) => ((s2 - s1) % tr.L + tr.L) % tr.L;
  const inRange = (tr, s, a, b) => fwd(tr, a, s) <= fwd(tr, a, b);

  // hand-made circuits first, then generated ones (made on demand from the seed in the id)
  const GEN = new Map();
  function byId(id) {
    const d = DEFS.find(x => x.id === id) || GEN.get(id);
    if (d) return d;
    const m = /^gen-(\d+)$/.exec(id || '');
    if (m && F1.TrackGen) { const g = F1.TrackGen.make(+m[1]); GEN.set(g.id, g); return g; }
    return null;
  }
  // the scenery and sky set a circuit borrows (generated circuits reuse a venue's)
  const lookOf = tr => (tr.def && tr.def.look) || tr.id;
  // which trees line the circuit: firs, quiver trees or broadleaf
  const treesOf = tr => (tr.def && tr.def.trees) || ({ hakone: 'fir', rimal: 'quiver' })[lookOf(tr)] || 'broad';

  F1.Tracks = { DEFS, byId, lookOf, treesOf, build, locate, surfaceAt, pointAt, fwd, inRange, DS, surfZ, surfS, roadZ, groundAt, crossZ };
})(typeof window !== 'undefined' ? window : globalThis);
