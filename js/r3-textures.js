// Procedural textures for the 3D renderer: drawn once on canvases, no image files.
(function (G) {
  'use strict';
  const F1 = G.F1;
  const U = F1.U;

  function cv(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function speckle(g, w, h, n, cols, s0, s1, rnd) {
    for (let i = 0; i < n; i++) {
      g.fillStyle = cols[Math.floor(rnd() * cols.length)];
      const s = s0 + rnd() * (s1 - s0);
      g.fillRect(rnd() * w, rnd() * h, s, s);
    }
  }
  function tex(c, srgb = true, rep = true) {
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    if (rep) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
    t.anisotropy = 8;
    return t;
  }

  const cache = {};
  function get(key, fn) { return cache[key] || (cache[key] = fn()); }

  const T = {};
  T.asphalt = () => get('asphalt', () => {
    const c = cv(512, 512), g = c.getContext('2d'), r = U.rng(3);
    g.fillStyle = '#3d4045'; g.fillRect(0, 0, 512, 512);
    speckle(g, 512, 512, 26000, ['#36393e', '#45484d', '#2f3236', '#4c4f55', '#3a3d41'], 1, 2.4, r);
    speckle(g, 512, 512, 900, ['#5c5f64', '#26282b'], 1, 3, r);
    // faint patching
    g.globalAlpha = 0.06;
    for (let k = 0; k < 14; k++) { g.fillStyle = r() < 0.5 ? '#000' : '#fff'; g.fillRect(r() * 512, r() * 512, 60 + r() * 160, 40 + r() * 120); }
    g.globalAlpha = 1;
    return tex(c);
  });
  T.grass = (a = '#4c7a33', b = '#557f3c') => get('grass' + a, () => {
    const c = cv(512, 512), g = c.getContext('2d'), r = U.rng(5);
    for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? a : b; g.fillRect(0, i * 64, 512, 64); }
    speckle(g, 512, 512, 30000, ['rgba(40,70,25,.35)', 'rgba(110,150,70,.25)', 'rgba(60,95,35,.4)'], 1, 2.5, r);
    return tex(c);
  });
  T.gravel = () => get('gravel', () => {
    const c = cv(512, 512), g = c.getContext('2d'), r = U.rng(7);
    g.fillStyle = '#c9b38a'; g.fillRect(0, 0, 512, 512);
    speckle(g, 512, 512, 40000, ['#b7a07a', '#dbc8a3', '#a88f6a', '#e6d6b6', '#9a8463'], 1, 3, r);
    return tex(c);
  });
  // worn verge: sandy soil showing through thinned turf, solid at the track edge (v = 0) and
  // breaking up into tufts and bare spots toward the grass (v = 1); tiles along the edge (u)
  T.wear = () => get('wear', () => {
    const w = 2048, h = 64, c = cv(w, h), g = c.getContext('2d'), r = U.rng(29);
    const img = g.createImageData(w, h), d = img.data;
    const n1 = new Float32Array(w * h);
    // value noise wrapped in u, a few octaves
    const grid = (gx, gy) => { const a = new Float32Array(gx * gy); for (let k = 0; k < a.length; k++) a[k] = r(); return (x, y) => {
      const fx = x * gx, fy = y * (gy - 1), i0 = Math.floor(fx), j0 = Math.min(gy - 2, Math.floor(fy)), tx = fx - i0, ty = fy - j0, i1 = (i0 + 1) % gx;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty), A = a[j0 * gx + i0 % gx], B = a[j0 * gx + i1], C = a[(j0 + 1) * gx + i0 % gx], D = a[(j0 + 1) * gx + i1];
      return (A * (1 - sx) + B * sx) * (1 - sy) + (C * (1 - sx) + D * sx) * sy; }; };
    const o = [grid(40, 4), grid(120, 6), grid(400, 14)], og = grid(4, 2);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const u = x / w, v = y / (h - 1);
      const n = o[0](u, v) * 0.5 + o[1](u, v) * 0.3 + o[2](u, v) * 0.2;
      const run = Math.max(0, Math.min(1, (og(u, 0.3) - 0.38) * 4)); // stretches of clean edge between worn ones
      const a = Math.max(0, Math.min(1, (n - v * 0.85) * 3.2 + 0.25 - v * 0.4)) * run;
      const k = (y * w + x) * 4, t = 0.85 + o[2](u, v) * 0.3;
      d[k] = 206 * t; d[k + 1] = 186 * t; d[k + 2] = 146 * t; d[k + 3] = a * 255;
    }
    g.putImageData(img, 0, 0);
    const t = tex(c); t.wrapT = THREE.ClampToEdgeWrapping; return t;
  });
  T.runoff = col => get('runoff' + col, () => {
    const c = cv(256, 256), g = c.getContext('2d'), r = U.rng(9);
    g.fillStyle = col; g.fillRect(0, 0, 256, 256);
    speckle(g, 256, 256, 9000, ['rgba(0,0,0,.08)', 'rgba(255,255,255,.06)'], 1, 2, r);
    return tex(c);
  });
  T.ground = (col, specks) => get('ground' + col, () => {
    const c = cv(512, 512), g = c.getContext('2d'), r = U.rng(11);
    g.fillStyle = col; g.fillRect(0, 0, 512, 512);
    speckle(g, 512, 512, 30000, specks, 1, 3.2, r);
    return tex(c);
  });
  T.concrete = () => get('concrete', () => {
    const c = cv(256, 128), g = c.getContext('2d'), r = U.rng(13);
    g.fillStyle = '#c8cacd'; g.fillRect(0, 0, 256, 128);
    speckle(g, 256, 128, 3000, ['#b9bbbe', '#d6d8db'], 1, 2, r);
    g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(0, 0, 2, 128); g.fillRect(128, 0, 2, 128); // block seams
    g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(0, 118, 256, 10);
    return tex(c);
  });
  T.armco = () => get('armco', () => {
    const c = cv(128, 64), g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 0, 64);
    gr.addColorStop(0, '#d5d9dd'); gr.addColorStop(0.3, '#9ea4aa'); gr.addColorStop(0.5, '#e4e7ea'); gr.addColorStop(0.75, '#8c9298'); gr.addColorStop(1, '#c9cdd1');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 64);
    g.fillStyle = '#5b6066'; g.fillRect(60, 0, 8, 64);
    return tex(c);
  });
  T.tyres = () => get('tyres', () => {
    const c = cv(256, 128), g = c.getContext('2d');
    g.fillStyle = '#16171a'; g.fillRect(0, 0, 256, 128);
    for (let x = 0; x < 256; x += 32) for (let y = 0; y < 128; y += 32) {
      g.fillStyle = '#0c0d0f'; g.beginPath(); g.arc(x + 16, y + 16, 14, 0, 6.283); g.fill();
      g.fillStyle = '#2a2c30'; g.beginPath(); g.arc(x + 16, y + 16, 6, 0, 6.283); g.fill();
    }
    // conveyor belt facing in sponsor colours
    g.fillStyle = '#d42a2a'; g.fillRect(0, 44, 256, 18);
    g.fillStyle = '#f2f2f2'; for (let x = 0; x < 256; x += 64) g.fillRect(x, 44, 32, 18);
    return tex(c);
  });
  T.fence = () => get('fence', () => {
    const c = cv(128, 128), g = c.getContext('2d');
    g.clearRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(70,74,78,0.9)'; g.lineWidth = 2;
    for (let k = -128; k < 256; k += 16) { g.beginPath(); g.moveTo(k, 0); g.lineTo(k + 128, 128); g.stroke(); g.beginPath(); g.moveTo(k + 128, 0); g.lineTo(k, 128); g.stroke(); }
    g.fillStyle = 'rgba(60,64,68,1)'; g.fillRect(0, 0, 128, 4); g.fillRect(0, 0, 4, 128);
    const t = tex(c); return t;
  });
  T.crowd = () => get('crowd', () => {
    // spectators on stepped seating, as a photograph of a full stand shows them: a dark, uneven
    // mass (most people wear navy, black and grey), pale faces and caps as specks, the odd bright
    // jacket or team shirt, empty seats in ones and in clumps, two stair aisles and a rail along
    // the front. The rows under the roof are in its shade (the top of the canvas is the back of
    // the stand); the front rows stand in the open.
    const c = cv(1024, 512), g = c.getContext('2d'), r = U.rng(17);
    g.fillStyle = '#2a2e33'; g.fillRect(0, 0, 1024, 512);
    const pick = a => a[Math.floor(r() * a.length)];
    const dark = ['#1b2030', '#141518', '#23262b', '#1d2a44', '#2b2f36', '#30343c', '#1f2c26', '#33291f', '#272c3f', '#3a3f48', '#151a24'];
    const mid = ['#586270', '#4a566b', '#6b6f72', '#5a6352', '#6a4a44', '#4d5f7a', '#7a756a', '#544a5e'];
    const pale = ['#d8d6cf', '#c9cdd2', '#e4e2dc', '#b9c4cf', '#cfc6b0'];
    const loud = ['#b8322a', '#d2691e', '#c9a227', '#1f6f5c', '#2b5fa8', '#a02040', '#e07a1f'];
    const skin = ['#d9b08c', '#c4946c', '#a5714c', '#7a4f33', '#e6c3a3', '#b98a63'];
    const hair = ['#17130f', '#2a2019', '#3b2c1e', '#5a4630', '#8a8478', '#c9c2b4', '#101012'];
    const caps = ['#15171a', '#e9e7e0', '#b8322a', '#1d2a44', '#d2691e', '#3a3f48', '#1f6f5c'];
    const seat = ['#4f5a5c', '#566163', '#4a5557'];
    // where a block of seats is empty: a slow random field, so empties come in clumps
    const gw = 26, gh = 22, fld = new Float32Array(gw * gh); for (let k = 0; k < fld.length; k++) fld[k] = r();
    const empty = (x, row) => { const fx = x / 1024 * (gw - 1), i = Math.floor(fx), t = fx - i; return fld[row * gw + i] * (1 - t) + fld[row * gw + Math.min(gw - 1, i + 1)] * t; };
    const aisle = x => (x > 142 && x < 166) || (x > 449 && x < 473) || (x > 756 && x < 780);
    let row = 0;
    for (let y = 0; y < 512; y += 24, row++) {
      // the step: its tread in front of the row and the dark riser under the seats
      g.fillStyle = '#3a3f44'; g.fillRect(0, y + 18, 1024, 3);
      g.fillStyle = '#15171a'; g.fillRect(0, y + 21, 1024, 3);
      let x = r() * 5;
      while (x < 1024) {
        const w = 8.5 + r() * 3.5, cx = x + w / 2;
        if (aisle(cx)) { x += w; continue; }
        const e = empty(cx, row);
        if (e < 0.2 || r() < 0.07) {
          // an empty seat: its back and the tipped-up squab
          g.fillStyle = pick(seat); g.fillRect(x + 1, y + 7, w - 2, 9);
          g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(x + 1, y + 14, w - 2, 2);
        } else {
          const q = r(), body = q < 0.6 ? pick(dark) : q < 0.8 ? pick(mid) : q < 0.92 ? pick(pale) : pick(loud);
          const lean = (r() - 0.5) * 2.4, top = y + 1 + r() * 4, hw = 2.1 + r() * 0.6, hh = 3.1 + r() * 0.7, sw = w * (0.42 + r() * 0.1);
          // shoulders and chest, sloping from the neck, down to the seat in front
          g.fillStyle = body;
          g.beginPath(); g.moveTo(cx - sw, y + 21); g.lineTo(cx - sw, top + hh * 2 + 3); g.quadraticCurveTo(cx - sw * 0.7, top + hh * 2 - 0.5, cx + lean * 0.4, top + hh * 2 - 1);
          g.quadraticCurveTo(cx + sw * 0.7, top + hh * 2 - 0.5, cx + sw, top + hh * 2 + 3); g.lineTo(cx + sw, y + 21); g.closePath(); g.fill();
          // a fold of shade down one side, so a body is not a flat patch
          g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(cx + (lean > 0 ? -sw : sw * 0.35), top + hh * 2 + 2, sw * 0.65, y + 19 - top - hh * 2);
          // head, then hair or a cap over its upper half
          g.fillStyle = pick(skin);
          g.beginPath(); g.ellipse(cx + lean, top + hh, hw, hh, 0, 0, 6.283); g.fill();
          const hq = r();
          g.fillStyle = hq < 0.36 ? pick(caps) : pick(hair);
          if (hq < 0.9) { g.beginPath(); g.ellipse(cx + lean, top + hh * 0.72, hw * 1.05, hh * 0.78, 0, Math.PI, 0); g.fill(); }
          if (hq < 0.12) g.fillRect(cx + lean - hw * 1.5, top + hh * 0.7, hw * 3, 1.1);   // (a brim)
          // forearms or hands in the lap on some
          if (r() < 0.28) { g.fillStyle = pick(skin); g.fillRect(cx - 1.5 + lean, y + 15 + r() * 2, 3 + r() * 2, 1.6); }
        }
        x += w + r() * 1.6;
      }
      // the stair aisles: concrete steps with a painted nosing
      for (const ax of [142, 449, 756]) {
        g.fillStyle = '#7c8083'; g.fillRect(ax, y, 24, 24);
        g.fillStyle = '#5c6063'; g.fillRect(ax, y + 9, 24, 3); g.fillRect(ax, y + 21, 24, 3);
        g.fillStyle = '#b9a23c'; g.fillRect(ax, y + 7, 24, 1.5); g.fillRect(ax, y + 19, 24, 1.5);
      }
    }
    // a little dirt over everything, so no two patches of one colour are the same
    speckle(g, 1024, 512, 5000, ['rgba(0,0,0,0.16)', 'rgba(255,255,255,0.05)', 'rgba(0,0,0,0.1)'], 1, 3, r);
    // the roof's shade: all but the front quarter of the rows, cooler and far darker than the open
    g.globalCompositeOperation = 'multiply';
    const sh = g.createLinearGradient(0, 0, 0, 512);
    sh.addColorStop(0, 'rgb(148,158,176)'); sh.addColorStop(0.7, 'rgb(164,172,186)'); sh.addColorStop(0.8, 'rgb(255,255,255)'); sh.addColorStop(1, 'rgb(255,255,255)');
    g.fillStyle = sh; g.fillRect(0, 0, 1024, 512);
    g.globalCompositeOperation = 'source-over';
    // the rail along the front
    g.fillStyle = '#9aa0a4'; g.fillRect(0, 505, 1024, 2);
    g.fillStyle = 'rgba(160,166,170,0.8)'; for (let x = 0; x < 1024; x += 44) g.fillRect(x, 494, 1.5, 12);
    return tex(c);
  });
  T.windows = () => get('windows', () => {
    const c = cv(256, 256), g = c.getContext('2d'), r = U.rng(19);
    g.fillStyle = '#d8d1c4'; g.fillRect(0, 0, 256, 256);
    for (let y = 8; y < 256; y += 32) for (let x = 8; x < 256; x += 32) {
      g.fillStyle = r() < 0.15 ? '#c9a46a' : '#3d4d5c'; g.fillRect(x, y, 18, 20);
      g.fillStyle = 'rgba(255,255,255,.15)'; g.fillRect(x, y, 18, 4);
    }
    return tex(c);
  });
  T.checker = () => get('checker', () => {
    const c = cv(128, 32), g = c.getContext('2d');
    for (let x = 0; x < 16; x++) for (let y = 0; y < 4; y++) { g.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4'; g.fillRect(x * 8, y * 8, 8, 8); }
    const t = tex(c); t.magFilter = THREE.NearestFilter; return t;
  });
  T.board = n => get('board' + n, () => {
    const c = cv(64, 96), g = c.getContext('2d');
    g.fillStyle = '#f6f6f6'; g.fillRect(0, 0, 64, 96);
    g.fillStyle = '#111';
    for (let k = 0; k < n; k++) g.fillRect(10 + k * 16, 12, 9, 72);
    return tex(c, true, false);
  });
  T.soft = () => get('soft', () => {
    const c = cv(64, 64), g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return tex(c, false, false);
  });
  // Shadow masks for alphaMap, which reads the green channel: an opaque greyscale ramp, black
  // at the edge (a canvas with transparency stores white there and the shadow would fill
  // the whole quad). contact: dense over its inner third, then a long falloff; softA: a
  // gentle falloff from the centre.
  const mask = (key, fn) => get(key, () => {
    const n = 128, c = cv(n, n), g = c.getContext('2d'), img = g.createImageData(n, n), d = img.data;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const r = Math.min(1, Math.hypot((x + 0.5) / n * 2 - 1, (y + 0.5) / n * 2 - 1)), v = Math.round(fn(r) * 255);
      const i = (y * n + x) * 4; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return tex(c, false, false);
  });
  const smooth = t => t * t * (3 - 2 * t);
  T.softA = () => mask('softMask', r => Math.pow(1 - smooth(r), 1.1));
  T.number = (num, col) => {
    const c = cv(128, 64), g = c.getContext('2d');
    g.clearRect(0, 0, 128, 64);
    g.font = 'italic 900 52px Titillium Web, Segoe UI, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = col; g.fillText(String(num), 64, 34);
    return tex(c, true, false);
  };
  // distant ridge line for the horizon band
  T.ridge = (cols, seed, jag, canopy) => get('ridge' + seed + (canopy ? 'c' : ''), () => {
    const c = cv(2048, 256), g = c.getContext('2d'), r = U.rng(seed);
    g.clearRect(0, 0, 2048, 256);
    // layered silhouettes from summed sine octaves (seamless around the ring),
    // each layer nearer, darker and lower than the one behind it
    cols.forEach((col, layer) => {
      const oct = [];
      for (let k = 0; k < 5; k++) oct.push([2 + Math.floor(r() * (3 << k)), r() * 6.283, 1 / (1 + k * k * 1.6)]);
      const top = 40 + layer * 34, amp = Math.min(1, jag / 14) * (70 - layer * 12);
      // each layer on its own canvas, so its texture stays inside its own outline
      const lc = cv(2048, 256), lg = lc.getContext('2d');
      const gr = lg.createLinearGradient(0, top, 0, 256);
      gr.addColorStop(0, col); gr.addColorStop(1, cols[0]);
      lg.fillStyle = gr;
      lg.beginPath(); lg.moveTo(0, 256);
      for (let x = 0; x <= 2048; x += canopy ? 2 : 4) {
        let v = 0;
        for (const [f, ph, a] of oct) v += Math.sin(x / 2048 * 6.283 * f + ph) * a;
        // forested hills: the skyline is a row of crowns a few metres high, not a smooth curve
        const crowns = canopy ? Math.abs(Math.sin(x * 0.9 + layer * 1.7)) * (2.4 - layer * 0.5) + r() * 1.2 : 0;
        lg.lineTo(x, U.clamp(top + 40 - v * amp * 0.45 - crowns, 8, 250));
      }
      lg.lineTo(2048, 256); lg.closePath(); lg.fill();
      if (canopy) {
        // canopy texture: crowns lit on top and shaded below, denser and finer on far layers,
        // plus the odd lighter field or clearing on the slopes
        lg.globalCompositeOperation = 'source-atop';
        const n = 9000 + layer * 3000, rad = 1.1 + layer * 0.55;
        for (let k = 0; k < n; k++) {
          const x = r() * 2048, y = top - 20 + r() * (256 - top + 20), q = r();
          lg.fillStyle = q < 0.5 ? 'rgba(10,22,12,' + (0.05 + layer * 0.025) + ')' : 'rgba(225,235,200,' + (0.025 + layer * 0.012) + ')';
          lg.beginPath(); lg.ellipse(x, y, rad * (0.8 + r()), rad * (0.6 + r() * 0.6), 0, 0, 6.283); lg.fill();
        }
        for (let k = 0; k < 10 + layer * 4; k++) {
          const x = r() * 2048, y = top + 40 + r() * 120, w = 20 + r() * 70, h = 4 + r() * 10;
          lg.fillStyle = 'rgba(190,200,140,' + (0.05 + r() * 0.06) + ')';
          lg.beginPath(); lg.ellipse(x, y, w, h, (r() - 0.5) * 0.3, 0, 6.283); lg.fill();
        }
        lg.globalCompositeOperation = 'source-over';
      }
      g.drawImage(lc, 0, 0);
    });
    const t = tex(c); t.wrapT = THREE.ClampToEdgeWrapping; return t;
  });
  T.lot = () => get('lot', () => {
    const c = cv(256, 256), g = c.getContext('2d');
    g.fillStyle = '#6a6a67'; g.fillRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 2;
    for (let x = 0; x < 256; x += 22) { g.beginPath(); g.moveTo(x, 8); g.lineTo(x, 70); g.stroke(); g.beginPath(); g.moveTo(x, 186); g.lineTo(x, 248); g.stroke(); }
    return tex(c);
  });

  // 2x2 twill carbon weave: each tow is a lens of fibres, lit across its width.
  // Returns { map, normal } built from the same height field.
  T.carbon = () => get('carbon', () => {
    const n = 256, cell = 16, hgt = new Float32Array(n * n), alb = cv(n, n), ga = alb.getContext('2d');
    const img = ga.createImageData(n, n), d = img.data;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      const warp = ((cx + cy) >> 1) % 2 === 0; // twill: diagonal steps of two
      const u = (warp ? x : y) % cell / cell, v = (warp ? y : x) % cell / cell;
      const lens = Math.sin(Math.PI * u); // rounded across the tow
      const h = 0.25 + 0.75 * lens;
      hgt[y * n + x] = h;
      const fibre = 0.9 + 0.1 * Math.sin(v * Math.PI * 22 + u * 3);
      const c = (18 + 26 * Math.pow(lens, 3) * (warp ? 1 : 0.7)) * fibre;
      const i = (y * n + x) * 4;
      d[i] = c; d[i + 1] = c * 1.03; d[i + 2] = c * 1.1; d[i + 3] = 255;
    }
    ga.putImageData(img, 0, 0);
    const nor = cv(n, n), gn = nor.getContext('2d'), ni = gn.createImageData(n, n), nd = ni.data;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const hx = hgt[y * n + (x + 1) % n] - hgt[y * n + (x + n - 1) % n], hy = hgt[((y + 1) % n) * n + x] - hgt[((y + n - 1) % n) * n + x];
      const l = Math.hypot(hx * 3, hy * 3, 1), i = (y * n + x) * 4;
      nd[i] = (-hx * 3 / l * 0.5 + 0.5) * 255; nd[i + 1] = (hy * 3 / l * 0.5 + 0.5) * 255; nd[i + 2] = (1 / l * 0.5 + 0.5) * 255; nd[i + 3] = 255;
    }
    gn.putImageData(ni, 0, 0);
    return { map: tex(alb), normal: tex(nor, false) };
  });

  // Tyre sidewall: moulded lettering around the rim, in grey rubber (planar UV on a ring)
  T.sidewall = () => get('sidewall', () => {
    const n = 512, c = cv(n, n), g = c.getContext('2d');
    g.fillStyle = '#141416'; g.fillRect(0, 0, n, n);
    g.strokeStyle = 'rgba(70,72,76,0.9)'; g.lineWidth = 2;
    for (const r of [0.74, 0.97]) { g.beginPath(); g.arc(n / 2, n / 2, r * n / 2, 0, 6.283); g.stroke(); }
    g.font = '900 25px Titillium Web, Segoe UI, sans-serif'; g.fillStyle = '#b9babd'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const word = (txt, a0, r) => {
      const step = 0.072;
      [...txt].forEach((ch, k) => {
        const a = a0 + (k - (txt.length - 1) / 2) * step;
        g.save(); g.translate(n / 2 + Math.cos(a) * r, n / 2 + Math.sin(a) * r); g.rotate(a + Math.PI / 2); g.fillText(ch, 0, 0); g.restore();
      });
    };
    word('SLIPSTREAM', -Math.PI / 2, n * 0.448); word('SLIPSTREAM', Math.PI / 2, n * 0.448);
    return tex(c, true, false);
  });

  // Armco W-beam profile as a normal map: two ridges across the rail height
  T.corrugation = () => get('corrugation', () => {
    const c = cv(8, 128), g = c.getContext('2d'), img = g.createImageData(8, 128), d = img.data;
    for (let y = 0; y < 128; y++) {
      const s = Math.cos(y / 128 * Math.PI * 4) * 0.85;
      const l = Math.hypot(s, 1);
      for (let x = 0; x < 8; x++) { const i = (y * 8 + x) * 4; d[i] = 128; d[i + 1] = (s / l * 0.5 + 0.5) * 255; d[i + 2] = (1 / l * 0.5 + 0.5) * 255; d[i + 3] = 255; }
    }
    g.putImageData(img, 0, 0);
    return tex(c, false);
  });

  // Tileable low-frequency noise (R and G are independent fields) used to break up
  // texture repetition over large areas.
  T.macro = () => get('macro', () => {
    const n = 256, c = cv(n, n), g = c.getContext('2d'), img = g.createImageData(n, n), d = img.data, r = U.rng(23);
    const waves = ch => Array.from({ length: 14 }, (_, k) => [1 + Math.floor(r() * (2 + k)), 1 + Math.floor(r() * (2 + k)) * (r() < 0.5 ? -1 : 1), r() * 6.283, 1 / (1 + k * 0.6), ch]);
    const W = [waves(0), waves(1)];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      for (const ch of [0, 1]) {
        let v = 0, s = 0;
        for (const [fx, fy, ph, a] of W[ch]) { v += Math.sin((fx * x + fy * y) / n * 6.283 + ph) * a; s += a; }
        d[i + ch] = (v / s * 0.5 + 0.5) * 255;
      }
      d[i + 2] = 128; d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return tex(c, false);
  });

  // ---- photo textures (CC0, embedded as data URIs by tools/assets_prep.py) ----
  // Each call returns its own texture with its own repeat; all share one image, and one copy of
  // it on the GPU (one three.js Source: three.js keeps one GL texture per source and settings).
  //
  // GPU-compressed copies (KTX2, tools/ktx_prep.py) are used where the page is served over http
  // and the browser can run the Basis transcoder: a texture takes a quarter to a sixth of the
  // memory, and the decoding runs in worker threads instead of the main one. Otherwise (file://,
  // no WebAssembly, a failure) the JPEG bundles js/assets/photos_*.js are loaded instead.
  // T.ready(renderer) settles which, before any circuit is built.
  const imgs = {}, photoCache = {}, ktxOf = {};
  let ktx = null;
  T.has = key => !!((F1.Assets && F1.Assets[key]) || (ktx && F1.AssetsK && F1.AssetsK[key]));
  const ver = (() => { const s = document.querySelector('script[src*="js/r3-textures.js"]'), m = s && /[?&]v=(\w+)/.exec(s.src); return m ? '?v=' + m[1] : ''; })();
  // (a bundle that does not arrive is asked for twice more: a circuit built without the photos
  // keeps its drawn stand-ins, flat boxes with a grid of squares for a town, for the whole session)
  const later = ms => new Promise(ok => setTimeout(ok, ms));
  const fallback = () => Promise.all((F1.AssetsKFallback || []).map(src => new Promise(ok => {
    const go = n => {
      const s = document.createElement('script'); s.src = src + ver + (n ? (ver ? '&' : '?') + 'again=' + n : '');
      s.onload = ok; s.onerror = () => { if (n < 2) later(400).then(() => go(n + 1)); else { console.warn('Slipstream: photo bundle missing', src); ok(); } };
      document.head.appendChild(s);
    };
    go(0);
  })));
  // one compressed file, asked for again (twice) if the request fails
  const loadK = (L, key, n = 0) => L.loadAsync(F1.AssetsK[key].f + ver).catch(e => { if (n >= 2) throw e; return later(300 * (n + 1)).then(() => loadK(L, key, n + 1)); });
  T.ready = renderer => {
    if (T.readyP) return T.readyP;
    const can = F1.AssetsK && /^https?:/.test(location.protocol) && typeof WebAssembly === 'object' && typeof Worker === 'function' && !G.__noKtx;
    T.readyP = (can ? import('./vendor/ktx2/KTX2Loader.js' + ver).then(m => {
      const L = new m.KTX2Loader().setTranscoderPath('js/vendor/ktx2/').setWorkerLimit(Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2)));
      L.detectSupport(renderer);
      // one tiny file through the whole path first: if anything in it fails, use the JPEGs
      const k0 = Object.keys(F1.AssetsK).sort((a, b) => F1.AssetsK[a].w - F1.AssetsK[b].w)[0];
      return loadK(L, k0).then(t => { ktxOf[k0] = Promise.resolve(t); ktx = L; });
    }) : Promise.reject(new Error('no KTX2 here'))).catch(e => {
      if (can) console.warn('Slipstream: compressed textures unavailable, using JPEG', e);
      ktx = null; return fallback();
    });
    return T.readyP;
  };
  T.compressed = () => !!ktx;
  // which copy of the photos this session runs on: 'ktx', 'jpeg', or 'none' (the drawn stand-ins)
  T.pack = () => (ktx ? 'ktx' : F1.Assets && F1.Assets.asphalt ? 'jpeg' : 'none');
  // a KTX2 file's levels, formats and filtering laid onto a texture made earlier (materials keep
  // the object they were given), so all the textures of one photo share the same mip arrays
  function takeKtx(t, ct) {
    t.isCompressedTexture = true;
    t.source = ct.source; t.mipmaps = ct.mipmaps;
    t.format = ct.format; t.type = ct.type; t.generateMipmaps = false; t.flipY = false;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
  }
  T.photo = (key, rep = 1, srgb = true) => {
    const ck = key + '|' + rep + '|' + srgb;
    if (photoCache[ck]) return photoCache[ck];
    const t = new THREE.Texture();
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    if (Array.isArray(rep)) t.repeat.set(rep[0], rep[1]); else t.repeat.set(rep, rep);
    if (ktx && F1.AssetsK[key]) {
      const k = F1.AssetsK[key];
      (ktxOf[key] || (ktxOf[key] = loadK(ktx, key))).then(ct => takeKtx(t, ct), e => console.warn('Slipstream: texture', key, e));
      return (photoCache[ck] = t);
    }
    let im = imgs[key];
    if (!im) {
      im = imgs[key] = new Image();
      im.waiting = []; im.source = new THREE.Source(null);
      im.onload = () => { im.source.data = im; for (const w of im.waiting) w.needsUpdate = true; im.waiting = null; };
      im.src = F1.Assets[key];
    }
    t.source = im.source;
    if (im.waiting) im.waiting.push(t); else t.needsUpdate = true;
    return (photoCache[ck] = t);
  };
  T.image = key => { if (!imgs[key]) T.photo(key); return imgs[key]; };

  F1.R3T = T;
})(typeof window !== 'undefined' ? window : globalThis);
