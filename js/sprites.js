// Procedural art: ground textures and car sprites. Everything is flat top-down,
// realistic proportions, no fake-3D tricks. Cars are drawn once per livery into
// offscreen canvases and reused.
(function (G) {
  'use strict';
  const F1 = G.F1;
  const U = F1.U;

  const PX = 24; // sprite resolution, pixels per metre

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.ceil(w); c.height = Math.ceil(h);
    return c;
  }

  function noise(ctx, w, h, n, colors, size, rnd) {
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = colors[Math.floor(rnd() * colors.length)];
      const s = size * (0.5 + rnd());
      ctx.fillRect(rnd() * w, rnd() * h, s, s);
    }
  }

  // Ground patterns. Each returns {pat, metres} where the pattern canvas covers
  // `metres` world metres; the renderer scales it into world space.
  function makePatterns(ctx, theme) {
    const rnd = U.rng(99);
    const P = {};
    // grass with mowing stripes
    {
      const c = canvas(512, 512), g = c.getContext('2d');
      const a = theme.grassA, b = theme.grassB;
      for (let i = 0; i < 4; i++) { g.fillStyle = i % 2 ? a : b; g.fillRect(0, i * 128, 512, 128); }
      noise(g, 512, 512, 9000, theme.grassN, 2, rnd);
      P.grass = { pat: ctx.createPattern(c, 'repeat'), m: 48 };
    }
    {
      const c = canvas(256, 256), g = c.getContext('2d');
      g.fillStyle = theme.gravel; g.fillRect(0, 0, 256, 256);
      noise(g, 256, 256, 7000, theme.gravelN, 2, rnd);
      P.gravel = { pat: ctx.createPattern(c, 'repeat'), m: 10 };
    }
    {
      const c = canvas(256, 256), g = c.getContext('2d');
      g.fillStyle = theme.asphalt; g.fillRect(0, 0, 256, 256);
      noise(g, 256, 256, 6000, theme.asphaltN, 1.6, rnd);
      P.asphalt = { pat: ctx.createPattern(c, 'repeat'), m: 8 };
    }
    {
      const c = canvas(256, 256), g = c.getContext('2d');
      g.fillStyle = theme.runoff; g.fillRect(0, 0, 256, 256);
      noise(g, 256, 256, 4000, theme.runoffN, 1.6, rnd);
      P.runoff = { pat: ctx.createPattern(c, 'repeat'), m: 8 };
    }
    {
      const c = canvas(256, 256), g = c.getContext('2d');
      g.fillStyle = theme.ground; g.fillRect(0, 0, 256, 256);
      noise(g, 256, 256, 5000, theme.groundN, 2.4, rnd);
      P.ground = { pat: ctx.createPattern(c, 'repeat'), m: 24 };
    }
    {
      const c = canvas(256, 256), g = c.getContext('2d');
      g.fillStyle = theme.water || '#1d4e6b'; g.fillRect(0, 0, 256, 256);
      g.strokeStyle = 'rgba(255,255,255,0.06)'; g.lineWidth = 2;
      for (let i = 0; i < 40; i++) { const x = rnd() * 256, y = rnd() * 256; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 18 + rnd() * 20, y); g.stroke(); }
      P.water = { pat: ctx.createPattern(c, 'repeat'), m: 40 };
    }
    return P;
  }

  function hex(c) {
    const n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function shade(c, k) {
    const [r, g, b] = hex(c);
    const f = v => Math.round(U.clamp(k < 0 ? v * (1 + k) : v + (255 - v) * k, 0, 255));
    return `rgb(${f(r)},${f(g)},${f(b)})`;
  }

  // Car body in metres, nose toward +x, origin at the CoG.
  // Layout follows a modern F1 car: 5.6 m long, 2.0 m wide, 3.6 m wheelbase.
  function drawCarBody(g, team, opts) {
    const base = team.base, acc = team.accent, third = team.third;
    const carbon = '#16181c', carbon2 = '#22252b';
    const sideGrad = (x0, c1, c2) => {
      const gr = g.createLinearGradient(0, -1, 0, 1);
      gr.addColorStop(0, c2); gr.addColorStop(0.5, c1); gr.addColorStop(1, c2);
      return gr;
    };
    // floor
    g.fillStyle = carbon;
    g.beginPath();
    g.moveTo(1.15, -0.55); g.lineTo(0.75, -0.95); g.lineTo(-1.15, -0.95); g.lineTo(-1.55, -0.6);
    g.lineTo(-1.55, 0.6); g.lineTo(-1.15, 0.95); g.lineTo(0.75, 0.95); g.lineTo(1.15, 0.55); g.closePath(); g.fill();
    // rear wing endplates + main plane
    g.fillStyle = carbon2; g.fillRect(-2.62, -0.53, 0.42, 1.06);
    g.fillStyle = base; g.fillRect(-2.55, -0.5, 0.26, 1.0);
    g.fillStyle = acc; g.fillRect(-2.32, -0.5, 0.08, 1.0);
    g.fillStyle = carbon; g.fillRect(-2.64, -0.55, 0.46, 0.06); g.fillRect(-2.64, 0.49, 0.46, 0.06);
    // beam wing / pillar
    g.fillStyle = carbon2; g.fillRect(-2.2, -0.08, 0.5, 0.16);
    // sidepods (coke-bottle taper)
    g.fillStyle = sideGrad(0, base, shade(base, -0.28));
    g.beginPath();
    g.moveTo(0.95, -0.42); g.lineTo(0.72, -0.8); g.lineTo(0.15, -0.82); g.bezierCurveTo(-0.6, -0.8, -1.15, -0.5, -1.75, -0.32);
    g.lineTo(-1.75, 0.32); g.bezierCurveTo(-1.15, 0.5, -0.6, 0.8, 0.15, 0.82); g.lineTo(0.72, 0.8); g.lineTo(0.95, 0.42); g.closePath(); g.fill();
    // sidepod inlets
    g.fillStyle = '#0b0c0e';
    g.fillRect(0.66, -0.8, 0.1, 0.32); g.fillRect(0.66, 0.48, 0.1, 0.32);
    // accent sweep along the sidepods
    g.fillStyle = acc;
    g.beginPath();
    g.moveTo(0.6, -0.78); g.bezierCurveTo(-0.3, -0.72, -0.9, -0.5, -1.6, -0.3); g.lineTo(-1.6, -0.22); g.bezierCurveTo(-0.9, -0.4, -0.3, -0.6, 0.6, -0.64); g.closePath(); g.fill();
    g.beginPath();
    g.moveTo(0.6, 0.78); g.bezierCurveTo(-0.3, 0.72, -0.9, 0.5, -1.6, 0.3); g.lineTo(-1.6, 0.22); g.bezierCurveTo(-0.9, 0.4, -0.3, 0.6, 0.6, 0.64); g.closePath(); g.fill();
    // engine cover / spine
    g.fillStyle = sideGrad(0, shade(base, 0.08), shade(base, -0.2));
    g.beginPath();
    g.moveTo(0.35, -0.36); g.lineTo(-0.45, -0.34); g.bezierCurveTo(-1.2, -0.28, -1.8, -0.14, -2.15, -0.1);
    g.lineTo(-2.15, 0.1); g.bezierCurveTo(-1.8, 0.14, -1.2, 0.28, -0.45, 0.34); g.lineTo(0.35, 0.36); g.closePath(); g.fill();
    g.fillStyle = third; g.fillRect(-1.6, -0.035, 1.2, 0.07);
    // nose + chassis
    g.fillStyle = sideGrad(0, base, shade(base, -0.25));
    g.beginPath();
    g.moveTo(2.78, -0.09); g.bezierCurveTo(2.3, -0.13, 1.6, -0.22, 0.95, -0.38); g.lineTo(0.95, 0.38); g.bezierCurveTo(1.6, 0.22, 2.3, 0.13, 2.78, 0.09); g.closePath(); g.fill();
    g.fillStyle = acc; g.fillRect(1.25, -0.04, 1.4, 0.08);
    // front wing
    g.fillStyle = carbon2;
    g.beginPath(); g.moveTo(2.62, -0.98); g.lineTo(2.96, -0.98); g.lineTo(2.96, 0.98); g.lineTo(2.62, 0.98); g.closePath(); g.fill();
    g.fillStyle = base;
    g.beginPath(); g.moveTo(2.66, -0.95); g.quadraticCurveTo(2.95, -0.5, 2.93, 0); g.quadraticCurveTo(2.95, 0.5, 2.66, 0.95); g.lineTo(2.84, 0.95); g.lineTo(2.84, -0.95); g.closePath(); g.fill();
    g.fillStyle = acc; g.fillRect(2.62, -0.98, 0.34, 0.12); g.fillRect(2.62, 0.86, 0.34, 0.12);
    // cockpit
    g.fillStyle = '#08090b';
    g.beginPath(); g.moveTo(0.85, -0.24); g.lineTo(0.85, 0.24); g.lineTo(-0.05, 0.27); g.lineTo(-0.05, -0.27); g.closePath(); g.fill();
    // helmet
    g.fillStyle = opts.helmet || third;
    g.beginPath(); g.arc(0.25, 0, 0.15, 0, Math.PI * 2); g.fill();
    g.fillStyle = acc; g.fillRect(0.22, -0.15, 0.06, 0.3);
    // halo
    g.strokeStyle = '#2b2e34'; g.lineWidth = 0.07;
    g.beginPath(); g.moveTo(0.95, 0); g.lineTo(0.62, 0); g.moveTo(0.62, 0); g.quadraticCurveTo(0.6, -0.27, 0.0, -0.27); g.moveTo(0.62, 0); g.quadraticCurveTo(0.6, 0.27, 0.0, 0.27); g.stroke();
    // mirrors
    g.fillStyle = carbon2; g.fillRect(0.75, -0.62, 0.12, 0.16); g.fillRect(0.75, 0.46, 0.12, 0.16);
  }

  function wheelPath(g, x, y, l, w) {
    g.fillStyle = '#121214';
    g.fillRect(x - l / 2, y - w / 2, l, w);
    g.fillStyle = '#1f2024';
    g.fillRect(x - l / 2 + 0.05, y - w / 2, l - 0.1, w);
    g.fillStyle = 'rgba(255,255,255,0.06)';
    for (let k = -2; k <= 2; k++) g.fillRect(x + k * l / 6 - 0.012, y - w / 2, 0.024, w);
  }

  const cache = new Map();
  function carSprite(team, opts = {}) {
    const key = team.id + (opts.helmet || '');
    if (cache.has(key)) return cache.get(key);
    const Lm = 6.2, Wm = 2.4;
    const c = canvas(Lm * PX, Wm * PX), g = c.getContext('2d');
    g.setTransform(PX, 0, 0, PX, 3.0 * PX, Wm / 2 * PX);
    // rear wheels are part of the body sprite; fronts are drawn live so they steer
    wheelPath(g, -1.65, -0.78, 0.72, 0.42);
    wheelPath(g, -1.65, 0.78, 0.72, 0.42);
    drawCarBody(g, team, opts);
    // shadow silhouette (blurred) for the sun shadow pass
    const s = canvas(Lm * PX, Wm * PX), sg = s.getContext('2d');
    sg.filter = 'blur(5px)';
    sg.drawImage(c, 0, 0);
    sg.filter = 'none';
    sg.globalCompositeOperation = 'source-in';
    sg.fillStyle = 'rgba(0,0,0,1)'; sg.fillRect(0, 0, s.width, s.height);
    const spr = { img: c, shadow: s, ox: 3.0, oy: Wm / 2, px: PX };
    cache.set(key, spr);
    return spr;
  }

  // Small flat car icon for menus and the team cards.
  function carIcon(team, w) {
    const spr = carSprite(team);
    const h = w * spr.img.height / spr.img.width;
    const c = canvas(w, h), g = c.getContext('2d');
    g.drawImage(spr.img, 0, 0, w, h);
    g.save();
    const k = w / (6.2);
    g.setTransform(k, 0, 0, k, 3.0 * k, h / 2);
    wheelPath(g, 1.95, -0.8, 0.66, 0.34);
    wheelPath(g, 1.95, 0.8, 0.66, 0.34);
    g.restore();
    return c;
  }

  F1.Sprites = { makePatterns, carSprite, carIcon, wheelPath, shade, PX };
})(typeof window !== 'undefined' ? window : globalThis);
