// Track Lab: a viewer for the elevation-aware circuit generator (js/trackgen2.js), to judge the
// algorithm before it goes into the game. It runs the same track modules the game does, draws the
// circuit in 3D over its cut-and-filled ground (with the town, the harbour and the tunnel for city
// circuits), plots the elevation profile and the plan view, lists every check, drives a lap at
// the speed profile's pace, and batch-tests many seeds.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  // anything that goes wrong is shown in the status line, never a page stuck on 'Loading'
  const fatal = msg => { const st = $('status'); st.className = 'status bad'; st.textContent = msg; $('busy').classList.remove('on'); };
  addEventListener('error', e => fatal('Error: ' + (e.message || e.error) + (e.filename ? ' (' + e.filename.split('/').slice(-2).join('/') + ':' + e.lineno + ')' : '')));
  addEventListener('unhandledrejection', e => fatal('Error: ' + (e.reason && e.reason.message || e.reason)));
  const F1 = window.F1;
  // the lab needs the current game modules; an old copy (from a browser or offline cache) lacks
  // what the new generator uses
  const missing = !F1 ? 'the game modules' : !window.THREE ? 'three.js' : !F1.TrackGen || !F1.TrackGen._layout ? 'js/trackgen.js (an old copy)' : !F1.TrackGen2 ? 'js/trackgen2.js' : !F1.Gen2Pool ? 'js/gen2pool.js' : '';
  if (missing) { fatal('Could not load ' + missing + '. Reload with Ctrl+Shift+R to fetch the current files.'); return; }
  const U = F1.U, TG2 = F1.TrackGen2, THREE = window.THREE;
  const state = { style: 'city', seed: 1, res: null, ex: 1, roadc: 'asphalt', bld: true, drive: null, hoverI: -1 };

  // ---------- three.js scene ----------
  const cv = $('gl');
  const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#9fb7cf');
  scene.fog = new THREE.Fog('#9fb7cf', 2500, 7000);
  const camera = new THREE.PerspectiveCamera(50, 1, 1, 20000);
  scene.add(new THREE.HemisphereLight('#dfeaff', '#4a4a3a', 1.1));
  const sun = new THREE.DirectionalLight('#fff4e0', 1.9);
  sun.position.set(-0.75, 0.42, 0.3).multiplyScalar(1000); // low, so the relief shows
  scene.add(sun);
  let world = new THREE.Group();
  scene.add(world);
  const marker = new THREE.Mesh(new THREE.SphereGeometry(6, 16, 12), new THREE.MeshBasicMaterial({ color: '#e10600' }));
  marker.visible = false;
  scene.add(marker);

  function resize() {
    const r = cv.parentElement.getBoundingClientRect();
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / Math.max(1, r.height);
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);

  // orbit: drag to turn, right drag to pan, wheel to zoom
  const orbit = { yaw: 0.6, pitch: 0.75, dist: 2600, tx: 0, ty: 0, tz: 0 };
  function placeCamera() {
    const cp = Math.cos(orbit.pitch);
    camera.position.set(orbit.tx + Math.sin(orbit.yaw) * cp * orbit.dist, orbit.ty + Math.sin(orbit.pitch) * orbit.dist, orbit.tz + Math.cos(orbit.yaw) * cp * orbit.dist);
    camera.lookAt(orbit.tx, orbit.ty, orbit.tz);
  }
  let drag = null;
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, b: e.button }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointerup', () => { drag = null; });
  cv.addEventListener('pointermove', e => {
    if (!drag || state.drive) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.b === 2 || e.shiftKey) {
      const k = orbit.dist / 900, s = Math.sin(orbit.yaw), c = Math.cos(orbit.yaw);
      orbit.tx += (-dx * c - dy * s) * k; orbit.tz += (dx * s - dy * c) * k;
    } else {
      orbit.yaw -= dx * 0.005;
      orbit.pitch = U.clamp(orbit.pitch + dy * 0.004, 0.05, 1.5);
    }
  });
  cv.addEventListener('wheel', e => { e.preventDefault(); orbit.dist = U.clamp(orbit.dist * Math.exp(e.deltaY * 0.001), 60, 9000); }, { passive: false });

  // ---------- colours ----------
  const GRADE = [[0, '#3fbf6a'], [0.04, '#d8d13c'], [0.08, '#f08a2c'], [0.12, '#e5332a']];
  const gradeCol = g => {
    g = Math.abs(g);
    for (let k = 1; k < GRADE.length; k++) if (g <= GRADE[k][0]) return new THREE.Color(GRADE[k - 1][1]).lerp(new THREE.Color(GRADE[k][1]), (g - GRADE[k - 1][0]) / (GRADE[k][0] - GRADE[k - 1][0]));
    return new THREE.Color(GRADE[GRADE.length - 1][1]);
  };
  const FACADE = ['#efe3c8', '#e8cfa3', '#d9a77a', '#f3efe6', '#e7c9b4', '#f0d9a8', '#d8b9a0', '#e9d8c4', '#f2e6d0', '#d6a98a'];
  const TOWER = ['#9fb3c2', '#b8c4cc', '#8ea2b0'];

  // ---------- building the scene for a circuit ----------
  function disposeWorld() {
    world.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    scene.remove(world);
    world = new THREE.Group();
    scene.add(world);
  }
  const Y = h => h * state.ex;

  function terrainMesh(res) {
    const tr = res.tr, city = res.style === 'city';
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < tr.N; i++) { x0 = Math.min(x0, tr.x[i]); y0 = Math.min(y0, tr.y[i]); x1 = Math.max(x1, tr.x[i]); y1 = Math.max(y1, tr.y[i]); }
    const M = city ? 900 : 420;
    x0 -= M; y0 -= M; x1 += M; y1 += M;
    const cell = Math.max(5, Math.max(x1 - x0, y1 - y0) / (city ? 360 : 300));
    const nx = Math.ceil((x1 - x0) / cell) + 1, ny = Math.ceil((y1 - y0) / cell) + 1;
    const pos = new Float32Array(nx * ny * 3), col = new Float32Array(nx * ny * 3), H = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) H[j * nx + i] = tr.H2(x0 + i * cell, y0 + j * cell);
    const grass = new THREE.Color(res.style === 'modern' ? '#c9b48a' : '#6d8f4a'), rock = new THREE.Color('#8a8378'), pave = new THREE.Color('#c9c1b2'), quay = new THREE.Color('#d9d4c8'), dark = new THREE.Color('#4f6b38');
    const scrub = new THREE.Color('#6f7a4a'), cliff = new THREE.Color('#a39581'), bed = new THREE.Color('#2a5566');
    const c = new THREE.Color(), site = city ? res.site : null;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, x = x0 + i * cell, y = y0 + j * cell, h = H[k];
      const hx = H[j * nx + Math.min(nx - 1, i + 1)] - H[j * nx + Math.max(0, i - 1)], hy = H[Math.min(ny - 1, j + 1) * nx + i] - H[Math.max(0, j - 1) * nx + i];
      const slope = Math.hypot(hx, hy) / (2 * cell);
      c.copy(grass).lerp(dark, U.clamp(0.5 + Math.sin(x * 0.013) * Math.cos(y * 0.011) * 0.5, 0, 1) * 0.35);
      if (city) {
        // the sea bed, the quays and promenade, the town's paving, then scrub and rock on the
        // mountainside; cliffs where it is steep
        const u = site.inland(x, y);
        if (h < 0.3) c.copy(bed);
        else if (u < 16 || h < 3.2) c.copy(quay);
        else if (u < 1000) c.copy(pave).lerp(scrub, U.smooth((u - 700) / 300));
        else c.copy(scrub).lerp(dark, 0.3);
        c.lerp(cliff, U.clamp((slope - 0.55) / 0.45, 0, 1));
      } else c.lerp(rock, U.clamp((slope - 0.45) / 0.5, 0, 1));
      pos[k * 3] = x; pos[k * 3 + 1] = Y(h); pos[k * 3 + 2] = y;
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
    }
    const idx = [];
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = j * nx + i, b = a + 1, d = a + nx, e = d + 1; idx.push(a, d, b, b, d, e); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.name = 'terrain';
    world.add(mesh);
    return { x0, y0, x1, y1 };
  }

  // a strip along the lap between lateral offsets a(i) and b(i), lifted by `lift`
  function strip(tr, a, b, colour, lift, onlyIf) {
    const pos = [], col = [], idx = [];
    const N = tr.N, c = new THREE.Color();
    let open = false;
    for (let k = 0; k <= N; k++) {
      const i = k % N;
      if (onlyIf && !onlyIf(i)) { open = false; continue; }
      const da = a(i), db = b(i);
      for (const d of [da, db]) {
        pos.push(tr.x[i] + tr.nx[i] * d, Y(tr.z[i] + tr.bank[i] * d) + lift, tr.y[i] + tr.ny[i] * d);
        c.set(typeof colour === 'function' ? colour(i, d) : colour);
        col.push(c.r, c.g, c.b);
      }
      const v = pos.length / 3;
      if (open) idx.push(v - 4, v - 2, v - 3, v - 3, v - 2, v - 1);
      open = true;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    world.add(m);
    return m;
  }
  // a vertical wall along the lap at lateral offset d(i)
  function wall(tr, d, h, colour, onlyIf) {
    const pos = [], idx = [];
    const N = tr.N;
    let open = false;
    for (let k = 0; k <= N; k++) {
      const i = k % N;
      if (onlyIf && !onlyIf(i)) { open = false; continue; }
      const o = d(i), x = tr.x[i] + tr.nx[i] * o, z = tr.y[i] + tr.ny[i] * o, base = Y(tr.z[i] + tr.bank[i] * o);
      pos.push(x, base - 0.3, z, x, base + h, z);
      const v = pos.length / 3;
      if (open) idx.push(v - 4, v - 2, v - 3, v - 3, v - 2, v - 1);
      open = true;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    world.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: colour, side: THREE.DoubleSide })));
  }

  function roadMeshes(res) {
    const tr = res.tr, hw = tr.hw, city = res.style === 'city';
    const roadCol = state.roadc === 'grade' ? (i => gradeCol(tr.dz[i])) : (i => (i % 400 < 3 ? '#e8e8e8' : '#3a3c40'));
    strip(tr, () => -hw, () => hw, roadCol, 0.12);
    // kerbs
    const kerb = (side, i) => (side ? tr.kerbR[i] : tr.kerbL[i]);
    const kc = i => ((i >> 1) % 2 ? '#d6261f' : '#f2f2f2');
    strip(tr, () => hw, () => hw + tr.kerbW, kc, 0.14, i => kerb(1, i));
    strip(tr, () => -hw - tr.kerbW, () => -hw, kc, 0.14, i => kerb(0, i));
    // run-off ribbon (tarmac or gravel) and the barriers
    strip(tr, () => hw, i => tr.barr[1][i], city ? '#8d8a85' : (i => (tr.runT[1][i] === F1.SURF.GRAVEL ? '#cbb58b' : '#7d9a58')), 0.06);
    strip(tr, i => -tr.barr[0][i], () => -hw, city ? '#8d8a85' : (i => (tr.runT[0][i] === F1.SURF.GRAVEL ? '#cbb58b' : '#7d9a58')), 0.06);
    wall(tr, i => tr.barr[1][i], city ? 1.3 * state.ex : 1.0 * state.ex, city ? '#e6e3dc' : '#9aa0a6');
    wall(tr, i => -tr.barr[0][i], city ? 1.3 * state.ex : 1.0 * state.ex, city ? '#e6e3dc' : '#9aa0a6');
    // pit lane
    const p = tr.pit;
    strip(tr, i => p.off[i] - p.lane / 2, i => p.off[i] + p.lane / 2, '#55585e', 0.1, i => !isNaN(p.off[i]));
    // start line
    strip(tr, () => -hw, () => hw, '#ffffff', 0.18, i => i < 2 || i > tr.N - 2);
    // tunnel: walls and a roof, with a building over it
    if (res.tunnel) {
      const { i0, i1 } = res.tunnel, inT = i => { const k = i < i0 ? i + tr.N : i; return k >= i0 && k <= i1; };
      const roof = 7.5 * state.ex, w = hw + 2.2;
      wall(tr, () => w, roof, '#9b958c', inT);
      wall(tr, () => -w, roof, '#9b958c', inT);
      const pos = [], idx = [];
      for (let i = i0; i <= i1; i++) {
        const j = i % tr.N;
        for (const d of [-w - 1, w + 1]) pos.push(tr.x[j] + tr.nx[j] * d, Y(tr.z[j]) + roof, tr.y[j] + tr.ny[j] * d);
        const v = pos.length / 3;
        if (i > i0) idx.push(v - 4, v - 2, v - 3, v - 3, v - 2, v - 1);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      world.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: '#cfc6b6', side: THREE.DoubleSide })));
    }
  }

  function buildingMeshes(res) {
    if (!res.city || !state.bld) return;
    const tr = res.tr, B = res.city.buildings, grp = new THREE.Group();
    const byCol = new Map();
    for (const b of B) {
      // footed on the lowest ground under the footprint, so none floats over a slope
      let base = Infinity;
      for (const p of b.poly) base = Math.min(base, tr.H2(p[0], p[1]));
      const cx = b.poly.reduce((s, p) => s + p[0], 0) / b.poly.length, cy = b.poly.reduce((s, p) => s + p[1], 0) / b.poly.length;
      base = Math.min(base, tr.H2(cx, cy));
      const shape = new THREE.Shape(b.poly.map(p => new THREE.Vector2(p[0], -p[1])));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: Y(b.h + 3), bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, Y(base) - 3 * state.ex, 0);
      const col = b.tower ? TOWER[Math.floor(b.tone * TOWER.length) % TOWER.length] : FACADE[Math.floor(b.tone * FACADE.length) % FACADE.length];
      if (!byCol.has(col)) byCol.set(col, new THREE.MeshLambertMaterial({ color: col }));
      grp.add(new THREE.Mesh(geo, byCol.get(col)));
    }
    world.add(grp);
  }

  // land beyond the modelled ground: a plain at the height of its edge (open circuits), so the
  // view never ends in empty sky. The town's sea is a plane at sea level under everything: the
  // ground stands above it on land
  function waterMesh(res, box) {
    const tr = res.tr, F = 12000;
    if (res.style === 'city' && !res.site.coastLine) {
      // a generated town (its ground runs down under the sea): one sheet at sea level
      const g = new THREE.PlaneGeometry(F, F); g.rotateX(-Math.PI / 2); g.translate((box.x0 + box.x1) / 2, 0.15, (box.y0 + box.y1) / 2);
      scene.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: '#1f5873', roughness: 0.15 })));
      return;
    }
    if (res.style === 'city') {
      // the sea: from the coastline (carried on past its ends) out to the horizon, so none shows
      // inland behind the mountains
      const site = res.site, pts = site.coastLine, n = pts.length;
      const seaward = (p, q) => { const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l; return site.inland(p[0] + nx * 60, p[1] + ny * 60) < site.inland(p[0] - nx * 60, p[1] - ny * 60) ? [nx, ny] : [-nx, -ny]; };
      const d0 = [pts[0][0] - pts[2][0], pts[0][1] - pts[2][1]], l0 = Math.hypot(d0[0], d0[1]) || 1, d1 = [pts[n - 1][0] - pts[n - 3][0], pts[n - 1][1] - pts[n - 3][1]], l1 = Math.hypot(d1[0], d1[1]) || 1;
      const E0 = [pts[0][0] + d0[0] / l0 * F, pts[0][1] + d0[1] / l0 * F], E1 = [pts[n - 1][0] + d1[0] / l1 * F, pts[n - 1][1] + d1[1] / l1 * F];
      const s0 = seaward(pts[0], pts[1]), s1 = seaward(pts[n - 2], pts[n - 1]);
      const ring = [E0].concat(pts, [E1, [E1[0] + s1[0] * F, E1[1] + s1[1] * F], [E0[0] + s0[0] * F, E0[1] + s0[1] * F]]);
      // inland of the coastline (the quays) the ground covers it anyway: the ring is drawn a
      // little inland so no gap shows along the shore
      const shape = new THREE.Shape(ring.map(p => new THREE.Vector2(p[0], -p[1])));
      const g = new THREE.ShapeGeometry(shape);
      g.rotateX(-Math.PI / 2);
      const w = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: '#2b6c8f', transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
      w.position.y = 0.05;
      world.add(w);
      return;
    }
    let edge = Infinity;
    for (let x = box.x0; x <= box.x1; x += 40) edge = Math.min(edge, tr.H2(x, box.y1), tr.H2(x, box.y0));
    for (let y = box.y0; y <= box.y1; y += 40) edge = Math.min(edge, tr.H2(box.x0, y), tr.H2(box.x1, y));
    const land = new THREE.Mesh(new THREE.PlaneGeometry(box.x1 - box.x0 + 2 * F, box.y1 - box.y0 + 2 * F), new THREE.MeshLambertMaterial({ color: res.style === 'modern' ? '#bca77f' : '#5f7f42' }));
    land.rotation.x = -Math.PI / 2;
    land.position.set((box.x0 + box.x1) / 2, Y(edge) - 1.5, (box.y0 + box.y1) / 2);
    world.add(land);
  }

  // the harbour's yachts: moored stern-on along the quays and the breakwaters, and palms along
  // the promenade (instanced, one draw each)
  function harbourLife(res) {
    if (res.style !== 'city' || !res.site.harbour) return;   // (a generated town's harbour is the game's to draw)
    const tr = res.tr, site = res.site, rnd = U.rng(res.seed * 31 + 7);
    const boats = [];
    const moor = (x, y, dx, dy) => { // (dx, dy): pointing out from the quay
      for (let k = 0; k < 3; k++) {
        const len = 12 + rnd() * 30, gx = x + dx * (6 + len / 2), gy = y + dy * (6 + len / 2);
        if (tr.H2(gx, gy) > -0.2 || tr.H2(x + dx * (8 + len), y + dy * (8 + len)) > -0.2) return;
        boats.push([gx, gy, Math.atan2(dy, dx), len]);
        return;
      }
    };
    const out = site.out;
    for (const i of site.harbour) if (i % 9 === 0) {
      const d = tr.hw + 16, x = tr.x[i] + tr.nx[i] * out * d, y = tr.y[i] + tr.ny[i] * out * d;
      moor(x, y, tr.nx[i] * out, tr.ny[i] * out);
    }
    for (const pl of site.piers) for (let k = 0; k < pl.length - 1; k++) {
      const a = pl[k], b = pl[k + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
      for (let t = 20; t < L - 10; t += 16) for (const sgn of [-1, 1]) moor(a[0] + ux * t - uy * sgn * site.pierW / 2, a[1] + uy * t + ux * sgn * site.pierW / 2, -uy * sgn, ux * sgn);
    }
    if (boats.length) {
      const hull = new THREE.BoxGeometry(1, 1, 1), m = new THREE.InstancedMesh(hull, new THREE.MeshLambertMaterial({ color: '#f4f4f2' }), boats.length);
      const deck = new THREE.InstancedMesh(hull, new THREE.MeshLambertMaterial({ color: '#2f3a44' }), boats.length);
      const o = new THREE.Object3D();
      boats.forEach(([x, y, a, len], k) => {
        o.position.set(x, Y(0.9), y); o.rotation.set(0, -a, 0); o.scale.set(len, 2.2 * state.ex, len * 0.24); o.updateMatrix(); m.setMatrixAt(k, o.matrix);
        o.position.set(x, Y(2.4), y); o.scale.set(len * 0.45, 1.6 * state.ex, len * 0.16); o.updateMatrix(); deck.setMatrixAt(k, o.matrix);
      });
      world.add(m, deck);
    }
    // palms along the promenade and the quays, clear of the tunnel
    const palms = [];
    const inT = i => res.tunnel && ((i >= res.tunnel.i0 && i <= res.tunnel.i1) || (i + tr.N >= res.tunnel.i0 && i + tr.N <= res.tunnel.i1));
    for (const i of site.run) if (i % 11 === 0 && !inT(i)) {
      const d = tr.hw + 5, x = tr.x[i] + tr.nx[i] * out * d, y = tr.y[i] + tr.ny[i] * out * d;
      if (tr.H2(x, y) > 1) palms.push([x, y, tr.H2(x, y)]);
    }
    if (palms.length) {
      const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.35, 1, 6), new THREE.MeshLambertMaterial({ color: '#8a7358' }), palms.length);
      const crown = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshLambertMaterial({ color: '#4f7a3a' }), palms.length);
      const o = new THREE.Object3D();
      palms.forEach(([x, y, h], k) => {
        const ht = 8 + rnd() * 4;
        o.position.set(x, Y(h) + ht * state.ex / 2, y); o.rotation.set(0, 0, 0); o.scale.set(1, ht * state.ex, 1); o.updateMatrix(); trunk.setMatrixAt(k, o.matrix);
        o.position.set(x, Y(h) + ht * state.ex, y); o.scale.set(3.2, 1.4 * state.ex, 3.2); o.updateMatrix(); crown.setMatrixAt(k, o.matrix);
      });
      world.add(trunk, crown);
    }
    // the hotel over the tunnel
    if (res.tunnel) {
      const { i0, i1 } = res.tunnel, mid = Math.floor((i0 + i1) / 2) % tr.N, len = (i1 - i0) * tr.ds;
      const g = new THREE.BoxGeometry(len * 0.8, 1, tr.hw * 2 + 40);
      const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: '#efe7da' }));
      const ht = 28 + rnd() * 14;
      mesh.scale.set(1, ht * state.ex, 1);
      mesh.position.set(tr.x[mid] - tr.nx[mid] * out * 6, Y(tr.z[mid]) + (7.5 + ht / 2) * state.ex, tr.y[mid] - tr.ny[mid] * out * 6);
      mesh.rotation.y = -Math.atan2(tr.ty[mid], tr.tx[mid]);
      world.add(mesh);
    }
  }

  function buildScene() {
    const res = state.res;
    disposeWorld();
    if (!res) return;
    const box = terrainMesh(res);
    roadMeshes(res);
    buildingMeshes(res);
    waterMesh(res, box);
    harbourLife(res);
  }

  // ---------- panels ----------
  function stats(res) {
    const rep = res.report.info, tr = res.tr;
    const cells = [
      [(tr.L / 1000).toFixed(2) + ' km', 'LENGTH'], [rep.corners, 'CORNERS'], [Math.round(rep.range) + ' m', 'CLIMB'],
      [(rep.gMax * 100).toFixed(1) + ' %', 'MAX GRADE'], [rep.minR.toFixed(0) + ' m', 'TIGHTEST'], [rep.nMin.toFixed(2) + ' g', 'CREST LOAD'],
      [rep.nMax.toFixed(2) + ' g', 'DIP LOAD'], [isFinite(rep.minSep) ? Math.round(rep.minSep) + ' m' : 'over ' + res.st.sep + ' m', 'CLOSEST PASS'], [res.tries + ' / ' + res.ms + ' ms', 'TRIES / TIME'],
    ];
    if (res.city) cells.push([res.city.buildings.length, 'BUILDINGS'], [rep.hairpins, 'HAIRPINS'], [res.tunnel ? Math.round((res.tunnel.i1 - res.tunnel.i0) * tr.ds) + ' m' : 'none', 'TUNNEL']);
    $('stats').innerHTML = cells.map(([v, k]) => `<div><b>${v}</b><span>${k}</span></div>`).join('');
    $('name').textContent = res.def.name;
    $('sub').textContent = `${res.style.toUpperCase()}  /  seed ${res.seed}  /  ${tr.w} m wide  /  ${res.def.v.length} corner vertices`;
  }
  const CHECKS = [
    ['length', 'Lap length'], ['radius', 'Corner radius'], ['kink', 'No kinks'], ['separation', 'Clearance'], ['grid', 'Start straight'],
    ['pit lane', 'Pit lane clear'], ['no straight', 'Overtaking straight'], ['corners', 'Corner count'], ['variety', 'Corner variety'],
    ['gradient', 'Gradients'], ['closure', 'Lap closes'], ['crest', 'No take-off crests'],
    ['dip', 'No bottoming dips'], ['banking', 'Banking'], ['realism', 'Like real F1 circuits'], ['retaining walls', 'Banks meet the road'], ['bank reach', 'Ground continuous'], ['nan', 'Finite geometry'],
  ];
  const CITY_CHECKS = [['layout', 'Laid out like Monaco'], ['in the sea', 'On land'], ['below sea level', 'Above the sea'], ['building on the road', 'Buildings clear'], ['too few buildings', 'Town built'], ['tunnel', 'Tunnel sound'], ['no hairpin', 'Hairpin']];
  function checks(res) {
    const rep = TG2.verify(res), failed = new Set(rep.fails.map(f => f.split(':')[0]));
    const list = CHECKS.concat(res.style === 'city' ? CITY_CHECKS : []);
    const info = rep.info;
    const val = { gradient: (info.gMax * 100).toFixed(1) + '%', separation: isFinite(info.minSep) ? Math.round(info.minSep) + ' m' : '>' + res.st.sep + ' m', radius: info.minR.toFixed(0) + ' m', crest: info.nMin.toFixed(2) + 'g', dip: info.nMax.toFixed(2) + 'g', 'elevation range': Math.round(info.range) + ' m', corners: info.corners };
    $('checks').innerHTML = list.map(([k, label]) => `<li class="${failed.has(k) ? 'bad' : ''}">${label}<small>${val[k] != null ? val[k] : ''}</small></li>`).join('');
    const st = $('status');
    st.className = 'status ' + (rep.ok ? 'ok' : 'bad');
    st.textContent = rep.ok ? 'All checks passed (re-verified in the page)' : 'FAILED: ' + rep.fails.join(', ');
  }

  function drawProfile(res) {
    const cvs = $('profile'), W = cvs.width = cvs.clientWidth * 2, H = cvs.height = 300, ctx = cvs.getContext('2d');
    const tr = res.tr, N = tr.N;
    let zmin = Infinity, zmax = -Infinity;
    for (let i = 0; i < N; i++) { zmin = Math.min(zmin, tr.z[i]); zmax = Math.max(zmax, tr.z[i]); }
    const pad = Math.max(4, (zmax - zmin) * 0.12);
    zmin -= pad; zmax += pad;
    const X = i => 50 + (W - 64) * i / N, Yp = z => H - 30 - (H - 46) * (z - zmin) / (zmax - zmin);
    ctx.clearRect(0, 0, W, H);
    ctx.font = '20px Titillium Web, sans-serif'; ctx.fillStyle = '#6d7682'; ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1;
    const step = [5, 10, 20, 25, 50][Math.min(4, Math.floor((zmax - zmin) / 40))];
    for (let z = Math.ceil(zmin / step) * step; z <= zmax; z += step) { ctx.beginPath(); ctx.moveTo(50, Yp(z)); ctx.lineTo(W - 14, Yp(z)); ctx.stroke(); ctx.fillText(Math.round(z) + ' m', 0, Yp(z) + 6); }
    for (let km = 0; km * 1000 < tr.L; km++) ctx.fillText(km + ' km', X(km * 1000 / tr.ds) - 10, H - 4);
    // filled body, then the line coloured by gradient
    ctx.beginPath(); ctx.moveTo(X(0), H - 30);
    for (let i = 0; i < N; i += 2) ctx.lineTo(X(i), Yp(tr.z[i]));
    ctx.lineTo(X(N), H - 30); ctx.closePath(); ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.fill();
    ctx.lineWidth = 4;
    for (let i = 0; i < N - 2; i += 2) { ctx.strokeStyle = '#' + gradeCol(tr.dz[i]).getHexString(); ctx.beginPath(); ctx.moveTo(X(i), Yp(tr.z[i])); ctx.lineTo(X(i + 2), Yp(tr.z[i + 2])); ctx.stroke(); }
    // corners as ticks, the tunnel as a band
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    for (const a of tr.apexes) ctx.fillRect(X(a.i) - 1, H - 30, 2, 8);
    if (res.tunnel) { ctx.fillStyle = 'rgba(225,6,0,.25)'; ctx.fillRect(X(res.tunnel.i0), 10, X(res.tunnel.i1) - X(res.tunnel.i0), H - 40); }
    if (state.hoverI >= 0) { ctx.fillStyle = '#e10600'; ctx.fillRect(X(state.hoverI) - 1, 0, 3, H - 30); ctx.fillStyle = '#fff'; const i = state.hoverI; ctx.fillText(`${(i * tr.ds / 1000).toFixed(2)} km   ${tr.z[i].toFixed(1)} m   ${(tr.dz[i] * 100).toFixed(1)} %`, 60, 24); }
    cvs.onmousemove = e => {
      const r = cvs.getBoundingClientRect(), i = Math.round(U.clamp(((e.clientX - r.left) * 2 - 50) / (W - 64), 0, 0.9999) * N);
      state.hoverI = i; drawProfile(res);
      marker.visible = true; marker.position.set(tr.x[i], Y(tr.z[i]) + 8, tr.y[i]);
    };
    cvs.onmouseleave = () => { state.hoverI = -1; marker.visible = false; drawProfile(res); };
  }

  // the lap against the real circuits its style is matched to: each statistic, this lap's value,
  // the real group's spread, and the real circuit whose profile is most alike
  function realPanel(res) {
    const R = TG2.REAL()[res.style], m = res.report.info.real, ref = window.F1REF || {};
    const group = Object.values(ref).filter(c => R.from.includes(c.name));
    const span = f => { const v = group.map(f); return Math.min(...v).toFixed(1).replace(/\.0$/, '') + ' to ' + Math.max(...v).toFixed(1).replace(/\.0$/, ''); };
    const rows = [
      ['Climb', m.range.toFixed(0) + ' m', span(c => c.range) + ' m', m.range >= R.range[0] && m.range <= R.range[1]],
      ['Steepest 100 m', m.g100.toFixed(1) + ' %', span(c => c.g100) + ' %', m.g100 <= R.g100[1] && m.g100 >= R.g100[0]],
      ['Lap steeper than 4 %', m.share4.toFixed(0) + ' %', span(c => c.share['4']) + ' %', m.share4 >= R.share4[0] && m.share4 <= R.share4[1]],
      ['Ascent per m of climb', m.ratio.toFixed(2), span(c => c.ascent / Math.max(1, c.range)), m.ratio >= R.ratio[0] && m.ratio <= R.ratio[1]],
      ['Separate climbs', m.climbs, span(c => c.climbs), m.climbs >= R.climbs[0] && m.climbs <= R.climbs[1]],
      ['Sharpest crest', Math.round(m.crestR) + ' m', span(c => c.crestR) + ' m', m.crestR >= R.crestR],
    ];
    $('real').innerHTML = '<tr><th title="A tick: inside the real spread, with a small margin">STATISTIC</th><th>THIS LAP</th><th>REAL ' + res.style.toUpperCase() + ' (' + group.length + ')</th></tr>' + rows.map(([k, v, r, ok]) => `<tr><td class="${ok ? 'ok' : 'bad'}">${k}</td><td><b>${v}</b></td><td>${r}</td></tr>`).join('');
    // most similar: the nearest in climb, steepness and steep share, each on its own scale
    let best = null, bd = Infinity;
    for (const c of group) {
      const d = ((c.range - m.range) / 25) ** 2 + ((c.g100 - m.g100) / 4) ** 2 + ((c.share['4'] - m.share4) / 15) ** 2 + ((c.climbs - m.climbs) / 3) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    $('simname').textContent = best ? best.name + ' (' + best.range.toFixed(0) + ' m, ' + best.g100.toFixed(1) + ' %)' : '';
    $('simleg').textContent = best ? best.name : 'real';
    const cvs = $('simprof'), W = cvs.width = cvs.clientWidth * 2, H = cvs.height = 220, ctx = cvs.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    if (!best) return;
    // both drawn over the lap as a fraction, on the same height scale
    const tr = res.tr, zs = [];
    for (let i = 0; i < tr.N; i += 3) zs.push(tr.z[i]);
    const z0 = Math.min(...zs), gen = zs.map(z => z - z0), real = best.profile;
    const top = Math.max(...gen, ...real) * 1.1 + 2;
    const line = (arr, col, w) => { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); arr.forEach((z, k) => { const x = 10 + (W - 20) * k / (arr.length - 1), y = H - 14 - (H - 28) * z / top; k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); };
    line(real, '#7d8794', 4); line(gen, '#e10600', 4);
    ctx.fillStyle = '#6d7682'; ctx.font = '20px Titillium Web, sans-serif'; ctx.fillText(Math.round(top) + ' m', 12, 22); ctx.fillText('start', 12, H - 2); ctx.fillText('finish', W - 62, H - 2);
  }

  function drawMap(res) {
    const cvs = $('map'), W = cvs.width = cvs.clientWidth * 2, H = cvs.height = 460, ctx = cvs.getContext('2d');
    const tr = res.tr, N = tr.N;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < N; i++) { x0 = Math.min(x0, tr.x[i]); y0 = Math.min(y0, tr.y[i]); x1 = Math.max(x1, tr.x[i]); y1 = Math.max(y1, tr.y[i]); }
    const k = Math.min((W - 40) / (x1 - x0), (H - 40) / (y1 - y0)), ox = (W - (x1 - x0) * k) / 2, oy = (H - (y1 - y0) * k) / 2;
    const P = (x, y) => [ox + (x - x0) * k, oy + (y - y0) * k];
    ctx.clearRect(0, 0, W, H);
    if (res.city) {
      ctx.fillStyle = '#2d5f7c';
      for (let py = 0; py < H; py += 6) for (let px = 0; px < W; px += 6) {
        const x = x0 + (px - ox) / k, y = y0 + (py - oy) / k;
        if (res.tr.H2(x, y) < 0.3) ctx.fillRect(px, py, 6, 6);
      }
      ctx.fillStyle = 'rgba(232,207,163,.28)';
      for (const b of res.city.buildings) { ctx.beginPath(); b.poly.forEach((p, n) => { const q = P(p[0], p[1]); n ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.closePath(); ctx.fill(); }
    }
    let zmin = Infinity, zmax = -Infinity;
    for (let i = 0; i < N; i++) { zmin = Math.min(zmin, tr.z[i]); zmax = Math.max(zmax, tr.z[i]); }
    ctx.lineWidth = Math.max(4, tr.w * k);
    ctx.lineCap = 'round';
    for (let i = 0; i < N; i += 2) {
      const t = (tr.z[i] - zmin) / Math.max(1, zmax - zmin);
      ctx.strokeStyle = `hsl(${220 - t * 200}, 75%, ${45 + t * 15}%)`;
      const a = P(tr.x[i], tr.y[i]), b = P(tr.x[(i + 2) % N], tr.y[(i + 2) % N]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    const s = P(tr.x[0], tr.y[0]);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(s[0], s[1], 7, 0, 7); ctx.fill();
    ctx.font = '20px Titillium Web, sans-serif'; ctx.fillStyle = '#aab2bd';
    ctx.fillText(`low ${zmin.toFixed(0)} m`, 10, H - 12); ctx.fillText(`high ${zmax.toFixed(0)} m`, W - 130, H - 12);
  }

  // ---------- generating ----------
  function frameView(res) {
    const tr = res.tr;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, zs = 0;
    for (let i = 0; i < tr.N; i++) { x0 = Math.min(x0, tr.x[i]); y0 = Math.min(y0, tr.y[i]); x1 = Math.max(x1, tr.x[i]); y1 = Math.max(y1, tr.y[i]); zs += tr.z[i]; }
    orbit.tx = (x0 + x1) / 2; orbit.tz = (y0 + y1) / 2; orbit.ty = Y(zs / tr.N);
    orbit.dist = Math.max(x1 - x0, y1 - y0) * 1.15;
  }
  // candidates are tried on every core (js/gen2pool.js); a newer request supersedes an older one
  let genId = 0;
  async function generate(keepView) {
    stopDrive();
    const id = ++genId, threads = F1.Gen2Pool.threads();
    $('busy').classList.add('on');
    $('busyt').textContent = `${state.style}, seed ${state.seed}, on ${threads || 1} thread${threads === 1 ? '' : 's'}`;
    try {
      const res = await F1.Gen2Pool.make(state.seed, state.style, n => { if (id === genId) $('busyt').textContent = `${state.style}, seed ${state.seed}: ${n} candidates on ${threads} threads`; });
      if (id !== genId) return;
      state.res = res;
      stats(res); checks(res); drawProfile(res); drawMap(res); realPanel(res);
      buildScene();
      if (!keepView) frameView(res);
      const u = new URL(location.href); u.searchParams.set('style', state.style); u.searchParams.set('seed', state.seed); history.replaceState(null, '', u);
    } catch (e) {
      if (id !== genId) return;
      console.error(e);
      $('status').className = 'status bad';
      $('status').textContent = 'No circuit: ' + e.message + (e.reasons ? ' (' + Object.entries(e.reasons).map(([k, v]) => k + ' ' + v).join(', ') + ')' : '');
    }
    if (id === genId) $('busy').classList.remove('on');
  }

  // ---------- drive a lap ----------
  function startDrive() {
    if (!state.res) return;
    state.drive = { s: 0, t: 0 };
    $('drive').textContent = 'STOP';
    $('drivehud').classList.add('on');
  }
  function stopDrive() {
    if (!state.drive) return;
    state.drive = null;
    $('drive').textContent = 'DRIVE A LAP';
    $('drivehud').classList.remove('on');
    camera.fov = 50; camera.updateProjectionMatrix();
  }
  function driveStep(dt) {
    const d = state.drive, tr = state.res.tr, N = tr.N, sp = state.res.speed;
    const at = s => { const f = ((s % tr.L) + tr.L) % tr.L / tr.ds, i = Math.floor(f) % N, j = (i + 1) % N, t = f - Math.floor(f); return { i, x: U.lerp(tr.x[i], tr.x[j], t), y: U.lerp(tr.y[i], tr.y[j], t), z: U.lerp(tr.z[i], tr.z[j], t) }; };
    const p = at(d.s);
    const v = sp[p.i] * 0.85;
    d.s += v * dt;
    if (d.s > tr.L) d.s -= tr.L;
    const q = at(d.s + 24), h = 1.15;
    camera.fov = 62; camera.updateProjectionMatrix();
    camera.position.set(p.x, Y(p.z) + h * state.ex, p.y);
    camera.lookAt(q.x, Y(q.z) + h * state.ex * 0.6, q.y);
    $('drivehud').textContent = `${Math.round(v * 3.6)} km/h   ${(tr.dz[p.i] * 100).toFixed(1)} %   ${tr.z[p.i].toFixed(1)} m   ${(d.s / 1000).toFixed(2)} km`;
  }

  // ---------- batch ----------
  function runBatch() {
    const n = U.clamp(+$('bn').value || 25, 1, 2000), styles = TG2.STYLE_LIST, out = $('bout');
    const tally = {}, bad = [];
    let k = 0, total = n * styles.length, t0 = performance.now();
    styles.forEach(s => { tally[s] = { ok: 0, tries: 0, ms: 0 }; });
    // one seed per worker at a time, on every core
    const first = +$('seed').value || 1, jobs = [];
    for (const style of styles) for (let i = 0; i < n; i++) jobs.push({ style, seed: first + i });
    const run = () => F1.Gen2Pool.batch(jobs, o => {
      if (o.ok) { tally[o.style].ok++; tally[o.style].tries += o.tries; tally[o.style].ms += o.ms; }
      else bad.push([o.style, o.seed, o.fails.join(', ')]);
      k++;
      if (k % 4 === 0) report(false);
    }).then(() => report(true));
    const report = done => {
      out.innerHTML = `<b>${done ? 'Done' : 'Running'}: ${k} / ${total}</b> in ${((performance.now() - t0) / 1000).toFixed(0)} s on ${F1.Gen2Pool.threads()} threads<br>` +
        styles.map(s => { const t = tally[s]; return `${s}: <b>${t.ok}</b> valid, ${(t.tries / Math.max(1, t.ok)).toFixed(1)} tries, ${(t.ms / Math.max(1, t.ok)).toFixed(0)} ms each`; }).join('<br>') +
        (bad.length ? '<br><span class="bad">' + bad.length + ' FAILED</span><br>' + bad.slice(0, 20).map(([s, sd, why]) => `<a data-s="${s}" data-seed="${sd}">${s} ${sd}</a> ${why}`).join('<br>') : '<br><b>No failures</b>');
      out.querySelectorAll('a').forEach(a => { a.onclick = () => { setStyle(a.dataset.s); state.seed = +a.dataset.seed; $('seed').value = state.seed; generate(); }; });
    };
    run();
  }

  // ---------- controls ----------
  function segGroup(id, attr, fn) {
    $(id).addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      $(id).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      fn(b.dataset[attr]);
    });
  }
  function setStyle(s) { state.style = s; $('styles').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.s === s)); }
  segGroup('styles', 's', s => { state.style = s; generate(); });
  segGroup('ex', 'x', x => { state.ex = +x; if (state.res) { buildScene(); frameView(state.res); } });
  segGroup('roadc', 'r', r => { state.roadc = r; buildScene(); });
  segGroup('bld', 'b', b => { state.bld = b === '1'; buildScene(); });
  $('prev').onclick = () => { state.seed = Math.max(1, state.seed - 1); $('seed').value = state.seed; generate(); };
  $('next').onclick = () => { state.seed = state.seed + 1; $('seed').value = state.seed; generate(); };
  $('rand').onclick = () => { state.seed = 1 + Math.floor(Math.random() * 999999); $('seed').value = state.seed; generate(); };
  $('seed').onchange = () => { state.seed = U.clamp(Math.floor(+$('seed').value) || 1, 1, 999999); $('seed').value = state.seed; generate(); };
  $('drive').onclick = () => (state.drive ? stopDrive() : startDrive());
  $('batch').onclick = runBatch;
  addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Escape') stopDrive();
    if (e.code === 'ArrowRight') $('next').onclick();
    if (e.code === 'ArrowLeft') $('prev').onclick();
  });

  // ---------- loop ----------
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (state.drive && state.res) driveStep(dt); else placeCamera();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  const q = new URLSearchParams(location.search);
  if (q.get('style') && TG2.STYLES[q.get('style')]) setStyle(q.get('style'));
  if (q.get('seed')) state.seed = U.clamp(+q.get('seed') || 1, 1, 999999);
  $('seed').value = state.seed;
  F1.Gen2Pool.start(); // the workers start (and compile the generator) while the page loads
  resize();
  requestAnimationFrame(loop);
  generate();
  window.__lab = { state, generate, orbit, setStyle };
})();
