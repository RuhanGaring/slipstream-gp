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
    const c = cv(512, 256), g = c.getContext('2d'), r = U.rng(17);
    g.fillStyle = '#5c6169'; g.fillRect(0, 0, 512, 256);
    const cols = ['#e64545', '#2f6fd6', '#f2c230', '#f4f4f4', '#222', '#2c9c62', '#e07a1f', '#b84ad6', '#f0d6b8', '#8a5a3c'];
    for (let y = 4; y < 256; y += 16) {
      g.fillStyle = '#4a4f57'; g.fillRect(0, y + 10, 512, 6);
      for (let x = 2; x < 512; x += 7) {
        if (r() < 0.12) continue;
        g.fillStyle = cols[Math.floor(r() * cols.length)];
        g.fillRect(x, y + 2 + r() * 2, 5, 7);
        g.fillStyle = r() < 0.5 ? '#f0d6b8' : '#8a5a3c';
        g.fillRect(x + 1, y, 3, 3);
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
  T.ridge = (cols, seed, jag) => get('ridge' + seed, () => {
    const c = cv(2048, 256), g = c.getContext('2d'), r = U.rng(seed);
    g.clearRect(0, 0, 2048, 256);
    // layered silhouettes from summed sine octaves (seamless around the ring),
    // each layer nearer, darker and lower than the one behind it
    cols.forEach((col, layer) => {
      const oct = [];
      for (let k = 0; k < 5; k++) oct.push([2 + Math.floor(r() * (3 << k)), r() * 6.283, 1 / (1 + k * k * 1.6)]);
      const top = 40 + layer * 34, amp = Math.min(1, jag / 14) * (70 - layer * 12);
      const gr = g.createLinearGradient(0, top, 0, 256);
      gr.addColorStop(0, col); gr.addColorStop(1, cols[0]);
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(0, 256);
      for (let x = 0; x <= 2048; x += 4) {
        let v = 0;
        for (const [f, ph, a] of oct) v += Math.sin(x / 2048 * 6.283 * f + ph) * a;
        g.lineTo(x, U.clamp(top + 40 - v * amp * 0.45, 8, 250));
      }
      g.lineTo(2048, 256); g.closePath(); g.fill();
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
