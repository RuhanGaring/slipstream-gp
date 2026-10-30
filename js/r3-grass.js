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
    return mesh;
  }

  // keep the clump grid centred on the camera (snapped to whole cells)
  function update(mesh, camera, time) {
    if (!mesh) return;
    const cam = camera.position || camera;
    const u = mesh.material.userData.grass, half = mesh.userData.grassHalf;
    u.uGOrigin.value.set(Math.floor(cam.x / CELL) * CELL - half * CELL, Math.floor(cam.z / CELL) * CELL - half * CELL);
    u.uGTime.value = time;
  }

  // shader injection used by F1.R3S.patch when a material carries userData.grass
  const VERT_PARS = [
    'attribute vec2 gOff;',
    'uniform vec2 uGOrigin; uniform float uGCell; uniform float uGR; uniform float uGTime;',
    'uniform sampler2D uGMask; uniform vec4 uGMaskB; uniform sampler2D uGHeight; uniform vec4 uGHeightB;',
    'uniform sampler2D uGMacro;',
    'varying vec2 vGWp; varying float vGShade;',
    // (a sin()-based hash falls apart at world coordinates of hundreds of metres)
    'float gHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }',
  ].join('\n');
  const VERT = [
    '  vec2 gBase = uGOrigin + gOff * uGCell;',
    '  vec2 gWp = gBase + (vec2(gHash(gBase), gHash(gBase + 3.17)) - 0.5) * uGCell * 1.1;',
    '  float gDens = clamp((texture2D(uGMask, (gWp - uGMaskB.xy) / uGMaskB.zw).r - 0.2) / 0.8, 0.0, 1.0);',
    '  float gH = texture2D(uGHeight, (gWp - uGHeightB.xy) / uGHeightB.zw).r;',
    '  float gDist = distance(gWp, cameraPosition.xz);',
    '  float gKeep = step(0.05, gDens) * step(gHash(gBase + 7.7), gDens) * (1.0 - smoothstep(uGR * 0.55, uGR, gDist));',
    '  float gSc = gKeep * (0.75 + 0.5 * gHash(gBase + 5.3));',
    '  float gA = gHash(gBase + 9.1) * 6.2831;',
    '  transformed.xz = mat2(cos(gA), -sin(gA), sin(gA), cos(gA)) * transformed.xz;',
    '  transformed *= vec3(gSc, gSc * (0.75 + 0.45 * gDens), gSc);',
    '  transformed.xz += vec2(sin(uGTime * 1.8 + gWp.x * 0.33 + gWp.y * 0.21), cos(uGTime * 1.4 + gWp.y * 0.29)) * 0.04 * transformed.y / 0.26;',
    '  transformed += vec3(gWp.x, gH + 0.02, gWp.y);',
    // the turf takes the ground's own colour: the fragment shader projects the ground photo
    // straight down onto the blades (so they carry the same detail as the field around them),
    // and the ground's large-scale macro variation is applied per clump here
    '  vGWp = transformed.xz;',
    '  float gM = textureLod(uGMacro, gWp / 140.0, 0.0).r * 0.6 + textureLod(uGMacro, gWp / 29.4, 0.0).g * 0.4;',
    '  vGShade = mix(0.78, 1.22, gM) * (0.96 + 0.08 * gHash(gBase + 11.3));',
  ].join('\n');
  function patchShader(sh, u) {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = VERT_PARS + '\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT);
    sh.fragmentShader = 'varying vec2 vGWp; varying float vGShade; uniform sampler2D uGGround; uniform sampler2D uGMacro; uniform float uGNorm;\n' + F1.R3S.LAWN + '\n' + sh.fragmentShader
      .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.rgb *= texture2D(uGGround, vGWp / 3.2).rgb * vGShade * uGNorm * lawnTint(uGMacro, vGWp, cameraPosition) * lawnBreak(uGGround, vGWp);')
      // both faces of a card take the ground's up normal (a flipped back face would go dark)
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  normal = normalize(vNormal);');
  }

  F1.R3Grass = { build, update, patchShader };
})(typeof window !== 'undefined' ? window : globalThis);
