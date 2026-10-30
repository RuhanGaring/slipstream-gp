// 3D renderer (three.js), built from the same circuit data the simulation uses.
// World mapping: game x -> three X, game y -> three Z, height on Y. A car with heading
// h has rotation.y = -h, so its local +X is forward and local +Z is the driver's right.
(function (G) {
  'use strict';
  const F1 = G.F1;
  const U = F1.U, Tracks = F1.Tracks, SURF = F1.SURF;
  const T = F1.R3T, RC = F1.R3Car;

  // Per-venue light: sun position (degrees), sky gradient, fog, horizon backdrop.
  const LOOKS = {
    kestrel: { sunEl: 40, sunAz: 130, sun: '#fff0dc', sunI: 2.4, top: '#6c8db5', hor: '#d5dde6', bot: '#8f9a86', fog: '#c8d1da', fogN: 420, fogF: 4200, cloud: 0.62, haze: 0.6, exp: 1.3, env: 0.9, bg: 1.5,
      ridge: ['#7f9076', '#5f7356', '#4b5f45'], ridgeH: 90, jag: 5 },
    varenna: { sunEl: 21, sunAz: 235, sun: '#ffcf96', sunI: 3.2, top: '#3f78c0', hor: '#f1d4ab', bot: '#8d8a6a', fog: '#e3d2b6', fogN: 500, fogF: 4800, cloud: 0.32, haze: 1.2, exp: 0.95, env: 0.85,
      ridge: ['#a7a58e', '#7d8768', '#5f6d4c'], ridgeH: 110, jag: 7 },
    lucerne: { sunEl: 55, sunAz: 160, sun: '#fff6e8', sunI: 3.2, top: '#2a70c4', hor: '#c2dcf0', bot: '#6f8a99', fog: '#c6dbea', fogN: 600, fogF: 5200, cloud: 0.28, haze: 0.7, exp: 0.92, env: 1.0,
      ridge: ['#9fb0a8', '#7d9384', '#5f7766'], ridgeH: 380, jag: 16 },
    hakone: { sunEl: 30, sunAz: 110, sun: '#fff3e2', sunI: 2.5, top: '#7c9cc4', hor: '#e1e7ee', bot: '#7d8c78', fog: '#d6dee7', fogN: 260, fogF: 3000, cloud: 0.5, haze: 0.9, exp: 1.0, env: 0.95,
      ridge: ['#aebccc', '#8a9db2', '#6c8299'], ridgeH: 620, jag: 26 },
    rimal: { sunEl: 8, sunAz: 265, sun: '#ff9d5c', sunI: 2.8, top: '#2b3f72', hor: '#f4a466', bot: '#9a7a55', fog: '#e7b38a', fogN: 500, fogF: 5200, cloud: 0.18, haze: 1.6, exp: 1.05, env: 0.8,
      ridge: ['#d2a172', '#b88a5e', '#9c7350'], ridgeH: 60, jag: 4 },
    // (with an HDR probe the sun, sky and fog colour come from the probe; these set the rest)
    ileverte: { sunEl: 38, sunAz: 140, sun: '#fff4e6', sunI: 2.8, top: '#3f7fc8', hor: '#cfe0ef', bot: '#7d9088', fog: '#c9dbe9', fogN: 600, fogF: 5200, cloud: 0.4, haze: 0.7, exp: 1.0, env: 1.0,
      ridge: ['#8fa3b0', '#73889a', '#5d7385'], ridgeH: 70, jag: 3 },
    sierra: { sunEl: 18, sunAz: 220, sun: '#ffd9a8', sunI: 3.2, top: '#3c6fb8', hor: '#e8d8bf', bot: '#9c8a68', fog: '#dcd2c0', fogN: 500, fogF: 5600, cloud: 0.1, haze: 1.0, exp: 0.95, env: 0.9,
      ridge: ['#b7a993', '#9a8d78', '#7c7262'], ridgeH: 760, jag: 30 },
    bahia: { sunEl: 24, sunAz: 250, sun: '#ffd8a0', sunI: 3.0, top: '#4f86c6', hor: '#f0dcc0', bot: '#7f8a62', fog: '#e4d6bd', fogN: 450, fogF: 4400, cloud: 0.35, haze: 1.1, exp: 0.95, env: 0.9,
      ridge: ['#86997a', '#6a7f62', '#556b4f'], ridgeH: 240, jag: 12 },
    nordwald: { sunEl: 25, sunAz: 120, sun: '#f2f0ea', sunI: 1.8, top: '#8a98a8', hor: '#d3d8dc', bot: '#6d7864', fog: '#c8ced2', fogN: 240, fogF: 2600, cloud: 0.8, haze: 0.8, exp: 1.05, env: 0.95,
      ridge: ['#5d6f58', '#4a5c47', '#3b4b39'], ridgeH: 150, jag: 9 },
    lonestar: { sunEl: 16, sunAz: 240, sun: '#ffcf96', sunI: 3.0, top: '#4a7cc0', hor: '#efd8b6', bot: '#a08a64', fog: '#e2cfae', fogN: 600, fogF: 6000, cloud: 0.2, haze: 1.2, exp: 1.0, env: 0.85,
      ridge: ['#b3a07c', '#9a8a68', '#7f7258'], ridgeH: 45, jag: 3 },
  };

  let renderer = null, scene, camera, sun, hemi, skyMesh, skyMat, envScene, pmrem, envRT = null;
  let W = 1, H = 1;
  const state = { tr: null, look: null, root: null, gantry: [], cache: new Map(), water: null, tvCams: [] };
  const live = new Map(); // car object -> model

  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const col = hex => new THREE.Color(hex);
  const mod = (i, n) => ((i % n) + n) % n;

  // ---------- geometry helpers ----------
  function Acc(colored) { this.p = []; this.n = []; this.uv = []; this.c = colored ? [] : null; this.ix = []; this.k = 0; }
  Acc.prototype.v = function (x, y, z, nx, ny, nz, u, v, c) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.uv.push(u, v);
    if (this.c) this.c.push(c ? c.r : 1, c ? c.g : 1, c ? c.b : 1);
    return this.k++;
  };
  Acc.prototype.t = function (a, b, c) { this.ix.push(a, b, c); };
  Acc.prototype.geo = function () {
    if (!this.k) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.c) g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.k > 65000 ? new THREE.Uint32BufferAttribute(this.ix, 1) : new THREE.Uint16BufferAttribute(this.ix, 1));
    g.computeBoundingSphere();
    return g;
  };

  // Batch: merge many transformed geometries into one draw call (optionally coloured).
  function Batch(colored) { this.parts = []; this.colored = colored; }
  Batch.prototype.add = function (geo, m, c) { this.parts.push([geo, m, c]); };
  Batch.prototype.geo = function () {
    if (!this.parts.length) return null;
    let n = 0;
    const list = this.parts.map(([g0, m, c]) => {
      const g = g0.index ? g0.toNonIndexed() : g0.clone();
      if (m) g.applyMatrix4(m);
      if (!g.attributes.normal) g.computeVertexNormals();
      n += g.attributes.position.count;
      return [g, c];
    });
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2), cc = this.colored ? new Float32Array(n * 3) : null;
    let o = 0;
    for (const [g, c] of list) {
      const m = g.attributes.position.count;
      pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3);
      if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
      if (cc) {
        if (g.attributes.color && !c) cc.set(g.attributes.color.array, o * 3);
        else for (let k = 0; k < m; k++) { cc[(o + k) * 3] = c ? c.r : 1; cc[(o + k) * 3 + 1] = c ? c.g : 1; cc[(o + k) * 3 + 2] = c ? c.b : 1; }
      }
      o += m;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (cc) out.setAttribute('color', new THREE.BufferAttribute(cc, 3));
    out.computeBoundingSphere();
    return out;
  };

  const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), SC = new THREE.Vector3(), PV = new THREE.Vector3();
  function mat(x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) {
    E.set(rx, ry, rz, 'YXZ'); Q.setFromEuler(E); SC.set(sx, sy, sz); PV.set(x, y, z);
    return new THREE.Matrix4().compose(PV, Q, SC);
  }

  // contiguous runs of samples where cond(i) holds, around the closed loop: [i0, iEnd) in unwrapped indices
  function runs(N, cond) {
    let start = -1;
    for (let i = 0; i < N; i++) if (!cond(i)) { start = i; break; }
    if (start < 0) return [[0, N]];
    const out = [];
    let r0 = -1;
    for (let k = 1; k <= N; k++) {
      const i = start + k;
      const c = k < N && cond(i % N);
      if (c && r0 < 0) r0 = i;
      if (!c && r0 >= 0) { out.push([r0, i]); r0 = -1; }
    }
    return out;
  }

  // flat ribbon between lateral offsets fa(k) < fb(k), samples i0..i1 inclusive
  function ribbon(acc, tr, i0, i1, fa, fb, y, uvs, c) {
    const N = tr.N;
    let prev = -1;
    for (let i = i0; i <= i1; i++) {
      const k = mod(i, N);
      const da = fa(k), db = fb(k);
      if (isNaN(da) || isNaN(db)) { prev = -1; continue; }
      const ax = tr.x[k] + tr.nx[k] * da, az = tr.y[k] + tr.ny[k] * da;
      const bx = tr.x[k] + tr.nx[k] * db, bz = tr.y[k] + tr.ny[k] * db;
      const a = acc.v(ax, y + Tracks.surfZ(tr, k, da), az, 0, 1, 0, ax / uvs, az / uvs, c);
      acc.v(bx, y + Tracks.surfZ(tr, k, db), bz, 0, 1, 0, bx / uvs, bz / uvs, c);
      if (prev >= 0) { acc.t(prev, prev + 1, a); acc.t(prev + 1, a + 1, a); }
      prev = a;
    }
  }

  // vertical faces along an offset path: inner face (and top + outer face when thick)
  function wallRun(acc, tr, i0, i1, df, y0, y1, uLen, vLen, thick, c) {
    const N = tr.N;
    let prev = -1, len = 0, px = 0, pz = 0;
    for (let i = i0; i <= i1; i++) {
      const k = mod(i, N);
      const d = df(k), sg = d >= 0 ? 1 : -1;
      const x = tr.x[k] + tr.nx[k] * d, z = tr.y[k] + tr.ny[k] * d;
      if (prev >= 0) len += Math.hypot(x - px, z - pz);
      px = x; pz = z;
      const nx = -tr.nx[k] * sg, nz = -tr.ny[k] * sg; // faces the track
      const u = len / uLen;
      const g0 = Tracks.surfZ(tr, k, d);
      const a = acc.v(x, y0 + g0 - (y0 <= 0 ? 0.25 : 0), z, nx, 0, nz, u, 0, c);
      acc.v(x, y1 + g0, z, nx, 0, nz, u, (y1 - y0) / vLen, c);
      if (thick) {
        const ox = x + tr.nx[k] * sg * thick, oz = z + tr.ny[k] * sg * thick;
        acc.v(x, y1 + g0, z, 0, 1, 0, u, 0, c);
        acc.v(ox, y1 + g0, oz, 0, 1, 0, u, thick / vLen, c);
        acc.v(ox, y1 + g0, oz, -nx, 0, -nz, u, (y1 - y0) / vLen, c);
        acc.v(ox, y0 + g0 - (y0 <= 0 ? 0.25 : 0), oz, -nx, 0, -nz, u, 0, c);
      }
      const st = thick ? 6 : 2;
      if (prev >= 0) {
        acc.t(prev, prev + 1, a); acc.t(prev + 1, a + 1, a);
        if (thick) {
          acc.t(prev + 2, prev + 3, a + 2); acc.t(prev + 3, a + 3, a + 2);
          acc.t(prev + 4, prev + 5, a + 4); acc.t(prev + 5, a + 5, a + 4);
        }
      }
      prev = a;
      void st;
    }
  }

  // ---------- materials ----------
  const MATS = {};
  function std(o) { return new THREE.MeshStandardMaterial(o); }
  function repTex(t, rx, ry) { const c = t.clone(); c.repeat.set(rx, ry); c.needsUpdate = true; return c; }
  // PBR material from a photo set: albedo, plus normal and packed AO/roughness/metal
  // maps when the asset pack has them (all with the same repeat so they line up).
  function pbr(key, rep, o = {}, Mat = THREE.MeshStandardMaterial) {
    const m = new Mat(Object.assign({ map: T.photo(key, rep), roughness: 1, metalness: 0 }, o));
    if (T.has(key + '_n') && !o.normalMap) m.normalMap = T.photo(key + '_n', rep, false);
    if (T.has(key + '_arm')) { const a = T.photo(key + '_arm', rep, false); m.aoMap = a; m.roughnessMap = a; m.metalnessMap = a; }
    return m;
  }
  // Large-scale variation: two octaves of tileable noise in world space modulate albedo and
  // roughness, so a 3 m photo tile does not visibly repeat across a field or a straight.
  function macro(m, scale, amt, ramt = 0.12, lawn = false) {
    m.userData.macro = { scale, amt, ramt, lawn };
    return m;
  }

  function materials() {
    if (MATS.asphalt) return MATS;
    const ph = T.has('asphalt');
    // Photo PBR sets when the CC0 asset pack is present, procedural textures otherwise.
    // Ribbon UVs are in units of 9-10 m, so repeat = ribbon unit / real tile size.
    // Roughness and metalness come from measured maps; the constants are only multipliers.
    if (ph) {
      // lifted to a used circuit's mid grey and worn in by F1.R3S.wear.asphalt
      MATS.asphalt = F1.R3S.wear.asphalt(macro(pbr('asphalt', 9 / 3.5, { color: '#d2d2d2' }), 70, 0.09, 0.15), 5.5);
      MATS.pitlane = macro(pbr('pitlane', 9 / 3, { color: '#dedede' }), 50, 0.07);
      MATS.gravel = macro(pbr('gravel', 10 / 1.6, { normalMap: T.photo('gravel_n', 10 / 1.6, false), color: '#f4ecdf' }), 45, 0.12);
    } else {
      MATS.asphalt = std({ map: T.asphalt(), roughness: 0.88 });
      MATS.pitlane = std({ map: T.asphalt(), color: '#e3e3e6', roughness: 0.82 });
      MATS.gravel = std({ map: T.gravel(), roughness: 1 });
    }
    const aN = ph ? T.photo('asphalt_n', 9 / 3.5, false) : null;
    // kerbs: painted concrete; UVs run 1.5 m along and across the kerb
    MATS.kerb = std({ vertexColors: true, roughness: ph ? 0.85 : 0.55 });
    MATS.kerb.userData.wetK = [0.7, 1];
    MATS.asphalt.userData.wetK = [1, 1]; MATS.pitlane.userData.wetK = [1, 1]; MATS.gravel.userData.wetK = [0.8, 0.5];
    if (ph) { MATS.kerb.normalMap = T.photo('kerb_n', 1, false); MATS.kerb.roughnessMap = T.photo('kerb_arm', 1, false); MATS.kerb.aoMap = MATS.kerb.roughnessMap; }
    F1.R3S.wear.kerb(MATS.kerb);
    // road paint: thermoplastic over the asphalt grain, a little glossier than the road
    MATS.paint = std({ vertexColors: true, roughness: 0.55, normalMap: aN });
    MATS.paint.userData.wetK = [0.4, 1];
    if (aN) MATS.paint.normalScale.set(0.6, 0.6);
    F1.R3S.wear.paint(MATS.paint);
    // rubbered-in line: darker and smoother than the asphalt around it
    MATS.rubber = std({ color: '#0a0a0b', roughness: 0.5, transparent: true, opacity: 0.32, depthWrite: false, normalMap: aN });
    MATS.concrete = ph ? pbr('concrete', [3, 0.45], { side: THREE.DoubleSide }) : std({ map: T.concrete(), roughness: 0.9, side: THREE.DoubleSide });
    // printed vinyl hoardings on concrete: uniform satin, the wall's relief shows through
    MATS.adwall = std({ map: adTexture(), roughness: 0.5, side: THREE.DoubleSide, normalMap: ph ? T.photo('concrete_n', [5, 0.45], false) : null });
    if (ph) MATS.adwall.normalScale.set(0.35, 0.35);
    // galvanised W-beam: metal, roughness from the photo, ridges from a profile normal map
    MATS.armco = ph ? pbr('metal', [1, 0.6], { metalness: 1, color: '#d4d8dc', side: THREE.DoubleSide, normalMap: T.corrugation() })
      : std({ map: T.armco(), roughness: 0.35, metalness: 0.75, side: THREE.DoubleSide });
    MATS.tyres = std({ map: T.tyres(), roughness: 0.85, side: THREE.DoubleSide });
    if (ph) { MATS.tyres.normalMap = T.photo('rubber_n', 2, false); MATS.tyres.roughnessMap = T.photo('rubber_arm', 2, false); }
    MATS.fence = std({ map: T.fence(), alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.45, metalness: 1, color: '#a7adb3' });
    MATS.steel = ph ? pbr('metal', 1, { metalness: 1, color: '#c4c9ce' }) : std({ color: '#5b6067', roughness: 0.45, metalness: 0.7 });
    // the metal photo's mean luminance (linear) is 0.0347; times each material's colour
    if (ph) for (const m of [MATS.armco, MATS.steel]) {
      const c = m.color; F1.R3S.wear.zinc(m, 0.0347 * (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b));
    }
    // painted steel (gantry, posts) and painted cladding (garages, roofs): dielectric paint
    MATS.dark = std({ color: '#2a2d32', roughness: 0.45, metalness: 0, normalMap: ph ? T.photo('metal_n', 1, false) : null });
    MATS.white = std({ color: '#e6e9ec', roughness: 0.4, metalness: 0, normalMap: ph ? T.photo('metal_n', 1, false) : null });
    if (ph) { MATS.dark.normalScale.set(0.3, 0.3); MATS.white.normalScale.set(0.3, 0.3); }
    MATS.crowd = std({ map: T.crowd(), roughness: 0.9 });
    MATS.vcol = std({ vertexColors: true, roughness: 0.45, metalness: 0 });
    MATS.vcolMetal = std({ vertexColors: true, roughness: 0.3, metalness: 0.5 });
    MATS.interior = std({ color: '#1c1e22', roughness: 0.85 });
    MATS.foliage = std({ roughness: 0.75, flatShading: true });
    MATS.palm = std({ color: '#4d7a2c', roughness: 0.7, side: THREE.DoubleSide, flatShading: true });
    MATS.bark = std({ color: '#5a4636', roughness: 0.95 });
    MATS.lot = std({ map: T.lot(), roughness: 0.85, normalMap: aN });
    // sea water: dielectric (IOR 1.33), near-mirror, the only detail is wave normals
    MATS.water = new THREE.MeshPhysicalMaterial({ color: '#0f3343', roughness: 0.03, metalness: 0, ior: 1.33, normalMap: waterNormal() });
    MATS.water.normalScale.set(0.3, 0.3);
    MATS.shadowBlob = new THREE.MeshBasicMaterial({ alphaMap: T.softA(), color: '#000000', transparent: true, opacity: 0.55, depthWrite: false });
    MATS.ghost = new THREE.MeshBasicMaterial({ color: '#8fd0ff', transparent: true, opacity: 0.32, depthWrite: false });
    return MATS;
  }

  // Fictional sponsor hoardings for walls: the circuit's own branding and the teams'.
  function adTexture() {
    const c = document.createElement('canvas'); c.width = 2048; c.height = 128;
    const g = c.getContext('2d');
    const ads = [['SLIPSTREAM', '#0b1f3a', '#ffffff'], ['VANTA', '#121417', '#d8b45a'], ['FERRO CORSA', '#c8102e', '#ffffff'], ['MERIDIAN', '#0e8f86', '#ffffff'],
      ['HALCYON', '#16224a', '#ff7a1a'], ['GRAND PRIX', '#f4f4f4', '#c8102e'], ['KODIAK', '#1a2f8f', '#f2c230'], ['AUREX', '#b7e000', '#121212']];
    ads.forEach(([t, bg, fg], k) => {
      g.fillStyle = bg; g.fillRect(k * 256, 0, 256, 128);
      g.fillStyle = fg; g.font = 'italic 900 46px Titillium Web, Segoe UI, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(t, k * 256 + 128, 70, 236);
      g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(k * 256, 0, 3, 128);
    });
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, 118, 2048, 10);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    return t;
  }

  function waterNormal() {
    const n = 256, c = document.createElement('canvas'); c.width = c.height = n;
    const g = c.getContext('2d'), img = g.createImageData(n, n), d = img.data;
    const h = (x, y) => Math.sin(x * 0.098 + y * 0.031) * 0.6 + Math.sin(x * 0.047 - y * 0.12) * 0.5 + Math.sin((x + y) * 0.21) * 0.25 + Math.sin(x * 0.31 - y * 0.17) * 0.15;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const dx = h(x + 1, y) - h(x - 1, y), dy = h(x, y + 1) - h(x, y - 1);
      const l = Math.hypot(dx, dy, 1);
      const i = (y * n + x) * 4;
      d[i] = (-dx / l * 0.5 + 0.5) * 255; d[i + 1] = (-dy / l * 0.5 + 0.5) * 255; d[i + 2] = (1 / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(0.02, 0.02);
    return t;
  }

  // ---------- init ----------
  const SKY_VS = 'varying vec3 vDir;\nvoid main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  const SKY_FS = [
    'uniform vec3 top; uniform vec3 hor; uniform vec3 bot; uniform vec3 sunDir; uniform vec3 sunCol; uniform float cloud; uniform float haze; uniform float time;',
    'varying vec3 vDir;',
    'float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
    'float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }',
    'float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int k = 0; k < 5; k++){ s += a * vn(p); p *= 2.03; a *= 0.5; } return s; }',
    'void main(){',
    '  vec3 d = normalize(vDir); float y = d.y;',
    '  vec3 c = y > 0.0 ? mix(hor, top, pow(clamp(y, 0.0, 1.0), 0.48)) : mix(hor, bot, clamp(-y * 6.0, 0.0, 1.0));',
    '  float s = max(dot(d, sunDir), 0.0);',
    '  c += sunCol * (pow(s, 5.0) * 0.22 * haze + pow(s, 60.0) * 0.4);',
    '  if (y > 0.0) {',
    '    vec2 uv = d.xz / (y + 0.1) * 1.4;',
    '    float n = fbm(uv + vec2(time * 0.003, time * 0.001));',
    '    float cl = smoothstep(1.0 - cloud, 1.2 - cloud * 0.7, n) * smoothstep(0.0, 0.2, y);',
    '    vec3 cc = mix(hor, vec3(1.0), 0.6) * (0.78 + 0.5 * pow(s, 6.0)) * (0.85 + 0.25 * fbm(uv * 2.0 + 7.0));',
    '    c = mix(c, cc, cl * 0.92);',
    '  }',
    '  c += sunCol * pow(s, 2000.0) * 30.0;',
    '  gl_FragColor = vec4(c, 1.0);',
    '  #include <tonemapping_fragment>',
    '  #include <colorspace_fragment>',
    '}'].join('\n');

  // The potato preset (integrated GPUs) also changes things fixed when the WebGL context is
  // made: no canvas MSAA, and a plain depth buffer instead of the logarithmic one (which writes
  // gl_FragDepth and so turns off early depth rejection for every pixel). Read straight from the
  // saved settings, since the renderer is built before the game loads them; switching it reloads.
  // Rock (the slowest phones) goes further: the far plane comes in to 1.6 km, with the fog
  // thickened to meet it, so whole tiles of trees and scenery are culled before they are drawn.
  let POT = false, ROCK = false;
  try {
    const gx = JSON.parse(localStorage.getItem('slip_settings') || '{}').gfx;
    // a first start on a phone or tablet is on potato (js/game.js picks the same preset)
    const pr = gx ? (gx.boot != null ? gx.boot : gx.preset) : typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches ? 'potato' : '';
    ROCK = pr === 'rock'; POT = ROCK || pr === 'potato';
  } catch (e) { /* no storage */ }
  const FAR = ROCK ? 1600 : POT ? 3000 : 14000; // the starting far plane; GFX.viewDist moves it (setView)
  function init(canvas) {
    // (three always gives the canvas an alpha channel and keeps it opaque by clearing alpha to 1:
    // nothing drawn straight to the screen may write alpha below 1, or Edge shows the black page
    // through it; see r3SunA in js/r3-shadow.js)
    renderer = new THREE.WebGLRenderer({ canvas, antialias: !POT, powerPreference: 'high-performance', logarithmicDepthBuffer: !POT, preserveDrawingBuffer: false });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap; // filter radius set per cascade (js/r3-shadow.js)
    // The shadow slices are drawn one at a time. For the outer two every car is swapped for its
    // one-mesh stand-in (see js/r3-shadow.js): at their scale a car is a few texels, and its full
    // detail (twenty-odd parts, the cockpit, skinned arms) cost more than the rest of the scene.
    {
      const SM = renderer.shadowMap, smRender = SM.render.bind(SM), CL = F1.R3Shadow.S.lights;
      const swap = on => {
        for (const o of live.values()) {
          const b = o.userData.body, px = b && b.userData.shadowProxy;
          if (!px) continue;
          for (const ch of b.children) {
            if (ch === px) continue;
            if (on) { ch.userData.sv = ch.visible; ch.visible = false; } else ch.visible = ch.userData.sv;
          }
          px.visible = on;
        }
      };
      SM.render = (lights, sc, cam) => {
        if (lights.length < 2 || G.__shFull) return smRender(lights, sc, cam); // debug: G.__shFull draws every slice in full
        for (const l of lights) {
          const outer = CL.indexOf(l) > 0 && l.shadow.needsUpdate;
          if (outer) swap(true);
          try { smRender([l], sc, cam); } finally { if (outer) swap(false); }
        }
      };
    }
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(60, 1, 0.06, FAR);
    hemi = new THREE.HemisphereLight('#cfe0f5', '#5a6248', 0.35);
    scene.add(hemi);
    // the sun lights the scene; its shadow comes from the cascades (js/r3-shadow.js)
    sun = new THREE.DirectionalLight('#ffffff', 2.5);
    sun.castShadow = false;
    scene.add(sun, sun.target);
    F1.R3Shadow.init(scene);
    skyMat = new THREE.ShaderMaterial({
      uniforms: { top: { value: col('#6c8db5') }, hor: { value: col('#d5dde6') }, bot: { value: col('#888') }, sunDir: { value: V(0, 1, 0) }, sunCol: { value: col('#fff') }, cloud: { value: 0.5 }, haze: { value: 1 }, time: { value: 0 } },
      vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    });
    skyMesh = new THREE.Mesh(new THREE.SphereGeometry(9000, 32, 16), skyMat);
    skyMesh.renderOrder = -10; skyMesh.frustumCulled = false;
    if (POT) skyMesh.scale.setScalar(FAR / 9000 * 0.75); // inside the shorter far plane (setView keeps it there)
    scene.add(skyMesh);
    envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMat));
    pmrem = new THREE.PMREMGenerator(renderer);
    F1.R3Post.init(renderer);
    initFx();
    state.wx = F1.R3W.create(scene);
    return renderer;
  }

  let DPR = 1;
  function resize(w, h, dpr) {
    if (!renderer) return;
    W = w; H = h; DPR = Math.min(GFX.dprCap || (GFX.lite ? 1 : 2), dpr || 1);
    applyScale();
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    F1.R3Post.setSize(Math.round(w * DPR), Math.round(h * DPR));
  }
  // Without post-processing, render scale is the canvas pixel ratio; with it, the canvas
  // stays at native resolution and the post stack renders the scene at the scaled size.
  function applyScale() {
    const P = F1.R3Post.Q;
    renderer.setPixelRatio(P.on ? DPR : DPR * GFX.scale);
  }

  // ---------- graphics quality ----------
  const GFX = { scenery: 'full', viewDist: 14000, dprCap: 2, aniso: 8, trees: 1, treeDist: 0, boards: true, backdrop: true, grass: true, carNear: 50, carFar: 300, carDraw: 0, post: true, scale: 1, msaa: 4, shadows: 'high', ssao: true, bloom: true, shafts: true, motion: true, lens: true, tone: 'agx', ev: 0, aniso: 16 };
  // Only post on/off and the shadow setup change which shader programs the scene needs; every
  // other setting is a uniform or a render target size. When the programs do change they are
  // built with compileAsync (parallel, off the main thread where the driver allows) while the
  // canvas holds its last frame, instead of all compiling inside the next render call.
  let progKey = '', compiling = null;
  function setQuality(g) {
    Object.assign(GFX, g);
    // the tier the context was made for wins while it runs (changing it restarts the game)
    GFX.potato = GFX.potato || POT; GFX.rock = ROCK;
    F1.R3Post.setQuality({ on: GFX.post, scale: GFX.scale, msaa: GFX.msaa, ssao: GFX.ssao, aoSamples: GFX.aoSamples || 10, aoK: GFX.aoStrength != null ? GFX.aoStrength : 0.85, bloom: GFX.bloom, bloomK: GFX.bloomK || 0.06, shafts: GFX.shafts, shaftK: GFX.shaftK != null ? GFX.shaftK : 0.45, motion: GFX.motion, shutter: GFX.shutter || 180, lens: GFX.lens, grain: GFX.grain !== false, tone: GFX.tone });
    if (!renderer) return;
    renderer.shadowMap.enabled = GFX.shadows !== 'off';
    F1.R3Shadow.setQuality(GFX.shadows, { res: GFX.shadowRes, dist: GFX.shadowDist, soft: GFX.shadowSoft });
    renderer.shadowMap.needsUpdate = true;
    if (state.grass) { state.grass.visible = grassOn(); F1.R3Grass.setQuality(state.grass, grassQ()); }
    if (state.wx) state.wx.density = GFX.rainK;
    applyScenery();
    setView();
    applyAniso(scene);
    const key = (GFX.post ? 'p' : 'n') + F1.R3Shadow.casters();
    if (key !== progKey) {
      const first = !progKey;
      progKey = key;
      scene.traverse(o => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.needsUpdate = true; }); });
      if (!first && state.tr) {
        const t0 = performance.now(), job = compiling = precompile().then(() => {
          if (compiling === job) compiling = null;
          G.__gfxSwitchMs = Math.round(performance.now() - t0);
        });
      }
    }
    applyScale();
    if (W > 1) resize(W, H, DPR);
  }

  // Scenery detail. Trees thin out by drawing only the first share of each tile's instances
  // (shuffled when built, so the forest keeps its outline and just gets sparser; a tile left
  // empty is not drawn at all); the trackside boards go below Reduced and the distant hills
  // in Rock, where they would lie beyond the far plane anyway.
  const DENS = { full: 1, reduced: 0.6, sparse: 0.33, minimal: 0.12 };
  function applyScenery() {
    const root = state.root;
    if (!root) return;
    const k = GFX.trees != null ? GFX.trees : DENS[GFX.scenery || 'full'] || 1;
    state.dens = [];
    for (const o of root.children) {
      const n0 = o.userData.dens;
      if (n0) {
        const n = Math.round(n0 * k);
        if (o.isInstancedMesh) o.count = n; else o.geometry.instanceCount = n;
        o.visible = o.userData.on = n > 0;
        if (n > 0) state.dens.push(o);
      }
      if (o.userData.cat === 'boards') o.visible = GFX.boards !== false;
    }
    if (root.userData.backdropMesh) root.userData.backdropMesh.visible = GFX.backdrop !== false && camera.far > root.userData.backdrop.R + 200;
  }

  const grassOn = () => (GFX.grass != null ? !!GFX.grass : !GFX.lite);
  const grassQ = () => ({ density: GFX.grassDensity || 0.85, near: GFX.grassLod || 13, far: GFX.grassDist || 120 });
  // View distance: the far plane, with the sky dome kept inside it and the fog thickened to
  // hide its edge (about 90 per cent at the far plane). Potato and rock draw with a plain
  // depth buffer, which loses precision far out, so they keep within 3 km.
  function setView() {
    if (!camera) return;
    const far = Math.max(800, Math.min(POT ? 3000 : 20000, GFX.viewDist || FAR));
    if (camera.far !== far) { camera.far = far; camera.updateProjectionMatrix(); }
    skyMesh.scale.setScalar(Math.min(1, far / 9000 * 0.75));
    if (state.look) {
      const d = Math.max(0.9 / state.look.fogF, far < 6000 ? 1.5 / far : 0);
      if (scene.fog) scene.fog.density = d;
      if (state.base) state.base.fogD = d;
      F1.R3S.U.uFogDensity.value = d;
    }
    if (state.root && state.root.userData.backdropMesh) state.root.userData.backdropMesh.visible = GFX.backdrop !== false && far > state.root.userData.backdrop.R + 200;
  }
  // Texture filtering at grazing angles: every texture in the tree takes the setting
  // (capped at what the GPU offers); changing it re-uploads them, so it is only done when it changes
  const TEX_KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'bumpMap', 'alphaMap', 'clearcoatNormalMap'];
  function applyAniso(root) {
    if (!renderer || !root) return;
    const a = Math.max(1, Math.min(GFX.aniso || 8, renderer.capabilities.getMaxAnisotropy()));
    root.traverse(o => {
      const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of ms) for (const k of TEX_KEYS) { const t = m[k]; if (t && t.isTexture && !t.isRenderTargetTexture && t.anisotropy !== a) {
        t.anisotropy = a;
        // re-upload only what is already loaded; anything still loading takes the value when it arrives
        const img = t.image;
        if (img && img.complete !== false && (img.width || img.data || img.length)) t.needsUpdate = true;
      } }
    });
  }

  function applyLook(id) {
    const L = LOOKS[id] || LOOKS.kestrel;
    state.look = L;
    const el = L.sunEl * Math.PI / 180, az = L.sunAz * Math.PI / 180;
    state.sunDir = V(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
    const u = skyMat.uniforms;
    u.top.value.set(L.top); u.hor.value.set(L.hor); u.bot.value.set(L.bot); u.sunDir.value.copy(state.sunDir);
    u.sunCol.value.set(L.sun); u.cloud.value = L.cloud; u.haze.value = L.haze;
    sun.color.set(L.sun); sun.intensity = L.sunI;
    hemi.color.set(L.hor); hemi.groundColor.set(L.bot); hemi.intensity = 0.25;
    // rock: fog thick enough to hide the near far plane (about 90 per cent at 1.6 km)
    const fogD = Math.max(0.9 / L.fogF, camera.far < 6000 ? 1.5 / camera.far : 0);
    scene.fog = new THREE.FogExp2(L.fog, fogD);
    renderer.toneMappingExposure = L.exp;
    const S3 = F1.R3S.U;
    S3.uFogCol.value.set(L.fog); S3.uFogDensity.value = fogD; S3.uFogFalloff.value = id === 'hakone' || id === 'sierra' ? 1 / 260 : 1 / 420;
    if (envRT) envRT.dispose();
    envRT = null;
    scene.background = null; skyMesh.visible = true;
    // Physically based path: a calibrated HDR light probe (tools/hdr_prep.py). The sun has
    // been cut out of it and becomes the directional light, with its measured irradiance
    // and colour; the sky is normalised so a white ground plane reads 1.0.
    const H0 = F1.Assets && F1.Assets['hdr_' + id];
    state.hdr = H0 || null;
    if (H0) {
      const probe = F1.R3S.hdrTexture(H0);
      envRT = pmrem.fromEquirectangular(probe);
      probe.dispose();
      state.sunDir = V(H0.sun[0], H0.sun[1], H0.sun[2]).normalize();
      if (state.sunDir.y < 0.06) { state.sunDir.y = 0.06; state.sunDir.normalize(); }
      const e = H0.sunE, lum = e[0] * 0.2126 + e[1] * 0.7152 + e[2] * 0.0722;
      sun.color.setRGB(e[0] / lum, e[1] / lum, e[2] / lum, THREE.LinearSRGBColorSpace); sun.intensity = lum;
      hemi.intensity = 0;
      scene.fog.color.setRGB(H0.fog[0], H0.fog[1], H0.fog[2], THREE.LinearSRGBColorSpace);
      S3.uFogCol.value.copy(scene.fog.color);
      state.exposure = { kestrel: 1.0, varenna: 0.9, lucerne: 1.0, hakone: 1.0, rimal: 0.85, sierra: 0.88, lonestar: 0.85 }[id] || 1;
    } else {
      envRT = pmrem.fromScene(envScene, 0.02);
      state.exposure = L.exp;
    }
    scene.environment = envRT.texture;
    S3.uSunDir.value.copy(state.sunDir); S3.uSunCol.value.copy(sun.color).multiplyScalar(sun.intensity);
    state.sky = T.has('sky_' + id) ? T.photo('sky_' + id, 1) : null;
    state.skyReady = false;
    if (state.sky) { state.sky.mapping = THREE.EquirectangularReflectionMapping; state.sky.wrapS = THREE.RepeatWrapping; state.sky.wrapT = THREE.ClampToEdgeWrapping; }
    for (const k in MATS) if (MATS[k].isMeshStandardMaterial) MATS[k].envMapIntensity = H0 ? 1 : L.env;
    state.base = { sunI: sun.intensity, fogD: S3.uFogDensity.value, fog: S3.uFogCol.value.clone(), hemi: hemi.intensity, bg: scene.backgroundIntensity };
  }

  // the safety car: a low dark wedge with a light bar, driven round the track by the race
  let scCar = null;
  function updateSC(sc, dt) {
    void dt;
    if (!scCar) {
      scCar = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.9, 1.9), new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.35, metalness: 0.4 }));
      body.position.y = 0.65; const cab = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.55, 1.6), new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.2 })); cab.position.set(-0.2, 1.3, 0);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 1.4), new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 3, 0) })); bar.position.set(-0.2, 1.65, 0);
      scCar.add(body, cab, bar);
      for (const sx of [-1.5, 1.5]) for (const sz of [-1, 1]) { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.3, 14), new THREE.MeshStandardMaterial({ color: 0x111111 })); w.rotation.x = Math.PI / 2; w.position.set(sx, 0.36, sz * 0.95); scCar.add(w); }
      scene.add(scCar);
    }
    scCar.visible = !!(sc && sc.vis && state.tr);
    if (!scCar.visible) return;
    scCar.position.set(sc.x, Tracks.groundAt(state.tr, sc.x, sc.y), sc.y); scCar.rotation.y = -sc.h;
    scCar.children[2].material.color.setRGB(Math.floor(clock * 4) % 2 ? 5 : 0.4, Math.floor(clock * 4) % 2 ? 3 : 0.2, 0);
  }

  // Rain dims and greys the light, thickens the fog, wets the road and draws the drops.
  // rain and wet are 0..1; they are smoothed here so a shower arrives and leaves gradually.
  function applyWeather(wx, dt) {
    const B = state.base; if (!B) return;
    const r = wx ? wx.rain : 0, w = wx ? wx.wet : 0, a = Math.min(1, dt * 1.5);
    state.rainS = (state.rainS || 0) + (r - (state.rainS || 0)) * a;
    state.wetS = (state.wetS || 0) + (w - (state.wetS || 0)) * a;
    const k = state.rainS, S3 = F1.R3S.U;
    sun.intensity = B.sunI * (1 - 0.8 * k);
    hemi.intensity = B.hemi * (1 - 0.3 * k);
    S3.uSunCol.value.copy(sun.color).multiplyScalar(sun.intensity);
    S3.uFogDensity.value = B.fogD * (1 + 0.9 * k);
    S3.uFogCol.value.copy(B.fog).lerp(WX_GREY, 0.35 * k);
    if (scene.fog) { scene.fog.density = B.fogD * (1 + 0.9 * k); scene.fog.color.copy(S3.uFogCol.value); }
    if (B.bg != null) scene.backgroundIntensity = B.bg * (1 - 0.35 * k);
    S3.uWet.value = state.wetS;
    state.wxExp = 1 - 0.18 * k;
    if (state.wx) state.wx.update(k, camera, dt, clock, S3.uFogCol.value);
  }
  const WX_GREY = new THREE.Color(0.28, 0.3, 0.33);

  // Photo sky: once decoded, it becomes the background and the light probe; the sun and
  // the fog are read off the panorama so shadows and haze agree with the clouds.
  function skyReady() {
    const tex = state.sky;
    if (!tex || state.skyReady || !tex.image || !tex.image.width) return;
    state.skyReady = true;
    const L = state.look;
    if (state.hdr) { // lighting already comes from the HDR probe: the photo is only the backdrop
      scene.background = tex;
      scene.backgroundIntensity = state.hdr.bg;
      skyMesh.visible = false;
      return;
    }
    const w = 256, h = 128, c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.drawImage(tex.image, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    // horizon colour: the band just above the horizon
    let r = 0, gg = 0, b = 0, n = 0;
    for (let y = Math.floor(h * 0.44); y < Math.floor(h * 0.49); y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
    const hor = new THREE.Color().setRGB(r / n / 255, gg / n / 255, b / n / 255, THREE.SRGBColorSpace);
    scene.fog.color.copy(hor);
    hemi.color.copy(hor);
    // sun: centroid of the brightest pixels in the upper hemisphere
    const lum = [];
    for (let y = 0; y < h / 2; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; lum.push([d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11, x, y]); }
    lum.sort((a, bb) => bb[0] - a[0]);
    let sx = 0, sy = 0, sc = 0;
    for (let k = 0; k < 12; k++) { sx += Math.cos((lum[k][1] / w - 0.5) * Math.PI * 2); sy += Math.sin((lum[k][1] / w - 0.5) * Math.PI * 2); sc += lum[k][2]; }
    const phi = Math.atan2(sy, sx), el = Math.max(L.sunEl < 12 ? 6 : 14, (0.5 - (sc / 12 + 0.5) / h) * 180) * Math.PI / 180;
    state.sunDir = V(Math.cos(el) * Math.cos(phi), Math.sin(el), Math.cos(el) * Math.sin(phi));
    if (envRT) envRT.dispose();
    envRT = pmrem.fromEquirectangular(tex);
    scene.environment = envRT.texture;
    scene.background = tex;
    scene.backgroundIntensity = L.bg || 1.3;
    skyMesh.visible = false;
    for (const k in MATS) if (MATS[k].isMeshStandardMaterial) MATS[k].envMapIntensity = L.env * 1.25;
  }

  // ---------- circuit ----------
  function setTrack(tr, W2) {
    materials();
    if (state.tr === tr) return;
    if (state.root) scene.remove(state.root);
    if (F1.R3D) F1.R3D.clearDebris(scene);
    let built = state.cache.get(tr.id);
    if (!built || built.tr !== tr) { built = buildTrack(tr, W2); state.cache.set(tr.id, built); }
    state.tr = tr; state.root = built.root; state.gantry = built.gantry; state.water = built.water; state.tvCams = built.tvCams; state.grass = built.grass;
    if (state.grass) { state.grass.visible = grassOn(); F1.R3Grass.setQuality(state.grass, grassQ()); }
    if (built.turf) { F1.R3S.U.uTurf.value = built.turf.tex; F1.R3S.U.uTurfB.value.copy(built.turf.b); }
    if (built.grass && built.grass.userData.parts) { const gu = built.grass.userData.parts[0].material.userData.grass; F1.R3S.U.uGrassMask.value = gu.uGMask.value; F1.R3S.U.uGrassMaskB.value.copy(gu.uGMaskB.value); }
    {
      // turf under a clear sky is lighter and more yellow-green; under cloud, greyer and more olive
      const L0 = LOOKS[Tracks.lookOf(tr)] || LOOKS.kestrel, oc = U.smooth((L0.cloud - 0.42) / 0.3);
      F1.R3S.U.uLawnGrade.value.set(1.12 - 0.14 * oc, 1.12 - 0.12 * oc, 0.9 - 0.02 * oc, 0.28 * oc);
    }
    F1.R3S.patchTree(built.root);
    // lawn stripes along the start straight (strength 0: the reference circuits show none)
    { const hx = tr.x[3] - tr.x[0], hz = tr.y[3] - tr.y[0], l = Math.hypot(hx, hz) || 1; F1.R3S.U.uLawn.value.set(hx / l, hz / l, 10, 0); }
    scene.add(built.root);
    applyLook(Tracks.lookOf(tr));
    backdropFor(Tracks.lookOf(tr), built.root);
    applyScenery();
    applyAniso(built.root);
    clearFx();
  }

  function buildTrack(tr, W2) {
    const M = materials();
    const root = new THREE.Group();
    const N = tr.N, hw = tr.hw, style = tr.def.style, th = F1.Render.THEMES[style];
    const add = (geo, m, o = {}) => {
      if (!geo) return null;
      const mesh = new THREE.Mesh(geo, m);
      mesh.receiveShadow = o.receive !== false; mesh.castShadow = !!o.cast;
      if (o.order) mesh.renderOrder = o.order;
      root.add(mesh);
      return mesh;
    };
    const b = W2.bounds;
    const cx = (b.x0 + b.x1) / 2, cz = (b.y0 + b.y1) / 2, span = Math.max(b.x1 - b.x0, b.y1 - b.y0);

    // ground: the venue's terrain, cut and filled to meet the circuit
    const SEA = 0;
    let hgrid = null; // the fine terrain samples, kept for the grass
    let turf = null;  // the lawn's site conditions (turfMap)
    const waterZ = W2.water ? W2.water.y : null;
    {
      let gm;
      if (T.has('grass')) {
        const key = style === 'park' ? 'grass' : style === 'modern' ? 'sand' : 'pavement', rep = 36 / (style === 'modern' ? 6 : 3.2);
        gm = macro(pbr(key, rep, { color: style === 'modern' ? '#f3dcc0' : '#ffffff' }), style === 'park' ? 140 : 180, style === 'park' ? 0.22 : 0.14, 0.1, style === 'park');
      } else gm = std({ map: style === 'park' ? T.grass(th.grassA, th.grassB) : T.ground(th.ground, th.groundN), roughness: 0.97 });
      gm.userData.wetK = [0.55, 0.25];
      MATS['ground_' + style] = gm;
      const grid = (x0, z0, x1, z1, cell, fine) => {
        const nxv = Math.ceil((x1 - x0) / cell) + 1, nzv = Math.ceil((z1 - z0) / cell) + 1;
        if (fine) { hgrid = { x0, z0, cell, nx: nxv, nz: nzv, y: new Float32Array(nxv * nzv), edge: new Float32Array(nxv * nzv) }; hgrid.edge.fill(99); }
        const pos = new Float32Array(nxv * nzv * 3), uv = new Float32Array(nxv * nzv * 2), idx = new Uint32Array((nxv - 1) * (nzv - 1) * 6);
        const Yv = fine ? new Float32Array(nxv * nzv) : null, Wv = fine ? new Float32Array(nxv * nzv) : null, Bv = fine ? new Float32Array(nxv * nzv) : null;
        for (let j = 0; j < nzv; j++) for (let i = 0; i < nxv; i++) {
          const x = x0 + i * cell, z = z0 + j * cell, k = j * nxv + i;
          let y = fine ? Tracks.groundAt(tr, x, z) - 0.07 : tr.H(x, z) - 0.6;
          if (fine) Bv[k] = y; // the landform itself, before any sinking under the road (lights the turf)
          // the coarse outer ground lies under the detailed one: inside it (clear of its edge) it
          // is sunk well out of the way, or it pokes through wherever the road is cut below the terrain
          if (!fine && x > b.x0 - 220 + 100 && x < b.x1 + 220 - 100 && z > b.y0 - 220 + 100 && z < b.y1 + 220 - 100) y -= 60;
          if (fine) {
            // A 7 m grid cannot follow a road that dips or crests between its vertices: the flat
            // triangles would poke through the tarmac. Sink the ground near the road by the sag a
            // chord of this size makes (curvature x cell^2 / 8, with a margin), fading out beyond.
            let bi = -1, bd = 1e18;
            tr.hash.near(x, z, 150, q => { const dd = (x - tr.x[q]) ** 2 + (z - tr.y[q]) ** 2; if (dd < bd) { bd = dd; bi = q; } });
            if (bi >= 0) {
              const dl = (x - tr.x[bi]) * tr.nx[bi] + (z - tr.y[bi]) * tr.ny[bi];
              const sag = bd > 3600 ? 0 : Math.min(0.9, 0.1 + Math.abs(tr.ddz[bi]) * cell * cell * 0.6 + Math.abs(tr.bank[bi]) * 2);
              Wv[k] = bd < 3600 ? 1 - U.smooth((Math.abs(dl) - tr.hw) / 9) : 0;
              hgrid.edge[k] = Math.abs(dl) - tr.hw; // metres from the edge of the tarmac
              y -= sag * Wv[k];
              // A wide gravel or tarmac run-off is a ribbon in the road's own plane; out at its far
              // edge a rising hillside can stand above it and show through as bare turf. The ground
              // under the whole run-off is kept below it (and its neighbours' minimum, below).
              const sd = dl > 0 ? 1 : 0, rt = tr.runT[sd][bi];
              if (bd < 3600 && rt === F1.SURF.GRAVEL) {
                const re = tr.hw + tr.runW[sd][bi], wr = 1 - U.smooth((Math.abs(dl) - re - 0.5) / 3);
                if (wr > 0) {
                  // a quarter metre under the gravel, and never more than 1.5 m below the terrain
                  // (the surface height extrapolated far out can fall away; the ground must not)
                  const under = Math.max(Tracks.surfZ(tr, bi, dl) - 0.25, y - 1.5);
                  if (y > under) y += (under - y) * wr;
                  Wv[k] = Math.max(Wv[k], wr);
                }
              }
            }
            Yv[k] = y;
          }
          if (waterZ != null && z < waterZ - 2) y = SEA - 3;
          if (fine) y = Yv[k];
          pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
          if (fine) hgrid.y[k] = y + 0.07;
          uv[k * 2] = x / 36; uv[k * 2 + 1] = z / 36;
        }
        if (fine) {
          // Adaptive: near the road every ground point also drops to the lowest of its eight
          // neighbours (and a little more), so no triangle between them can rise above the road
          // however it slopes or banks. The road's own surface hides what is below it.
          for (let j = 0; j < nzv; j++) for (let i = 0; i < nxv; i++) {
            const k = j * nxv + i, w = Wv[k];
            if (w <= 0) continue;
            let m = Yv[k];
            for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
              const jj = j + dj, ii = i + di;
              if (jj >= 0 && jj < nzv && ii >= 0 && ii < nxv) m = Math.min(m, Yv[jj * nxv + ii]);
            }
            const y2 = Yv[k] + (m - 0.06 - Yv[k]) * w;
            if (!(waterZ != null && z0 + j * cell < waterZ - 2)) { pos[k * 3 + 1] = y2; hgrid.y[k] = y2 + 0.07; }
          }
        }
        let q = 0;
        for (let j = 0; j < nzv - 1; j++) for (let i = 0; i < nxv - 1; i++) {
          const a = j * nxv + i, b2 = a + 1, c2 = a + nxv, d2 = c2 + 1;
          idx[q++] = a; idx[q++] = c2; idx[q++] = b2; idx[q++] = b2; idx[q++] = c2; idx[q++] = d2;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        g.setIndex(new THREE.BufferAttribute(idx, 1));
        g.computeVertexNormals(); g.computeBoundingSphere();
        if (fine) {
          // The ground is sunk in places to stay under the road, kerbs and gravel; lit with those
          // facets' normals, slivers of turf would face a low sun like little walls and glare
          // white. It is lit by the landform instead (central differences of the unsunk heights).
          const nr = g.attributes.normal;
          const B = (i, j) => Bv[Math.min(nzv - 1, Math.max(0, j)) * nxv + Math.min(nxv - 1, Math.max(0, i))];
          for (let j = 0; j < nzv; j++) for (let i = 0; i < nxv; i++) {
            const gx = (B(i + 1, j) - B(i - 1, j)) / (2 * cell), gz = (B(i, j + 1) - B(i, j - 1)) / (2 * cell), l = Math.hypot(gx, 1, gz);
            nr.setXYZ(j * nxv + i, -gx / l, 1 / l, -gz / l);
          }
          nr.needsUpdate = true;
        }
        return g;
      };
      const pad = 220;
      add(grid(b.x0 - pad, b.y0 - pad, b.x1 + pad, b.y1 + pad, 7, true), gm);
      turf = turfMap(hgrid, tr);
      const size = span + 9000;
      add(grid(cx - size / 2, cz - size / 2, cx + size / 2, cz + size / 2, 90, false), gm);
    }
    // water for the harbour circuit
    let water = null;
    if (W2.water) {
      const wy = W2.water.y;
      const g = new THREE.PlaneGeometry(span + 9000, 6000);
      g.rotateX(-Math.PI / 2); g.translate(cx, SEA, wy - 3000);
      water = add(g, M.water);
      const qh = Math.max(3, tr.H(cx, wy) + 1.5);
      const q = new THREE.BoxGeometry(span + 9000, qh + 3, 4); q.translate(cx, SEA - 3 + (qh + 3) / 2, wy - 1);
      add(q, M.concrete, { cast: false });
      // boats
      const hull = new Batch(true), cabin = new Batch(true), mast = new Batch(false);
      const hs = new THREE.Shape(); [[-0.5, -0.5], [0.25, -0.5], [0.5, 0], [0.25, 0.5], [-0.5, 0.5]].forEach(([x, y], k) => (k ? hs.lineTo(x, y) : hs.moveTo(x, y)));
      const hg = new THREE.ExtrudeGeometry(hs, { depth: 1.5, bevelEnabled: false }); hg.rotateX(-Math.PI / 2);
      const cb = new THREE.BoxGeometry(1, 1, 1);
      const mg = new THREE.CylinderGeometry(0.06, 0.08, 1, 5); mg.translate(0, 0.5, 0);
      const rnd = U.rng(77);
      for (const it of W2.decor) {
        if (it.type !== 'boat') continue;
        const l = it.l, w = l * 0.32, ry = -it.h;
        hull.add(hg, mat(it.x, SEA - 0.4, it.y, ry, l, 1, w), col(it.col));
        cabin.add(cb, mat(it.x - Math.cos(it.h) * l * 0.05, SEA + 0.9, it.y - Math.sin(it.h) * l * 0.05, ry, l * 0.36, 1.1, w * 0.62), col(rnd() < 0.5 ? '#e9ecef' : '#c9ced4'));
        if (rnd() < 0.4) mast.add(mg, mat(it.x, SEA + 0.4, it.y, 0, 1, l * 0.9, 1));
      }
      add(hull.geo(), M.vcol, { cast: true }); add(cabin.geo(), M.vcol, { cast: true }); add(mast.geo(), M.white);
    }

    // run-off: gravel traps and tarmac, per side
    {
      const gr = new Acc(), ta = new Acc(), ve = new Acc();
      for (const side of [0, 1]) {
        const sg = side ? 1 : -1;
        for (const t of [SURF.GRAVEL, SURF.TARMAC, SURF.GRASS]) {
          const acc = t === SURF.GRAVEL ? gr : t === SURF.TARMAC ? ta : ve;
          if (t === SURF.GRASS && style === 'park') continue;
          for (const [i0, i1] of runs(N, k => tr.runT[side][k] === t)) {
            const fa = k => (sg < 0 ? -(hw + tr.runW[side][k]) : hw - 0.3);
            const fb = k => (sg < 0 ? -hw + 0.3 : hw + tr.runW[side][k]);
            ribbon(acc, tr, i0, i1, fa, fb, t === SURF.GRAVEL ? -0.035 : -0.02, 10);
          }
        }
        // street circuits: tarmac right up to the wall
        if (style === 'street') {
          const fa = k => (sg < 0 ? -(tr.barr[0][k] + 0.2) : hw - 0.3), fb = k => (sg < 0 ? -hw + 0.3 : tr.barr[1][k] + 0.2);
          ribbon(ta, tr, 0, N, fa, fb, -0.025, 10);
        }
      }
      add(gr.geo(), M.gravel);
      { const tm = std({ map: T.runoff(th.runoff), roughness: 0.85 }); tm.userData.wetK = [1, 1]; add(ta.geo(), tm); }
      add(ve.geo(), T.has('grass') ? macro(pbr('grass', 10 / 3.2), 140, 0.22, 0.1, true) : std({ map: T.grass(th.grassA, th.grassB), roughness: 0.97 }));
    }

    // asphalt, rubber line, pit lane
    {
      const a = new Acc();
      ribbon(a, tr, 0, N, () => -hw, () => hw, 0, 9);
      const ag = a.geo();
      // track coordinates for the wear shader (two vertices per sample, edge to edge):
      // distance along the lap, lateral offset, racing line offset, and the load there,
      // from the sharpest curvature within 120 m ahead (braking zones and the corner itself)
      {
        const trk = new Float32Array((N + 1) * 2 * 4), look = Math.round(120 / tr.ds), load = new Float32Array(N);
        for (let k = 0; k < N; k++) { let m = 0; for (let q = -6; q <= look; q++) m = Math.max(m, Math.abs(tr.kap[(k + q + N) % N])); load[k] = Math.min(1, m * 55); }
        for (let i = 0; i <= N; i++) {
          const k = i % N, lo = tr.line ? tr.line.off[k] : 0;
          trk.set([i * tr.ds, -hw, lo, load[k], i * tr.ds, hw, lo, load[k]], i * 8);
        }
        ag.setAttribute('trk', new THREE.Float32BufferAttribute(trk, 4));
      }
      add(ag, M.asphalt);
      const p = new Acc(), L2 = tr.pit.lane / 2;
      for (const [i0, i1] of runs(N, k => !isNaN(tr.pit.off[k]))) ribbon(p, tr, i0, i1 - 1, k => tr.pit.off[k] - L2, k => tr.pit.off[k] + L2, -0.006, 9);
      add(p.geo(), M.pitlane);
    }

    // painted lines: edges, pit lane, start, grid, DRS, pit boxes
    {
      const pa = new Acc(true), white = col('#f2f3f4');
      ribbon(pa, tr, 0, N, () => -hw + 0.05, () => -hw + 0.32, 0.012, 9, white);
      ribbon(pa, tr, 0, N, () => hw - 0.32, () => hw - 0.05, 0.012, 9, white);
      const L2 = tr.pit.lane / 2;
      for (const [i0, i1] of runs(N, k => !isNaN(tr.pit.off[k]))) {
        ribbon(pa, tr, i0, i1 - 1, k => tr.pit.off[k] - L2 + 0.05, k => tr.pit.off[k] - L2 + 0.3, 0.008, 9, white);
        ribbon(pa, tr, i0, i1 - 1, k => tr.pit.off[k] + L2 - 0.3, k => tr.pit.off[k] + L2 - 0.05, 0.008, 9, white);
      }
      const quad = (s0, s1, d0, d1, c, y = 0.012) => {
        const q1 = Tracks.pointAt(tr, s0, d0), q2 = Tracks.pointAt(tr, s0, d1), q3 = Tracks.pointAt(tr, s1, d1), q4 = Tracks.pointAt(tr, s1, d0);
        const yy = q => y + Tracks.groundAt(tr, q[0], q[1]);
        const k = pa.v(q1[0], yy(q1), q1[1], 0, 1, 0, 0, 0, c);
        pa.v(q2[0], yy(q2), q2[1], 0, 1, 0, 0, 0, c); pa.v(q3[0], yy(q3), q3[1], 0, 1, 0, 0, 0, c); pa.v(q4[0], yy(q4), q4[1], 0, 1, 0, 0, 0, c);
        pa.t(k, k + 1, k + 2); pa.t(k, k + 2, k + 3);
      };
      for (let k = 0; k < 20; k++) {
        const g = tr.grid[k];
        quad(g.s + 2.75, g.s + 2.9, g.d - 1.15, g.d + 1.15, white);
        quad(g.s + 1.9, g.s + 2.9, g.d - 1.15, g.d - 1.0, white);
        quad(g.s + 1.9, g.s + 2.9, g.d + 1.0, g.d + 1.15, white);
      }
      for (const z of tr.drs) for (const s of [z.act, z.det]) for (let k = 0; k < 8; k++) {
        const d0 = -hw + (k + 0.25) * tr.w / 8;
        quad(s, s + 0.2, d0, d0 + tr.w / 16, white);
      }
      // pit boxes in team colours
      for (const it of W2.decor) {
        if (it.type !== 'box') continue;
        const c = col(it.team.base === '#121417' ? '#d8b45a' : it.team.base);
        const ch = Math.cos(it.h), sh = Math.sin(it.h);
        const rect = (x0, x1, z0, z1, cc) => {
          const P = (lx, lz) => [it.x + ch * lx - sh * lz, it.y + sh * lx + ch * lz];
          const ps = [P(x0, z0), P(x0, z1), P(x1, z1), P(x1, z0)];
          const k = pa.v(ps[0][0], 0.008 + Tracks.groundAt(tr, ps[0][0], ps[0][1]), ps[0][1], 0, 1, 0, 0, 0, cc);
          for (let q = 1; q < 4; q++) pa.v(ps[q][0], 0.008 + Tracks.groundAt(tr, ps[q][0], ps[q][1]), ps[q][1], 0, 1, 0, 0, 0, cc);
          pa.t(k, k + 1, k + 2); pa.t(k, k + 2, k + 3);
        };
        rect(-3.2, 3.2, -1.4, -1.25, c); rect(-3.2, 3.2, 1.25, 1.4, c); rect(-3.2, -3.05, -1.4, 1.4, c); rect(3.05, 3.2, -1.4, 1.4, c);
        rect(-1.75, -1.57, -1.0, 1.0, white); rect(1.55, 1.73, -1.0, 1.0, white);
      }
      add(pa.geo(), M.paint, { receive: true });
      // chequered start line
      const ck = new Acc();
      const s0 = -0.8, s1 = 0.8;
      for (const [s, v] of [[s0, 0], [s1, 1]]) for (const d of [-hw, hw]) {
        const q = Tracks.pointAt(tr, s, d);
        ck.v(q[0], 0.014 + Tracks.groundAt(tr, q[0], q[1]), q[1], 0, 1, 0, (d + hw) / 6.4, v, null);
      }
      ck.t(0, 1, 2); ck.t(1, 3, 2);
      add(ck.geo(), std({ map: T.checker(), roughness: 0.6 }));
    }

    // kerbs: raised, red and white in 2 m blocks
    {
      const kb = new Acc(true), red = col('#d0202a'), wht = col('#f1f1f1');
      for (const side of [0, 1]) {
        const sg = side ? 1 : -1, arr = side ? tr.kerbR : tr.kerbL, kw = tr.kerbW;
        const prof = [[-0.05, 0.0], [0.3 * kw, 0.06], [kw - 0.1, 0.06], [kw, 0.0]];
        for (let i = 0; i < N; i++) {
          if (!arr[i]) continue;
          const c = (Math.floor(i / 1) % 2) ? red : wht;
          const j = (i + 1) % N;
          const base = kb.k;
          for (const [kk, u] of [[i, i * tr.ds / 1.5], [j, (i + 1) * tr.ds / 1.5]]) for (const [dd, yy] of prof) {
            const d = sg * (hw + dd);
            kb.v(tr.x[kk] + tr.nx[kk] * d, Tracks.surfZ(tr, kk, d) + (yy > 0 ? 0.004 : 0.002), tr.y[kk] + tr.ny[kk] * d, 0, 1, 0, u, dd / 1.5, c);
          }
          for (let q = 0; q < 3; q++) { kb.t(base + q, base + q + 1, base + 4 + q); kb.t(base + q + 1, base + 5 + q, base + 4 + q); }
        }
      }
      const g = kb.geo();
      if (g) { g.computeVertexNormals(); add(g, M.kerb); }
    }

    // barriers
    {
      const conc = new Acc(), ad = new Acc(), arm = new Acc(), tyr = new Acc(), fen = new Acc(), posts = new Batch(false);
      const pit = tr.pit, ps = pit.side > 0 ? 1 : 0;
      const gz0 = (pit.boxS[9] - 16 + tr.L) % tr.L, gz1 = (pit.boxS[0] + 16) % tr.L;
      const garageZone = k => !isNaN(pit.off[k]) && Tracks.inRange(tr, k * tr.ds, gz0, gz1);
      const mainStraight = k => { const s = k * tr.ds; return s < 260 || s > tr.L - 320; };
      const postG = new THREE.BoxGeometry(0.12, 1, 0.12);
      const fenceH = 4.2;
      for (const side of [0, 1]) {
        const sg = side ? 1 : -1;
        const skip = k => side === ps && garageZone(k);
        const d = k => sg * (tr.barr[side][k] + 0.45);
        // concrete (street, modern, every main straight) or armco
        const isConc = k => style !== 'park' || mainStraight(k);
        for (const [i0, i1] of runs(N, k => !skip(k) && isConc(k))) {
          wallRun(style === 'park' ? conc : ad, tr, i0, i1, d, -0.07, 1.05, style === 'park' ? 8 : 14, 1.12, 0.55);
          wallRun(fen, tr, i0, i1, k => d(k) + sg * 0.45, 1.05, fenceH, 1.6, 1.6, 0);
          for (let i = i0; i <= i1; i += 3) { const k = mod(i, N), dd = d(k) + sg * 0.5; posts.add(postG, mat(tr.x[k] + tr.nx[k] * dd, Tracks.surfZ(tr, k, dd) + 1.05 + (fenceH - 1.05) / 2, tr.y[k] + tr.ny[k] * dd, 0, 1, fenceH - 1.05, 1)); }
        }
        if (style === 'park') {
          for (const [i0, i1] of runs(N, k => !skip(k) && !isConc(k))) {
            wallRun(arm, tr, i0, i1, d, 0.42, 0.95, 4, 0.53, 0);
            for (let i = i0; i <= i1; i += 2) { const k = mod(i, N), dd = d(k) + sg * 0.12; posts.add(postG, mat(tr.x[k] + tr.nx[k] * dd, Tracks.surfZ(tr, k, dd) + 0.45, tr.y[k] + tr.ny[k] * dd, 0, 1, 0.95, 1)); }
          }
          // catch fence behind gravel traps
          for (const [i0, i1] of runs(N, k => !skip(k) && !isConc(k) && tr.runT[side][k] === SURF.GRAVEL)) {
            wallRun(fen, tr, i0, i1, k => d(k) + sg * 1.4, 0, fenceH, 1.6, 1.6, 0);
            for (let i = i0; i <= i1; i += 3) { const k = mod(i, N), dd = d(k) + sg * 1.45; posts.add(postG, mat(tr.x[k] + tr.nx[k] * dd, Tracks.surfZ(tr, k, dd) + fenceH / 2, tr.y[k] + tr.ny[k] * dd, 0, 1, fenceH, 1)); }
          }
        }
        // tyre walls in front of the barrier at gravel traps
        for (const [i0, i1] of runs(N, k => !skip(k) && tr.runT[side][k] === SURF.GRAVEL)) wallRun(tyr, tr, i0, i1, k => sg * (tr.barr[side][k] - 0.5), -0.05, 0.95, 4, 1.0, 0.9);
      }
      // pit wall with fence
      for (const [i0, i1] of runs(N, k => !isNaN(pit.wall[k]))) {
        const d = k => pit.side * (pit.wall[k] + 0.1);
        wallRun(ad, tr, i0, i1 - 1, d, -0.07, 1.1, 14, 1.12, 0.6);
        wallRun(fen, tr, i0, i1 - 1, k => d(k) + pit.side * 0.3, 1.1, 3.6, 1.6, 1.6, 0);
      }
      add(conc.geo(), M.concrete, { cast: true }); add(ad.geo(), M.adwall, { cast: true });
      add(arm.geo(), M.armco, { cast: true }); add(tyr.geo(), M.tyres, { cast: true });
      add(fen.geo(), M.fence, { cast: false });
      add(posts.geo(), M.steel, { cast: true });
    }

    // pit complex: garages, pit building
    {
      const shell = new Batch(false), paint = new Batch(true), dark = new Batch(false);
      const pit = tr.pit;
      const box = new THREE.BoxGeometry(1, 1, 1);
      for (const it of W2.decor) {
        if (it.type !== 'garage') continue;
        const f = pit.side > 0 ? -1 : 1; // local z of the face that looks onto the pit lane
        const ry = -it.h;
        const P = (lx, lz) => [it.x + Math.cos(it.h) * lx - Math.sin(it.h) * lz, it.y + Math.sin(it.h) * lx + Math.cos(it.h) * lz];
        const [x0, z0] = P(0, 0);
        const gy = Tracks.groundAt(tr, x0, z0);
        shell.add(facadeBox(it.w, 6.8, it.d, 3, 3), mat(x0, 2.9 + gy - 0.5, z0, ry));
        const [x1, z1] = P(0, f * (it.d / 2 + 0.02));
        dark.add(box, mat(x1, 2.0 + gy, z1, ry, it.w - 1.2, 4.0, 0.05));
        const [x2, z2] = P(0, f * (it.d / 2 + 0.08));
        paint.add(box, mat(x2, 4.75 + gy, z2, ry, it.w, 1.3, 0.12), col(it.team.base));
        paint.add(box, mat(x2, 4.2 + gy, z2, ry, it.w, 0.18, 0.14), col(it.team.accent));
      }
      add(shell.geo(), venueMats().clad, { cast: true }); add(dark.geo(), M.interior); add(paint.geo(), M.vcolMetal, { cast: false });
      for (const it of W2.decor) {
        if (it.type !== 'poly') continue;
        const sh = new THREE.Shape(it.pts.map(p => new THREE.Vector2(p[0], -p[1])));
        const hgt = 13;
        const g = new THREE.ExtrudeGeometry(sh, { depth: hgt, bevelEnabled: false });
        g.rotateX(-Math.PI / 2);
        // roof: painted metal deck; sides: glass curtain wall (dielectric, near-mirror)
        const m = [std({ color: '#c9cdd2', roughness: 0.45, metalness: 0 }), T.has('glass') ? pbr('glass', 1 / 15, { envMapIntensity: 1.4 }) : std({ map: repTex(T.windows(), 1 / 30, 1 / 26), roughness: 0.08, metalness: 0, envMapIntensity: 1.4 })];
        const mesh = new THREE.Mesh(g, m);
        mesh.castShadow = true; mesh.receiveShadow = true;
        mesh.position.y = Tracks.groundAt(tr, it.x, it.y) - 1.5; // sunk so it meets sloping ground
        mesh.scale.y = (hgt + 1.5) / hgt;
        root.add(mesh);
      }
    }

    // Every part of the venue is tagged with a category (userData.cat) so the scenery setting
    // can thin or hide it as a whole: road and ground stay; stands, buildings, trees, boards...
    let mark = 0;
    const tag = cat => { for (let i = mark; i < root.children.length; i++) root.children[i].userData.cat = cat; mark = root.children.length; };
    tag('base');
    // grandstands
    {
      const conc = new Batch(false), crowd = new Batch(false), roof = new Batch(false), steel = new Batch(false), fascia = new Batch(true);
      const box = new THREE.BoxGeometry(1, 1, 1);
      // seating slope: local x along the track, rising away from it (+z)
      const slope = new THREE.PlaneGeometry(28, Math.hypot(12, 8.5));
      slope.rotateX(-Math.PI / 2 - Math.atan2(8.5, 12)); slope.translate(0, 5.6, 0);
      const suv = slope.attributes.uv; for (let k = 0; k < suv.count; k++) suv.setXY(k, suv.getX(k) * 2, suv.getY(k) * 0.95);
      const sideS = new THREE.Shape([new THREE.Vector2(-6, 0), new THREE.Vector2(6.3, 0), new THREE.Vector2(6.3, 10.5), new THREE.Vector2(-6, 1.4)]);
      const side = new THREE.ExtrudeGeometry(sideS, { depth: 0.35, bevelEnabled: false });
      side.rotateY(Math.PI / 2); // shape x -> -z, extrusion -> +x
      const col0 = new THREE.CylinderGeometry(0.18, 0.18, 1, 6);
      const ads = ['#c8102e', '#0b1f3a', '#0e8f86', '#16224a', '#f2c230'];
      let n = 0;
      for (const it of W2.decor) {
        if (it.type !== 'stand') continue;
        const ry = -it.h + (it.side > 0 ? 0 : Math.PI);
        const base = new THREE.Matrix4().compose(V(it.x, Tracks.groundAt(tr, it.x, it.y), it.y), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), V(1, 1, 1));
        const at = m => base.clone().multiply(m);
        crowd.add(slope, base);
        conc.add(box, at(mat(0, 0.7, -6.1, 0, 28, 1.4, 0.3)));
        conc.add(box, at(mat(0, 5.4, 6.4, 0, 28, 10.8, 0.4)));
        conc.add(side, at(mat(-14.2, 0, 0)));
        conc.add(side, at(mat(13.85, 0, 0)));
        roof.add(box, at(mat(0, 13.2, 2.0, 0, 29.5, 0.35, 10, -0.06)));
        for (const x of [-12, -4, 4, 12]) steel.add(col0, at(mat(x, 6.6, 6.2, 0, 1, 13.2, 1)));
        fascia.add(box, at(mat(0, 12.6, -3.0, 0, 29.5, 1.0, 0.25, -0.06)), col(ads[n++ % ads.length]));
      }
      add(conc.geo(), M.standShell || (M.standShell = T.has('concrete') ? pbr('concrete', 4, { color: '#9da2a8' }) : std({ color: '#6d727a', roughness: 0.8 })), { cast: true }); add(crowd.geo(), M.crowd, { cast: false });
      add(roof.geo(), M.white, { cast: true }); add(steel.geo(), M.steel, { cast: true }); add(fascia.geo(), M.vcol);
    }

    tag('stands');
    // city blocks (street circuit)
    {
      const walls = new Batch(true), roofs = new Batch(true);
      const kinds = T.has('glass') ? [['office', 28, new Batch(false)], ['glass', 15, new Batch(false)], ['glasslit', 15, new Batch(false)]] : [];
      const tints = ['#f2e6d0', '#e8d2b0', '#f6efe4', '#e4c8a8', '#d9c3a5', '#efe1cf', '#e9d9c2'];
      for (const it of W2.decor) {
        if (it.type !== 'building') continue;
        const r = U.rng(it.seed);
        const hgt = 10 + r() * 26 + (r() < 0.12 ? 25 : 0);
        const pick = r();
        if (kinds.length && pick > 0.45) {
          // modern blocks: office bands or glass, the taller ones more often glass
          const [, tile, bt] = kinds[pick > 0.85 ? 2 : hgt > 26 && pick > 0.6 ? 1 : 0];
          const gy0 = Tracks.groundAt(tr, it.x, it.y) - 3;
          bt.add(facadeBox(it.w, hgt + 3, it.h, tile, tile), mat(it.x, (hgt + 3) / 2 + gy0, it.y));
          const rf0 = new THREE.BoxGeometry(it.w + 0.6, 0.6, it.h + 0.6); rf0.translate(it.x, hgt + 3 + gy0, it.y);
          roofs.add(rf0, null, col(it.col));
          continue;
        }
        const g = new THREE.BoxGeometry(it.w, hgt, it.h);
        const uv = g.attributes.uv, pos = g.attributes.position, nor = g.attributes.normal;
        for (let k = 0; k < uv.count; k++) {
          const nx = Math.abs(nor.getX(k)), nz = Math.abs(nor.getZ(k));
          const along = nx > 0.5 ? pos.getZ(k) : nz > 0.5 ? pos.getX(k) : pos.getX(k);
          uv.setXY(k, along / 14 + (it.seed % 4) / 4, (pos.getY(k) + hgt / 2) / 14); // 4 bays x 4 floors per 14 m tile
        }
        const gy = Tracks.groundAt(tr, it.x, it.y) - 3; // foundations below sloping streets
        g.scale(1, (hgt + 3) / hgt, 1);
        g.translate(it.x, (hgt + 3) / 2 + gy, it.y);
        walls.add(g, null, col(tints[Math.floor(r() * tints.length)]));
        const rf = new THREE.BoxGeometry(it.w + 0.6, 0.6, it.h + 0.6); rf.translate(it.x, hgt + 3 + gy, it.y);
        roofs.add(rf, null, col(it.col));
      }
      add(walls.geo(), T.has('facade') ? pbr('facade', 1, { vertexColors: true }) : std({ map: repTex(T.windows(), 1, 1), vertexColors: true, roughness: 0.75 }), { cast: true });
      add(roofs.geo(), M.roofs || (M.roofs = std({ vertexColors: true, roughness: 0.8, normalMap: T.has('concrete_n') ? T.photo('concrete_n', 1, false) : null })), { cast: true });
      const VMc = venueMats(), kindMat = { office: VMc.office, glass: VMc.glass, glasslit: VMc.lit };
      for (const [k, , bt] of kinds) add(bt.parts.length ? bt.geo() : null, kindMat[k], { cast: true });
    }

    tag('city');
    // car parks
    for (const it of W2.decor) {
      if (it.type !== 'lot') continue;
      const g = new THREE.PlaneGeometry(it.w, it.h); g.rotateX(-Math.PI / 2); g.translate(it.x, Tracks.groundAt(tr, it.x, it.y) + 0.02, it.y);
      const uv = g.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * it.w / 30, uv.getY(k) * it.h / 30);
      add(g, M.lot);
    }

    tag('lots');
    buildTrees(root, W2, tr); tag('trees');
    const venue = buildVenue(root, tr, W2); tag('venue');
    const grass = F1.R3Grass && hgrid ? F1.R3Grass.build(tr, W2, hgrid, venue, { root, renderer, ground: MATS['ground_' + style] }) : null;
    if (grass) root.add(grass);
    tag('grass');
    const gantry = buildGantry(root, tr); tag('gantry');
    buildBoards(root, W2, tr); tag('boards');
    buildBackdrop(root, W2);
    const tvCams = buildTvCams(tr);
    return { tr, root, gantry, water, tvCams, grass, turf };
  }

  // The turf map: what the ground does to the grass at each 7 m terrain sample.
  // r, dryness of the site (0.5 neutral): water runs off crests and collects in hollows (the
  // terrain's curvature over 14 m), steeper ground drains faster, and slopes turned toward the
  // venue's sun dry out sooner than those turned away. g, wear: the first five metres of grass
  // beside the tarmac, where cars run wide.
  function turfMap(hg, tr) {
    const { nx, nz, cell, y } = hg, data = new Uint8Array(nx * nz * 4);
    const L = LOOKS[Tracks.lookOf(tr)] || LOOKS.kestrel, el = L.sunEl * Math.PI / 180, az = L.sunAz * Math.PI / 180;
    const sx = Math.cos(el) * Math.cos(az), sz = Math.cos(el) * Math.sin(az);
    const Y = (i, j) => y[U.clamp(j, 0, nz - 1) * nx + U.clamp(i, 0, nx - 1)];
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, h = Y(i, j);
      const lap = (Y(i - 2, j) + Y(i + 2, j) + Y(i, j - 2) + Y(i, j + 2)) / 4 - h; // > 0 in a hollow
      const gx = (Y(i + 1, j) - Y(i - 1, j)) / (2 * cell), gz = (Y(i, j + 1) - Y(i, j - 1)) / (2 * cell);
      const slope = Math.hypot(gx, gz), sun = -(gx * sx + gz * sz); // > 0 facing the sun
      const d = U.clamp(-lap / 0.45 * 0.55 + slope * 1.6 + sun * 2.2, -1, 1);
      data[k * 4] = Math.round((0.5 + 0.5 * d) * 255);
      const e = hg.edge[k];
      data[k * 4 + 1] = e > -1 && e < 6 ? Math.round((1 - U.smooth(e / 6)) * 255) : 0;
      data[k * 4 + 2] = Math.round(U.clamp(e, 0, 255)); // metres from the tarmac edge, for the mowing stripes
      data[k * 4 + 3] = 255;
    }
    const t = new THREE.DataTexture(data, nx, nz, THREE.RGBAFormat);
    t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
    return { tex: t, b: new THREE.Vector4(hg.x0 - cell / 2, hg.z0 - cell / 2, nx * cell, nz * cell) };
  }

  // trees, conifers and palms, instanced and split into tiles so they cull
  function buildTrees(root, W2, tr) {
    const M = materials();
    const conifer = Tracks.treesOf(tr) === 'fir';
    const crownG = new THREE.IcosahedronGeometry(1, 1);
    {
      const p = crownG.attributes.position, r = U.rng(3);
      const seen = new Map();
      for (let k = 0; k < p.count; k++) {
        const key = p.getX(k).toFixed(3) + p.getY(k).toFixed(3) + p.getZ(k).toFixed(3);
        let j = seen.get(key); if (j == null) { j = 0.82 + r() * 0.36; seen.set(key, j); }
        p.setXYZ(k, p.getX(k) * j, p.getY(k) * j * 0.85, p.getZ(k) * j);
      }
      crownG.computeVertexNormals();
    }
    let coneG = new THREE.ConeGeometry(1, 2.8, 7); coneG.translate(0, 1.4, 0);
    let crownCards = null, crownMat = M.foliage, coneMat = M.foliage;
    if (T.has('leaves')) {
      // Foliage cards: leaf-cluster quads scattered through a unit sphere, normals bent
      // outward from the centre so the crown shades like a volume, not like flat planes.
      const b = new Batch(false), r = U.rng(17);
      for (let k = 0; k < 8; k++) {
        const g = new THREE.PlaneGeometry(1.35, 1.35);
        const u = r() * 2 - 1, a = r() * Math.PI * 2, rr = 0.48 * Math.cbrt(r());
        const cx = Math.sqrt(1 - u * u) * Math.cos(a) * rr, cy = u * rr * 0.8, cz = Math.sqrt(1 - u * u) * Math.sin(a) * rr;
        b.add(g, mat(cx, cy, cz, r() * Math.PI * 2, 1, 1, 1, (r() - 0.5) * 1.6, (r() - 0.5) * 0.8));
      }
      crownCards = b.geo();
      const p = crownCards.attributes.position, nn = crownCards.attributes.normal;
      for (let k = 0; k < p.count; k++) {
        const v = V(p.getX(k), p.getY(k) + 0.25, p.getZ(k)).normalize();
        nn.setXYZ(k, v.x, v.y, v.z);
      }
      // leaves are waxy (roughness ~0.6) and translucent: a little of the albedo is added as
      // emission so backlit crowns glow green instead of going black
      crownMat = std({ map: T.photo('leaves'), alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.62, emissive: '#ffffff', emissiveMap: T.photo('leaves'), emissiveIntensity: 0.12 });
      // conifer: three crossed vertical cards
      const cb = new Batch(false);
      for (let k = 0; k < 3; k++) { const g = new THREE.PlaneGeometry(1, 2.8); g.translate(0, 1.4, 0); cb.add(g, mat(0, 0, 0, k * Math.PI / 3)); }
      coneG = cb.geo();
      const cp = coneG.attributes.position, cn = coneG.attributes.normal;
      for (let k = 0; k < cp.count; k++) { const v = V(cp.getX(k), 0.6, cp.getZ(k)).normalize(); cn.setXYZ(k, v.x, v.y, v.z); }
      coneMat = std({ map: T.photo('conifer'), alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.7, emissive: '#ffffff', emissiveMap: T.photo('conifer'), emissiveIntensity: 0.08 });
      M.bark.map = T.photo('bark', [1, 3]); M.bark.color.set('#b7a894'); M.bark.needsUpdate = true;
    }
    const trunkG = new THREE.CylinderGeometry(0.14, 0.22, 1, 5); trunkG.translate(0, 0.5, 0);
    const palmTrunk = new THREE.CylinderGeometry(0.17, 0.26, 1, 6); palmTrunk.translate(0, 0.5, 0);
    const fronds = (() => {
      const b = new Batch(false);
      for (let k = 0; k < 8; k++) {
        const a = k / 8 * Math.PI * 2;
        const g = new THREE.PlaneGeometry(3.8, 0.7, 4, 1);
        const p = g.attributes.position;
        for (let q = 0; q < p.count; q++) { const x = p.getX(q) + 1.9; p.setXYZ(q, x, -0.09 * x * x + 0.35 * x, p.getY(q) * (1 - x / 4.5)); }
        g.computeVertexNormals();
        b.add(g, mat(0, 0, 0, a, 1, 1, 1, 0, 0));
      }
      return b.geo();
    })();
    const tiles = new Map();
    let items = W2.decor.filter(it => it.type === 'tree' || it.type === 'palm');
    // scanned-model impostors (js/r3-trees.js) when their atlases are present
    if (F1.R3Trees && F1.R3Trees.available() && F1.R3Trees.build(root, tr, items.filter(it => it.type === 'tree'))) items = items.filter(it => it.type === 'palm');
    const step = Math.max(1, Math.ceil(items.length / 9000));
    const rnd = U.rng(91);
    for (let n = 0; n < items.length; n += step) {
      const it = items[n];
      const key = Math.floor(it.x / 450) + ',' + Math.floor(it.y / 450);
      let t = tiles.get(key); if (!t) tiles.set(key, t = []);
      t.push(it);
    }
    const tmp = new THREE.Object3D(), c = new THREE.Color();
    for (const list of tiles.values()) {
      // shuffled, so a thinned tile (scenery setting) keeps a random share spread over it
      for (let k = list.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [list[k], list[j]] = [list[j], list[k]]; }
      const trees = list.filter(i => i.type === 'tree'), palms = list.filter(i => i.type === 'palm');
      if (trees.length) {
        const trunks = new THREE.InstancedMesh(trunkG, M.bark, trees.length);
        const crowns = new THREE.InstancedMesh(conifer ? coneG : crownCards || crownG, conifer ? coneMat : crownMat, trees.length);
        trees.forEach((it, k) => {
          const R = it.r * 0.75, cone = conifer;
          const th = cone ? R * 0.7 : R * 1.1;
          const tw = crownCards ? R * 0.55 : R * 1.4;
          const gy = Tracks.groundAt(tr, it.x, it.y);
          tmp.position.set(it.x, gy - 0.3, it.y); tmp.rotation.set(0, rnd() * 6.28, 0); tmp.scale.set(tw, th + R * 0.5 + 0.3, tw); tmp.updateMatrix();
          trunks.setMatrixAt(k, tmp.matrix);
          if (cone) { tmp.position.set(it.x, th * 0.6 + gy, it.y); tmp.scale.set(R * 0.75, R * 1.2, R * 0.75); }
          else { tmp.position.set(it.x, th + R * 0.65 + gy, it.y); const sc = crownCards ? R * 1.75 : R; tmp.scale.set(sc, sc * 0.92, sc); }
          tmp.updateMatrix();
          crowns.setMatrixAt(k, tmp.matrix);
          if (crownCards) c.setHSL(0.22 + (rnd() - 0.5) * 0.06, 0.25, 0.62 + (rnd() - 0.5) * 0.22);
          else c.set(it.c || '#3c6a2c').offsetHSL((rnd() - 0.5) * 0.03, 0, (rnd() - 0.5) * 0.08);
          crowns.setColorAt(k, c);
        });
        for (const m of [trunks, crowns]) { m.castShadow = true; m.receiveShadow = true; m.computeBoundingSphere(); m.userData.dens = trees.length; root.add(m); }
      }
      if (palms.length) {
        const trunks = new THREE.InstancedMesh(palmTrunk, M.bark, palms.length);
        const tops = new THREE.InstancedMesh(fronds, M.palm, palms.length);
        palms.forEach((it, k) => {
          const h = 7 + it.r * 0.9;
          const gy = Tracks.groundAt(tr, it.x, it.y);
          tmp.position.set(it.x, gy - 0.3, it.y); tmp.rotation.set(0, it.a, 0); tmp.scale.set(1, h + 0.3, 1); tmp.updateMatrix();
          trunks.setMatrixAt(k, tmp.matrix);
          tmp.position.set(it.x, h - 0.2 + gy, it.y); tmp.scale.set(1, 1, 1); tmp.updateMatrix();
          tops.setMatrixAt(k, tmp.matrix);
        });
        for (const m of [trunks, tops]) { m.castShadow = true; m.receiveShadow = true; m.computeBoundingSphere(); m.userData.dens = palms.length; root.add(m); }
      }
    }
  }

  // ---------- venue buildings ----------
  // A box whose UVs are in tiles of real size (tu metres across, tv metres up), so a facade
  // photo keeps its true scale on any building: floors stay 3.5 m, panels stay panels.
  function facadeBox(w, h, d, tu, tv) {
    const g = new THREE.BoxGeometry(w, h, d);
    const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
    for (let k = 0; k < uv.count; k++) {
      const x = p.getX(k) + w / 2, y = p.getY(k) + h / 2, z = p.getZ(k) + d / 2;
      if (Math.abs(n.getX(k)) > 0.5) uv.setXY(k, z / tu, y / tv);
      else if (Math.abs(n.getZ(k)) > 0.5) uv.setXY(k, x / tu, y / tv);
      else uv.setXY(k, x / tu, z / tu);
    }
    return g;
  }
  let VM = null;
  function venueMats() {
    if (VM) return VM;
    const M = materials(), has = T.has('glass');
    VM = {
      glass: has ? pbr('glass', 1, { envMapIntensity: 1.4 }) : std({ map: repTex(T.windows(), 1, 1), roughness: 0.1 }),
      office: has ? pbr('office', 1, { envMapIntensity: 1.2 }) : std({ map: repTex(T.windows(), 1, 1), roughness: 0.4 }),
      lit: has ? pbr('glasslit', 1, { envMapIntensity: 1.3 }) : std({ map: repTex(T.windows(), 1, 1), roughness: 0.1 }),
      clad: has ? pbr('clad', 1, { color: '#e4e7eb' }) : M.white,
      roof: M.standShell || M.concrete,
    };
    if (has) VM.clad.normalScale.set(1.4, 1.4);
    return VM;
  }

  // Paddock and hospitality buildings behind the garages, a race-control tower at the head
  // of the pit lane and a sponsor footbridge over the start straight. Everything is placed
  // from the circuit's own geometry (so procedural venues get it too) and only where it
  // stays clear of the track, the stands and the other buildings. Returns the footprints.
  function buildVenue(root, tr, W2) {
    const M = materials(), VMt = venueMats();
    const pit = tr.pit, foot = [];
    const blocked = [];
    for (const it of W2.decor) {
      if (it.type === 'stand') blocked.push({ x: it.x, y: it.y, r: 22 });
      else if (it.type === 'building' || it.type === 'lot') blocked.push({ x: it.x, y: it.y, r: Math.max(it.w, it.h) * 0.6 });
    }
    const polys = W2.decor.filter(it => it.type === 'poly').map(it => it.pts);
    const inPoly = (x, y, v) => { let c = false; for (let i = 0, j = v.length - 1; i < v.length; j = i++) { if ((v[i][1] > y) !== (v[j][1] > y) && x < (v[j][0] - v[i][0]) * (y - v[i][1]) / (v[j][1] - v[i][1]) + v[i][0]) c = !c; } return c; };
    // clear of every part of the circuit (centreline plus its barriers and a margin)
    const clear = (x, y, w, d, h) => {
      const ch = Math.cos(h), sh = Math.sin(h), R = Math.hypot(w, d) / 2;
      let ok = true;
      tr.hash.near(x, y, R + 70, i => {
        if (!ok) return;
        const dist = Math.hypot(tr.x[i] - x, tr.y[i] - y) - R;
        if (dist < Math.max(tr.barr[0][i], tr.barr[1][i]) + 6) ok = false;
      });
      if (!ok) return false;
      for (const b of blocked) if (Math.hypot(b.x - x, b.y - y) < b.r + R) return false;
      for (const f of foot) if (Math.hypot(f.x - x, f.y - y) < f.r + R + 3) return false;
      for (const [cx, cz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2], [0, 0]]) {
        const px = x + ch * cx - sh * cz, py = y + sh * cx + ch * cz;
        for (const v of polys) if (inPoly(px, py, v)) return false;
      }
      return true;
    };
    const glass = new Batch(false), office = new Batch(false), lit = new Batch(false), roof = new Batch(false), clad = new Batch(false);
    const place = (x, y, h, w, d, floors, kind) => {
      if (!clear(x, y, w, d, h)) return false;
      const gy = Tracks.groundAt(tr, x, y), H = floors * 3.6, ry = -h;
      // glazed ground floor, office or glass floors above, a roof slab with plant on top
      lit.add(facadeBox(w, 3.6, d, 15, 15), mat(x, gy + 1.8 - 0.4, y, ry));
      (kind === 'glass' ? glass : office).add(facadeBox(w - 0.4, H - 3.6, d - 0.4, kind === 'glass' ? 15 : 28, kind === 'glass' ? 15 : 28), mat(x, gy + 3.6 + (H - 3.6) / 2 - 0.4, y, ry));
      roof.add(new THREE.BoxGeometry(w + 0.6, 0.5, d + 0.6), mat(x, gy + H - 0.15, y, ry));
      clad.add(facadeBox(w * 0.3, 1.6, d * 0.4, 3, 3), mat(x + Math.cos(h) * w * 0.15, gy + H + 0.9, y + Math.sin(h) * w * 0.15, ry));
      foot.push({ x, y, w, d, h, r: Math.hypot(w, d) / 2 });
      return true;
    };
    // behind the garages: the paddock
    const garages = W2.decor.filter(it => it.type === 'garage');
    const f = pit.side > 0 ? -1 : 1; // local z of the garage face that looks onto the pit lane
    garages.forEach((it, k) => {
      if (k % 2) return;
      const back = -f * (it.d / 2 + 18 + 6.5);
      const x = it.x - Math.sin(it.h) * back, y = it.y + Math.cos(it.h) * back;
      place(x, y, it.h, 26, 13, 2 + ((k / 2) % 3 === 1 ? 1 : 0), 'office');
    });
    // race control: a glass tower at the head of the pit lane
    if (garages.length) {
      for (const it of [garages[0], garages[garages.length - 1]]) {
        const back = -f * (it.d / 2 + 14);
        const x = it.x - Math.sin(it.h) * back + Math.cos(it.h) * 18, y = it.y + Math.cos(it.h) * back + Math.sin(it.h) * 18;
        if (place(x, y, it.h, 14, 14, 7, 'glass')) break;
      }
    }
    // sponsor footbridge across the start straight, ahead of the grid
    {
      const s = (tr.L - 205 + tr.L) % tr.L, i = Math.round(s / tr.ds) % tr.N;
      const dl = -(tr.barr[0][i] + 3), dr = tr.barr[1][i] + 3, span = dr - dl;
      const [x, y, hh] = Tracks.pointAt(tr, s, (dl + dr) / 2);
      const gy = Math.max(Tracks.groundAt(tr, ...Tracks.pointAt(tr, s, dl).slice(0, 2)), Tracks.groundAt(tr, ...Tracks.pointAt(tr, s, dr).slice(0, 2)), tr.z[i]);
      const g = new THREE.Group();
      g.position.set(x, gy, y); g.rotation.y = -hh;
      const deck = new THREE.BoxGeometry(2.8, 2.4, span);
      const uv = deck.attributes.uv, p = deck.attributes.position, n = deck.attributes.normal;
      for (let k = 0; k < uv.count; k++) if (Math.abs(n.getX(k)) > 0.5) uv.setXY(k, (p.getZ(k) + span / 2) / 30, (p.getY(k) + 1.2) / 2.4);
      const dm = new THREE.Mesh(deck, M.adwall); dm.position.y = 8.6; dm.castShadow = true; dm.receiveShadow = true; g.add(dm);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.12, span + 0.2), M.steel); rail.position.y = 9.85; g.add(rail);
      for (const z of [dl - (dl + dr) / 2 - 1.8, dr - (dl + dr) / 2 + 1.8]) {
        const tw = new THREE.Mesh(facadeBox(3.6, 9.8, 3.6, 3, 3), VMt.clad); tw.position.set(0, 4.9, z); tw.castShadow = true; tw.receiveShadow = true; g.add(tw);
      }
      root.add(g);
      foot.push({ x: Tracks.pointAt(tr, s, dl - 2)[0], y: Tracks.pointAt(tr, s, dl - 2)[1], w: 5, d: 5, h: hh, r: 4 });
      foot.push({ x: Tracks.pointAt(tr, s, dr + 2)[0], y: Tracks.pointAt(tr, s, dr + 2)[1], w: 5, d: 5, h: hh, r: 4 });
    }
    const addB = (b, m) => { const geo = b.geo(); if (!geo) return; const mesh = new THREE.Mesh(geo, m); mesh.castShadow = true; mesh.receiveShadow = true; root.add(mesh); };
    addB(lit, VMt.lit); addB(glass, VMt.glass); addB(office, VMt.office); addB(roof, VMt.roof); addB(clad, VMt.clad);
    return foot;
  }

  // start gantry with five pairs of red lights
  function buildGantry(root, tr) {
    const M = materials();
    const g = new THREE.Group();
    const [x, y, h] = Tracks.pointAt(tr, 4, 0);
    g.position.set(x, tr.z[2], y); g.rotation.y = -h;
    const k = Math.floor(4 / tr.ds);
    const dl = -(tr.barr[0][k] + 1.2), dr = tr.barr[1][k] + 1.2;
    const box = (w, hh, d, px, py, pz, m) => { const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), m); mesh.position.set(px, py, pz); mesh.castShadow = true; g.add(mesh); return mesh; };
    box(0.6, 7.4, 0.6, 0, 3.7, dl, M.dark); box(0.6, 7.4, 0.6, 0, 3.7, dr, M.dark);
    box(0.7, 0.9, dr - dl, 0, 7.0, (dl + dr) / 2, M.dark);
    box(0.4, 1.7, 4.0, 0, 5.75, 0, M.dark);
    const lamp = new THREE.CylinderGeometry(0.16, 0.16, 0.12, 14); lamp.rotateZ(Math.PI / 2);
    const mats = [];
    for (let c = 0; c < 5; c++) {
      const m = std({ color: '#2a0a08', emissive: '#ff2414', emissiveIntensity: 0, roughness: 0.3 });
      mats.push(m);
      for (const yy of [6.15, 5.4]) { const l = new THREE.Mesh(lamp, m); l.position.set(-0.24, yy, -1.44 + c * 0.72); g.add(l); }
    }
    root.add(g);
    return mats;
  }

  function buildBoards(root, W2, tr) {
    const M = materials();
    const post = new THREE.BoxGeometry(0.1, 1.2, 0.1); post.translate(0, 0.6, 0);
    const plane = new THREE.PlaneGeometry(0.9, 1.3); plane.rotateY(-Math.PI / 2);
    const mats = {};
    for (const b of W2.boards || []) {
      const m = mats[b.n] || (mats[b.n] = std({ map: T.board(b.n), roughness: 0.6, side: THREE.DoubleSide }));
      const g = new THREE.Group();
      g.position.set(b.x, Tracks.groundAt(tr, b.x, b.y), b.y); g.rotation.y = -b.h;
      const p = new THREE.Mesh(post, M.steel); g.add(p);
      const bd = new THREE.Mesh(plane, m); bd.position.set(0, 1.8, 0); bd.castShadow = true; g.add(bd);
      root.add(g);
    }
  }

  // distant hills / mountains / dunes: a ring of layered silhouettes, unfogged and pre-hazed
  function buildBackdrop(root, W2) {
    const b = W2.bounds;
    const cx = (b.x0 + b.x1) / 2, cz = (b.y0 + b.y1) / 2;
    const R = Math.hypot(b.x1 - b.x0, b.y1 - b.y0) / 2 + 3800;
    root.userData.backdrop = { cx, cz, R };
  }
  function backdropFor(id, root) {
    const L = LOOKS[id] || LOOKS.kestrel, bd = root.userData.backdrop;
    if (!bd || root.userData.backdropMesh) return;
    const H0 = L.ridgeH * 3.2;
    const g = new THREE.CylinderGeometry(bd.R, bd.R, H0, 96, 1, true);
    g.translate(bd.cx, H0 / 2 - 30, bd.cz);
    const uv = g.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setX(k, uv.getX(k) * 3);
    const m = new THREE.MeshBasicMaterial({ map: T.ridge(L.ridge, id.length * 13 + 7, L.jag), transparent: true, alphaTest: 0.5, side: THREE.BackSide, fog: false, depthWrite: false });
    m.color.set('#ffffff').lerp(col(L.fog), 0.25);
    if (state.hdr) { const f = state.hdr.fog; m.color.multiplyScalar((f[0] * 0.2126 + f[1] * 0.7152 + f[2] * 0.0722) / 0.55); }
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = -5; mesh.frustumCulled = false;
    root.add(mesh);
    root.userData.backdropMesh = mesh;
  }

  // trackside TV cameras: every ~200 m, outside of the next bend, up on a tower
  function buildTvCams(tr) {
    const cams = [];
    const step = Math.round(190 / tr.ds);
    for (let i = 0; i < tr.N; i += step) {
      let kk = 0;
      for (let q = 0; q < Math.round(120 / tr.ds); q++) kk += tr.kap[(i + q) % tr.N];
      const side = kk > 0 ? 0 : 1, sg = side ? 1 : -1;
      // on a gantry just inside the barrier, high enough to see over fences and walls
      const d = sg * Math.max(tr.hw + 2.5, tr.barr[side][i] - 2.5);
      const cxp = tr.x[i] + tr.nx[i] * d, czp = tr.y[i] + tr.ny[i] * d;
      cams.push({ s: i * tr.ds, x: cxp, z: czp, y: 7.5 + (i * 7 % 4) + Tracks.groundAt(tr, cxp, czp) });
    }
    return cams;
  }

  // ---------- cars ----------
  function modelFor(car) {
    let m = live.get(car);
    if (m) return m;
    const num = car.driver ? car.driver.num : car.id + 1;
    const body = RC.makeCar(car.team, num, car.compound ? car.compound.id : 'M');
    // skylight occlusion near the road on the bodywork and tyres (r3-shaders, userData.carAO);
    // set before the first patch. Tyre meshes sit on the wheel centre, so they lift by the
    // wheel radius. Interior meshes are left to the cockpit's own shading.
    {
      const wheels = new Set(body.userData.wheels || []), inner = body.userData.cockpit && body.userData.cockpit.group;
      const under = (m, set) => { for (let p = m.parent; p; p = p.parent) if (set.has(p)) return true; return false; };
      body.traverse(m => {
        if (m.isMesh) m.receiveShadow = true; // cars take the shade of buildings, stands and trees
        if (!m.isMesh || !m.material || Array.isArray(m.material) || m.material.userData.carAO) return;
        if (inner && under(m, new Set([inner]))) return;
        m.material.userData.carAO = under(m, wheels) ? { lift: 0.36, k: 0.62 } : { lift: 0, k: 0.55 };
      });
    }
    const outer = new THREE.Group();
    outer.add(body);
    // the road frame under the car (follows the road, not the sprung body); the car's shadows
    // on the road are real ones now (cascaded sun shadow plus shade-weighted AO), no decals
    const ground = new THREE.Group();
    outer.add(ground);
    // the ground a car's shadow falls on moves with the car: a proxy drawn only in the motion
    // blur's velocity pass (layer 5), so the shadow is not smeared as if it were scenery
    // (both live in their own small scene, velScene, so that pass does not walk the world)
    const sp = new THREE.Mesh(velShadowGeo(), MATS.shadowBlob);
    const hull = new THREE.Mesh(RC.velHull(), MATS.shadowBlob);
    for (const q of [sp, hull]) { q.matrixAutoUpdate = false; q.visible = false; q.frustumCulled = false; velScene.add(q); }
    outer.userData = { body, spin: 0, flap: 0, seen: 0, ground, gy: 0, velOn: false, velParts: [sp, hull] };
    // every part of the car takes shadow, the scanned body and the cockpit included: the halo
    // across the wheel, the cockpit sides over the hands and lap, the car over its own floor
    body.traverse(o => { if (o.isMesh) o.receiveShadow = true; });
    applyAniso(body);
    // the car's stand-in for the outer shadow slices: its merged far model, hidden except while
    // those slices are drawn (see the shadow-map wrapper in init)
    if (body.userData.far) {
      const proxy = new THREE.Mesh(body.userData.far.geometry, body.userData.far.material);
      proxy.castShadow = true; proxy.receiveShadow = false; proxy.visible = false;
      body.add(proxy);
      body.userData.shadowProxy = proxy;
    }
    F1.R3S.patchTree(outer);
    scene.add(outer);
    live.set(car, outer);
    return outer;
  }
  // the velocity pass's scene and the ground patch a car's shadow falls on
  const velScene = new THREE.Scene();
  let _vsg = null;
  function velShadowGeo() { if (!_vsg) { _vsg = new THREE.PlaneGeometry(8, 3.9); _vsg.rotateX(-Math.PI / 2); _vsg.translate(0, 0.03, 0); } return _vsg; }

  let frameNo = 0;
  function updateCars(cars, dt, hideHelmet) {
    frameNo++;
    for (const c of cars) {
      const o = modelFor(c), ud = o.userData, body = ud.body, bu = body.userData;
      ud.seen = frameNo;
      // on the road surface, tilted to its grade and banking; the chassis then heaves,
      // pitches and rolls on its suspension exactly as the physics has it
      const tr = state.tr;
      const has = tr && c.loc && c.loc.i >= 0;
      const gy = has ? Tracks.surfS(tr, c.loc.s, c.loc.d) : tr ? Tracks.groundAt(tr, c.x, c.y) : 0;
      let pr = 0, rr = 0;
      if (has) {
        const i = c.loc.i, psi = c.h - Math.atan2(tr.ty[i], tr.tx[i]);
        pr = Math.atan(tr.dz[i] * Math.cos(psi) + tr.bank[i] * Math.sin(psi));
        rr = -Math.atan(-tr.dz[i] * Math.sin(psi) + tr.bank[i] * Math.cos(psi));
      }
      ud.gy = gy;
      o.position.set(c.x, gy, c.y);
      o.rotation.y = -c.h;
      body.position.y = c.zh || 0;
      body.rotation.z = pr + (c.pitch || 0);
      body.rotation.x = rr + (c.roll || 0);
      ud.ground.rotation.set(rr, 0, pr);
      const PW = c.wheels && c.wheels.length === 4 ? c.wheels : null;
      bu.wheels.forEach((w, k) => {
        const pw = PW && PW[k], wd = w.userData;
        // each wheel turns at its own speed: lockups stop it, wheelspin races it
        wd.ang = (wd.ang || 0) + (pw && pw.omega != null ? pw.omega : (c.u != null ? c.u : c.speed || 0) / 0.36) * dt;
        wd.spin.rotation.z = -wd.ang;
        if (wd.front) w.rotation.y = -(c.steer || 0);
        // suspension travel
        if (wd.baseY == null) wd.baseY = w.position.y;
        w.position.y = wd.baseY + (pw && pw.s0 != null ? U.clamp(pw.comp - pw.s0, -0.05, 0.05) : 0);
      });
      ud.flap += ((c.drsOpen ? -0.85 : 0) - ud.flap) * Math.min(1, dt * 12);
      bu.flapPivot.rotation.z = ud.flap;
      bu.rainMat.emissiveIntensity = c.limiter ? (Math.floor(performance.now() / 120) % 2 ? 5 : 0) : 0;
      if (c.compound) RC.setCompound(body, c.compound.id);
      if (c.dm && F1.R3D) F1.R3D.sync(scene, o, c, dt); // soft-body dents and parts breaking off
      // helmet hidden for the onboard camera
      const hide = c === hideHelmet;
      if (bu.hidden !== hide) {
        bu.hidden = hide;
        if (bu.helmet) bu.helmet.forEach(m => { m.visible = !hide; });
        if (bu.cockpit && bu.cockpit.povOnly) bu.cockpit.povOnly.forEach(m => { m.visible = hide; });
        else body.children.forEach(ch => { if (ch.geometry && ch.geometry.type === 'SphereGeometry') ch.visible = !hide; });
      }
      // detail level by distance to the camera
      if (bu.lodGroups) {
        const d2 = (c.x - camera.position.x) ** 2 + (c.y - camera.position.z) ** 2;
        // full detail close up, the low-detail model further out, then the merged far mesh
        // (one draw call); in Rock even the player's car is low detail outside the cockpit
        const n0 = GFX.carNear || 50, n1 = Math.max(n0, GFX.carFar || 300);
        // the cockpit interior only within 10 m (or for the car being driven from inside)
        RC.setLod(body, d2 > n1 * n1 ? 2 : d2 > n0 * n0 ? 1 : 0, d2 < 100 || c === hideHelmet);
        // car draw distance (potato 350 m, rock 250 m): further cars are a few pixels; skip them
        body.visible = !(GFX.carDraw > 0) || d2 < GFX.carDraw * GFX.carDraw || c === o.focus;
        RC.updateCockpit(body, G.__ckSteer != null ? G.__ckSteer : c.steer, hide ? c : null); // debug: G.__ckSteer pins the wheel
        RC.updateHead(body, c, dt);
      }
    }
    for (const [car, o] of live) if (o.userData.seen !== frameNo) { scene.remove(o); for (const q of o.userData.velParts) velScene.remove(q); live.delete(car); }
  }

  let ghostModel = null;
  function updateGhost(g) {
    if (!g) { if (ghostModel) ghostModel.visible = false; return; }
    if (!ghostModel) {
      ghostModel = RC.makeCar(F1.Data.TEAMS[0], 0, 'M');
      ghostModel.traverse(o => { if (o.isMesh) { o.material = MATS.ghost; o.castShadow = false; } });
      scene.add(ghostModel);
    }
    ghostModel.visible = true;
    ghostModel.position.set(g.x, state.tr ? Tracks.groundAt(state.tr, g.x, g.y) : 0, g.y); ghostModel.rotation.y = -g.h;
  }

  // ---------- effects: smoke, dust, sparks, skid marks, debris ----------
  const fx = {};
  const PT_VS = [
    'attribute float size; attribute vec4 rgba; varying vec4 vC; uniform float scale;',
    '#include <common>', '#include <logdepthbuf_pars_vertex>',
    'void main(){ vC = rgba; vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  vC.a *= smoothstep(size * 0.6, size * 0.6 + 6.0, -mv.z);', // fade puffs that would fill the lens
    '  gl_PointSize = max(2.0, size * scale / -mv.z); gl_Position = projectionMatrix * mv;', '#include <logdepthbuf_vertex>', '}'].join('\n');
  const PT_FS = [
    'uniform sampler2D map; varying vec4 vC;', '#include <common>', '#include <logdepthbuf_pars_fragment>',
    'void main(){', '#include <logdepthbuf_fragment>', '  float a = texture2D(map, gl_PointCoord).a; gl_FragColor = vec4(pow(vC.rgb, vec3(2.2)), vC.a * a);',
    '#include <colorspace_fragment>', '}'].join('\n');
  function pointsLayer(n, additive) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('rgba', new THREE.BufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.ShaderMaterial({
      uniforms: { map: { value: T.soft() }, scale: { value: 500 } }, vertexShader: PT_VS, fragmentShader: PT_FS,
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const p = new THREE.Points(g, m);
    p.frustumCulled = false; p.renderOrder = 5;
    return p;
  }
  function initFx() {
    fx.smoke = pointsLayer(1000, false); fx.sparks = pointsLayer(600, true);
    scene.add(fx.smoke, fx.sparks);
    const n = 9000;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 12), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 16), 4).setUsage(THREE.DynamicDrawUsage));
    const ix = new Uint32Array(n * 6);
    for (let k = 0; k < n; k++) { const b = k * 4; ix.set([b, b + 1, b + 2, b, b + 2, b + 3], k * 6); }
    g.setIndex(new THREE.BufferAttribute(ix, 1));
    fx.skid = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    fx.skid.frustumCulled = false; fx.skid.renderOrder = 2;
    scene.add(fx.skid);
    fx.skidHead = 0; fx.skidN = 0;
    fx.debris = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.08, 0.6), new THREE.MeshStandardMaterial({ color: '#1b1c20', roughness: 0.5 }), 200);
    fx.debris.count = 0; fx.debris.frustumCulled = false; fx.debris.castShadow = true;
    scene.add(fx.debris);
    // assist ribbon + markers
    const an = 140;
    const ag = new THREE.BufferGeometry();
    ag.setAttribute('position', new THREE.BufferAttribute(new Float32Array(an * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    ag.setAttribute('color', new THREE.BufferAttribute(new Float32Array(an * 2 * 4), 4).setUsage(THREE.DynamicDrawUsage));
    const aix = [];
    for (let k = 0; k < an - 1; k++) { const b = k * 2; aix.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
    ag.setIndex(aix);
    fx.assist = new THREE.Mesh(ag, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
    fx.assist.frustumCulled = false; fx.assist.renderOrder = 3; fx.assistN = an;
    scene.add(fx.assist);
    fx.marks = [];
    const disc = new THREE.CircleGeometry(1, 20); disc.rotateX(-Math.PI / 2);
    const bar = new THREE.PlaneGeometry(1.0, 5.0); bar.rotateX(-Math.PI / 2);
    for (let k = 0; k < 24; k++) {
      const m = new THREE.Mesh(k < 6 ? bar : disc, new THREE.MeshBasicMaterial({ color: '#fff', toneMapped: false, transparent: true, opacity: 0.95, depthWrite: false }));
      m.visible = false; m.renderOrder = 4; m.userData.bar = k < 6;
      scene.add(m); fx.marks.push(m);
    }
  }
  function clearFx() {
    const c = fx.skid.geometry.attributes.color;
    c.array.fill(0); c.needsUpdate = true;
    fx.skidHead = 0; fx.skidN = 0;
  }

  const SKIDC = [[14, 14, 16, 0.55], [60, 72, 30, 0.5], [150, 128, 88, 0.6]].map(([r, g, b, a]) => { const c = new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace); return [c.r, c.g, c.b, a]; });
  function updateFx(F, dt) {
    if (!F) return;
    // smoke / dust and sparks (the game owns the particles; we only draw them)
    const sm = fx.smoke.geometry.attributes, sp = fx.sparks.geometry.attributes;
    let ns = 0, nk = 0;
    for (const p of F.parts) {
      const f = p.t / p.life;
      if (p.kind === 0 && ns < 1000) {
        const r = U.lerp(p.r0, p.r1, Math.sqrt(f));
        sm.position.setXYZ(ns, p.x, (p.z || 0) + 0.25 + r * 0.45 + f * 1.4, p.y);
        // grass and gravel dust is fine, low and brownish; tyre smoke is denser and grey
        const dirt = p.col === '120,140,70' || p.col === '214,196,150';
        sm.size.setX(ns, r * (dirt ? 1.2 : 1.5));
        const [cr, cg, cb] = dirt ? [158, 146, 118] : p.col.split(',').map(Number);
        sm.rgba.setXYZW(ns, cr / 255 * 0.8, cg / 255 * 0.8, cb / 255 * 0.8, p.a * (1 - f) * (dirt ? 0.5 : 0.55));
        ns++;
      } else if (p.kind === 1 && nk < 600) {
        sp.position.setXYZ(nk, p.x, (p.z || 0) + 0.12 + f * 0.3, p.y);
        sp.size.setX(nk, 0.16);
        sp.rgba.setXYZW(nk, 1, (220 - f * 120) / 255, (120 - f * 100) / 255, 1 - f);
        nk++;
      }
    }
    fx.smoke.geometry.setDrawRange(0, ns); fx.sparks.geometry.setDrawRange(0, nk);
    for (const a of [sm.position, sm.size, sm.rgba, sp.position, sp.size, sp.rgba]) a.needsUpdate = true;
    const scale = (F1.R3Post.Q.on ? F1.R3Post.height : renderer.getDrawingBufferSize(new THREE.Vector2()).y) * camera.projectionMatrix.elements[5] / 2;
    fx.smoke.material.uniforms.scale.value = scale; fx.sparks.material.uniforms.scale.value = scale;

    // skid marks: append what the game added since last frame
    if (F.skidN < fx.skidN) clearFx();
    const pos = fx.skid.geometry.attributes.position, cl = fx.skid.geometry.attributes.color;
    let k = fx.skidHead, wrote = 0;
    const S = F.skid;
    while (k !== F.skidHead && wrote < 9000) {
      const o = k * 5;
      const x1 = S[o], z1 = S[o + 1], x2 = S[o + 2], z2 = S[o + 3], kind = S[o + 4];
      let dx = x2 - x1, dz = z2 - z1;
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const w = 0.17, nx = -dz * w, nz = dx * w, y = 0.018 + (state.tr ? Tracks.groundAt(state.tr, x1, z1) : 0);
      pos.setXYZ(k * 4, x1 + nx, y, z1 + nz); pos.setXYZ(k * 4 + 1, x1 - nx, y, z1 - nz);
      pos.setXYZ(k * 4 + 2, x2 - nx, y, z2 - nz); pos.setXYZ(k * 4 + 3, x2 + nx, y, z2 + nz);
      const c = SKIDC[kind] || SKIDC[0];
      for (let q = 0; q < 4; q++) cl.setXYZW(k * 4 + q, c[0], c[1], c[2], c[3]);
      k = (k + 1) % 9000; wrote++;
    }
    if (wrote) { pos.needsUpdate = true; cl.needsUpdate = true; }
    fx.skidHead = F.skidHead; fx.skidN = F.skidN;

    // debris
    let nd = 0;
    const tmp = new THREE.Object3D();
    for (const d of F.debris) {
      if (d.t > 4 || nd >= 200) continue;
      tmp.position.set(d.x, 0.05 + (d.z || 0), d.y); tmp.rotation.set(0, d.a, 0); tmp.scale.set(d.s * 2, 1, d.s * 2); tmp.updateMatrix();
      fx.debris.setMatrixAt(nd++, tmp.matrix);
    }
    fx.debris.count = nd; fx.debris.instanceMatrix.needsUpdate = true;
    void dt;
  }

  // racing line ribbon and reference markers ahead of the player
  const ACOL = {
    red: [1, 0.23, 0.19, 0.85], amber: [1, 0.77, 0, 0.75], green: [0.25, 0.86, 0.47, 0.55],
  };
  function updateAssist(a) {
    const show = a && a.mode !== 'off' && a.car;
    fx.assist.visible = !!show;
    for (const m of fx.marks) m.visible = false;
    if (!show) return;
    const tr = a.tr, car = a.car, prof = a.prof || tr.prof, mode = a.mode;
    const i0 = car.loc.i, v = car.speed, n = fx.assistN;
    const pos = fx.assist.geometry.attributes.position, cc = fx.assist.geometry.attributes.color;
    const w = 0.45;
    for (let k = 0; k < n; k++) {
      const i = (i0 + 3 + k) % tr.N;
      const brk = prof[(i + 1) % tr.N] < prof[i] - 0.05;
      const slower = prof[i] < v - 3;
      let c = null;
      if (brk || slower) {
        const dist = (k + 3) * tr.ds, need = (v * v - prof[i] * prof[i]) / (2 * 38);
        c = need > dist - 25 ? ACOL.red : ACOL.amber;
      } else if (mode !== 'brake') c = ACOL.green;
      const off = tr.line.off[i];
      const x = tr.x[i] + tr.nx[i] * off, z = tr.y[i] + tr.ny[i] * off;
      const hy = 0.03 + Tracks.surfZ(tr, i, off);
      pos.setXYZ(k * 2, x - tr.nx[i] * w, hy, z - tr.ny[i] * w);
      pos.setXYZ(k * 2 + 1, x + tr.nx[i] * w, hy, z + tr.ny[i] * w);
      const fade = Math.min(1, k / 6) * (1 - Math.max(0, (k - n + 25) / 25));
      const col4 = c || [0, 0, 0, 0];
      for (let q = 0; q < 2; q++) cc.setXYZW(k * 2 + q, col4[0], col4[1], col4[2], col4[3] * fade);
    }
    pos.needsUpdate = true; cc.needsUpdate = true;
    if (!a.marks) return;
    const ahead = i => (((i - i0) % tr.N) + tr.N) % tr.N * tr.ds;
    const P = i => [tr.x[i] + tr.nx[i] * tr.line.off[i], tr.y[i] + tr.ny[i] * tr.line.off[i]];
    let nb = 0, nd = 6;
    const dot = (i, hex, r) => {
      if (nd >= fx.marks.length) return;
      const m = fx.marks[nd++], p = P(i);
      m.visible = true; m.position.set(p[0], 0.04 + Tracks.surfZ(tr, i, tr.line.off[i]), p[1]); m.scale.set(r, 1, r); m.material.color.set(hex);
    };
    for (const m of a.marks) {
      const dA = ahead(m.apex);
      if (dA > 330 && ahead(m.exit) > 330) continue;
      if (m.brake >= 0 && ahead(m.brake) < 330 && nb < 6) {
        const mk = fx.marks[nb++], i = m.brake, p = P(i);
        mk.visible = true; mk.position.set(p[0], 0.04 + Tracks.surfZ(tr, i, tr.line.off[i]), p[1]); mk.rotation.y = -Math.atan2(tr.ty[i], tr.tx[i]); mk.material.color.set('#ff3b30');
      }
      if (mode !== 'full') continue;
      const far = i => Math.abs(i - m.apex) * tr.ds > 14;
      if (ahead(m.turnIn) < 330 && far(m.turnIn)) dot(m.turnIn, '#ffcc1f', 0.9);
      if (dA < 330) dot(m.apex, '#3aa0ff', 1.05);
      if (ahead(m.exit) < 330 && far(m.exit)) dot(m.exit, '#2bd66b', 0.9);
    }
  }

  // ---------- cameras ----------
  const C = { yaw: 0, mode: '', look: V(0, 0, 0), tv: null, fov: 60, last: null };
  const MODES = ['chase', 'far', 'tcam', 'cockpit', 'helmet', 'tv', 'orbit', 'show'];
  const V2S = new THREE.Vector2();
  function setFov(f, dt, snap) {
    C.fov = snap ? f : C.fov + (f - C.fov) * Math.min(1, dt * 4);
    if (Math.abs(camera.fov - C.fov) > 0.01) { camera.fov = C.fov; camera.updateProjectionMatrix(); }
  }
  const carY = car => { const o = live.get(car); return o ? o.userData.gy : state.tr ? Tracks.groundAt(state.tr, car.x, car.y) : 0; };
  function onboard(car, ex, ey, lookAhead, ly) {
    const ch = Math.cos(car.h), sh = Math.sin(car.h), g0 = carY(car);
    ey += g0; ly += g0;
    const pitch = U.clamp((car.ax || 0) * 0.0005, -0.03, 0.02);
    camera.position.set(car.x + ch * ex, ey + pitch * ex, car.y + sh * ex);
    C.look.set(car.x + ch * lookAhead, ly + pitch * lookAhead, car.y + sh * lookAhead);
    camera.up.set(0, 1, 0);
    camera.lookAt(C.look);
  }
  function tvCam(car, dt, snap) {
    const cams = state.tvCams, tr = state.tr;
    if (!cams.length) return;
    const s = car.loc && car.loc.s != null ? car.loc.s : 0;
    let cur = C.tv;
    const fwd = (a, b) => Tracks.fwd(tr, a, b);
    if (!cur || snap || (fwd(cur.s, s) > 70 && fwd(cur.s, s) < tr.L / 2) || fwd(s, cur.s) > 420 || !sight(cur, car)) {
      let best = null, bd = 1e9;
      for (const c of cams) { const d = fwd(s, c.s); if (d > 30 && d < bd && sight(c, car)) { bd = d; best = c; } }
      if (!best) for (const c of cams) { const d = fwd(s, c.s); if (d > 30 && d < bd) { bd = d; best = c; } }
      if (best && best !== cur) { C.tv = cur = best; snap = true; }
    }
    if (!cur) return;
    camera.position.set(cur.x, cur.y, cur.z);
    const tx = car.x + Math.cos(car.h) * car.speed * 0.12, tz = car.y + Math.sin(car.h) * car.speed * 0.12;
    const ty0 = carY(car) + 0.7;
    if (snap) C.look.set(tx, ty0, tz);
    else C.look.lerp(V(tx, ty0, tz), Math.min(1, dt * 6));
    camera.lookAt(C.look);
    const dist = camera.position.distanceTo(C.look);
    setFov(U.clamp(2 * Math.atan(9 / dist) * 180 / Math.PI, 3.5, 55), dt, snap);
  }
  // sight line from a trackside camera to a car stays within the barriers all the way
  const LOC = {};
  function sight(c, car) {
    const tr = state.tr;
    let hint = car.loc && car.loc.i >= 0 ? car.loc.i : -1;
    for (let k = 1; k < 10; k++) {
      const f = k / 10, x = car.x + (c.x - car.x) * f, z = car.y + (c.z - car.y) * f;
      Tracks.locate(tr, x, z, hint, LOC);
      hint = LOC.i;
      const side = LOC.d > 0 ? 1 : 0;
      if (Math.abs(LOC.d) > tr.barr[side][LOC.i] + 1.5 && Math.abs(LOC.along) < tr.ds * 3) return false;
    }
    return true;
  }
  function updateCamera(o) {
    const car = o.focus, dt = o.dt || 0.016;
    let mode = o.mode;
    if (!MODES.includes(mode) && mode !== 'load') mode = 'chase';
    const snap = C.mode !== mode || C.last !== car || (car && Math.hypot(camera.position.x - car.x, camera.position.z - car.y) > 200 && mode !== 'tv');
    C.mode = mode; C.last = car;
    if (mode !== 'show' && camera.view && camera.view.enabled) camera.clearViewOffset();
    if (mode !== 'tcam' && mode !== 'cockpit' && mode !== 'helmet') camera.up.set(0, 1, 0);
    camera.near = POT ? (mode === 'cockpit' || mode === 'helmet' ? 0.1 : 0.3) : mode === 'cockpit' || mode === 'helmet' ? 0.05 : 0.2;
    if (mode === 'load') { loadCam(o.load, dt); return; }
    if (!car) return;
    if (mode === 'chase' || mode === 'far') {
      const k = o.zoomK || 1;
      const dist = (mode === 'far' ? 9.5 : 6.4) / k + Math.min(1.5, car.speed * 0.014);
      const ht = (mode === 'far' ? 2.9 : 1.95) / Math.sqrt(k);
      if (snap) C.yaw = car.h;
      else C.yaw += U.wrapAngle(car.h - C.yaw) * (1 - Math.exp(-6.5 * dt));
      const cx = Math.cos(C.yaw), cz = Math.sin(C.yaw);
      const g0 = carY(car);
      camera.position.set(car.x - cx * dist, ht + g0, car.y - cz * dist);
      C.look.set(car.x + cx * 3.5, 0.85 + g0, car.y + cz * 3.5);
      camera.lookAt(C.look);
      setFov(56 + Math.min(12, car.speed * 0.12), dt, snap);
    } else if (mode === 'tcam') {
      // T-cam: bolted to the pod on the roll hoop. It moves only with the chassis, so the
      // car stays still in frame under braking: no lag, no head bob, no speed zoom.
      const om = live.get(car), bu = om && om.userData.body.userData;
      if (bu && bu.tcamEye) {
        om.updateMatrixWorld(true);
        bu.tcamEye.getWorldPosition(camera.position);
        bu.tcamLook.getWorldPosition(C.look);
        camera.up.set(0, 1, 0).applyQuaternion(om.userData.body.getWorldQuaternion(new THREE.Quaternion()));
        camera.lookAt(C.look);
      } else onboard(car, -0.95, 1.22, 30, 0.75);
      setFov(62, dt, true);
    } else if (mode === 'cockpit') {
      const hm = RC.hasModel();
      const ov = G.__cockpitEye; // debug override [x, y, lookY]
      const om = live.get(car), bu = om && om.userData.body.userData;
      if (bu && bu.eyeA && !ov) {
        // the driver's head is in the chassis: it pitches, rolls and climbs with the car
        om.updateMatrixWorld(true);
        bu.eyeA.getWorldPosition(camera.position); bu.lookA.getWorldPosition(C.look);
        camera.up.set(0, 1, 0).applyQuaternion(bu.eyeA.getWorldQuaternion(new THREE.Quaternion()));
        camera.lookAt(C.look);
      } else onboard(car, ov ? ov[0] : hm ? 0.3 : 0.24, ov ? ov[1] : hm ? 0.9 : 0.84, 30, ov ? ov[2] : hm ? 0.8 : 0.5);
      setFov(G.__cockpitFov || (hm ? 64 : 74), dt, snap); // a wide onboard lens, about 96 degrees across on 16:9
      const gs = F1.Game && F1.Game.settings;
      headMotion(car, dt, snap, !gs || gs.headMotion !== false);
    } else if (mode === 'helmet') {
      // fixed to the driver's helmet: the head's turns, tips and drops carry the whole view
      const om = live.get(car), bu = om && om.userData.body.userData;
      if (bu && bu.hEye) {
        om.updateMatrixWorld(true);
        bu.hEye.getWorldPosition(camera.position); bu.hLook.getWorldPosition(C.look);
        camera.up.set(0, 1, 0).applyQuaternion(bu.hEye.getWorldQuaternion(new THREE.Quaternion()));
        camera.lookAt(C.look);
      } else onboard(car, 0.0, 1.2, 30, 0.75);
      setFov(G.__helmetFov || 66, dt, snap);
    } else if (mode === 'tv') {
      tvCam(car, dt, snap);
    } else if (mode === 'show') {
      // menu showcase: a low tracking shot alongside the car, from the front three-quarter,
      // drifting slowly round; the frame is shifted so the car sits right of the menus
      C.showT = (C.showT || 0) + dt;
      const a = car.h + 0.62 + 0.38 * Math.sin(C.showT * 0.09), r = 7.4;
      const g0 = carY(car);
      camera.position.set(car.x + Math.cos(a) * r, 1.05 + g0, car.y + Math.sin(a) * r);
      C.look.set(car.x - Math.cos(car.h) * 0.3, 0.1 + g0, car.y - Math.sin(car.h) * 0.3); // aimed low: the car rides above the team card
      camera.up.set(0, 1, 0);
      camera.lookAt(C.look);
      setFov(36, dt, true);
      const sz = renderer.getSize(V2S);
      camera.setViewOffset(sz.x, sz.y, -sz.x * 0.14, 0, sz.x, sz.y);
    } else if (mode === 'orbit') { // debug: turntable around the car
      const a = (G.__orbit || 0) + car.h, r = G.__orbitR || 6.5;
      const g0 = carY(car);
      camera.position.set(car.x + Math.cos(a) * r, (G.__orbitY || 1.5) + g0, car.y + Math.sin(a) * r);
      C.look.set(car.x, 0.45 + g0, car.y); camera.lookAt(C.look);
      setFov(40, dt, true);
    }
    if (o.shake > 0 && mode !== 'tcam') {
      camera.position.x += (Math.random() - 0.5) * o.shake * 0.12;
      camera.position.y += (Math.random() - 0.5) * o.shake * 0.08;
    }
    // debug: a fixed camera, G.__freeCam = [x, y, z, lookX, lookY, lookZ] (world metres)
    if (G.__freeCam) { const f = G.__freeCam; camera.position.set(f[0], f[1], f[2]); camera.lookAt(f[3], f[4], f[5]); }
  }
  // Driver's head on the cockpit camera. The eye point is already fixed in the chassis, so
  // pitch, roll and heave of the car carry through; this adds what the neck does on top. The
  // head is a mass on a stiff, well damped spring (about 2.2 Hz, the band a braced neck under a
  // helmet settles in), driven by the acceleration measured at the eye: it is thrown forward
  // under braking, out of a corner and down over a kerb, and the driver looks a little into the
  // corner ahead of the car. Amounts are a few centimetres and degrees per g, so a 5 g corner
  // reads clearly without the horizon swimming.
  const HM = { on: false, p: new THREE.Vector3(), lv: new THREE.Vector3(), la: new THREE.Vector3(), x: new THREE.Vector3(), v: new THREE.Vector3(), yaw: 0, buzz: 0 };
  const _hr = new THREE.Vector3(), _hu = new THREE.Vector3(), _hf = new THREE.Vector3(), _hvel = new THREE.Vector3(), _ha = new THREE.Vector3();
  function headMotion(car, dt, snap, enabled) {
    if (!enabled || dt <= 0) { HM.on = false; return; }
    const pos = camera.position;
    if (!HM.on || snap || dt > 0.1) {
      HM.on = true; HM.p.copy(pos); HM.lv.set(0, 0, 0); HM.la.set(0, 0, 0); HM.x.set(0, 0, 0); HM.v.set(0, 0, 0); HM.yaw = 0;
      return;
    }
    // world acceleration of the eye from its path, low-passed (finite differences of a 60 Hz
    // path are noisy; 40 ms keeps a kerb strike sharp)
    _hvel.subVectors(pos, HM.p).divideScalar(dt); HM.p.copy(pos);
    _ha.subVectors(_hvel, HM.lv).divideScalar(dt); HM.lv.copy(_hvel);
    _ha.y += 9.81; // the head also carries its weight: level and still reads 1 g down
    if (_ha.lengthSq() > 400 * 400) _ha.set(0, 9.81, 0); // a teleport or reset, not a load
    HM.la.lerp(_ha, 1 - Math.exp(-dt / 0.04));
    // in the camera's frame: x right, y up, z back
    camera.updateMatrixWorld();
    const m = camera.matrixWorld.elements;
    _hr.set(m[0], m[1], m[2]); _hu.set(m[4], m[5], m[6]); _hf.set(-m[8], -m[9], -m[10]);
    const g = 9.81, aR = HM.la.dot(_hr) / g, aU = HM.la.dot(_hu) / g - 1, aF = HM.la.dot(_hf) / g;
    // the head lags the chassis: displaced against the acceleration (metres per g)
    const tx = -aR * 0.011, ty = -aU * 0.006, tz = aF * 0.009; // braking (aF < 0) throws it forward (-z)
    const w = 2 * Math.PI * 2.2, z = 0.55, k = w * w, c = 2 * z * w;
    const n = Math.max(1, Math.ceil(dt / 0.004)), h = dt / n;
    for (let i = 0; i < n; i++) {
      HM.v.x += (k * (tx - HM.x.x) - c * HM.v.x) * h; HM.v.y += (k * (ty - HM.x.y) - c * HM.v.y) * h; HM.v.z += (k * (tz - HM.x.z) - c * HM.v.z) * h;
      HM.x.addScaledVector(HM.v, h);
    }
    // keep it inside the helmet's travel
    HM.x.x = THREE.MathUtils.clamp(HM.x.x, -0.07, 0.07); HM.x.y = THREE.MathUtils.clamp(HM.x.y, -0.04, 0.04); HM.x.z = THREE.MathUtils.clamp(HM.x.z, -0.06, 0.06);
    // eyes lead into the corner: the lateral load says which way and how hard (about 0.6 deg/g, at most 2.5)
    const look = THREE.MathUtils.clamp(aR * 0.01, -0.044, 0.044);
    HM.yaw += (look - HM.yaw) * (1 - Math.exp(-dt / 0.35));
    // engine and road buzz: tiny and fast, grows with speed; enough to feel, not to blur
    HM.buzz += dt;
    const sp = Math.min(1, (car.speed || 0) / 90), bz = 0.0009 * sp;
    const bx = Math.sin(HM.buzz * 71) * bz * 0.6, by = (Math.sin(HM.buzz * 53) + Math.sin(HM.buzz * 89 + 1.3) * 0.5) * bz;
    pos.addScaledVector(_hr, HM.x.x + bx).addScaledVector(_hu, HM.x.y + by).addScaledVector(_hf, -HM.x.z);
    camera.rotateY(-HM.yaw);
    // the neck holds the eyes nearly level: only a slight nod and tip (under 1.5 degrees)
    camera.rotateX(HM.x.z * 0.35 - HM.x.y * 0.15); // nods down as it is thrown forward
    camera.rotateZ(-HM.x.x * 0.3); // and tips with the sideways load
  }
  // the loading-screen shot: low, outside the hero corner, long lens on the pack
  function loadCam(L, dt) {
    if (!L) return;
    const tr = L.tr, side = L.hero.side, t = L.t;
    const s = L.apexS + 18 + t * 1.2;
    const out = side > 0 ? 0 : 1;
    const bar = tr.barr[out][L.hero.minI];
    if (tr.def.style === 'street') {
      // crane shot over the corner: the walls are too close for a trackside camera
      const [hx, hz] = Tracks.pointAt(tr, L.apexS + 6 + t * 0.6, -side * (tr.hw - 1.2));
      camera.position.set(hx, 7.5 - t * 0.25 + Tracks.groundAt(tr, hx, hz), hz);
      const ld = L.cars[0];
      C.look.set(ld.x, 0.6 + Tracks.groundAt(tr, ld.x, ld.y), ld.y); camera.lookAt(C.look);
      const dd = camera.position.distanceTo(C.look);
      setFov(U.clamp(2 * Math.atan(9 / dd) * 180 / Math.PI, 8, 45), dt, true);
      return;
    }
    const [x, z] = Tracks.pointAt(tr, s, -side * Math.min(bar - 0.8, Math.max(tr.hw + 3, bar - 1.8)));
    camera.position.set(x, 1.4 + t * 0.12 + Tracks.groundAt(tr, x, z), z);
    const lead = L.cars[1] || L.cars[0];
    C.look.set(lead.x, 0.7 + Tracks.groundAt(tr, lead.x, lead.y), lead.y);
    camera.lookAt(C.look);
    const dist = camera.position.distanceTo(C.look);
    setFov(U.clamp(2 * Math.atan(11 / dist) * 180 / Math.PI, 6, 40), dt, true);
  }

  // ---------- frame ----------
  let clock = 0;
  // A graphics report for tracking down a browser that draws the game differently (F9 in game):
  // what the GPU is, what it supports, whether the sky lighting probe came out lit, and which
  // shaders (if any) failed to compile.
  function diagnose() {
    const out = {};
    try {
      const gl = renderer.getContext(), dbg = gl.getExtension('WEBGL_debug_renderer_info');
      out.gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      out.webgl2 = !!renderer.capabilities.isWebGL2;
      out.ext = ['EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'OES_texture_float_linear', 'KHR_parallel_shader_compile', 'EXT_texture_filter_anisotropic']
        .map(e => e.replace(/^(EXT|OES|KHR)_/, '') + (gl.getExtension(e) ? ' yes' : ' NO')).join(', ');
      out.limits = 'textures ' + gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) + ', frag uniforms ' + gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) + ', max size ' + gl.getParameter(gl.MAX_TEXTURE_SIZE);
      const progs = renderer.info.programs || [];
      const bad = progs.filter(p => p.diagnostics && p.diagnostics.runnable === false);
      out.programs = progs.length + ' compiled, ' + bad.length + ' failed' + (bad.length ? ': ' + bad.map(p => p.name || p.cacheKey.slice(0, 30)).join(' | ') : '');
      if (bad.length) out.firstError = String((bad[0].diagnostics.fragmentShader && bad[0].diagnostics.fragmentShader.log) || bad[0].diagnostics.programLog || '').slice(0, 300);
      // the sky light probe: read a few texels back (zero means the scene gets no sky light)
      if (envRT) {
        try {
          const w = envRT.width, h = envRT.height, buf = new Uint16Array(4 * 4);
          renderer.readRenderTargetPixels(envRT, Math.floor(w * 0.3), Math.floor(h * 0.25), 2, 2, buf);
          let s = 0; for (let k = 0; k < 16; k += 4) s += THREE.DataUtils.fromHalfFloat(buf[k + 1]);
          out.skyProbe = (s / 4).toFixed(3) + (s > 0 ? ' (lit)' : ' (DARK: no sky light)');
        } catch (e) { out.skyProbe = 'read failed: ' + e.message; }
      } else out.skyProbe = 'none';
      out.post = JSON.stringify(F1.R3Post.status ? F1.R3Post.status() : {});
      out.shadows = (renderer.shadowMap.enabled ? 'on' : 'off') + ', ' + F1.R3Shadow.S.lights.map(l => l.shadow.mapSize.x + (l.shadow.map ? '' : ' (no map)')).join('/');
      const c = renderer.domElement;
      out.screen = c.width + 'x' + c.height + ' @ dpr ' + (window.devicePixelRatio || 1) + ', zoom ' + Math.round(window.outerWidth / window.innerWidth * 100) + '%';
      out.browser = navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 140);
    } catch (e) { out.error = e.message; }
    return out;
  }

  // Compile every shader program the scene needs before the first frame, in the background
  // where the browser supports it (KHR_parallel_shader_compile via three's compileAsync). Done
  // inside the first render instead, the compiles hold the page for many seconds.
  function precompile(cars) {
    if (!renderer || !state.tr || !renderer.compileAsync) return Promise.resolve();
    updateCars(cars || state.lastCars || [], 0, null); // the car models join the scene here
    // programs are keyed on the target they draw into: the post stack draws the scene into a
    // linear HDR target with no tone mapping, so compile against one
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(F1.R3Post.Q.on ? rt : null);
    // and with the tone mapping the frame will use (the post stack does its own)
    const tm = renderer.toneMapping;
    renderer.toneMapping = F1.R3Post.Q.on ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    // compile walks only visible objects: show the hidden ones (car LOD levels, spares) for it
    const hid = [];
    scene.traverse(o => { if (!o.visible && o !== state.grass) { hid.push(o); o.visible = true; } });
    let p;
    try { p = renderer.compileAsync(scene, camera); } catch (e) { p = Promise.resolve(); }
    hid.forEach(o => { o.visible = false; });
    renderer.toneMapping = tm;
    renderer.setRenderTarget(prev);
    return Promise.all([p.catch(() => {}), F1.R3Post.Q.on ? F1.R3Post.precompile() : null]).then(() => rt.dispose());
  }

  function render(o) {
    if (!renderer || !state.tr || compiling) return;
    const dt = o.dt || 0.016;
    clock += dt;
    state.lastCars = o.cars;
    updateCars(o.cars || [], dt, o.mode === 'cockpit' ? o.focus : null);
    // tree draw distance (advanced graphics; 700 m in Rock): tiles whose nearest edge is further are skipped
    if (GFX.treeDist > 0 && state.dens) for (const m of state.dens) {
      const bs = m.isInstancedMesh ? m.boundingSphere : m.geometry.boundingSphere; // the tile's own sphere, not one tree's
      if (!bs) continue;
      m.visible = camera.position.distanceTo(bs.center) - bs.radius < GFX.treeDist;
    } else if (state.dens && state.densCulled) for (const m of state.dens) m.visible = true;
    if (state.dens) state.densCulled = GFX.treeDist > 0;
    updateGhost(o.ghost);
    updateFx(o.fx, dt);
    if (F1.R3D) F1.R3D.stepDebris(dt, state.tr);
    updateAssist(o.assist);
    const lit = o.lightsOn || 0;
    state.gantry.forEach((m, k) => { m.emissiveIntensity = k < lit ? 7 : 0; });
    skyReady();
    updateCamera(o);
    applyWeather(o.weather, dt);
    updateSC(o.sc, dt);
    // sky follows the camera; shadows follow the point of interest
    skyMesh.position.copy(camera.position);
    skyMat.uniforms.time.value = clock;
    if (state.grass && state.grass.visible) F1.R3Grass.update(state.grass, camera, clock);
    F1.R3S.U.uWindT.value = clock; // the same gusts on the ground as in the 3D grass
    // the sun: a direction (its light needs no position); its shadow comes from the cascades,
    // fitted to the camera's view each frame
    if (G.__sunDir) state.sunDir.fromArray(G.__sunDir).normalize(); // debug: [x, y, z] toward the sun (world)
    sun.target.position.set(0, 0, 0);
    sun.position.copy(state.sunDir).multiplyScalar(400);
    camera.updateMatrixWorld();
    F1.R3Shadow.update(camera, state.sunDir);
    // the cars nearest the camera hide the sky from the road under them
    {
      const cx = camera.position.x, cz = camera.position.z, near = [];
      for (const [car, m] of live) {
        if (!m.visible || car.retired && car.hidden) continue;
        const d = (car.x - cx) ** 2 + (car.y - cz) ** 2;
        if (d < 120 * 120) near.push([d, car, m]);
      }
      near.sort((a, b) => a[0] - b[0]);
      F1.R3Shadow.setCars(G.__noCarOcc ? [] : near.slice(0, 8).map(([, car, m]) => ({ x: car.x, y: m.userData.gy || 0, z: car.y, h: car.h })));
    }
    if (MATS.water && MATS.water.normalMap) MATS.water.normalMap.offset.set(clock * 0.01, clock * 0.006);
    const exposure = (state.exposure || 1) * Math.pow(2, GFX.ev || 0) * (state.wxExp || 1);
    F1.R3Shadow.U.r3SunA.value = F1.R3Post.Q.on ? 1 : 0;
    if (F1.R3Post.Q.on) {
      renderer.toneMapping = THREE.NoToneMapping;
      const mode = C.mode;
      F1.R3Post.render(scene, camera, {
        exposure, dt: o.dt || 0, sunDir: state.sunDir, sunCol: sun.color,
        motionNear: mode === 'tv' || mode === 'load' || mode === 'orbit' ? 1e6 : mode === 'show' ? 9.5 : mode === 'cockpit' || mode === 'helmet' || mode === 'tcam' ? 3.5 : 9.5,
        vel: G.__noVel ? null : velMovers(o.cars || []),
      });
    } else {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = exposure;
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    }
  }

  // cars for the motion blur's velocity pass: only those within 60 m of the camera (a far car
  // barely moves on screen relative to the scenery); the rest leave layer 5
  function velMovers(cars) {
    const out = [];
    for (const c of cars) {
      const m = live.get(c); if (!m) continue;
      const on = m.visible !== false && Math.hypot(c.x - camera.position.x, c.y - camera.position.z) < 60;
      if (on !== !!m.userData.velOn) { m.userData.velOn = on; for (const q of m.userData.velParts) q.visible = on; }
      if (on) out.push(m);
    }
    if (!out.length) return null;
    // called by the post pass after the main render has updated the world matrices
    const sync = () => { for (const m of out) { const [sp, hull] = m.userData.velParts; sp.matrix.copy(m.userData.ground.matrixWorld); hull.matrix.copy(m.userData.body.matrixWorld); } };
    return { scene: velScene, sync, meshes: out.flatMap(m => m.userData.velParts) };
  }

  // world point -> CSS pixels (null when behind the camera)
  const PJ = new THREE.Vector3();
  function project(x, y, h) {
    PJ.set(x, h + (state.tr ? Tracks.groundAt(state.tr, x, y) : 0), y).project(camera);
    if (PJ.z > 1 || PJ.z < -1) return null;
    return { x: (PJ.x + 1) / 2 * W, y: (1 - PJ.y) / 2 * H, d: camera.position.distanceTo(V(x, h, y)) };
  }

  F1.R3 = { HM, potatoBoot: () => POT, bootTier: () => (ROCK ? 'rock' : POT ? 'potato' : ''), init, resize, setTrack, render, precompile, diagnose, project, setQuality, GFX, MODES, LOOKS, get camera() { return camera; }, get renderer() { return renderer; }, get scene() { return scene; } };
})(typeof window !== 'undefined' ? window : globalThis);
