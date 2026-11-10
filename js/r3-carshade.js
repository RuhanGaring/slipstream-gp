// The shade a car casts on the road from the sky, traced from the car's real shape.
//
// Physically, the light a patch of road gets from the sky is the sky's light over the half of
// all directions above it, each weighted by how steeply it comes down (the cosine). Under and
// round a car, part of that sky is hidden by the car. This module measures how much, for a grid
// of road points round the car, by Monte Carlo over the sky: for each of N directions spread over
// the sky in proportion to that cosine weight, the car's merged shadow mesh (its real shape,
// js/r3-car.js meta.shadow) is drawn from that direction into a small depth map, and every road
// point of the grid checks whether the car stands between it and that part of the sky. The share
// of directions left open is the point's sky visibility: 0 all hidden, 1 open sky.
//
// Two ways to use it (Settings > Advanced graphics > Car shade):
//   traced  the reference: the nearest car traced live from its pose on its suspension (heave,
//           pitch and roll over the road under it). Each trace is complete (all directions) and
//           built in the background, a few directions a frame, while the last finished one is
//           shown: a part-done trace is never seen, so the shade has no noise
//   baked   the fast one, built from the reference: the same trace run once per car model while
//           the circuit loads (the car at rest, all directions), kept as a texture, so a pixel
//           reads one value
// Both write into one atlas (a row per car model, two per live slot: shown and being built). The composite
// (js/r3-post.js carSky) reads it for the road round each car near the camera. The sun's own
// shadow is the cascaded shadow map (js/r3-shadow.js): this is the sky's share of the light.
(function (G) {
  'use strict';
  const F1 = G.F1, THREE = G.THREE;

  // the grid round a car, in the frame of the road under it (x forward, y up, z right), metres
  const X0 = -4.4, X1 = 4.4, Z0 = -2.2, Z1 = 2.2, NX = 256, NZ = 128;
  const BAKE_N = 256, LIVE_N = 8; // directions: a full trace; added to the live one each frame
  const LIVE = 1, ROWS = 16, MODEL_ROWS = ROWS - LIVE * 2;
  const DEPTH = 256, REACH = 4.8, CAM = 8; // depth map size, its half width and its distance (m)

  let R = null, atlas = null, depthRT = null;
  const rowOf = new Map(); // car model id -> atlas row
  const U = {
    uShadeMap: { value: null }, uShadeOn: { value: 0 },
    uShadeExt: { value: new THREE.Vector4(X0, Z0, X1 - X0, Z1 - Z0) }, uShadeRows: { value: ROWS },
    // per car near the camera (the same order as js/r3-shadow.js uOccCar): the inverse of the
    // road frame under it, and its atlas row (-1: none)
    uShadeInv: { value: Array.from({ length: 8 }, () => new THREE.Matrix4()) }, uShadeRow: { value: new Array(8).fill(-1) },
  };
  // for the composite: the sky left to a road point near the cars, from the atlas
  const GLSL = [
    'uniform sampler2D uShadeMap; uniform vec4 uShadeExt; uniform float uShadeRows; uniform mat4 uShadeInv[8]; uniform float uShadeRow[8];',
    'float r3CarShade(vec3 wp, vec3 wn) {',
    '  float vis = 1.0;',
    '  for (int i = 0; i < 8; i++) {',
    '    if (i < uOccN && uShadeRow[i] >= 0.0) {',
    '      vec3 lp = (uShadeInv[i] * vec4(wp, 1.0)).xyz;',
    '      vec2 f = (lp.xz - uShadeExt.xy) / uShadeExt.zw;',
    '      if (all(greaterThan(f, vec2(0.0))) && all(lessThan(f, vec2(1.0)))) {',
    '        vec3 ln = normalize(mat3(uShadeInv[i]) * wn);',
    // the road (facing up, under 0.2 m), or a point just above it that does not face up (the
    // foot of a tyre: its anti-aliased edge pixels hold road colour), which takes the road's value
    '        float g = (1.0 - smoothstep(0.06, 0.2, lp.y)) * smoothstep(0.3, 0.7, ln.y);',
    '        float lw = (1.0 - smoothstep(0.02, 0.12, lp.y)) * (1.0 - smoothstep(0.3, 0.7, ln.y));',
    '        float w = max(g, lw);',
    '        if (w > 0.0) {',
    // (one level, read with textureLod: an ordinary read inside a loop gives the GPU's derivative
    // based level choice nothing to go on)
    '          float v = textureLod(uShadeMap, vec2(f.x, (uShadeRow[i] + f.y) / uShadeRows), 0.0).r;',
    // (to open sky over the last 0.3 m of the grid, so its edge never shows)
    '          vec2 e = min(f, 1.0 - f) * uShadeExt.zw;',
    '          v = mix(1.0, v, smoothstep(0.0, 0.3, min(e.x, e.y)));',
    '          vis *= mix(1.0, v, w);',
    '        }',
    '      }',
    '    }',
    '  }',
    '  return vis;',
    '}'].join('\n');

  // cosine-weighted directions over the sky (a Fibonacci spiral: even cover, no clumps)
  const SKY = [];
  for (let i = 0; i < BAKE_N; i++) {
    const u = (i + 0.5) / BAKE_N, phi = i * 2.399963229728653, r = Math.sqrt(u);
    SKY.push(new THREE.Vector3(r * Math.cos(phi), Math.sqrt(Math.max(0, 1 - u)), r * Math.sin(phi)));
  }

  // the car seen from one sky direction: its distance from that side (/64), nearest kept;
  // an empty texel (0) means no car there
  const depthMat = new THREE.ShaderMaterial({
    vertexShader: 'varying float vD; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vD = -mv.z; gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'varying float vD; void main(){ gl_FragColor = vec4(vD / 64.0, 0.0, 0.0, 1.0); }',
    side: THREE.DoubleSide,
  });
  // each road point of the grid: is the sky in this direction open? (adds its weight where it is)
  const accMat = new THREE.ShaderMaterial({
    uniforms: { tD: { value: null }, uVP: { value: new THREE.Matrix4() }, uV: { value: new THREE.Matrix4() }, uW: { value: 0 }, uExt: U.uShadeExt },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: [
      'varying vec2 vUv; uniform sampler2D tD; uniform mat4 uVP; uniform mat4 uV; uniform float uW; uniform vec4 uExt;',
      'void main(){',
      '  vec3 P = vec3(uExt.x + vUv.x * uExt.z, 0.004, uExt.y + vUv.y * uExt.w);',
      '  vec4 c = uVP * vec4(P, 1.0); vec2 uv = c.xy / c.w * 0.5 + 0.5;',
      '  float dP = -(uV * vec4(P, 1.0)).z;',
      '  float open = 1.0;',
      // (blocked where the car is nearer that side of the sky than the point is)
      '  if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) { float s = texture2D(tD, uv).r; if (s > 0.0 && s * 64.0 < dP - 0.03) open = 0.0; }',
      '  gl_FragColor = vec4(open * uW, 0.0, 0.0, 1.0);',
      '}'].join('\n'),
    blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
  });
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const quad = new THREE.Mesh(tri, accMat); quad.frustumCulled = false;
  const qScene = new THREE.Scene(); qScene.add(quad);
  const carScene = new THREE.Scene(), carMesh = new THREE.Mesh(new THREE.BufferGeometry(), depthMat);
  carMesh.matrixAutoUpdate = false; carMesh.frustumCulled = false; carScene.add(carMesh);
  carScene.matrixWorldAutoUpdate = false;
  const dcam = new THREE.OrthographicCamera(-REACH, REACH, REACH, -REACH, 0.1, CAM * 2.5);
  const _vp = new THREE.Matrix4(), _c = new THREE.Color(), BLACK = new THREE.Color(0, 0, 0);

  function init(renderer) {
    R = renderer;
    const o = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    atlas = new THREE.WebGLRenderTarget(NX, NZ * ROWS, o);
    depthRT = new THREE.WebGLRenderTarget(DEPTH, DEPTH, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
    U.uShadeMap.value = atlas.texture;
    // every row starts as open sky, so a row read before it is filled shades nothing
    withState(() => { for (let r = 0; r < ROWS; r++) { into(atlas, r); R.setClearColor(new THREE.Color(1, 1, 1), 1); R.clear(true, false, false); } });
  }
  function withState(fn) {
    const prev = R.getRenderTarget(), au = R.shadowMap.autoUpdate, ac = R.autoClear, cc = R.getClearColor(_c).clone(), ca = R.getClearAlpha();
    R.shadowMap.autoUpdate = false; R.autoClear = false;
    try { fn(); } finally {
      atlas.scissorTest = false; atlas.viewport.set(0, 0, NX, NZ * ROWS); atlas.scissor.set(0, 0, NX, NZ * ROWS);
      R.setRenderTarget(prev); R.shadowMap.autoUpdate = au; R.autoClear = ac; R.setClearColor(cc, ca);
    }
  }
  // draw into one row of the atlas, or into the slice target (row < 0)
  function into(rt, row) {
    if (rt === atlas) { atlas.viewport.set(0, row * NZ, NX, NZ); atlas.scissor.set(0, row * NZ, NX, NZ); atlas.scissorTest = true; }
    R.setRenderTarget(rt);
  }

  // add the open share of n sky directions (each weighing w) into rt (an atlas row, or the
  // slice), for the car geometry geo placed by matrix m in the road's frame
  function trace(rt, row, geo, m, dirOf, n, w) {
    carMesh.geometry = geo; carMesh.matrix.copy(m); carMesh.matrixWorld.copy(m);
    quad.material = accMat;
    for (let k = 0; k < n; k++) {
      const d = dirOf(k);
      dcam.position.copy(d).multiplyScalar(CAM);
      if (d.y > 0.99) dcam.up.set(1, 0, 0); else dcam.up.set(0, 1, 0);
      dcam.lookAt(0, 0, 0); dcam.updateMatrixWorld();
      R.setRenderTarget(depthRT); R.setClearColor(BLACK, 1); R.clear(true, true, false);
      R.render(carScene, dcam);
      _vp.multiplyMatrices(dcam.projectionMatrix, dcam.matrixWorldInverse);
      const u = accMat.uniforms;
      u.tD.value = depthRT.texture; u.uVP.value.copy(_vp); u.uV.value.copy(dcam.matrixWorldInverse); u.uW.value = w;
      into(rt, row);
      R.render(qScene, quadCam);
    }
  }

  // the fast setting, built from the reference: all directions, once per car model, at rest
  const _I = new THREE.Matrix4();
  function bake(id, geo) {
    if (!atlas || !geo) return -1;
    if (rowOf.has(id)) return rowOf.get(id);
    if (rowOf.size >= MODEL_ROWS) return -1;
    const row = rowOf.size;
    rowOf.set(id, row);
    const t0 = performance.now();
    withState(() => {
      into(atlas, row); R.setClearColor(BLACK, 1); R.clear(true, false, false);
      trace(atlas, row, geo, _I, k => SKY[k], BAKE_N, 1 / BAKE_N);
    });
    (G.__shadeBakeMs || (G.__shadeBakeMs = {}))[id] = Math.round(performance.now() - t0);
    return row;
  }

  // the reference, live: [{ key, geo, rel }] for the nearest car (rel: the car body's matrix in
  // the frame of the road under it). Returns the atlas row its finished trace is in.
  const slots = Array.from({ length: LIVE }, () => ({ key: null, show: 0, done: 0 }));
  function live(list) {
    if (!atlas) return [];
    const out = [];
    withState(() => {
      list.slice(0, LIVE).forEach((it, s) => {
        const sl = slots[s], base = MODEL_ROWS + s * 2;
        if (sl.key !== it.key) {
          // a car new to the slot: one full trace now to show, then the background ones
          sl.key = it.key; sl.show = 0; sl.done = 0;
          into(atlas, base); R.setClearColor(BLACK, 1); R.clear(true, false, false);
          trace(atlas, base, it.geo, it.rel, k => SKY[k], BAKE_N, 1 / BAKE_N);
        }
        // the next few directions of the trace being built, from the car's pose this frame
        const back = base + 1 - sl.show;
        if (sl.done === 0) { into(atlas, back); R.setClearColor(BLACK, 1); R.clear(true, false, false); }
        const n = Math.min(LIVE_N, BAKE_N - sl.done), d0 = sl.done;
        trace(atlas, back, it.geo, it.rel, k => SKY[d0 + k], n, 1 / BAKE_N);
        sl.done += n;
        if (sl.done >= BAKE_N) { sl.show = 1 - sl.show; sl.done = 0; } // finished: show it
        out.push(base + sl.show);
      });
    });
    for (let s = list.length; s < LIVE; s++) slots[s].key = null;
    return out;
  }

  // ---------- the car's own shade ----------
  // The same trace over the car itself, once per model: every vertex of the bodywork (all its
  // detail levels) gets the share of light reaching it past the rest of the car, over the whole
  // sphere round it weighted by its own facing (the cosine), against the car in full detail. The
  // result, 0 to 1 per vertex (attribute aSky), dims the sky light and the reflections on the car
  // (js/r3-shaders.js): inside the sidepod inlets, under the wings, the floor and the cockpit rim.
  // The wheels are left out: they spin, and a shade baked onto them would turn with them.
  const SPH = 128, SPHD = [];
  for (let i = 0; i < SPH; i++) {
    const y = 1 - 2 * (i + 0.5) / SPH, r = Math.sqrt(1 - y * y), phi = i * 2.399963229728653;
    SPHD.push(new THREE.Vector3(r * Math.cos(phi), y, r * Math.sin(phi)));
  }
  const vtxMat = new THREE.ShaderMaterial({
    uniforms: { tP: { value: null }, tN: { value: null }, tD: { value: null }, uVP: { value: new THREE.Matrix4() }, uV: { value: new THREE.Matrix4() }, uDir: { value: new THREE.Vector3() } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: [
      'varying vec2 vUv; uniform sampler2D tP; uniform sampler2D tN; uniform sampler2D tD; uniform mat4 uVP; uniform mat4 uV; uniform vec3 uDir;',
      'void main(){',
      '  vec4 P = texture2D(tP, vUv); vec3 N = texture2D(tN, vUv).xyz;',
      '  float w = max(dot(N, uDir), 0.0);',
      // (lifted a little off its own surface, so the car's own skin there does not count)
      '  vec3 Q = P.xyz + N * 0.012 + uDir * 0.004;',
      '  vec4 c = uVP * vec4(Q, 1.0); vec2 uv = c.xy / c.w * 0.5 + 0.5; float dQ = -(uV * vec4(Q, 1.0)).z;',
      '  float open = 1.0;',
      '  if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) { float s = texture2D(tD, uv).r; if (s > 0.0 && s * 64.0 < dQ - 0.02) open = 0.0; }',
      '  gl_FragColor = vec4(open * w, w, 0.0, 1.0) * P.w;',
      '}'].join('\n'),
    blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
  });
  const ratioMat = new THREE.ShaderMaterial({
    uniforms: { tA: { value: null } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'varying vec2 vUv; uniform sampler2D tA; void main(){ vec4 a = texture2D(tA, vUv); gl_FragColor = vec4(a.g > 1e-4 ? a.r / a.g : 1.0, 0.0, 0.0, 1.0); }',
    depthTest: false, depthWrite: false,
  });
  const selfDone = new Set();
  // body: the car's body group (js/r3-car.js), at rest. Fills aSky on its bodywork geometries.
  function bakeSelf(id, body) {
    if (!R || selfDone.has(id)) return;
    selfDone.add(id);
    const bu = body.userData, t0 = performance.now();
    body.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(body.matrixWorld).invert(), rel = o => new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    // the occluder: every mesh of the full-detail level and the wheels, in the body's frame
    const occ = new THREE.Scene(); occ.matrixWorldAutoUpdate = false;
    const addOcc = o => o.traverse(m => { if (m.isMesh && m.geometry && m.geometry.attributes.position) { const q = new THREE.Mesh(m.geometry, depthMat); q.matrixAutoUpdate = false; q.matrix.copy(rel(m)); q.matrixWorld.copy(q.matrix); q.frustumCulled = false; occ.add(q); } });
    if (bu.lodGroups && bu.lodGroups[0]) { const g = bu.lodGroups[0], was = g.visible; addOcc(g); g.visible = was; }
    for (const w of bu.wheels || []) addOcc(w);
    // the receivers: each distinct geometry of the bodywork levels (not the wheels)
    const geos = new Map();
    for (const g of bu.lodGroups || []) g.traverse(m => { if (m.isMesh && m.geometry && m.geometry.attributes.normal && !geos.has(m.geometry)) geos.set(m.geometry, rel(m)); });
    if (bu.farG) bu.farG.traverse(m => { if (m.isMesh && m.geometry && m.geometry.attributes.normal && !geos.has(m.geometry)) geos.set(m.geometry, rel(m)); });
    let V = 0;
    for (const g of geos.keys()) V += g.attributes.position.count;
    if (!V) return;
    const W = 1024, H = Math.ceil(V / W), P = new Float32Array(W * H * 4), N = new Float32Array(W * H * 4);
    const v = new THREE.Vector3(), n = new THREE.Vector3(), nm = new THREE.Matrix3();
    let o = 0;
    const spans = [];
    for (const [g, m] of geos) {
      const A = g.attributes.position, B = g.attributes.normal; nm.getNormalMatrix(m);
      spans.push([g, o, A.count]);
      for (let i = 0; i < A.count; i++, o++) {
        v.fromBufferAttribute(A, i).applyMatrix4(m); n.fromBufferAttribute(B, i).applyMatrix3(nm).normalize();
        P[o * 4] = v.x; P[o * 4 + 1] = v.y; P[o * 4 + 2] = v.z; P[o * 4 + 3] = 1;
        N[o * 4] = n.x; N[o * 4 + 1] = n.y; N[o * 4 + 2] = n.z;
      }
    }
    const tex = a => { const t = new THREE.DataTexture(a, W, H, THREE.RGBAFormat, THREE.FloatType); t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true; return t; };
    const tP = tex(P), tN = tex(N);
    const acc = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
    const out8 = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
    const bytes = new Uint8Array(W * H * 4);
    withState(() => {
      R.setRenderTarget(acc); R.setClearColor(BLACK, 1); R.clear(true, false, false);
      for (const d of SPHD) {
        dcam.position.copy(d).multiplyScalar(CAM); if (Math.abs(d.y) > 0.99) dcam.up.set(1, 0, 0); else dcam.up.set(0, 1, 0);
        dcam.lookAt(0, 0.4, 0.4 * 0); dcam.updateMatrixWorld();
        R.setRenderTarget(depthRT); R.setClearColor(BLACK, 1); R.clear(true, true, false);
        R.render(occ, dcam);
        const u = vtxMat.uniforms;
        u.tP.value = tP; u.tN.value = tN; u.tD.value = depthRT.texture; u.uDir.value.copy(d);
        u.uVP.value.multiplyMatrices(dcam.projectionMatrix, dcam.matrixWorldInverse); u.uV.value.copy(dcam.matrixWorldInverse);
        quad.material = vtxMat; R.setRenderTarget(acc); R.render(qScene, quadCam);
      }
      ratioMat.uniforms.tA.value = acc.texture; quad.material = ratioMat; R.setRenderTarget(out8); R.render(qScene, quadCam);
      R.readRenderTargetPixels(out8, 0, 0, W, H, bytes);
      quad.material = accMat;
    });
    for (const [g, o0, cnt] of spans) {
      const a = new Uint8Array(cnt);
      for (let i = 0; i < cnt; i++) a[i] = bytes[(o0 + i) * 4];
      g.setAttribute('aSky', new THREE.BufferAttribute(a, 1, true));
    }
    tP.dispose(); tN.dispose(); acc.dispose(); out8.dispose();
    (G.__selfAOMs || (G.__selfAOMs = {}))[id] = Math.round(performance.now() - t0);
  }

  // ---------- the circuit's own shade on the road ----------
  // The same physical trace for the road itself, once per circuit while it loads: a grid along
  // the lap (every 0.5 m) and across the road and its kerbs, each point's share of open sky past
  // the circuit's solid scenery (walls, barriers, stands, pit building, buildings, bridges; not
  // the trees), 48 cosine-weighted sky directions, the lap taken in 600 m sections each with its
  // own depth maps (about 0.3 m a texel). The road's material reads it (js/r3-shaders.js
  // asphaltWear) and dims its sky light and reflections: the shade at the foot of a wall, under
  // a bridge, between city buildings.
  const ROAD_DIRS = (() => { const n = 48, o = []; for (let i = 0; i < n; i++) { const u = (i + 0.5) / n, phi = i * 2.399963229728653, r = Math.sqrt(u); o.push(new THREE.Vector3(r * Math.cos(phi), Math.sqrt(Math.max(0, 1 - u)), r * Math.sin(phi))); } return o; })();
  const roadAcc = new THREE.ShaderMaterial({
    uniforms: { tP: { value: null }, tD: { value: null }, uVP: { value: new THREE.Matrix4() }, uV: { value: new THREE.Matrix4() }, uU: { value: new THREE.Vector2() }, uW: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: [
      'varying vec2 vUv; uniform sampler2D tP; uniform sampler2D tD; uniform mat4 uVP; uniform mat4 uV; uniform vec2 uU; uniform float uW;',
      'void main(){',
      '  vec3 Q = texture2D(tP, vec2(uU.x + vUv.x * uU.y, vUv.y)).xyz + vec3(0.0, 0.06, 0.0);',
      '  vec4 c = uVP * vec4(Q, 1.0); vec2 uv = c.xy / c.w * 0.5 + 0.5; float dQ = -(uV * vec4(Q, 1.0)).z;',
      '  float open = 1.0;',
      '  if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) { float s = texture2D(tD, uv).r; if (s > 0.0 && s < dQ - 0.15) open = 0.0; }',
      '  gl_FragColor = vec4(open * uW, 0.0, 0.0, 1.0);',
      '}'].join('\n'),
    blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
  });
  const roadDepthMat = new THREE.ShaderMaterial({
    vertexShader: 'varying float vD; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vD = -mv.z; gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'varying float vD; void main(){ gl_FragColor = vec4(vD, 0.0, 0.0, 1.0); }',
    side: THREE.DoubleSide,
  });
  // tr: the circuit; root: its scenery. Returns { tex, L, d0, dw } or null.
  function bakeRoad(tr, root) {
    if (!R || !R.capabilities.isWebGL2 || !R.extensions.get('EXT_color_buffer_float')) return null;
    const t0 = performance.now(), L = tr.L, NS = Math.min(8192, Math.ceil(L / 0.5)), ND = 48, half = tr.hw + 1.2, d0 = -half, dw = half * 2;
    // the grid's points on the road surface
    const P = new Float32Array(NS * ND * 4);
    for (let i = 0; i < NS; i++) {
      const s = (i + 0.5) / NS * L;
      for (let j = 0; j < ND; j++) {
        const d = d0 + (j + 0.5) / ND * dw, xz = F1.Tracks.pointAt(tr, s, d), y = F1.Tracks.surfS(tr, s, d), o = (j * NS + i) * 4;
        P[o] = xz[0]; P[o + 1] = y; P[o + 2] = xz[1]; P[o + 3] = 1;
      }
    }
    const tP = new THREE.DataTexture(P, NS, ND, THREE.RGBAFormat, THREE.FloatType); tP.minFilter = tP.magFilter = THREE.NearestFilter; tP.needsUpdate = true;
    // the occluders: the scenery's solid shadow casters (the merged copies included), not the trees
    const occ = new THREE.Scene(); occ.matrixWorldAutoUpdate = false;
    root.traverse(m => {
      if (!m.isMesh || !m.castShadow || m.isInstancedMesh || !m.geometry || m.geometry.isInstancedBufferGeometry) return;
      const mt = Array.isArray(m.material) ? m.material[0] : m.material;
      if (mt && (mt.transparent || mt.alphaTest > 0)) return;
      const q = new THREE.Mesh(m.geometry, roadDepthMat); q.matrixAutoUpdate = false; q.matrix.copy(m.matrixWorld); q.matrixWorld.copy(m.matrixWorld); q.layers.enableAll(); occ.add(q);
    });
    if (!occ.children.length) { tP.dispose(); return null; }
    const acc = new THREE.WebGLRenderTarget(NS, ND, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    acc.texture.wrapS = THREE.RepeatWrapping;
    const DM = 2048, dRT = new THREE.WebGLRenderTarget(DM, DM, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2000); cam.layers.enableAll();
    const SEC = Math.max(1, Math.round(L / 600)), per = Math.ceil(NS / SEC), ctr = new THREE.Vector3(), q = new THREE.Vector3();
    withState(() => {
      R.setRenderTarget(acc); R.setClearColor(BLACK, 1); R.clear(true, false, false);
      for (let sec = 0; sec < SEC; sec++) {
        const i0 = sec * per, i1 = Math.min(NS, i0 + per);
        if (i0 >= i1) break;
        // the section's middle and reach
        ctr.set(0, 0, 0); let n = 0, rad = 0;
        for (let i = i0; i < i1; i += 4) for (const j of [0, ND - 1]) { const o = (j * NS + i) * 4; ctr.x += P[o]; ctr.y += P[o + 1]; ctr.z += P[o + 2]; n++; }
        ctr.multiplyScalar(1 / n);
        for (let i = i0; i < i1; i += 4) for (const j of [0, ND - 1]) { const o = (j * NS + i) * 4; rad = Math.max(rad, q.set(P[o], P[o + 1], P[o + 2]).distanceTo(ctr)); }
        rad += 40;
        cam.left = cam.bottom = -rad; cam.right = cam.top = rad; cam.near = 1; cam.far = rad * 2 + 600; cam.updateProjectionMatrix();
        const u = roadAcc.uniforms;
        u.uU.value.set(i0 / NS, (i1 - i0) / NS); u.uW.value = 1 / ROAD_DIRS.length;
        for (const d of ROAD_DIRS) {
          cam.position.copy(ctr).addScaledVector(d, rad + 300); cam.up.set(d.y > 0.99 ? 1 : 0, d.y > 0.99 ? 0 : 1, 0); cam.lookAt(ctr); cam.updateMatrixWorld();
          R.setRenderTarget(dRT); R.setClearColor(BLACK, 1); R.clear(true, true, false);
          R.render(occ, cam);
          u.tP.value = tP; u.tD.value = dRT.texture; u.uVP.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); u.uV.value.copy(cam.matrixWorldInverse);
          acc.viewport.set(i0, 0, i1 - i0, ND); acc.scissor.set(i0, 0, i1 - i0, ND); acc.scissorTest = true;
          quad.material = roadAcc; R.setRenderTarget(acc); R.render(qScene, quadCam);
        }
      }
      acc.scissorTest = false; acc.viewport.set(0, 0, NS, ND); acc.scissor.set(0, 0, NS, ND);
      quad.material = accMat;
    });
    tP.dispose(); dRT.dispose();
    G.__roadSkyMs = Math.round(performance.now() - t0);
    return { tex: acc.texture, rt: acc, L, d0, dw };
  }

  F1.R3CarShade = { U, GLSL, init, bake, bakeSelf, bakeRoad, live, rowOf, ROWS, MODEL_ROWS, NX, NZ, get atlas() { return atlas; }, X0, X1, Z0, Z1 };
})(typeof window !== 'undefined' ? window : globalThis);
