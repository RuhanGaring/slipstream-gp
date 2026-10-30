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
    const w = 512, h = 64, c = cv(w, h), g = c.getContext('2d'), r = U.rng(29);
    const img = g.createImageData(w, h), d = img.data;
    const n1 = new Float32Array(w * h);
    // value noise wrapped in u, a few octaves
    const grid = (gx, gy) => { const a = new Float32Array(gx * gy); for (let k = 0; k < a.length; k++) a[k] = r(); return (x, y) => {
      const fx = x * gx, fy = y * (gy - 1), i0 = Math.floor(fx), j0 = Math.min(gy - 2, Math.floor(fy)), tx = fx - i0, ty = fy - j0, i1 = (i0 + 1) % gx;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty), A = a[j0 * gx + i0 % gx], B = a[j0 * gx + i1], C = a[(j0 + 1) * gx + i0 % gx], D = a[(j0 + 1) * gx + i1];
      return (A * (1 - sx) + B * sx) * (1 - sy) + (C * (1 - sx) + D * sx) * sy; }; };
    const o = [grid(16, 4), grid(48, 6), grid(160, 14)];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const u = x / w, v = y / (h - 1);
      const n = o[0](u, v) * 0.5 + o[1](u, v) * 0.3 + o[2](u, v) * 0.2;
      const a = Math.max(0, Math.min(1, (n - v * 0.85) * 3.2 + 0.25 - v * 0.4));
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
    // spectators on stepped seating: each row a band of people (shoulders and a head) over
    // the seat backs, in the muted clothing of a real crowd with the odd team colour, and gaps
    // where seats are empty. Shaded under each row so the steps read.
    const c = cv(1024, 512), g = c.getContext('2d'), r = U.rng(17);
    g.fillStyle = '#3c4148'; g.fillRect(0, 0, 1024, 512);
    const cloth = ['#2a2d33', '#3a4250', '#f0f0ee', '#d9d6cf', '#1d2a44', '#5d6670', '#7a1e1e', '#c23a2c', '#e8c547', '#2b5fa8', '#ff7a1a', '#4a6b3a', '#8c8f94', '#151719'];
    const skin = ['#e3bf9e', '#c99a73', '#a5714c', '#7a4f33', '#f0d0b4'];
    for (let y = 0; y < 512; y += 24) {
      g.fillStyle = '#596370'; g.fillRect(0, y + 17, 1024, 4); // seat backs
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, y + 21, 1024, 3); // the step's shadow
      let x = r() * 4;
      while (x < 1024) {
        const w = 8 + r() * 4;
        if (r() > 0.16) {
          const cx = x + w / 2, top = y + 3 + r() * 3;
          g.fillStyle = cloth[Math.floor(r() * cloth.length)];
          g.beginPath(); g.ellipse(cx, top + 11, w * 0.5, 7, 0, Math.PI, 0); g.fill();
          g.fillRect(cx - w * 0.5, top + 11, w, 6);
          g.fillStyle = skin[Math.floor(r() * skin.length)];
          g.beginPath(); g.arc(cx, top + 3, 2.6 + r() * 0.6, 0, 6.283); g.fill();
          if (r() < 0.3) { g.fillStyle = r() < 0.5 ? '#1b1b1d' : cloth[Math.floor(r() * cloth.length)]; g.fillRect(cx - 3, top - 0.5, 6, 2.2); } // caps
        }
        x += w + r() * 2;
      }
    }
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
  // Each call returns its own texture with its own repeat; all share one decoded image.
  const imgs = {}, photoCache = {};
  T.has = key => !!(F1.Assets && F1.Assets[key]);
  T.photo = (key, rep = 1, srgb = true) => {
    const ck = key + '|' + rep + '|' + srgb;
    if (photoCache[ck]) return photoCache[ck];
    const t = new THREE.Texture();
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    if (Array.isArray(rep)) t.repeat.set(rep[0], rep[1]); else t.repeat.set(rep, rep);
    let im = imgs[key];
    if (!im) {
      im = imgs[key] = new Image();
      im.waiting = [];
      im.onload = () => { for (const w of im.waiting) { w.image = im; w.needsUpdate = true; } im.waiting = null; };
      im.src = F1.Assets[key];
    }
    if (im.waiting) im.waiting.push(t); else { t.image = im; t.needsUpdate = true; }
    return (photoCache[ck] = t);
  };
  T.image = key => { if (!imgs[key]) T.photo(key); return imgs[key]; };

  F1.R3T = T;
})(typeof window !== 'undefined' ? window : globalThis);
