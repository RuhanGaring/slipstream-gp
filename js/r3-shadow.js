// Cascaded sun shadows for the 3D renderer (after the cascaded shadow maps of three.js's CSM
// add-on, MIT licence, reworked for this renderer).
//
// The view is cut into three slices by distance, each with its own shadow map: a dense one
// for the few metres around the camera (where a tyre meets the road and a floor sits three
// centimetres off it, so the car's own shadow reaches right into the contact), a middle one,
// and a wide one for the scenery. Each slice's shadow camera is fitted to a sphere around
// its part of the view frustum (a sphere does not change size as the camera turns, so the
// shadows do not shimmer) and snapped to whole texels. Neighbouring slices overlap and
// cross-fade. Depth bias is set in metres per slice, small near the camera, so shadows sit
// on their casters instead of floating off them.
//
// The cascade lights cast shadows but give no light. The sun is still the one ordinary
// directional light; the patched lit materials (js/r3-shaders.js) read the cascades, put the
// shadow on the sun, and also write how much sun reaches the surface (0 to 1) into the alpha
// of the HDR scene target, where the ambient occlusion pass (js/r3-post.js) reads it: AO is
// sky light being blocked, so it shows fully in shade and only faintly in direct sun. A
// material that misses the patch falls back to the plain chunk: lit by the sun, unshadowed.
(function (G) {
  'use strict';
  const F1 = G.F1, THREE = G.THREE;

  const N = 3;
  // per quality: shadow map size and the far edge (m of view depth) of each slice
  const Q = {
    // one slice: a single shadow pass and one map lookup per pixel, for integrated GPUs
    low: { n: 1, size: [2048], ends: [55] },
    medium: { n: 3, size: [2048, 1024, 1024], ends: [11, 55, 190] },
    high: { n: 3, size: [4096, 2048, 2048], ends: [11, 60, 260] },
    ultra: { n: 3, size: [4096, 4096, 2048], ends: [12, 70, 380] },
  };
  // depth bias (m) and PCF radius (texels) per slice
  const BIAS = [0.004, 0.025, 0.09], RADIUS = [1.6, 1.3, 1.1];
  const BACK = 260; // how far toward the sun the shadow cameras reach for casters (stands, trees)

  const S = { lights: [], on: false, q: Q.high, uni: null };

  // uniforms shared by every patched material (merged into R3S.U)
  const U = {
    r3Casc: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
    r3ShadowEnd: { value: 260 },
    // 1 while the scene is drawn into the post stack's HDR target (alpha carries the direct-sun
    // share there); 0 when drawing straight to the screen, where alpha is left alone (Edge
    // composites a WebGL canvas with the alpha written into it, and the page behind is black)
    r3SunA: { value: 0 },
  };

  // Cost control. The near slice draws every caster in full (it holds the cockpit, the hands
  // and the cars alongside, where shadow detail shows). The outer slices, where a car is a few
  // shadow texels, draw each car as a one-mesh stand-in (its merged far model) instead of its
  // twenty-odd detailed parts, cockpit and skinned arms (the swap is made in js/render3d.js,
  // which renders the slices one at a time). The outer
  // slices are also re-rendered less often: the middle one every other frame and the far one
  // every third, staggered so no frame pays for both; between renders each keeps sampling its
  // last map through the matrix it was drawn with, so the shadows stay put. Any jump (a camera
  // cut, a quality change) re-renders everything at once.
  const EVERY = [1, 2, 3], PHASE = [0, 0, 1];
  let frame = 0, force = true;
  const lastPos = [new THREE.Vector3(1e9, 0, 0), new THREE.Vector3(1e9, 0, 0), new THREE.Vector3(1e9, 0, 0)];
  const lastSun = new THREE.Vector3();
  function init(scene) {
    for (let i = 0; i < N; i++) {
      const l = new THREE.DirectionalLight(0xffffff, 0);
      l.castShadow = true;
      l.shadow.autoUpdate = false;
      scene.add(l, l.target);
      S.lights.push(l);
    }
  }

  // o (advanced graphics): res, dist and soft multiply the level's map sizes, slice reach and
  // filter radius
  function setQuality(level, o = {}) {
    const q0 = Q[level];
    S.on = !!q0;
    const base = q0 || Q.high, res = o.res || 1, dist = o.dist || 1, soft = o.soft || 1;
    S.q = { n: base.n, size: base.size.map(z => Math.max(256, Math.min(8192, Math.round(z * res)))), ends: base.ends.map(e => e * dist) };
    S.lights.forEach((l, i) => {
      l.castShadow = S.on && i < S.q.n;
      const sz = S.q.size[i] || 512;
      if (l.shadow.mapSize.x !== sz) { l.shadow.mapSize.set(sz, sz); if (l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; } }
      l.shadow.radius = RADIUS[i] * soft;
    });
    force = true;
  }

  const _m = new THREE.Matrix4(), _mi = new THREE.Matrix4(), _c = new THREE.Vector3(), _o = new THREE.Vector3(), _up = new THREE.Vector3();
  // fit the slices to the camera; sunDir points toward the sun
  function update(camera, sunDir) {
    if (!S.on || !camera.isPerspectiveCamera) return;
    const ends = S.q.ends;
    const ty = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2), tx = ty * camera.aspect;
    // light space: looking along -sunDir
    _up.set(0, 1, 0); if (Math.abs(sunDir.y) > 0.99) _up.set(0, 0, 1);
    _m.lookAt(_o.set(0, 0, 0), _c.copy(sunDir).negate(), _up);
    _mi.copy(_m).invert();
    let start = camera.near;
    frame++;
    if (lastSun.distanceToSquared(sunDir) > 1e-6) { force = true; lastSun.copy(sunDir); }
    for (let i = 0; i < S.q.n; i++) {
      const end = ends[i];
      // the slice reaches back over the previous one's last fifth, where they cross-fade
      const over = i ? (ends[i - 1] - (i > 1 ? ends[i - 2] : 0)) * 0.2 : 0;
      const d0 = Math.max(camera.near, start - over), d1 = end;
      U.r3Casc.value[i].set(i ? d0 : -1, i ? start : 0, end);
      // due this frame? (a camera that jumped further than a tenth of the slice re-renders it now)
      const l0 = S.lights[i], jump = lastPos[i].distanceToSquared(camera.position) > (end * 0.1) ** 2;
      const due = force || jump || G.__shFull || frame % EVERY[i] === PHASE[i];
      l0.shadow.needsUpdate = due;
      if (!due) { start = end; continue; }
      lastPos[i].copy(camera.position);
      // bounding sphere of the slice: centred on the view axis, radius to its far corners
      const cz = (d0 + d1) / 2;
      const rN = Math.hypot(d0 * tx, d0 * ty, d0 - cz), rF = Math.hypot(d1 * tx, d1 * ty, d1 - cz);
      const r = Math.max(rN, rF);
      _c.set(0, 0, -cz).applyMatrix4(camera.matrixWorld);
      // snap the centre to whole shadow texels in light space
      const l = S.lights[i], size = l.shadow.mapSize.x, texel = 2 * r / size;
      _c.applyMatrix4(_mi);
      _c.x = Math.round(_c.x / texel) * texel; _c.y = Math.round(_c.y / texel) * texel;
      _c.applyMatrix4(_m);
      const cam = l.shadow.camera;
      cam.left = cam.bottom = -r; cam.right = cam.top = r;
      cam.near = 0.5; cam.far = r + BACK + r;
      cam.updateProjectionMatrix();
      l.target.position.copy(_c);
      l.position.copy(_c).addScaledVector(sunDir, r + BACK);
      l.updateMatrixWorld(); l.target.updateMatrixWorld();
      // bias in metres, converted to the depth range; normal offset about half a texel
      l.shadow.bias = -BIAS[i] / cam.far;
      l.shadow.normalBias = texel * 0.6;
      start = end;
    }
    U.r3ShadowEnd.value = ends[S.q.n - 1];
    force = false;
  }

  // the directional-light part of three's lights_fragment_begin, rewritten: the cascade
  // lights (the shadow casters, which three lists first) are only sampled for the shadow; the
  // remaining directional light (the sun) takes it
  const DIR = [
    '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )',
    '  DirectionalLight directionalLight;',
    '  #if defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 )',
    '  if ( receiveShadow ) {',
    '    float r3D = vViewPosition.z, r3s, r3w;',
    '    DirectionalLightShadow r3Sh;',
    '    #pragma unroll_loop_start',
    '    for ( int i = 0; i < 3; i ++ ) {',
    '      #if ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )',
    '      if ( r3D >= r3Casc[ i ].x && r3D < r3Casc[ i ].z ) {',
    '        r3Sh = directionalLightShadows[ i ];',
    '        r3s = getShadow( directionalShadowMap[ i ], r3Sh.shadowMapSize, r3Sh.shadowBias, r3Sh.shadowRadius, vDirectionalShadowCoord[ i ] );',
    '        r3w = r3Casc[ i ].x < r3Casc[ i ].y ? smoothstep( r3Casc[ i ].x, r3Casc[ i ].y, r3D ) : 1.0;',
    '        r3SunVis = mix( r3SunVis, r3s, r3w );',
    '      }',
    '      #endif',
    '    }',
    '    #pragma unroll_loop_end',
    '    r3SunVis = mix( r3SunVis, 1.0, smoothstep( r3ShadowEnd * 0.85, r3ShadowEnd, r3D ) );',
    '  }',
    '  #endif',
    '  #pragma unroll_loop_start',
    '  for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {',
    '    #if ( UNROLLED_LOOP_INDEX >= NUM_DIR_LIGHT_SHADOWS )',
    '    directionalLight = directionalLights[ i ];',
    '    getDirectionalLightInfo( directionalLight, directLight );',
    '    directLight.color *= r3SunVis;',
    '    RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );',
    '    #endif',
    '  }',
    '  #pragma unroll_loop_end',
    '#endif',
  ].join('\n');
  let chunk = null;
  function lightsChunk() {
    if (chunk) return chunk;
    const src = THREE.ShaderChunk.lights_fragment_begin;
    const a = src.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )'), b = src.indexOf('#if ( NUM_RECT_AREA_LIGHTS > 0 )');
    if (a < 0 || b < 0) { console.warn('r3-shadow: unexpected lights chunk'); return (chunk = src); }
    chunk = 'float r3SunVis = 1.0;\n' + src.slice(0, a) + DIR + '\n' + src.slice(b);
    return chunk;
  }
  const PARS = 'uniform vec3 r3Casc[3]; uniform float r3ShadowEnd; uniform float r3SunA;\n';

  // ---------- sky occlusion under the cars ----------
  // The road under a car is in deep shade: the car hides most of the sky above it. Screen-space
  // AO cannot see that (it reaches a metre or so, and only what is on screen), so each car near
  // the camera is also described by a few boxes in its own frame (body and sidepods, nose, front
  // wing, gearbox and rear wing, the four tyres), and every lit surface around it works out how
  // much of its sky those boxes cover, exactly: the cosine-weighted solid angle of each visible
  // box face, integrated around its edges (box occlusion after Inigo Quilez, MIT). Only the sky
  // and bounce light is reduced (it is evaluated per pixel in the AO pass, js/r3-post.js, which
  // only scales the light that is not direct sun), so the shade shows where the sun does not
  // reach and stays out of direct sunlight. (Compiled into every lit material instead, it cost
  // the GPU shader compiler about a minute at start-up.)
  const MAXC = 8;
  U.uOccCar = { value: Array.from({ length: MAXC }, () => new THREE.Vector4()) }; // x, ground y, z, heading
  U.uOccN = { value: 0 };
  // box centre and half size in the car's frame (x forward, y up from the road, z right)
  const BOXES = [
    [-0.05, 0.33, 0, 1.55, 0.30, 0.78],   // floor, tub and sidepods
    [2.2, 0.40, 0, 0.75, 0.17, 0.28],     // nose
    [2.9, 0.20, 0, 0.32, 0.12, 0.97],     // front wing
    [-1.95, 0.52, 0, 0.38, 0.45, 0.50],   // gearbox, diffuser, rear wing
    [1.964, 0.38, -0.81, 0.36, 0.36, 0.16], [1.964, 0.38, 0.81, 0.36, 0.36, 0.16], // front tyres
    [-1.57, 0.38, -0.80, 0.36, 0.36, 0.2], [-1.57, 0.38, 0.80, 0.36, 0.36, 0.2],  // rear tyres
  ];
  U.uOccBC = { value: BOXES.map(b => new THREE.Vector3(b[0], b[1], b[2])) };
  U.uOccBR = { value: BOXES.map(b => new THREE.Vector3(b[3], b[4], b[5])) };
  const OCC_PARS = [
    'uniform vec4 uOccCar[' + MAXC + ']; uniform int uOccN;',
    // cosine-weighted occlusion of one face (corners a b c d, relative to the point, any winding)
    'float r3Face(vec3 n, vec3 a, vec3 b, vec3 c, vec3 d) {',
    '  a = normalize(a); b = normalize(b); c = normalize(c); d = normalize(d);',
    '  float s = acos(clamp(dot(a, b), -1.0, 1.0)) * dot(n, normalize(cross(a, b)))',
    '          + acos(clamp(dot(b, c), -1.0, 1.0)) * dot(n, normalize(cross(b, c)))',
    '          + acos(clamp(dot(c, d), -1.0, 1.0)) * dot(n, normalize(cross(c, d)))',
    '          + acos(clamp(dot(d, a), -1.0, 1.0)) * dot(n, normalize(cross(d, a)));',
    '  return abs(s) / 6.2831853;',
    '}',
    // a box (half size r) seen from point p (box frame) with normal n: the faces turned toward p
    'float r3Box(vec3 p, vec3 n, vec3 r) {',
    '  if (all(lessThan(abs(p), r))) return 0.0;',
    '  float o = 0.0;',
    '  vec3 q0 = vec3(-r.x, -r.y, -r.z) - p, q1 = vec3(r.x, -r.y, -r.z) - p, q2 = vec3(-r.x, r.y, -r.z) - p, q3 = vec3(r.x, r.y, -r.z) - p;',
    '  vec3 q4 = vec3(-r.x, -r.y, r.z) - p, q5 = vec3(r.x, -r.y, r.z) - p, q6 = vec3(-r.x, r.y, r.z) - p, q7 = vec3(r.x, r.y, r.z) - p;',
    '  if (p.x > r.x) o += r3Face(n, q1, q3, q7, q5); else if (p.x < -r.x) o += r3Face(n, q0, q4, q6, q2);',
    '  if (p.y > r.y) o += r3Face(n, q2, q6, q7, q3); else if (p.y < -r.y) o += r3Face(n, q0, q1, q5, q4);',
    '  if (p.z > r.z) o += r3Face(n, q4, q5, q7, q6); else if (p.z < -r.z) o += r3Face(n, q0, q2, q3, q1);',
    '  return o;',
    '}',
    // the boxes come in as uniforms and are walked in one plain loop (no constant-array
    // constructors, no continue: the most portable form across GPU shader compilers)
    'uniform vec3 uOccBC[8]; uniform vec3 uOccBR[8];',
    'float r3CarSky(vec3 wp, vec3 wn) {',
    '  float vis = 1.0;',
    '  for (int i = 0; i < ' + MAXC + '; i++) {',
    '    if (i < uOccN) {',
    '      vec4 cr = uOccCar[i];',
    '      vec2 dxz = wp.xz - cr.xz;',
    '      if (dot(dxz, dxz) < 36.0) {', // within 6 m: the car can cover some of this sky
    '        float ch = cos(cr.w), sh = sin(cr.w);',
    '        vec3 lp = vec3(dxz.x * ch + dxz.y * sh, wp.y - cr.y, -dxz.x * sh + dxz.y * ch);',
    '        vec3 ln = vec3(wn.x * ch + wn.z * sh, wn.y, -wn.x * sh + wn.z * ch);',
    // only the ground (and kerbs) under and round the car: the car's own surfaces are not
    // shaded by the coarse boxes that stand in for it
    '        float cv = 1.0, gw = 1.0 - smoothstep(0.06, 0.2, lp.y);',
    '        if (gw > 0.0) for (int j = 0; j < 8; j++) cv *= 1.0 - clamp(r3Box(lp - uOccBC[j], ln, uOccBR[j]), 0.0, 1.0);',
    '        vis *= mix(1.0, cv, gw);',
    '      }',
    '    }',
    '  }',
    '  return vis;',
    '}',
  ].join('\n');
  // the cars nearest the camera: [{ x, y (ground), z, h }]
  function setCars(list) {
    const n = Math.min(MAXC, list.length);
    for (let i = 0; i < n; i++) U.uOccCar.value[i].set(list[i].x, list[i].y, list[i].z, list[i].h);
    U.uOccN.value = n;
  }

  // shadow-casting lights in use; their count is baked into every lit shader
  function casters() { return S.on ? S.q.n : 0; }
  F1.R3Shadow = { casters, init, setQuality, update, lightsChunk, PARS, U, S, OCC_PARS, setCars };
})(typeof window !== 'undefined' ? window : globalThis);
