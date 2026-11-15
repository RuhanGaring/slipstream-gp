// Where the sound is: the acoustics of each stretch of a circuit, for js/audio.js.
// Outdoors a racing car's sound barely reverberates: what comes back is a few echoes off whatever
// stands near the track. So the reverb follows the place. An open stretch gets sparse, distant,
// dull echoes; a grandstand, a pit building or a block on one side gives a hard slap and a short
// bright tail; a street between buildings on both sides rings with flutter echoes bouncing across
// it. Read once per circuit from the race world (Render.build: stands, garages, buildings with
// their heights, trees) by casting rays from the road, and kept per track sample.
(function (G) {
  'use strict';
  const F1 = G.F1;

  // ---------- the map of a circuit ----------
  const CELL = 4, RAYS = 24, REACH = 150;
  // the hard things in the world, as a height grid: footprints rasterised into 4 m cells
  function grid(W) {
    const cells = new Map(), trees = [];
    const put = (x, y, h) => { const k = Math.floor(x / CELL) + ',' + Math.floor(y / CELL); if (!(cells.get(k) >= h)) cells.set(k, h); };
    const disc = (x, y, r, h) => { for (let a = -r; a <= r; a += CELL) for (let b = -r; b <= r; b += CELL) if (a * a + b * b <= r * r) put(x + a, y + b, h); };
    const poly = (p, h) => {
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (const [x, y] of p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      for (let x = x0; x <= x1; x += CELL) for (let y = y0; y <= y1; y += CELL) {
        let inside = false;
        for (let i = 0, j = p.length - 1; i < p.length; j = i++) if ((p[i][1] > y) !== (p[j][1] > y) && x < (p[j][0] - p[i][0]) * (y - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0]) inside = !inside;
        if (inside) put(x, y, h);
      }
    };
    for (const it of (W && W.decor) || []) {
      if (it.type === 'building') {
        const h = it.hgt || 12;
        if (it.poly) poly(it.poly, h); else disc(it.x, it.y, Math.min(it.w || 20, it.h || 20) / 2, h);
      } else if (it.type === 'stand') disc(it.x, it.y, 13, 14);
      else if (it.type === 'garage') disc(it.x, it.y, 7, 8);
      else if (it.type === 'tree' || it.type === 'palm') trees.push(it);
    }
    return { cells, trees };
  }
  function treeGrid(trees) {
    const g = new Map();
    for (const t of trees) { const k = Math.floor(t.x / 40) + ',' + Math.floor(t.y / 40); g.set(k, (g.get(k) || 0) + 1); }
    return g;
  }
  // per track sample: street (buildings close on both sides), semi (something big on one side),
  // forest (trees close by), and on each side (0 left, 1 right) the nearest hard face's distance
  // and height, for the slap echo
  function build(tr, W) {
    if (tr.acoustic && tr.acoustic.W === W) return tr.acoustic;
    const { cells, trees } = grid(W), tg = treeGrid(trees), N = tr.N;
    const step = Math.max(1, Math.round(8 / tr.ds)), P = Math.ceil(N / step);
    const pS = new Float32Array(P), pM = new Float32Array(P), pF = new Float32Array(P), pD = [new Float32Array(P), new Float32Array(P)], pH = [new Float32Array(P), new Float32Array(P)];
    const raw = { cl: new Float32Array(P), cr: new Float32Array(P), en: new Float32Array(P) };
    const hitAt = (x, y) => cells.get(Math.floor(x / CELL) + ',' + Math.floor(y / CELL)) || 0;
    for (let q = 0; q < P; q++) {
      const i = q * step, x = tr.x[i], y = tr.y[i], nx = tr.nx[i], ny = tr.ny[i];
      let encl = 0;
      const cover = [0, 0], nside = [0, 0];
      const slapD = [1e9, 1e9], slapH = [0, 0];
      for (let r = 0; r < RAYS; r++) {
        const a = r / RAYS * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
        // which side of the road the ray looks to (+ right, along the normal), and how squarely
        const lat = dx * nx + dy * ny, side = lat > 0 ? 1 : 0, square = Math.abs(lat);
        let hd = 0, hh = 0;
        for (let d = 6; d <= REACH; d += 3) { const h = hitAt(x + dx * d, y + dy * d); if (h > 0) { hd = d; hh = h; break; } }
        if (square > 0.5) { nside[side]++; if (hd && hd < 60) cover[side] += Math.min(1, hh / 10); }
        if (hd) {
          encl += Math.min(1, hh / 12) * (1 - hd / REACH);
          if (square > 0.9 && hd < slapD[side]) { slapD[side] = hd; slapH[side] = hh; }
        }
      }
      const cl = cover[0] / Math.max(1, nside[0]), cr = cover[1] / Math.max(1, nside[1]);
      raw.cl[q] = cl; raw.cr[q] = cr; raw.en[q] = encl / RAYS;
      // a street: built up on both sides (the side with less decides); one big face: built up on
      // one side only (where both are, it is the street's)
      const clamp = v => Math.min(1, Math.max(0, v));
      pS[q] = clamp((Math.min(cl, cr) - 0.35) / 0.55);
      pM[q] = clamp(Math.max(cl, cr) * 1.4 - 0.15) * (1 - pS[q]);
      let n = 0;
      const gx = Math.floor(x / 40), gy = Math.floor(y / 40);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) n += tg.get((gx + a) + ',' + (gy + b)) || 0;
      pF[q] = Math.min(1, n / 40);
      for (let s = 0; s < 2; s++) { pD[s][q] = slapD[s] < 1e9 ? slapD[s] : 0; pH[s][q] = slapH[s]; }
    }
    // spread over the samples, smoothed along the road (about 40 m), so the room changes gradually
    const out = { W, street: new Float32Array(N), semi: new Float32Array(N), forest: new Float32Array(N), slapD: [new Float32Array(N), new Float32Array(N)], slapH: [new Float32Array(N), new Float32Array(N)] };
    const sm = (src, dst, w) => {
      for (let i = 0; i < N; i++) {
        let acc = 0, n = 0;
        for (let k = -w; k <= w; k++) { const q = ((Math.round(i / step) + k) % P + P) % P; acc += src[q]; n++; }
        dst[i] = acc / n;
      }
    };
    const w = Math.max(1, Math.round(20 / (step * tr.ds)));
    sm(pS, out.street, w); sm(pM, out.semi, w); sm(pF, out.forest, w);
    // (a slap belongs to the face that is there: nearest, not averaged)
    for (let s = 0; s < 2; s++) for (let i = 0; i < N; i++) { const q = Math.round(i / step) % P; out.slapD[s][i] = pD[s][q]; out.slapH[s][i] = pH[s][q]; }
    out.raw = raw;
    tr.acoustic = out;
    return out;
  }

  // ---------- the rooms ----------
  // impulse responses made from seeded noise, stereo and decorrelated; all at one energy, so the
  // send levels alone say how much of each is heard
  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function lowpass(a, sr, f) { const k = 1 - Math.exp(-2 * Math.PI * f / sr); let y = 0; for (let i = 0; i < a.length; i++) { y += k * (a[i] - y); a[i] = y; } }
  // (to the energy of the one room the game had before, a 1.4 s noise tail: a send of 1 is as loud)
  function norm(chs, sr) { let e = 0; for (const a of chs) for (const x of a) e += x * x; const k = Math.sqrt(sr * 1.4 / 22.2) / Math.sqrt(e / chs.length + 1e-12); for (const a of chs) for (let i = 0; i < a.length; i++) a[i] *= k; }
  function irs(ctx) {
    const sr = ctx.sampleRate, out = {};
    const make = (len, fill) => { const L = Math.floor(sr * len), b = ctx.createBuffer(2, L, sr), chs = [b.getChannelData(0), b.getChannelData(1)]; chs.forEach((a, ch) => fill(a, ch, rng(97 + ch * 31 + Math.floor(len * 1000)))); norm(chs, sr); return b; };
    // open air: no room, only scattered echoes off distant banks, buildings and trees, arriving
    // late and dull, with a faint diffuse wash under them
    out.open = make(1.6, (a, ch, r) => {
      for (let i = 0; i < a.length; i++) { const t = i / sr; a[i] = (r() * 2 - 1) * 0.05 * Math.exp(-t / 0.22) * Math.min(1, t / 0.03); }
      for (let k = 0; k < 34; k++) {
        const t = 0.07 + Math.pow(r(), 1.4) * 1.3, i0 = Math.floor(t * sr), amp = (0.35 + r() * 0.65) * Math.exp(-t / 0.45);
        for (let j = 0; j < sr * 0.012 && i0 + j < a.length; j++) a[i0 + j] += (r() * 2 - 1) * amp * Math.exp(-j / (sr * 0.003));
      }
      lowpass(a, sr, 2200);
    });
    // one big face close by (a grandstand, the pit building, a block of flats): early reflections
    // and a short, fairly bright tail
    out.semi = make(1.2, (a, ch, r) => {
      for (let k = 0; k < 8; k++) { const t = 0.012 + r() * 0.07, i0 = Math.floor(t * sr); a[i0] += (r() < 0.5 ? -1 : 1) * (0.6 + r() * 0.4) * 3; }
      for (let i = 0; i < a.length; i++) { const t = i / sr; a[i] += (r() * 2 - 1) * Math.exp(-6.9 * t / 0.85) * Math.min(1, t / 0.015); }
      lowpass(a, sr, 5000);
    });
    // a street: two facades facing each other, the sound bouncing across (about 22 m, so every
    // 0.13 s, alternating ears) and smearing a little more each time, over a dense bright tail
    out.street = make(2.0, (a, ch, r) => {
      const P = 0.128;
      for (let n = 1; n * P < 1.9; n++) {
        const t = n * P + (ch === n % 2 ? 0 : 0.004), i0 = Math.floor(t * sr), amp = Math.exp(-6.9 * t / 1.6) * (ch === n % 2 ? 1 : 0.55) * 4, spread = sr * (0.002 + 0.004 * n);
        for (let j = 0; j < spread * 4 && i0 + j < a.length; j++) a[i0 + j] += (r() * 2 - 1) * amp * Math.exp(-j / spread);
      }
      for (let i = 0; i < a.length; i++) { const t = i / sr; a[i] += (r() * 2 - 1) * 0.6 * Math.exp(-6.9 * t / 1.4) * Math.min(1, t / 0.02); }
      lowpass(a, sr, 6500);
    });
    return out;
  }

  F1.AudioSpace = { build, irs };
})(typeof window !== 'undefined' ? window : globalThis);
