// Grass: real blades on the verges and fields, drawn as a field of clumps that follows
// the camera. One instanced mesh holds a fixed grid of clumps; the vertex shader moves the
// grid with the camera (snapped to the cell size, so nothing swims), jitters and rotates
// each clump from a hash of its world position, sets it on the ground from a height map,
// and keeps it only where the circuit's grass map says grass grows. The grass map is drawn
// from the circuit itself (asphalt, run-off, barriers, pit lane, buildings, stands, car
// parks are cut out), so every venue, procedural ones included, gets grass where it should.
(function (G) {
  'use strict';
  const F1 = G.F1, THREE = G.THREE;
  const U = F1.U, Tracks = F1.Tracks, SURF = F1.SURF;

  const CELL = 0.42, RADIUS = 56;
  // Near field: modelled blades, as current AAA grass does it (Ghost of Tsushima's procedural
  // grass, Horizon): within NRADIUS of the camera every blade is geometry, a tapered strip in
  // four segments curving over under its own weight, NBLADES to a clump of NCELL. The cards
  // above take over beyond, where a blade is under a pixel wide.
  const NCELL = 0.2, NRADIUS = 13, NBLADES = 28, NSEG = 3;
  // Cost control: every clump checks first whether its root is on screen and is dropped before
  // any other work if not (the grids surround the camera, so most of them are behind or beside
  // it); blades thin out with distance, where a clump is a few pixels; past the inner ring
  // (INNER m) blades are single segments, two triangles instead of six. Under them all, a few
  // millimetre-thin shell layers (SHELLS of them, over SRADIUS m) give the sward its dense
  // carpet of short growth for very little.
  // Far ring: past MIDR the cards continue on a coarser grid (FCELL) with cards widened to
  // match (FSIZE), out to the draw distance, so the field keeps its texture to the horizon.
  const MIDR = 45, FCELL = 1.1, FSIZE = 2.2;
  const INNER = 5, SHELLS = 8, SHELL_H = 0.0055, SCELL = 0.5, SRADIUS = 5.5;
  // Settings (setQuality): density keeps a share of each clump's NBLADES blades; LOD is the
  // radius of modelled blades; draw distance the radius of the whole field. Both grids are
  // rebuilt to the radius asked for, so a shorter distance also costs less.

  // Blade card: shape and a gentle root-to-tip brightness ramp only; the colour comes from
  // the ground under each clump. Transparent texels keep a mid brightness instead of black,
  // so the mipmaps of distant clumps do not darken into dark fringes.
  let _blades = null;
  function bladeTexture() {
    if (_blades) return _blades;
    const S = 256, c = document.createElement('canvas'); c.width = S; c.height = S;
    const g = c.getContext('2d'), r = U.rng(41);
    for (let k = 0; k < 220; k++) {
      const x = 6 + r() * (S - 12), h = S * (0.25 + Math.pow(r(), 1.6) * 0.75), w = 1.6 + r() * 2.6, lean = (r() - 0.5) * 70;
      const v = 170 + r() * 50, lo = Math.round(v * 0.9), hi = Math.round(Math.min(255, v * 1.08));
      const grd = g.createLinearGradient(0, S, 0, S - h);
      grd.addColorStop(0, `rgb(${lo},${lo},${lo})`);
      grd.addColorStop(1, `rgb(${hi},${hi},${hi})`);
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(x - w, S);
      g.quadraticCurveTo(x - w * 0.5 + lean * 0.45, S - h * 0.55, x + lean, S - h);
      g.quadraticCurveTo(x + w * 0.5 + lean * 0.45, S - h * 0.55, x + w, S);
      g.closePath(); g.fill();
    }
    const src = g.getImageData(0, 0, S, S).data, data = new Uint8Array(S * S * 4);
    let sum = 0, n = 0;
    for (let i = 3; i < src.length; i += 4) if (src[i] > 100) { sum += src[i - 3]; n++; }
    const mean = Math.round(sum / n);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4, o = ((S - 1 - y) * S + x) * 4; // rows bottom-up: v = 0 at the root
      const a = src[i + 3], l = a ? src[i] : mean;
      data[o] = data[o + 1] = data[o + 2] = l; data[o + 3] = a;
    }
    const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
    t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 8;
    t.needsUpdate = true;
    t.userData.norm = 255 / mean; // scales the blades' mean brightness to exactly 1
    return (_blades = t);
  }

  // A clump of blades. Each is 7 to 11 mm wide at the root, narrowing to a point, 6 to 12 cm
  // tall (a mown circuit verge), curving away from its facing by up to half its height. The
  // normals are rounded across the width (a blade has a midrib and curls slightly), so it
  // shades like a leaf rather than a flat card. bt is the height along the blade, 0 root to 1 tip.
  function bladeClumpGeometry(nseg = NSEG) {
    const r = U.rng(77), pos = [], nor = [], bt = [], bi = [], idx = [];
    for (let b = 0; b < NBLADES; b++) {
      const a = r() * Math.PI * 2, rr = Math.sqrt(r()) * NCELL * 0.55, ox = Math.cos(r() * 6.283) * rr, oz = Math.sin(r() * 6.283) * rr;
      const w = 0.007 + r() * 0.004, h = 0.06 + Math.pow(r(), 1.4) * 0.06, k = 0.1 + r() * 0.45;
      const sx = Math.cos(a), sz = Math.sin(a), lx = -sz, lz = sx; // across the blade, and the way it bends
      const base = pos.length / 3;
      for (let i = 0; i <= nseg; i++) {
        const t = i / nseg, wt = w * Math.max(0.04, 1 - Math.pow(t, 1.4));
        const cy = h * t * (1 - 0.3 * k * t), cl = h * k * t * t;
        const cx = ox + lx * cl, cz = oz + lz * cl;
        // tangent along the blade, and the face normal across it
        const ty = h * (1 - 0.6 * k * t), tl = 2 * h * k * t;
        let nx = -lx * ty, ny = tl, nz = -lz * ty; const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
        for (const sd of [-1, 1]) {
          pos.push(cx + sx * wt * 0.5 * sd, cy, cz + sz * wt * 0.5 * sd);
          const rx = nx + sx * 0.45 * sd, ry = ny, rz = nz + sz * 0.45 * sd, rl = Math.hypot(rx, ry, rz);
          nor.push(rx / rl, ry / rl, rz / rl); bt.push(t); bi.push((b + 0.5) / NBLADES);
        }
        if (i < nseg) { const q = base + i * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
      }
    }
    const n = Math.round(NRADIUS / NCELL) * 2 + 1, off = new Float32Array(n * n * 2);
    let q = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { off[q++] = i; off[q++] = j; }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('bT', new THREE.Float32BufferAttribute(bt, 1));
    g.setAttribute('bI', new THREE.Float32BufferAttribute(bi, 1)); // the blade's place in the clump, for the density setting
    g.setIndex(idx);
    g.setAttribute('gOff', new THREE.InstancedBufferAttribute(off, 2));
    g.instanceCount = n * n;
    g.userData.half = (n - 1) / 2;
    return g;
  }

  // the shell patch: a grid of SCELL squares, SHELLS instances stacked SHELL_H apart
  function shellGeometry() {
    const n = Math.round(SRADIUS / SCELL) * 2 + 1, pos = [], idx = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) pos.push(i * SCELL, 0, j * SCELL);
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { const a = j * n + i; idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1); }
    const lay = new Float32Array(SHELLS); for (let k = 0; k < SHELLS; k++) lay[k] = (k + 1) / SHELLS;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
    g.setIndex(idx);
    g.setAttribute('sL', new THREE.InstancedBufferAttribute(lay, 1));
    g.instanceCount = SHELLS;
    g.userData.half = (n - 1) / 2;
    return g;
  }

  // three crossed cards, 0.6 m wide and 0.26 m tall, rooted at y = 0
  function clumpGeometry() {
    const pos = [], uv = [], nor = [], idx = [];
    for (let k = 0; k < 3; k++) {
      const a = k * Math.PI / 3, ca = Math.cos(a) * 0.3, sa = Math.sin(a) * 0.3, b = pos.length / 3;
      [[-ca, 0, -sa, 0, 0], [ca, 0, sa, 1, 0], [ca, 0.26, sa, 1, 1], [-ca, 0.26, -sa, 0, 1]].forEach(v => {
        pos.push(v[0], v[1], v[2]); uv.push(v[3], v[4]); nor.push(0, 1, 0);
      });
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const n = Math.round(RADIUS / CELL) * 2 + 1, off = new Float32Array(n * n * 2);
    let q = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { off[q++] = i; off[q++] = j; }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setIndex(idx);
    g.setAttribute('gOff', new THREE.InstancedBufferAttribute(off, 2));
    g.instanceCount = n * n;
    g.userData.half = (n - 1) / 2;
    return g;
  }

  // where grass grows (red channel, 0..1 density), 1 m per pixel over the venue
  function grassMap(tr, W2, ext, extra) {
    const W = Math.ceil(ext.w), H = Math.ceil(ext.h);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    const X = x => x - ext.x0, Z = z => z - ext.z0;
    g.lineCap = 'round'; g.lineJoin = 'round';
    // a band along the circuit from the centreline out to `out(k)` metres, on one side
    const band = (side, out, fill) => {
      const sg = side ? 1 : -1, N = tr.N;
      g.fillStyle = fill;
      for (let i = 0; i < N; i += 2) {
        const j = (i + 3) % N, a = out(i), b = out(j); // quads overlap: no anti-aliased seams
        g.beginPath();
        g.moveTo(X(tr.x[i]), Z(tr.y[i]));
        g.lineTo(X(tr.x[i] + tr.nx[i] * sg * a), Z(tr.y[i] + tr.ny[i] * sg * a));
        g.lineTo(X(tr.x[j] + tr.nx[j] * sg * b), Z(tr.y[j] + tr.ny[j] * sg * b));
        g.lineTo(X(tr.x[j]), Z(tr.y[j]));
        g.closePath(); g.fill();
      }
    };
    for (const side of [0, 1]) {
      // beyond the barrier the field grows freely; inside it only the grass verges do,
      // trimmed back from the kerbs; gravel, tarmac run-off and asphalt have none
      band(side, k => tr.barr[side][k] + 1.2, '#000');
      band(side, k => (tr.runT[side][k] === SURF.GRASS ? tr.barr[side][k] - 0.6 : 0), 'rgb(235,235,235)');
      band(side, k => tr.hw + tr.kerbW + 1.3, '#000');
    }
    // the whole road and its kerbs, painted solid over the seam where the two sides meet
    g.strokeStyle = '#000'; g.lineWidth = 2 * (tr.hw + tr.kerbW + 1.3);
    g.beginPath();
    for (let i = 0; i <= tr.N; i++) { const k = i % tr.N; if (i) g.lineTo(X(tr.x[k]), Z(tr.y[k])); else g.moveTo(X(tr.x[k]), Z(tr.y[k])); }
    g.stroke();
    // pit lane, garages and every built footprint
    const pit = tr.pit;
    g.strokeStyle = '#000'; g.lineWidth = pit.lane + 14;
    g.beginPath();
    let on = false;
    for (let i = 0; i < tr.N; i += 2) {
      if (isNaN(pit.off[i])) { on = false; continue; }
      const x = X(tr.x[i] + tr.nx[i] * pit.off[i]), z = Z(tr.y[i] + tr.ny[i] * pit.off[i]);
      if (!on) { g.moveTo(x, z); on = true; } else g.lineTo(x, z);
    }
    g.stroke();
    g.fillStyle = '#000';
    const rect = (x, z, w, d, h) => {
      g.save(); g.translate(X(x), Z(z)); g.rotate(h || 0); g.fillRect(-w / 2, -d / 2, w, d); g.restore();
    };
    for (const it of W2.decor) {
      if (it.type === 'stand') rect(it.x, it.y, 34, 26, it.h);
      else if (it.type === 'garage') rect(it.x, it.y, it.w + 6, it.d + 30, it.h);
      else if (it.type === 'building') rect(it.x, it.y, it.w + 4, it.h + 4, 0);
      else if (it.type === 'lot') rect(it.x, it.y, it.w, it.h, 0);
      else if (it.type === 'venue') rect(it.x, it.y, it.w + 6, it.d + 6, it.h);
      else if (it.type === 'poly') {
        g.beginPath(); it.pts.forEach((p, k) => (k ? g.lineTo(X(p[0]), Z(p[1])) : g.moveTo(X(p[0]), Z(p[1])))); g.closePath(); g.fill();
      }
    }
    for (const it of extra || []) rect(it.x, it.y, it.w + 8, it.d + 8, it.h);
    if (W2.water) g.fillRect(0, Z(W2.water.y) - 2, W, H);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.NoColorSpace; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
    t.flipY = false; // canvas rows run with +z, the same way the shader samples
    return t;
  }

  // the ground's height grid (the same samples as the terrain mesh) as a half-float texture
  function heightMap(hg) {
    const n = hg.nx * hg.nz, data = new Uint16Array(n), toHalf = THREE.DataUtils.toHalfFloat;
    for (let k = 0; k < n; k++) data[k] = toHalf(hg.y[k]);
    const t = new THREE.DataTexture(data, hg.nx, hg.nz, THREE.RedFormat, THREE.HalfFloatType);
    t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
    return t;
  }

  // build the grass for a circuit; returns null where the venue has none (street, desert)
  function build(tr, W2, hg, extra) {
    if (tr.def.style !== 'park') return null;
    const pad = 40;
    const ext = { x0: hg.x0 + pad, z0: hg.z0 + pad, w: (hg.nx - 1) * hg.cell - 2 * pad, h: (hg.nz - 1) * hg.cell - 2 * pad };
    const geo = clumpGeometry();
    const uniforms = {
      uGOrigin: { value: new THREE.Vector2() },
      uGCell: { value: CELL },
      uGR: { value: RADIUS },
      uGNear: { value: NRADIUS }, // where the modelled blades hand over to these cards
      uGSize: { value: 1 }, // card width multiplier (the far ring's are wider)
      uGTime: { value: 0 },
      uGMask: { value: grassMap(tr, W2, ext, extra) },
      uGMaskB: { value: new THREE.Vector4(ext.x0, ext.z0, ext.w, ext.h) },
      uGHeight: { value: heightMap(hg) },
      uGHeightB: { value: new THREE.Vector4(hg.x0 - hg.cell / 2, hg.z0 - hg.cell / 2, hg.nx * hg.cell, hg.nz * hg.cell) },
      // the park ground's own photo and macro textures (render3d.js: the ground repeats the
      // photo every 3.2 m and varies it with macro(…, 140, 0.22)); the blades copy both
      uGGround: { value: F1.R3T.photo('grass', 1) },
      uGMacro: { value: F1.R3T.macro() },
      uGNorm: { value: bladeTexture().userData.norm },
    };
    // the same roughness as the park ground (F1.R3S.LAWN_ROUGH), so cards and field shine alike
    const m = new THREE.MeshStandardMaterial({ map: bladeTexture(), alphaTest: 0.4, side: THREE.DoubleSide, roughness: F1.R3S.LAWN_ROUGH, metalness: 0, color: '#ffffff' });
    m.alphaToCoverage = true;
    m.userData.grass = uniforms;
    const mesh = new THREE.Mesh(geo, m);
    mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false;
    mesh.userData.grassHalf = geo.userData.half;
    // the modelled blades near the camera: opaque geometry (no alpha test to shimmer), lit both sides
    const bladeMesh = (nseg, R, inner) => {
      const bgeo = bladeClumpGeometry(nseg);
      const bu = Object.assign({}, uniforms, { uGOrigin: { value: new THREE.Vector2() }, uGCell: { value: NCELL }, uGR: { value: R }, uGIn: { value: inner }, uGBlade: { value: 1 }, uGDens: { value: 0.85 } });
      const bm = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.62, metalness: 0, side: THREE.DoubleSide });
      bm.userData.grass = bu;
      const b = new THREE.Mesh(bgeo, bm);
      b.frustumCulled = false; b.receiveShadow = true; b.castShadow = false;
      return b;
    };
    const blades = bladeMesh(NSEG, INNER, 0), ring = bladeMesh(1, NRADIUS, INNER);
    // the shells: opaque layers cut by a strand pattern
    const su = Object.assign({}, uniforms, { uGOrigin: { value: new THREE.Vector2() }, uGCell: { value: SCELL }, uGR: { value: SRADIUS }, uGShell: { value: 1 } });
    const sm = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.8, metalness: 0 });
    sm.userData.grass = su;
    const shells = new THREE.Mesh(shellGeometry(), sm);
    shells.frustumCulled = false; shells.receiveShadow = true; shells.castShadow = false;
    // the far ring: the same cards on a coarser grid, widened
    const fgeo = clumpGeometry();
    const fu = Object.assign({}, uniforms, { uGOrigin: { value: new THREE.Vector2() }, uGCell: { value: FCELL }, uGR: { value: 120 }, uGNear: { value: MIDR }, uGSize: { value: FSIZE } });
    // (a fresh material: clone() would deep-copy userData through JSON, textures and all)
    const fm = new THREE.MeshStandardMaterial({ map: bladeTexture(), alphaTest: 0.4, side: THREE.DoubleSide, roughness: F1.R3S.LAWN_ROUGH, metalness: 0, color: '#ffffff' });
    fm.alphaToCoverage = true; fm.userData.grass = fu;
    const far = new THREE.Mesh(fgeo, fm);
    far.frustumCulled = false; far.receiveShadow = true; far.castShadow = false;
    const grp = new THREE.Group();
    grp.add(far, mesh, ring, blades, shells);
    grp.userData.parts = [mesh, blades, ring, shells, far];
    return grp;
  }

  // keep the clump grid centred on the camera (snapped to whole cells)
  // a camera-centred grid of radius R in cells of the given size
  function regrid(g, R, cell) {
    const n = Math.round(R / cell) * 2 + 1;
    if (g.userData.n === n) return;
    const off = new Float32Array(n * n * 2); let q = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { off[q++] = i; off[q++] = j; }
    g.setAttribute('gOff', new THREE.InstancedBufferAttribute(off, 2));
    g.instanceCount = n * n; g.userData.half = (n - 1) / 2; g.userData.n = n;
  }
  // o: { density (share of blades, 0.2 to 1), near (m of modelled blades), far (m of grass) }
  function setQuality(grp, o) {
    if (!grp || !grp.userData.parts) return;
    const [cards, blades, ring, , farRing] = grp.userData.parts;
    const near = Math.max(3, o.near || NRADIUS), far = Math.max(near + 4, o.far || RADIUS), inner = Math.min(INNER, near * 0.6);
    const dens = Math.min(1, Math.max(0.1, o.density || 0.85));
    const cu = cards.material.userData.grass, bu = blades.material.userData.grass, ru = ring.material.userData.grass;
    // the fine cards out to MIDR (or the whole distance if that is shorter), the far ring beyond
    const mid = Math.min(far, MIDR);
    regrid(cards.geometry, mid, CELL); cu.uGR.value = far > MIDR ? mid / 0.8 : mid; cu.uGNear.value = near;
    if (farRing) {
      farRing.visible = far > MIDR + 5;
      const fu = farRing.material.userData.grass;
      if (farRing.visible) { regrid(farRing.geometry, far, FCELL); fu.uGR.value = far; fu.uGNear.value = mid; }
    }
    regrid(blades.geometry, inner, NCELL); bu.uGR.value = inner; bu.uGDens.value = dens;
    regrid(ring.geometry, near, NCELL); ru.uGR.value = near; ru.uGIn.value = inner; ru.uGDens.value = dens;
  }
  function update(grp, camera, time) {
    if (!grp) return;
    const cam = camera.position || camera;
    for (const mesh of grp.userData.parts || [grp]) {
      const u = mesh.material.userData.grass, half = mesh.geometry.userData.half, c = u.uGCell.value;
      if (half == null) continue;
      u.uGOrigin.value.set(Math.floor(cam.x / c) * c - half * c, Math.floor(cam.z / c) * c - half * c);
      u.uGTime.value = time;
    }
  }

  // shader injection used by F1.R3S.patch when a material carries userData.grass
  const VERT_PARS = [
    'attribute vec2 gOff;',
    'uniform vec2 uGOrigin; uniform float uGCell; uniform float uGR; uniform float uGTime; uniform float uGNear; uniform float uGDens; uniform float uGIn; uniform float uGSize;',
    'uniform sampler2D uGMask; uniform vec4 uGMaskB; uniform sampler2D uGHeight; uniform vec4 uGHeightB;',
    'uniform sampler2D uGMacro;',
    'varying vec2 vGWp; varying float vGShade;',
    // (a sin()-based hash falls apart at world coordinates of hundreds of metres)
    'float gHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }',
    // is a root (plus a margin for the clump's size) on screen? one projection, before any other work
    'bool gOnScreen(vec3 w, float m) { vec4 c = projectionMatrix * viewMatrix * vec4(w, 1.0); if (c.w < -m) return false; float k = c.w + m * 2.0; return abs(c.x) < k * 1.1 && c.y < k * 1.25 && c.y > -k * 1.25; }',
  ].join('\n');
  const VERT = [
    '  vec2 gBase = uGOrigin + gOff * uGCell;',
    '  vec2 gWp = gBase + (vec2(gHash(gBase), gHash(gBase + 3.17)) - 0.5) * uGCell * 1.1;',
    '  float gH = texture2D(uGHeight, (gWp - uGHeightB.xy) / uGHeightB.zw).r;',
    '  bool gCull = !gOnScreen(vec3(gWp.x, gH + 0.1, gWp.y), 0.4 * uGSize);',
    '  vGWp = gWp; vGShade = 1.0;',
    '  if (!gCull) {',
    '  float gDens = clamp((texture2D(uGMask, (gWp - uGMaskB.xy) / uGMaskB.zw).r - 0.2) / 0.8, 0.0, 1.0);',
    '  float gDist = distance(gWp, cameraPosition.xz);',
    '  float gKeep = step(0.05, gDens) * step(gHash(gBase + 7.7), gDens) * (1.0 - smoothstep(uGR * (uGSize > 1.0 ? 0.75 : 0.55), uGR, gDist));',
    // the cards start where the modelled blades fade (they cross over between 8 and 12 m)
    '  gKeep *= smoothstep(uGNear * 0.6, uGNear * 0.92, gDist);',
    '  float gSc = gKeep * (0.75 + 0.5 * gHash(gBase + 5.3));',
    '  float gA = gHash(gBase + 9.1) * 6.2831;',
    '  transformed.xz = mat2(cos(gA), -sin(gA), sin(gA), cos(gA)) * transformed.xz;',
    '  transformed *= vec3(gSc * uGSize, gSc * (0.75 + 0.45 * gDens), gSc * uGSize);',
    '  transformed.xz += vec2(sin(uGTime * 1.8 + gWp.x * 0.33 + gWp.y * 0.21), cos(uGTime * 1.4 + gWp.y * 0.29)) * 0.04 * transformed.y / 0.26;',
    '  transformed += vec3(gWp.x, gH + 0.02, gWp.y);',
    // the turf takes the ground's own colour: the fragment shader projects the ground photo
    // straight down onto the blades (so they carry the same detail as the field around them),
    // and the ground's large-scale macro variation is applied per clump here
    '  vGWp = transformed.xz;',
    '  float gM = textureLod(uGMacro, gWp / 140.0, 0.0).r * 0.6 + textureLod(uGMacro, gWp / 29.4, 0.0).g * 0.4;',
    '  vGShade = mix(0.78, 1.22, gM) * (0.96 + 0.08 * gHash(gBase + 11.3));',
    '  }',
  ].join('\n');
  // the modelled blades: placed like the cards (snapped grid, hashed jitter and turn, ground
  // height, grass map), then bent by the wind more toward the tip, and faded out by height
  // between 70 and 100 per cent of their radius, where the cards have come in
  const VERTB = [
    '  vec2 gBase = uGOrigin + gOff * uGCell;',
    '  vec2 gWp = gBase + (vec2(gHash(gBase), gHash(gBase + 3.17)) - 0.5) * uGCell * 1.1;',
    '  float gH = texture2D(uGHeight, (gWp - uGHeightB.xy) / uGHeightB.zw).r;',
    '  bool gCull = !gOnScreen(vec3(gWp.x, gH + 0.06, gWp.y), 0.25);',
    '  vGWp = gWp; vBT = bT; vGView = vec3(0.0, 0.0, 1.0); vGShade = 1.0;',
    '  if (!gCull) {',
    '  float gDens = clamp((texture2D(uGMask, (gWp - uGMaskB.xy) / uGMaskB.zw).r - 0.2) / 0.8, 0.0, 1.0);',
    '  float gDist = distance(gWp, cameraPosition.xz);',
    '  float gKeep = step(0.05, gDens) * step(gHash(gBase + 7.7) * 0.85, gDens);',
    // blades thin out with distance (all of them within 2.5 m, under half at the far edge); the
    // outer ring starts where the inner blades end
    '  float gFall = mix(1.0, 0.42, smoothstep(2.5, ' + NRADIUS.toFixed(1) + ', gDist));',
    '  float gRing = uGIn > 0.0 ? smoothstep(uGIn * 0.8, uGIn, gDist) : 1.0;',
    '  float gSc = gKeep * gRing * step(bI, uGDens * gFall) * (0.8 + 0.4 * gHash(gBase + 5.3)) * (1.0 - smoothstep(uGR * (uGIn > 0.0 ? 0.7 : 0.8), uGR, gDist));',
    '  float gA = gHash(gBase + 9.1) * 6.2831; mat2 gR = mat2(cos(gA), -sin(gA), sin(gA), cos(gA));',
    '  transformed.xz = gR * transformed.xz;',
    '  transformed.y *= gSc * (0.8 + 0.35 * gDens); transformed.xz *= max(gSc, 0.001);',
    // wind: gusts travel across the field; the bend grows with the square of height up the blade
    '  float gw = sin(uGTime * 1.7 - dot(gWp, vec2(0.21, 0.13))) * 0.6 + sin(uGTime * 3.1 + gWp.x * 0.7) * 0.25;',
    '  transformed.xz += vec2(0.8, 0.6) * gw * 0.035 * bT * bT * gSc;',
    '  transformed += vec3(gWp.x, gH + 0.005, gWp.y);',
    '  vGWp = transformed.xz; vBT = bT; vGView = transformed - cameraPosition;',
    '  float gM = textureLod(uGMacro, gWp / 140.0, 0.0).r * 0.6 + textureLod(uGMacro, gWp / 29.4, 0.0).g * 0.4;',
    '  vGShade = mix(0.86, 1.14, gM) * (0.95 + 0.1 * gHash(gBase + 11.3));',
    '  }',
  ].join('\n');
  // anything dropped by the screen check is sent off screen whole
  const CULL_OUT = '#include <project_vertex>\n  if (gCull) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);';

  // The shells: SHELLS copies of a patch of ground SHELL_H apart, following the terrain. Each
  // layer keeps only the strands that reach it: a 3.8 mm grid of strands, each with its own
  // height and a little offset, round in section and narrowing toward its top, so the stack
  // reads as dense short growth between the blades. Faded out by distance (where the strands
  // would be finer than a pixel) and wherever the grass map has none.
  const VERTS = [
    '  vec2 gWp = uGOrigin + transformed.xz;',
    '  float gH = texture2D(uGHeight, (gWp - uGHeightB.xy) / uGHeightB.zw).r;',
    '  vSDens = clamp((texture2D(uGMask, (gWp - uGMaskB.xy) / uGMaskB.zw).r - 0.2) / 0.8, 0.0, 1.0) * (1.0 - smoothstep(uGR * 0.45, uGR * 0.95, distance(gWp, cameraPosition.xz)));',
    '  transformed = vec3(gWp.x, gH + 0.003 + sL * ' + (SHELL_H * SHELLS).toFixed(4) + ', gWp.y);',
    '  vGWp = gWp; vSL = sL; vGShade = 1.0;',
  ].join('\n');
  function patchShells(sh, u) {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = VERT_PARS + '\nattribute float sL; varying float vSL; varying float vSDens;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERTS);
    sh.fragmentShader = 'varying vec2 vGWp; varying float vGShade; varying float vSL; varying float vSDens; uniform sampler2D uGGround; uniform sampler2D uGMacro; uniform float uGNorm;\n' + F1.R3S.LAWN + '\n' + sh.fragmentShader
      .replace('#include <map_fragment>', [
        '#include <map_fragment>',
        '  { vec2 sp = vGWp * 260.0, sc = floor(sp); float sh0 = tfH(sc), sh1 = tfH(sc + 17.3);',
        '    float top = (0.25 + 0.75 * sh0) * vSDens;',
        '    vec2 lc = fract(sp) - 0.5 - (vec2(sh1, tfH(sc + 4.1)) - 0.5) * 0.35;',
        '    if (vSL > top || length(lc) > 0.42 * (1.0 - 0.75 * vSL / max(top, 1e-3))) discard; }',
        '  diffuseColor.rgb *= texture2D(uGGround, vGWp / 3.2).rgb * uGNorm * lawnTint(uGMacro, vGWp, cameraPosition) * lawnBreak(uGGround, vGWp) * mix(0.8, 1.0, vSL);'].join('\n'));
  }
  function patchShader(sh, u) {
    if (u.uGBlade) return patchBlades(sh, u);
    if (u.uGShell) return patchShells(sh, u);
    Object.assign(sh.uniforms, u);
    sh.vertexShader = VERT_PARS + '\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT).replace('#include <project_vertex>', CULL_OUT);
    sh.fragmentShader = 'varying vec2 vGWp; varying float vGShade; uniform sampler2D uGGround; uniform sampler2D uGMacro; uniform float uGNorm;\n' + F1.R3S.LAWN + '\n' + sh.fragmentShader
      .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.rgb *= texture2D(uGGround, vGWp / 3.2).rgb * vGShade * uGNorm * lawnTint(uGMacro, vGWp, cameraPosition) * lawnBreak(uGGround, vGWp);')
      // both faces of a card take the ground's up normal (a flipped back face would go dark)
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  normal = normalize(vNormal);');
  }

  function patchBlades(sh, u) {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = VERT_PARS + '\nattribute float bT; attribute float bI; varying float vBT; varying vec3 vGView;\n' + sh.vertexShader
      .replace('#include <beginnormal_vertex>', [
        '#include <beginnormal_vertex>',
        // turn the normal with the clump, and lean it halfway to the sky, as AAA grass does, so
        // a field of blades lights like the ground it grows from instead of going dark side-on
        '  { vec2 gB0 = uGOrigin + gOff * uGCell; float gA0 = gHash(gB0 + 9.1) * 6.2831;',
        '    objectNormal.xz = mat2(cos(gA0), -sin(gA0), sin(gA0), cos(gA0)) * objectNormal.xz;',
        '    objectNormal = normalize(mix(objectNormal, vec3(0.0, 1.0, 0.0), 0.5)); }'].join('\n'))
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERTB)
      .replace('#include <project_vertex>', CULL_OUT);
    sh.fragmentShader = 'varying vec2 vGWp; varying float vGShade; varying float vBT; varying vec3 vGView; uniform sampler2D uGGround; uniform sampler2D uGMacro; uniform float uGNorm;\n' + F1.R3S.LAWN + '\n' + sh.fragmentShader
      .replace('#include <map_fragment>', [
        '#include <map_fragment>',
        // the ground's own colour and variation, darker toward the root where the sward shades
        // itself, the tip a touch paler and yellower where it has been cut
        '  diffuseColor.rgb *= texture2D(uGGround, vGWp / 3.2).rgb * vGShade * uGNorm * lawnTint(uGMacro, vGWp, cameraPosition) * lawnBreak(uGGround, vGWp);',
        '  diffuseColor.rgb *= mix(0.8, 1.0, smoothstep(0.0, 0.6, vBT)) * mix(vec3(1.0), vec3(1.07, 1.05, 0.86), smoothstep(0.75, 1.0, vBT));'].join('\n'))
      // both faces keep the leaned-up normal: three would flip it for the back face, into the ground
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  normal = normalize(vNormal);')
      .replace('#include <lights_fragment_end>', [
        '#include <lights_fragment_end>',
        // light through the leaf: looking toward the sun, thin blades glow, less near the root
        // and not at all in shadow
        '  reflectedLight.directDiffuse += diffuseColor.rgb * uSunCol * r3SunVis * 0.4 * pow(clamp(dot(normalize(vGView), uSunDir), 0.0, 1.0), 3.0) * smoothstep(0.2, 1.0, vBT);'].join('\n'));
  }

  F1.R3Grass = { build, update, patchShader, setQuality };
})(typeof window !== 'undefined' ? window : globalThis);
