// Post-processing for the 3D renderer. The scene renders into a multisampled half-float
// target in linear radiance (white ground = 1.0); everything below works in that space
// and only the final composite applies exposure, tone mapping and the sRGB transfer.
//   SSAO        Alchemy-style ambient obscurance from the log depth buffer, depth-aware blur
//   bloom       soft-threshold prefilter + 6-level downsample / upsample chain
//   sun shafts  screen-space radial scattering of the visible sky around the sun
//   motion blur camera reprojection for the static world; cars (and the ground their shadows
//               fall on) carry their own screen velocity from a velocity pass, so a car running
//               alongside at your speed stays sharp
//   TAA         temporal anti-aliasing: the camera is jittered by a fraction of a pixel each
//               frame and the frames are blended along their motion (camera reprojection for the
//               world, the velocity pass for cars), with the history clipped to the colours
//               around each pixel so nothing smears; the composite sharpens it back a little
//   wet road    screen-space reflections on the road when it is wet (puddles mirror the cars and
//               the scenery), traced at half size only while the track is wet
//   composite   AgX or ACES tone mapping, vignette, chromatic aberration, grain dither
//   FXAA        on the finished picture: edges found by their contrast are smoothed along their
//               direction (the classic FXAA of Timothy Lottes); the grain goes on after it
(function (G) {
  'use strict';
  const F1 = G.F1;

  let R = null, W = 2, H = 2;
  const Q = { on: true, taa: true, fxaa: true, scale: 1, msaa: 4, ssao: true, aoSamples: 12, aoK: 0.85, bloom: true, bloomK: 0.06, shafts: true, shaftK: 0.45, motion: true, shutter: 180, lens: true, grain: true, tone: 'agx' };
  const RT = {};
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeo = new THREE.BufferGeometry();
  quadGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  quadGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const quad = new THREE.Mesh(quadGeo); quad.frustumCulled = false;
  const qScene = new THREE.Scene(); qScene.add(quad);
  function pass(mat, target) {
    quad.material = mat; R.setRenderTarget(target || null); R.render(qScene, quadCam);
    // a pass whose shader failed to compile on this GPU is switched off (once, with a warning)
    // rather than leaving its target empty, which could black out the picture
    if (!mat.userData.checked) {
      const p = R.properties.get(mat).currentProgram;
      if (p) {
        mat.userData.checked = true;
        if (p.diagnostics && p.diagnostics.runnable === false) { mat.userData.broken = true; console.warn('Slipstream: a post-processing shader failed to compile on this GPU and was switched off', p.diagnostics); }
      }
    }
  }
  const _cc = new THREE.Color();
  function clearTo(target, hex) {
    const a = R.getClearAlpha(); R.getClearColor(_cc);
    R.setRenderTarget(target); R.setClearColor(hex, 1); R.clear(true, false, false);
    R.setClearColor(_cc, a);
  }

  const VS = 'varying vec2 vUv;\nvoid main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
  const DEPTH = [
    'uniform sampler2D tDepth; uniform float uLogFar; uniform vec2 uProj;',
    // log depth buffer: d = log2(1 + w) / log2(far + 1), so the view distance w = 2^(d * log2(far + 1)) - 1
    // (or reversed depth: uLogFar < 0 and d = near / w, uLogFar holding -near)
    'float viewW(vec2 uv){ float d = texture2D(tDepth, uv).x; return uLogFar < 0.0 ? -uLogFar / max(d, 1e-7) : exp2(d * uLogFar) - 1.0; }',
    'vec3 viewPos(vec2 uv){ float w = viewW(uv); vec2 n = uv * 2.0 - 1.0; return vec3(n.x * w / uProj.x, n.y * w / uProj.y, -w); }'].join('\n');
  const ALL = []; // every pass material, for precompile()
  const mk = (frag, uniforms, o = {}) => { const m = new THREE.ShaderMaterial(Object.assign({ vertexShader: VS, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false }, o)); ALL.push(m); return m; };
  let revNear = 0;
  const depthU = () => ({ tDepth: { value: null }, uLogFar: { value: 1 }, uProj: { value: new THREE.Vector2(1, 1) } });

  // ---------- SSAO ----------
  // (plus the sky the cars hide from the road under them, js/r3-shadow.js, evaluated per pixel)
  const ssaoMat = mk([
    'varying vec2 vUv;', DEPTH,
    'uniform vec2 uTexel; uniform float uRadius; uniform float uFar; uniform int uSamples; uniform mat4 uInvView; uniform float uFrame;',
    F1.R3Shadow ? F1.R3Shadow.OCC_PARS : 'uniform int uOccN; float r3CarSky(vec3 p, vec3 n) { return 1.0; }',
    'float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }',
    'void main(){',
    '  float w = viewW(vUv);',
    '  if (w > uFar * 0.8) { gl_FragColor = vec4(1.0); return; }',
    '  vec3 p = viewPos(vUv);',
    '  vec3 dx1 = viewPos(vUv + vec2(uTexel.x, 0.0)) - p, dx2 = p - viewPos(vUv - vec2(uTexel.x, 0.0));',
    '  vec3 dy1 = viewPos(vUv + vec2(0.0, uTexel.y)) - p, dy2 = p - viewPos(vUv - vec2(0.0, uTexel.y));',
    '  vec3 n = normalize(cross(dot(dx1, dx1) < dot(dx2, dx2) ? dx1 : dx2, dot(dy1, dy1) < dot(dy2, dy2) ? dy1 : dy2));',
    '  if (dot(n, p) > 0.0) n = -n;',
    // inside the cockpit a 1.5 m radius spans the whole tub and blacks it out: the radius shrinks
    // with distance under a couple of metres, so close surfaces keep only their own creases
    '  float R = min(uRadius, max(0.1, w * 0.22));',
    '  float rad = R * uProj.y / w * 0.5;', // world radius projected to uv
    '  float a0 = ign(gl_FragCoord.xy + uFrame * 5.588238) * 6.2831853, sum = 0.0;', // (turns each frame with TAA: the temporal pass averages the pattern away)
    '  for (int i = 0; i < 16; i++) {',
    '    if (i >= uSamples) break;',
    '    float t = (float(i) + 0.5) / float(uSamples);',
    '    float a = a0 + float(i) * 2.3999632;',
    '    vec2 off = vec2(cos(a), sin(a)) * rad * sqrt(t);',
    '    vec3 v = viewPos(vUv + off) - p;',
    '    float vv = dot(v, v);',
    '    float fall = 1.0 - smoothstep(R * R * 0.5, R * R * 2.0, vv);',
    '    sum += max(0.0, dot(v, n) - 0.02 * w * 0.01) / (vv + 0.01) * fall;',
    '  }',
    '  float ao = uSamples > 0 ? max(0.0, 1.0 - 3.6 * sum / float(uSamples)) : 1.0;', // strong enough that the shade under a car reads as a contact shadow
    '  ao *= ao;',
    '  ao = mix(1.0, ao, smoothstep(0.3, 2.5, w) * 0.5 + 0.5);',
    // (g, once the cars' sky occlusion, is now worked out at full size in the composite)
    '  gl_FragColor = vec4(ao, 1.0, 1.0, 1.0);',
    '}'].join('\n'), Object.assign(depthU(), { uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1.5 }, uFar: { value: 14000 }, uSamples: { value: 12 }, uInvView: { value: new THREE.Matrix4() }, uFrame: { value: 0 } },
    F1.R3Shadow ? { uOccCar: F1.R3Shadow.U.uOccCar, uOccN: F1.R3Shadow.U.uOccN, uOccBC: F1.R3Shadow.U.uOccBC, uOccBR: F1.R3Shadow.U.uOccBR } : {}));

  const blurAOMat = mk([
    'varying vec2 vUv;', DEPTH, 'uniform sampler2D tAO; uniform vec2 uDir;',
    'void main(){',
    '  float w0 = viewW(vUv), ws = 0.0; vec2 s = vec2(0.0);',
    '  for (int i = -3; i <= 3; i++) {',
    '    vec2 uv = vUv + uDir * float(i);',
    '    float wd = abs(viewW(uv) - w0) / (w0 * 0.03 + 0.05);',
    '    float k = exp(-wd * wd) * (1.0 - abs(float(i)) / 4.5);',
    '    s += texture2D(tAO, uv).rg * k; ws += k;',
    '  }',
    '  gl_FragColor = vec4(s / max(ws, 1e-4), 1.0, 1.0);',
    '}'].join('\n'), Object.assign(depthU(), { tAO: { value: null }, uDir: { value: new THREE.Vector2() } }));

  // AO over time: this frame's (noisy, fewer samples) obscurance blended with last frame's,
  // reprojected by the camera and clipped to the range around the pixel. Only the screen-space
  // term (r): the cars' sky occlusion (g) moves with the cars and is exact each frame anyway.
  // The history keeps each pixel's view depth (b), and a carried-over value whose depth is not
  // where this surface was last frame came from something else and is dropped. Without that, in
  // the chase camera (the car still on screen, the road sliding under it) the road beside the car
  // took the car's own unshadowed value: a pale outline between the car and its shadow
  // (tools/halocheck.py checks for it).
  const aoTMat = mk([
    'varying vec2 vUv;', DEPTH, 'uniform sampler2D tAO; uniform sampler2D tHist; uniform mat4 uInvView; uniform mat4 uPrevVP; uniform vec2 uTexel; uniform float uReset;',
    'void main(){',
    '  vec2 c = texture2D(tAO, vUv).rg; float mn = c.r, mx = c.r;',
    '  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) { float a = texture2D(tAO, vUv + vec2(float(i), float(j)) * uTexel).r; mn = min(mn, a); mx = max(mx, a); }',
    '  vec4 pc = uPrevVP * (uInvView * vec4(viewPos(vUv), 1.0)); vec2 pu = pc.xy / pc.w * 0.5 + 0.5;',
    '  float off = uReset + step(pc.w, 0.0) + step(1.0, max(abs(pu.x - 0.5), abs(pu.y - 0.5)) * 2.0);',
    '  vec4 hh = texture2D(tHist, pu);',
    '  off += step(0.04 * pc.w + 0.15, abs(hh.b - pc.w));',
    '  float h = clamp(hh.r, mn, mx);',
    '  gl_FragColor = vec4(off > 0.5 ? c.r : mix(h, c.r, 0.3), c.g, viewW(vUv), 1.0);',
    '}'].join('\n'), Object.assign(depthU(), { tAO: { value: null }, tHist: { value: null }, uInvView: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() }, uTexel: { value: new THREE.Vector2() }, uReset: { value: 1 } }));

  // ---------- temporal anti-aliasing ----------
  // Colours are compared in YCoCg after a soft tone curve (so one bright sparkle does not widen
  // the clip box for everything round it); the history is read with a 5-tap Catmull-Rom filter,
  // which keeps it sharp under sub-pixel motion. Pixels within uStatic metres of the eye (the
  // cockpit, the hands) move with the camera and are not reprojected. As with the AO, the history
  // keeps its view depth (alpha) and a camera-reprojected value from another surface is dropped:
  // the variance clip alone let a car's colours stay on the road along its outline.
  const taaMat = mk([
    'varying vec2 vUv;', DEPTH,
    'uniform sampler2D tCur; uniform sampler2D tHist; uniform sampler2D tVel; uniform mat4 uInvView; uniform mat4 uPrevVP;',
    'uniform vec2 uTexel; uniform vec2 uJit; uniform float uReset; uniform float uStatic;',
    'vec3 tm(vec3 c){ return c / (1.0 + max(c.r, max(c.g, c.b))); }',
    'vec3 itm(vec3 c){ return c / max(1e-4, 1.0 - max(c.r, max(c.g, c.b))); }',
    'vec3 yc(vec3 c){ return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b); }',
    'vec3 rgb(vec3 y){ float t = y.x - y.z; return vec3(t + y.y, y.x + y.z, t - y.y); }',
    'vec3 cur(vec2 o){ return yc(tm(min(texture2D(tCur, vUv + o * uTexel).rgb, vec3(512.0)))); }',
    'vec3 hist(vec2 uv){',
    '  vec2 sz = 1.0 / uTexel, p = uv * sz, t1 = floor(p - 0.5) + 0.5, f = p - t1;',
    '  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f), w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);',
    '  vec2 w12 = w1 + w2, tc0 = (t1 - 1.0) * uTexel, tc3 = (t1 + 2.0) * uTexel, tc12 = (t1 + w2 / w12) * uTexel;',
    '  vec3 c = texture2D(tHist, vec2(tc12.x, tc0.y)).rgb * (w12.x * w0.y) + texture2D(tHist, vec2(tc0.x, tc12.y)).rgb * (w0.x * w12.y)',
    '    + texture2D(tHist, tc12).rgb * (w12.x * w12.y) + texture2D(tHist, vec2(tc3.x, tc12.y)).rgb * (w3.x * w12.y) + texture2D(tHist, vec2(tc12.x, tc3.y)).rgb * (w12.x * w3.y);',
    '  float ws = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;',
    '  return max(c / ws, vec3(0.0));',
    '}',
    'void main(){',
    '  vec3 c0 = cur(vec2(0.0));',
    '  vec3 m1 = c0, m2 = c0 * c0, s;',
    '  s = cur(vec2(-1.0, 0.0)); m1 += s; m2 += s * s; s = cur(vec2(1.0, 0.0)); m1 += s; m2 += s * s;',
    '  s = cur(vec2(0.0, -1.0)); m1 += s; m2 += s * s; s = cur(vec2(0.0, 1.0)); m1 += s; m2 += s * s;',
    '  s = cur(vec2(-1.0, -1.0)); m1 += s; m2 += s * s; s = cur(vec2(1.0, -1.0)); m1 += s; m2 += s * s;',
    '  s = cur(vec2(-1.0, 1.0)); m1 += s; m2 += s * s; s = cur(vec2(1.0, 1.0)); m1 += s; m2 += s * s;',
    '  vec3 mu = m1 / 9.0, sg = sqrt(max(m2 / 9.0 - mu * mu, 0.0));',
    // where this pixel was last frame: its own velocity for a car, else the camera's reprojection
    '  float w = viewW(vUv); vec2 u0 = vUv - uJit, n = u0 * 2.0 - 1.0;',
    '  vec3 p = vec3(n.x * w / uProj.x, n.y * w / uProj.y, -w);',
    '  vec4 pc = uPrevVP * (uInvView * vec4(p, 1.0)); vec2 pu = pc.xy / pc.w * 0.5 + 0.5;',
    '  vec4 mv = texture2D(tVel, vUv);',
    '  bool car = mv.a > 0.5 && abs(mv.b - w) < 0.3 + 0.02 * mv.b;',
    '  if (car) pu = u0 - mv.xy;',
    '  if (w < uStatic) pu = u0;',
    '  vec2 dp = (u0 - pu) / uTexel;',
    '  float off = uReset + step(pc.w, 0.0) + step(1.0, max(abs(pu.x - 0.5), abs(pu.y - 0.5)) * 2.0);',
    '  if (!car && w >= uStatic) off += step(0.04 * pc.w + 0.15, abs(texture2D(tHist, pu).a - pc.w));',
    '  vec3 h = yc(tm(min(hist(pu), vec3(512.0))));',
    // clip toward the middle of the box (variance clipping, a little tighter when it moves)
    '  float g = mix(1.25, 0.85, clamp(length(dp) / 24.0, 0.0, 1.0));',
    '  vec3 lo = min(mu - g * sg, c0), hi = max(mu + g * sg, c0);',
    '  vec3 ctr = 0.5 * (hi + lo), ext = 0.5 * (hi - lo) + 1e-5, d = h - ctr, a = abs(d / ext);',
    '  float m = max(a.x, max(a.y, a.z)); if (m > 1.0) h = ctr + d / m;',
    '  float k = off > 0.5 ? 1.0 : mix(0.09, 0.22, clamp(length(dp) / 30.0, 0.0, 1.0));',
    '  gl_FragColor = vec4(itm(rgb(mix(h, c0, k))), w);', // (alpha: this pixel's depth, for the next frame's test)
    '}'].join('\n'), Object.assign(depthU(), { tCur: { value: null }, tHist: { value: null }, tVel: { value: null }, uInvView: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() },
    uTexel: { value: new THREE.Vector2() }, uJit: { value: new THREE.Vector2() }, uReset: { value: 1 }, uStatic: { value: 0 } }));
  // ---------- FXAA ----------
  // The tone-mapped picture (sRGB, 8 bit) in, the canvas out. Only pixels on an edge (local
  // contrast over an eighth of the brightest, and over a small floor) are touched, so textures
  // stay sharp. Then the grain, which the composite leaves out when this pass runs.
  const fxaaMat = mk([
    'varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uGrain; uniform float uLens; uniform float uTime; uniform vec2 uRes;',
    'float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }',
    'float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
    'void main(){',
    '  vec3 cM = texture2D(tSrc, vUv).rgb;',
    '  float lM = lum(cM);',
    '  float lNW = lum(texture2D(tSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb), lNE = lum(texture2D(tSrc, vUv + vec2(1.0, -1.0) * uTexel).rgb);',
    '  float lSW = lum(texture2D(tSrc, vUv + vec2(-1.0, 1.0) * uTexel).rgb), lSE = lum(texture2D(tSrc, vUv + vec2(1.0, 1.0) * uTexel).rgb);',
    '  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE))), lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));',
    '  vec3 c = cM;',
    '  if (lMax - lMin > max(0.0312, lMax * 0.125)) {',
    // the edge runs across the steepest change; sample along it, at most 8 pixels each way
    '    vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));',
    '    float red = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);',
    '    dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + red), -8.0, 8.0) * uTexel;',
    '    vec3 a = 0.5 * (texture2D(tSrc, vUv + dir * (1.0 / 3.0 - 0.5)).rgb + texture2D(tSrc, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);',
    '    vec3 b = a * 0.5 + 0.25 * (texture2D(tSrc, vUv - dir * 0.5).rgb + texture2D(tSrc, vUv + dir * 0.5).rgb);',
    '    float lb = lum(b);',
    '    c = lb < lMin || lb > lMax ? a : b;',
    '  }',
    '  c += (hash(vUv * uRes + fract(uTime) * 61.0) - 0.5) * (uLens > 0.5 ? 0.016 : 0.006) * uGrain;',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'].join('\n'), { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uGrain: { value: 0 }, uLens: { value: 0 }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2() } });

  const HALTON = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };

  // ---------- wet road reflections ----------
  // A ray from each road pixel, mirrored about the (level) road, marched through the depth
  // buffer in growing steps and refined where it passes behind something. Only on the road (a
  // top-down mask of the circuit from js/render3d.js), only on level surfaces, strongest in the
  // puddles (the same world-space pattern the road material darkens and smooths) and at a
  // glancing angle (Fresnel). Rays that leave the screen fade out at its edges.
  const ssrMat = mk([
    'varying vec2 vUv;', DEPTH,
    'uniform sampler2D tScene; uniform sampler2D tVel; uniform sampler2D tMask; uniform vec4 uMaskB; uniform mat4 uInvView; uniform mat4 uView; uniform mat4 uProjM; uniform float uWet; uniform float uFrame;',
    'float wxH(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }',
    'float wxN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(wxH(i), wxH(i + vec2(1.0, 0.0)), f.x), mix(wxH(i + vec2(0.0, 1.0)), wxH(i + vec2(1.0, 1.0)), f.x), f.y); }',
    'float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }',
    'vec2 toUv(vec3 q){ vec4 c = uProjM * vec4(q, 1.0); return c.xy / c.w * 0.5 + 0.5; }',
    'void main(){',
    '  float w = viewW(vUv);',
    '  if (w > 500.0) { gl_FragColor = vec4(0.0); return; }',
    '  vec3 p = viewPos(vUv), wp = (uInvView * vec4(p, 1.0)).xyz;',
    '  float road = texture2D(tMask, (wp.xz - uMaskB.xy) / uMaskB.zw).r;',
    // (a car over the road is not the road: the velocity pass says where the cars are)
    '  vec4 mv = texture2D(tVel, vUv); if (mv.a > 0.8 && abs(mv.b - w) < 0.3 + 0.02 * mv.b) road = 0.0;',
    '  vec3 n = normalize(cross(dFdx(p), dFdy(p)));',
    '  float lev = smoothstep(0.88, 0.97, abs((uInvView * vec4(n, 0.0)).y));',
    '  float pud = smoothstep(0.5 - 0.14 * uWet, 0.74, wxN(wp.xz * 0.28) * 0.6 + wxN(wp.xz * 1.1) * 0.4);',
    '  float k = road * lev * uWet * (0.3 + 0.7 * pud);',
    '  if (k < 0.01) { gl_FragColor = vec4(0.0); return; }',
    '  vec3 V = normalize(p), Nv = normalize((uView * vec4(0.0, 1.0, 0.0, 0.0)).xyz), Rv = reflect(V, Nv);',
    '  float t = 0.2 + 0.5 * ign(gl_FragCoord.xy + uFrame * 5.588238), t0 = 0.0;',
    '  vec2 hit = vec2(-1.0);',
    '  for (int i = 0; i < 26; i++) {',
    '    vec3 q = p + Rv * t;',
    '    if (q.z > -0.05) break;',
    '    vec2 uv = toUv(q);',
    '    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;',
    '    float sw = viewW(uv), qd = -q.z;',
    '    if (qd > sw + 0.02 && qd < sw + 0.6 + 0.02 * sw + (t - t0) * abs(Rv.z)) {',
    '      float a = t0, b = t;',
    '      for (int j = 0; j < 5; j++) { float m = 0.5 * (a + b); vec3 qm = p + Rv * m; if (-qm.z > viewW(toUv(qm))) b = m; else a = m; }',
    '      hit = toUv(p + Rv * b); break;',
    '    }',
    '    t0 = t; t = t * 1.3 + 0.15;',
    '  }',
    '  if (hit.x < 0.0) { gl_FragColor = vec4(0.0); return; }',
    '  vec2 e = smoothstep(vec2(0.0), vec2(0.07), hit) * smoothstep(vec2(0.0), vec2(0.07), 1.0 - hit);',
    '  float fr = 0.02 + 0.98 * pow(1.0 - clamp(dot(-V, Nv), 0.0, 1.0), 5.0);',
    '  gl_FragColor = vec4(min(texture2D(tScene, hit).rgb, vec3(16.0)), k * e.x * e.y * mix(0.3, 1.0, fr));',
    '}'].join('\n'), Object.assign(depthU(), { tScene: { value: null }, tVel: { value: null }, tMask: { value: null }, uMaskB: { value: new THREE.Vector4(0, 0, 1, 1) }, uInvView: { value: new THREE.Matrix4() },
    uView: { value: new THREE.Matrix4() }, uProjM: { value: new THREE.Matrix4() }, uWet: { value: 0 }, uFrame: { value: 0 } }));
  const wetMixMat = mk([
    'varying vec2 vUv; uniform sampler2D tScene; uniform sampler2D tSSR; uniform int uDbg;',
    'void main(){ vec4 c = texture2D(tScene, vUv), r = texture2D(tSSR, vUv); gl_FragColor = uDbg == 1 ? vec4(vec3(r.a * 4.0), c.a) : vec4(mix(c.rgb, r.rgb, clamp(r.a, 0.0, 1.0) * 0.8), c.a); }'].join('\n'),
    { tScene: { value: null }, tSSR: { value: null }, uDbg: { value: 0 } });
  const WET = { k: 0, mask: null };

  // ---------- bloom ----------
  const preMat = mk([
    'varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThresh;',
    'vec3 tap(vec2 o){ return min(texture2D(tSrc, vUv + o * uTexel).rgb, vec3(64.0)); }',
    'void main(){',
    // 4-tap Karis-weighted average suppresses fireflies from specular sparkles
    '  vec3 a = tap(vec2(-1, -1)), b = tap(vec2(1, -1)), c = tap(vec2(-1, 1)), d = tap(vec2(1, 1));',
    '  float wa = 1.0 / (1.0 + max(a.r, max(a.g, a.b))), wb = 1.0 / (1.0 + max(b.r, max(b.g, b.b)));',
    '  float wc = 1.0 / (1.0 + max(c.r, max(c.g, c.b))), wd = 1.0 / (1.0 + max(d.r, max(d.g, d.b)));',
    '  vec3 col = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);',
    '  float br = max(col.r, max(col.g, col.b)), knee = uThresh * 0.5;',
    '  float soft = clamp(br - uThresh + knee, 0.0, 2.0 * knee); soft = soft * soft / (4.0 * knee + 1e-5);',
    '  gl_FragColor = vec4(col * max(soft, br - uThresh) / max(br, 1e-5), 1.0);',
    '}'].join('\n'), { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThresh: { value: 1.5 } });
  const downMat = mk([
    'varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uTexel;',
    'vec3 s(vec2 o){ return texture2D(tSrc, vUv + o * uTexel).rgb; }',
    'void main(){',
    // 13-tap downsample (box of boxes) keeps the bloom stable as the camera moves
    '  vec3 c = s(vec2(0)) * 0.125;',
    '  c += (s(vec2(-1, -1)) + s(vec2(1, -1)) + s(vec2(-1, 1)) + s(vec2(1, 1))) * 0.125;',
    '  c += (s(vec2(-2, -2)) + s(vec2(2, -2)) + s(vec2(-2, 2)) + s(vec2(2, 2))) * 0.03125;',
    '  c += (s(vec2(0, -2)) + s(vec2(0, 2)) + s(vec2(-2, 0)) + s(vec2(2, 0))) * 0.0625;',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'].join('\n'), { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
  const upMat = mk([
    'varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uTexel;',
    'vec3 s(vec2 o){ return texture2D(tSrc, vUv + o * uTexel).rgb; }',
    'void main(){',
    '  vec3 c = s(vec2(0)) * 4.0 + (s(vec2(-1, 0)) + s(vec2(1, 0)) + s(vec2(0, -1)) + s(vec2(0, 1))) * 2.0;',
    '  c += s(vec2(-1, -1)) + s(vec2(1, -1)) + s(vec2(-1, 1)) + s(vec2(1, 1));',
    '  gl_FragColor = vec4(c / 16.0, 1.0);',
    '}'].join('\n'), { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } }, { blending: THREE.AdditiveBlending, transparent: true });

  // ---------- sun shafts ----------
  const shaftMaskMat = mk([
    'varying vec2 vUv;', DEPTH, 'uniform sampler2D tScene; uniform vec2 uSun; uniform float uFar; uniform float uAspect;',
    'void main(){',
    '  float sky = step(uFar * 0.8, viewW(vUv));',
    '  vec2 d = (vUv - uSun) * vec2(uAspect, 1.0);',
    '  float near = 1.0 - smoothstep(0.0, 0.55, length(d));',
    '  vec3 c = min(texture2D(tScene, vUv).rgb, vec3(8.0));',
    '  gl_FragColor = vec4(c * sky * near, 1.0);',
    '}'].join('\n'), Object.assign(depthU(), { tScene: { value: null }, uSun: { value: new THREE.Vector2() }, uFar: { value: 14000 }, uAspect: { value: 1 } }));
  const shaftBlurMat = mk([
    'varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uSun; uniform float uStep;',
    'float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }',
    'void main(){',
    '  vec2 dl = (uSun - vUv) * uStep / 24.0;',
    '  vec2 uv = vUv + dl * ign(gl_FragCoord.xy);',
    '  vec3 c = vec3(0.0); float decay = 1.0, wsum = 0.0;',
    '  for (int i = 0; i < 24; i++) { c += texture2D(tSrc, uv).rgb * decay; wsum += decay; uv += dl; decay *= 0.965; }',
    '  gl_FragColor = vec4(c / wsum, 1.0);',
    '}'].join('\n'), { tSrc: { value: null }, uSun: { value: new THREE.Vector2() }, uStep: { value: 1 } });

  // ---------- motion blur ----------
  const motionMat = mk([
    'varying vec2 vUv;', DEPTH, 'uniform sampler2D tScene; uniform sampler2D tVel; uniform mat4 uInvView; uniform mat4 uPrevVP; uniform float uScale; uniform float uNear;',
    'float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }',
    'void main(){',
    '  vec3 p = viewPos(vUv);',
    '  vec4 wp = uInvView * vec4(p, 1.0);',
    '  vec4 pc = uPrevVP * wp;',
    '  vec2 prev = pc.xy / pc.w * 0.5 + 0.5;',
    '  vec2 vel = (vUv - prev) * uScale;',
    '  vel *= smoothstep(uNear, uNear * 1.8, -p.z);', // leave the car you are following sharp
    // a moving object drawn at this pixel (same depth): its own velocity instead
    '  vec4 mv = texture2D(tVel, vUv);',
    '  if (mv.a > 0.5 && abs(mv.b + p.z) < 0.3 + 0.02 * mv.b) vel = mv.xy * uScale;',
    '  float l = length(vel); if (l > 0.06) vel *= 0.06 / l;',
    '  vec3 c = vec3(0.0); float j = ign(gl_FragCoord.xy) - 0.5;',
    '  for (int i = 0; i < 8; i++) { float t = (float(i) + j) / 7.0 - 0.5; c += texture2D(tScene, vUv - vel * t).rgb; }',
    '  gl_FragColor = vec4(c / 8.0, 1.0);',
    '}'].join('\n'), Object.assign(depthU(), { tScene: { value: null }, tVel: { value: null }, uInvView: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() }, uScale: { value: 0.5 }, uNear: { value: 9 } }));

  // velocity pass: moving objects only (their own small scene of merged hulls), screen motion since the last frame from
  // each mesh's previous world matrix; b holds the view depth for the occlusion test
  const velMat = new THREE.ShaderMaterial({
    uniforms: { uPrevMVP: { value: new THREE.Matrix4() }, uA: { value: 1 } },
    vertexShader: [
      'uniform mat4 uPrevMVP; varying vec4 vCur; varying vec4 vPrev; varying float vZ;',
      'void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vCur = projectionMatrix * mv; vPrev = uPrevMVP * vec4(position, 1.0); vZ = -mv.z; gl_Position = vCur; }'].join('\n'),
    fragmentShader: [
      // (alpha: 1 on a car, 0.6 on the patch of road under it, which the wet-road pass must not skip)
      'varying vec4 vCur; varying vec4 vPrev; varying float vZ; uniform float uA;',
      'void main(){ vec2 a = vCur.xy / vCur.w * 0.5 + 0.5, b = vPrev.xy / vPrev.w * 0.5 + 0.5; gl_FragColor = vec4(a - b, vZ, uA); }'].join('\n'),
    side: THREE.DoubleSide,
  });
  const CC = new THREE.Color();
  velMat.onBeforeRender = (r, sc, cam, geo, obj) => {
    const pw = obj.userData.prevMW || obj.matrixWorld;
    velMat.uniforms.uPrevMVP.value.multiplyMatrices(prevVP, pw);
    velMat.uniforms.uA.value = obj.userData.velGround ? 0.6 : 1;
    velMat.uniformsNeedUpdate = true;
  };
  function velocityPass(vel, camera) {
    vel.sync();
    const scene = vel.scene;
    scene.overrideMaterial = velMat; scene.updateMatrixWorld();
    const cc = R.getClearColor(CC), ca = R.getClearAlpha();
    // three.js redraws the shadow map on every render call: not for this pass
    const au = R.shadowMap.autoUpdate; R.shadowMap.autoUpdate = false;
    R.setRenderTarget(RT.vel); R.setClearColor(0x000000, 0); R.clear(true, true, false);
    R.render(scene, camera);
    R.setClearColor(cc, ca); R.shadowMap.autoUpdate = au;
    scene.overrideMaterial = null;
  }
  // remember this frame's matrices for the next velocity pass
  function storeMovers(meshes) {
    for (const m of meshes) (m.userData.prevMW || (m.userData.prevMW = new THREE.Matrix4())).copy(m.matrixWorld);
  }

  // ---------- composite ----------
  const compMat = mk([
    'varying vec2 vUv;', DEPTH,
    'uniform sampler2D tScene; uniform sampler2D tAO; uniform sampler2D tBloom; uniform sampler2D tShaft; uniform sampler2D tSun;',
    // The shade under and around the cars (the sky their bodies and tyres hide from the road,
    // js/r3-shadow.js r3CarSky). It is exact and free of noise, so it is evaluated here for every
    // pixel at full size. It used to ride in the half-size AO target, where the blur and the
    // upsample mixed the tyre's own unshaded value into the road where the tyre stands: a pale
    // gap between each tyre and its contact shadow, and a softer, smeared shade under the floor.
    F1.R3Shadow ? F1.R3Shadow.OCC_PARS : 'uniform int uOccN; float r3CarSky(vec3 p, vec3 n) { return 1.0; }',
    'uniform mat4 uInvView;',
    // (the ground beside a car and the car's tyres: r3CarSky decides which points it shades)
    'float carSky(vec2 uv, vec2 tx) {',
    '  if (uOccN == 0) return 1.0;',
    '  float w = viewW(uv);',
    '  if (w > 150.0) return 1.0;',
    '  vec3 p = viewPos(uv), wp = (uInvView * vec4(p, 1.0)).xyz;',
    '  bool near = false;',
    '  for (int i = 0; i < 8; i++) { if (i < uOccN) { vec2 d = wp.xz - uOccCar[i].xz; if (dot(d, d) < 36.0) near = true; } }',
    '  if (!near) return 1.0;',
    // the surface normal from the depth: of the two neighbours each way, the nearer in depth, so
    // the normal at the foot of a tyre is the road's, not a blend with the tyre's side
    '  vec3 dx1 = viewPos(uv + vec2(tx.x, 0.0)) - p, dx2 = p - viewPos(uv - vec2(tx.x, 0.0));',
    '  vec3 dy1 = viewPos(uv + vec2(0.0, tx.y)) - p, dy2 = p - viewPos(uv - vec2(0.0, tx.y));',
    '  vec3 n = normalize(cross(dot(dx1, dx1) < dot(dx2, dx2) ? dx1 : dx2, dot(dy1, dy1) < dot(dy2, dy2) ? dy1 : dy2));',
    '  if (dot(n, p) > 0.0) n = -n;',
    '  vec3 wn = normalize((uInvView * vec4(n, 0.0)).xyz);',
    '  float k = r3CarSky(wp, wn);',
    // A pixel on the edge of a tyre (or any car part) against the road behind it holds some of
    // that road's colour (MSAA and TAA blend across the edge) but only the near surface's depth,
    // so it would take the near surface's (unshaded) value and its road share stays bright: a
    // faint light line between the wheel and its shadow. Where a neighbour lies well behind,
    // that neighbour's road value is worked out too and the darker of the two is used.
    '  vec3 fx = dot(dx1, dx1) > dot(dx2, dx2) ? p + dx1 : p - dx2, fy = dot(dy1, dy1) > dot(dy2, dy2) ? p + dy1 : p - dy2;',
    '  vec3 f = -fx.z > -fy.z ? fx : fy;',
    '  if (-f.z > w + 0.05 + 0.02 * w) k = min(k, r3CarSky((uInvView * vec4(f, 1.0)).xyz, vec3(0.0, 1.0, 0.0)));',
    '  return 0.03 + 0.97 * k;',
    '}',
    'uniform float uExposure; uniform float uAO; uniform float uBloom; uniform float uShaft; uniform vec3 uShaftCol; uniform int uDbg;',
    'uniform float uLens; uniform float uTime; uniform int uTone; uniform vec2 uRes; uniform float uGrain;',
    // The AO target is half size. Read plainly (bilinear), along a silhouette it mixes the near
    // surface's value into the far one's: the road beside a car took the car's own (unoccluded)
    // value, a pale outline round the car against its shadow. Each of the four half-size texels
    // round the pixel is weighted by how near its depth is to the pixel's own.
    'uniform vec2 uAOSize; uniform float uSunK; uniform float uSharp; uniform vec2 uSrcTexel;',
    'vec2 aoUp(vec2 uv) {',
    '  vec2 g = uv * uAOSize - 0.5, b = floor(g), f = g - b; float w0 = viewW(uv), ws = 0.0; vec2 s = vec2(0.0);',
    '  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {',
    '    vec2 t = (b + vec2(float(i), float(j)) + 0.5) / uAOSize;',
    '    float bw = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);',
    '    float dw = abs(viewW(t) - w0) / (w0 * 0.02 + 0.03);',
    '    float k = bw * exp(-dw * dw) + 1e-4 * bw;',
    '    s += texture2D(tAO, t).rg * k; ws += k;',
    '  }',
    '  return s / ws;',
    '}',
    'const mat3 SRGB_2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));',
    'const mat3 R2020_SRGB = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));',
    'vec3 agxCurve(vec3 x){ vec3 x2 = x * x, x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; }',
    // AgX (Troy Sobotka): a log encoding with a sigmoid, so bright saturated colours roll off to
    // white the way film does instead of skewing hue
    'vec3 agx(vec3 c){',
    '  const mat3 inset = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));',
    '  const mat3 outset = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));',
    '  c = inset * (SRGB_2020 * c);',
    '  c = clamp((log2(max(c, 1e-10)) + 12.47393) / 16.5, 0.0, 1.0);',
    '  c = agxCurve(c);',
    // "punchy" look in the AgX log domain: a power curve for contrast plus saturation
    '  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    // (the punch is for the mid tones: full strength in the shadows crushed foliage to black)
    '  vec3 tSh = smoothstep(vec3(0.12), vec3(0.42), max(c, 0.0)); c = pow(max(c, 0.0), 1.0 + 0.3 * tSh);',
    '  l = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '  c = l + 1.3 * (c - l);',
    '  c = outset * c;',
    '  c = pow(max(c, 0.0), vec3(2.2));',
    '  return clamp(R2020_SRGB * c, 0.0, 1.0);',
    '}',
    'vec3 aces(vec3 c){',
    '  const mat3 i = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));',
    '  const mat3 o = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));',
    '  c = i * (c / 0.6);',
    '  c = (c * (c + 0.0245786) - 0.000090537) / (c * (0.983729 * c + 0.4329510) + 0.238081);',
    '  return clamp(o * c, 0.0, 1.0);',
    '}',
    'vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }',
    'float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
    'void main(){',
    '  vec2 d = vUv - 0.5;',
    '  vec3 c;',
    '  if (uLens > 0.5) {', // lateral chromatic aberration, strongest toward the corners
    '    vec2 ca = d * dot(d, d) * 0.0045;',
    '    c = vec3(texture2D(tScene, vUv - ca).r, texture2D(tScene, vUv).g, texture2D(tScene, vUv + ca).b);',
    '  } else c = texture2D(tScene, vUv).rgb;',
    // after TAA: a light unsharp mask, kept inside the range of the pixel and its four
    // neighbours, so it never overshoots: at a dark edge (a tyre against the road) an unbounded
    // one drew a thin light line on the road beside it
    '  if (uSharp > 0.0) {',
    '    vec3 s1 = texture2D(tScene, vUv + vec2(uSrcTexel.x, 0.0)).rgb, s2 = texture2D(tScene, vUv - vec2(uSrcTexel.x, 0.0)).rgb;',
    '    vec3 s3 = texture2D(tScene, vUv + vec2(0.0, uSrcTexel.y)).rgb, s4 = texture2D(tScene, vUv - vec2(0.0, uSrcTexel.y)).rgb;',
    '    vec3 nb = (s1 + s2 + s3 + s4) * 0.25, lo = min(c, min(min(s1, s2), min(s3, s4))), hi = max(c, max(max(s1, s2), max(s3, s4)));',
    '    c = clamp(c + uSharp * (c - nb), lo, hi);',
    '  }',
    // AO is sky light being blocked, so it scales only the share of the light that is not
    // direct sun (the scene alpha, written by the lit materials): full in shade or overcast,
    // faint in bright sun
    // (never more than 80% of the sky light: a crease still sees some bounce light)
    // only the light that is not direct sun is occluded: the screen-space term (r, limited) and the cars' sky occlusion (g, full depth)
    '  { float dirS = clamp(texture2D(tSun, vUv).a, 0.0, 1.0) * uSunK; vec2 o = aoUp(vUv); c *= dirS + (1.0 - dirS) * mix(1.0, max(o.r, 0.2), uAO) * carSky(vUv, uSrcTexel); }',
    '  c += texture2D(tBloom, vUv).rgb * uBloom;',
    '  c += texture2D(tShaft, vUv).rgb * uShaftCol * uShaft;',
    '  c *= uExposure;',
    '  if (uLens > 0.5) c *= mix(1.0, smoothstep(1.0, 0.3, length(d * vec2(1.0, 0.8))), 0.18);', // optical vignetting
    '  c = uTone == 1 ? aces(c) : agx(c);',
    '  c = toSRGB(c);',
    // grain doubles as dither, which also hides 8-bit banding in skies and fog
    '  float g = hash(vUv * uRes + fract(uTime) * 61.0) - 0.5;',
    '  c += g * (uLens > 0.5 ? 0.016 : 0.006) * uGrain;',
    '  if (uDbg == 1) c = vec3(texture2D(tAO, vUv).r); else if (uDbg == 2) c = vec3(texture2D(tSun, vUv).a);', // debug views (window.__postDbg)
    '  gl_FragColor = vec4(c, 1.0);',
    '}'].join('\n'), {
    tScene: { value: null }, tAO: { value: null }, tBloom: { value: null }, tShaft: { value: null }, tSun: { value: null }, uDbg: { value: 0 }, uAOSize: { value: new THREE.Vector2(1, 1) }, uSunK: { value: 1 }, uSharp: { value: 0 }, uSrcTexel: { value: new THREE.Vector2(1, 1) },
    tDepth: { value: null }, uLogFar: { value: 1 }, uProj: { value: new THREE.Vector2(1, 1) }, uInvView: { value: new THREE.Matrix4() },
    ...(F1.R3Shadow ? { uOccCar: F1.R3Shadow.U.uOccCar, uOccN: F1.R3Shadow.U.uOccN, uOccSt: F1.R3Shadow.U.uOccSt, uOccBC: F1.R3Shadow.U.uOccBC, uOccBR: F1.R3Shadow.U.uOccBR } : {}),
    uExposure: { value: 1 }, uAO: { value: 0 }, uBloom: { value: 0 }, uShaft: { value: 0 }, uShaftCol: { value: new THREE.Color(1, 1, 1) },
    uLens: { value: 1 }, uGrain: { value: 1 }, uTime: { value: 0 }, uTone: { value: 0 }, uRes: { value: new THREE.Vector2() },
  });

  // ---------- targets ----------
  const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); black.needsUpdate = true;
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); white.needsUpdate = true;
  function target(w, h, o = {}) {
    return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), Object.assign({ type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false }, o));
  }
  function build() {
    for (const k in RT) { const v = RT[k]; if (Array.isArray(v)) v.forEach(t => t.dispose()); else if (v && v.dispose) v.dispose(); delete RT[k]; }
    const w = Math.max(2, Math.round(W * Q.scale)), h = Math.max(2, Math.round(H * Q.scale));
    const dt = new THREE.DepthTexture(w, h, THREE.FloatType);
    RT.scene = target(w, h, { depthBuffer: true, depthTexture: dt, samples: Q.msaa });
    RT.motion = target(w, h);
    RT.vel = target(w >> 1, h >> 1, { depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    RT.ao = target(w >> 1, h >> 1, { type: THREE.UnsignedByteType });
    RT.ao2 = target(w >> 1, h >> 1, { type: THREE.UnsignedByteType });
    RT.bloom = [];
    for (let k = 1; k <= 6; k++) RT.bloom.push(target(w >> k, h >> k));
    RT.shaftA = target(w >> 2, h >> 2); RT.shaftB = target(w >> 2, h >> 2);
    RT.taa = Q.taa ? [target(w, h), target(w, h)] : [];
    RT.aoH = Q.taa ? [target(w >> 1, h >> 1), target(w >> 1, h >> 1)] : []; // (half float: b holds the depth)
    RT.w = w; RT.h = h;
  }

  let dirty = true;
  function init(renderer) { R = renderer; }
  function setSize(w, h) { if (w !== W || h !== H) { W = w; H = h; dirty = true; } }
  function setQuality(o) {
    const need = o.scale !== Q.scale || o.msaa !== Q.msaa || (o.taa != null && !!o.taa !== !!Q.taa);
    if (o.fxaa != null) o.fxaa = !!o.fxaa;
    Object.assign(Q, o);
    if (need) dirty = true;
  }

  const prevVP = new THREE.Matrix4(), curVP = new THREE.Matrix4(), _pvp = new THREE.Matrix4(), SUN = new THREE.Vector3();
  let hadPrev = false, lastCam = null, lastMode = '', frame = 0, hi = 0, histOK = false;
  const lastPos = new THREE.Vector3(), lastDir = new THREE.Vector3(), _dir = new THREE.Vector3();

  // view: { exposure, sunDir (world), sunCol, dt }
  function render(scene, camera, view) {
    if (dirty || !RT.scene) { build(); dirty = false; hadPrev = false; histOK = false; }
    const w = RT.w, h = RT.h;
    camera.updateMatrixWorld();
    const taa = Q.taa && RT.taa.length > 0 && !taaMat.userData.broken;
    frame = (frame + 1) % 4096;
    // a camera cut (a new TV camera, a replay jump) starts the history again
    _dir.set(0, 0, -1).applyQuaternion(camera.quaternion);
    // (a change of camera mode is a cut even when the new camera is close by: chase to T camera)
    const cut = !hadPrev || lastCam !== camera || camera.position.distanceToSquared(lastPos) > 144 || _dir.dot(lastDir) < 0.9 || (view.mode || '') !== lastMode;
    lastPos.copy(camera.position); lastDir.copy(_dir); lastMode = view.mode || '';
    // 1. scene in linear HDR (with TAA, from a camera moved by a fraction of a pixel: Halton 2,3)
    let jx = 0, jy = 0;
    const pe = camera.projectionMatrix.elements;
    if (taa) { const k = (frame % 8) + 1; jx = HALTON(k, 2) - 0.5; jy = HALTON(k, 3) - 0.5; pe[8] += 2 * jx / w; pe[9] += 2 * jy / h; }
    R.setRenderTarget(RT.scene);
    R.render(scene, camera);
    if (taa) { pe[8] -= 2 * jx / w; pe[9] -= 2 * jy / h; }
    const logFar = revNear ? -revNear : Math.log2(camera.far + 1), proj = new THREE.Vector2(camera.projectionMatrix.elements[0], camera.projectionMatrix.elements[5]);
    const setDepth = m => { m.uniforms.tDepth.value = RT.scene.depthTexture; m.uniforms.uLogFar.value = logFar; m.uniforms.uProj.value.copy(proj); };
    let src = RT.scene.texture;
    curVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // the cars' screen motion, for TAA and motion blur
    // (not on the frame of a camera cut: the jump from the last camera's place read as a huge
    // movement and smeared the whole picture, the car's own bodywork included, for a frame)
    const moving = hadPrev && lastCam === camera && view.dt > 0 && !cut;
    let velTex = black;
    if (view.vel && (Q.motion && moving || taa && !cut)) { velocityPass(view.vel, camera); velTex = RT.vel.texture; }
    // wet road: reflections traced at half size, laid over the scene before TAA smooths them
    if (WET.k > 0.03 && WET.mask && !ssrMat.userData.broken && !wetMixMat.userData.broken) {
      if (!RT.ssr) { RT.ssr = target(w >> 1, h >> 1); RT.wet = target(w, h); }
      const u = ssrMat.uniforms;
      setDepth(ssrMat);
      u.tScene.value = src; u.tVel.value = velTex; u.tMask.value = WET.mask.tex; u.uMaskB.value.copy(WET.mask.b); u.uWet.value = WET.k; u.uFrame.value = frame % 64;
      u.uInvView.value.copy(camera.matrixWorld); u.uView.value.copy(camera.matrixWorldInverse); u.uProjM.value.copy(camera.projectionMatrix);
      pass(ssrMat, RT.ssr);
      wetMixMat.uniforms.tScene.value = src; wetMixMat.uniforms.tSSR.value = RT.ssr.texture; wetMixMat.uniforms.uDbg.value = G.__ssrDbg || 0;
      pass(wetMixMat, RT.wet);
      if (!ssrMat.userData.broken && !wetMixMat.userData.broken) src = RT.wet.texture;
    }
    // 2. temporal anti-aliasing
    if (taa) {
      const u = taaMat.uniforms, H0 = RT.taa[hi], H1 = RT.taa[1 - hi];
      setDepth(taaMat);
      u.tCur.value = src; u.tHist.value = H0.texture; u.tVel.value = velTex;
      u.uInvView.value.copy(camera.matrixWorld); u.uPrevVP.value.copy(prevVP);
      u.uTexel.value.set(1 / w, 1 / h); u.uJit.value.set(-jx / w, -jy / h);
      u.uReset.value = cut || !histOK ? 1 : 0; u.uStatic.value = view.staticNear || 0;
      pass(taaMat, H1);
      if (!taaMat.userData.broken) { src = H1.texture; hi = 1 - hi; histOK = true; }
    } else histOK = false;
    // 3. motion blur from camera movement
    if (Q.motion && moving) {
      setDepth(motionMat);
      motionMat.uniforms.tScene.value = src;
      motionMat.uniforms.tVel.value = velTex;
      motionMat.uniforms.uInvView.value.copy(camera.matrixWorld);
      motionMat.uniforms.uPrevVP.value.copy(prevVP);
      motionMat.uniforms.uScale.value = Math.min(1, Q.shutter / 360 / 60 / view.dt); // shutter angle, 180 degrees by default
      motionMat.uniforms.uNear.value = view.motionNear || 9;
      pass(motionMat, RT.motion);
      src = RT.motion.texture;
    }
    const prevForAO = _pvp.copy(prevVP);
    prevVP.copy(curVP); hadPrev = true; lastCam = camera;
    if (view.vel) storeMovers(view.vel.meshes);
    // 3. ambient obscurance
    let ao = white;
    // the pass also carries the cars' sky occlusion, so with screen-space AO off it still runs
    // (no samples) whenever there are cars near the camera
    if (Q.ssao && !ssaoMat.userData.broken && !blurAOMat.userData.broken) {
      // start from "nothing occluded": should the pass not run (a shader this GPU will not
      // compile) the scene keeps its sky light instead of going black
      clearTo(RT.ao, 0xffffff); clearTo(RT.ao2, 0xffffff);
      setDepth(ssaoMat);
      ssaoMat.uniforms.uTexel.value.set(1 / w, 1 / h);
      ssaoMat.uniforms.uFar.value = camera.far;
      // with TAA the pattern turns each frame and is blended over time, so fewer samples do
      ssaoMat.uniforms.uSamples.value = Q.ssao ? (taa ? Math.max(4, Math.round(Q.aoSamples * 0.6)) : Q.aoSamples) : 0;
      ssaoMat.uniforms.uFrame.value = taa ? frame % 64 : 0;
      ssaoMat.uniforms.uInvView.value.copy(camera.matrixWorld);
      pass(ssaoMat, RT.ao);
      setDepth(blurAOMat);
      blurAOMat.uniforms.tAO.value = RT.ao.texture; blurAOMat.uniforms.uDir.value.set(2 / w, 0); pass(blurAOMat, RT.ao2);
      blurAOMat.uniforms.tAO.value = RT.ao2.texture; blurAOMat.uniforms.uDir.value.set(0, 2 / h); pass(blurAOMat, RT.ao);
      ao = ssaoMat.userData.broken || blurAOMat.userData.broken ? white : RT.ao.texture;
      if (taa && Q.ssao && ao !== white && !aoTMat.userData.broken) {
        const A0 = RT.aoH[(frame & 1) ^ 1], A1 = RT.aoH[frame & 1], u = aoTMat.uniforms;
        setDepth(aoTMat);
        u.tAO.value = RT.ao.texture; u.tHist.value = A0.texture; u.uInvView.value.copy(camera.matrixWorld); u.uPrevVP.value.copy(prevForAO);
        u.uTexel.value.set(2 / w, 2 / h); u.uReset.value = cut ? 1 : 0;
        pass(aoTMat, A1);
        if (!aoTMat.userData.broken) ao = A1.texture;
        if (G.__aoProbe) aoProbe(RT.ao, A1);
      }
    }
    // 4. bloom
    let bloom = black;
    if (Q.bloom) {
      const B = RT.bloom;
      preMat.uniforms.tSrc.value = src; preMat.uniforms.uTexel.value.set(1 / w, 1 / h);
      preMat.uniforms.uThresh.value = 1.6 / view.exposure;
      pass(preMat, B[0]);
      for (let k = 1; k < B.length; k++) { downMat.uniforms.tSrc.value = B[k - 1].texture; downMat.uniforms.uTexel.value.set(1 / B[k - 1].width, 1 / B[k - 1].height); pass(downMat, B[k]); }
      R.autoClear = false;
      for (let k = B.length - 1; k > 0; k--) { upMat.uniforms.tSrc.value = B[k].texture; upMat.uniforms.uTexel.value.set(1 / B[k].width, 1 / B[k].height); pass(upMat, B[k - 1]); }
      R.autoClear = true;
      bloom = B[0].texture;
    }
    // 5. sun shafts when the sun is in front of the camera
    let shaft = black, shaftK = 0;
    if (Q.shafts && view.sunDir) {
      SUN.copy(view.sunDir).multiplyScalar(5000).add(camera.position).project(camera);
      const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).dot(view.sunDir);
      if (SUN.z < 1 && facing > 0.1) {
        const su = new THREE.Vector2(SUN.x * 0.5 + 0.5, SUN.y * 0.5 + 0.5);
        shaftK = Math.min(1, (facing - 0.1) * 2) * (1 - Math.min(1, Math.max(0, Math.max(Math.abs(SUN.x), Math.abs(SUN.y)) - 1) * 2));
        if (shaftK > 0.01) {
          setDepth(shaftMaskMat);
          shaftMaskMat.uniforms.tScene.value = src; shaftMaskMat.uniforms.uSun.value.copy(su);
          shaftMaskMat.uniforms.uFar.value = camera.far; shaftMaskMat.uniforms.uAspect.value = w / h;
          pass(shaftMaskMat, RT.shaftA);
          shaftBlurMat.uniforms.uSun.value.copy(su);
          shaftBlurMat.uniforms.tSrc.value = RT.shaftA.texture; shaftBlurMat.uniforms.uStep.value = 1; pass(shaftBlurMat, RT.shaftB);
          shaftBlurMat.uniforms.tSrc.value = RT.shaftB.texture; shaftBlurMat.uniforms.uStep.value = 0.35; pass(shaftBlurMat, RT.shaftA);
          shaft = RT.shaftA.texture;
        }
      }
    }
    // 6. composite to the canvas
    const u = compMat.uniforms;
    setDepth(compMat); u.uAOSize.value.set(RT.ao.width, RT.ao.height);
    u.tScene.value = src; u.tAO.value = ao; u.tBloom.value = bloom; u.tShaft.value = shaft; u.tSun.value = RT.scene.texture;
    u.uDbg.value = G.__postDbg || 0; u.uInvView.value.copy(camera.matrixWorld);
    u.uSharp.value = taa ? (G.__taaSharp != null ? G.__taaSharp : 0.22) : 0; u.uSrcTexel.value.set(1 / w, 1 / h);
    u.uExposure.value = view.exposure; u.uAO.value = Q.ssao ? Q.aoK : 0; u.uBloom.value = Q.bloom ? Q.bloomK : 0;
    u.uShaft.value = shaftK * Q.shaftK * (view.shaftK != null ? view.shaftK : 1); if (view.sunCol) u.uShaftCol.value.copy(view.sunCol);
    u.uGrain.value = view.dt > 0 && Q.grain ? 1 : 0; // no grain on the frozen frame behind the pause menu
    u.uLens.value = Q.lens ? 1 : 0; u.uTime.value = performance.now() / 1000; u.uTone.value = (view.tone || Q.tone) === 'aces' ? 1 : 0;
    u.uRes.value.set(R.domElement.width, R.domElement.height);
    // 7. FXAA on the finished picture (the composite then draws into an 8-bit target, without grain)
    const cw = R.domElement.width, ch = R.domElement.height;
    if (Q.fxaa && !fxaaMat.userData.broken) {
      if (!RT.ldr || RT.ldr.width !== cw || RT.ldr.height !== ch) { if (RT.ldr) RT.ldr.dispose(); RT.ldr = target(cw, ch, { type: THREE.UnsignedByteType }); }
      const grain = u.uGrain.value; u.uGrain.value = 0;
      pass(compMat, RT.ldr);
      const f = fxaaMat.uniforms;
      f.tSrc.value = RT.ldr.texture; f.uTexel.value.set(1 / cw, 1 / ch); f.uGrain.value = grain; f.uLens.value = u.uLens.value; f.uTime.value = u.uTime.value; f.uRes.value.set(cw, ch);
      pass(fxaaMat, null);
      if (fxaaMat.userData.broken) { u.uGrain.value = grain; pass(compMat, null); } // (a GPU that cannot compile it: the picture as before)
    } else pass(compMat, null);
  }

  // compile the passes' shaders in the background before the first frame (see R3.precompile)
  function precompile() {
    if (!R || !R.compileAsync) return Promise.resolve();
    const sc = new THREE.Scene(), cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), g = new THREE.PlaneGeometry(2, 2);
    for (const m of ALL) { const q = new THREE.Mesh(g, m); q.frustumCulled = false; sc.add(q); }
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType }), prev = R.getRenderTarget();
    R.setRenderTarget(rt);
    let p;
    try { p = R.compileAsync(sc, cam); } catch (e) { p = Promise.resolve(); }
    R.setRenderTarget(prev);
    return p.catch(() => {}).then(() => { rt.dispose(); g.dispose(); });
  }
  // which passes this GPU could not compile (switched off), for the graphics report
  function status() { const b = ALL.filter(m => m.userData.broken).length; return { on: Q.on, ssao: Q.ssao && !ssaoMat.userData.broken, taa: Q.taa && !taaMat.userData.broken, fxaa: Q.fxaa && !fxaaMat.userData.broken, wet: WET.k, brokenPasses: b }; }
  // Regression probe for the pale outline round a car against its shadow (tools/halocheck.py):
  // with window.__aoProbe set, each frame compares the occlusion carried over from earlier frames
  // with this frame's own, over the lower part of the screen (the road). A carried-over value far
  // brighter than this frame's is a car's unshadowed value left on the road beside it.
  // window.__aoProbeOut collects [share of such pixels, pixels looked at] per frame.
  // (half-float targets cannot be read back everywhere: each is copied into an 8-bit one first)
  const _rd = {}, copyMat = mk('varying vec2 vUv; uniform sampler2D tSrc; void main(){ gl_FragColor = vec4(texture2D(tSrc, vUv).r, 0.0, 0.0, 1.0); }', { tSrc: { value: null } });
  function readR(rt) {
    const w = rt.width, h = rt.height, k = w + 'x' + h;
    const tmp = _rd[k] || (_rd[k] = { t: target(w, h, { type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }), b: new Uint8Array(w * h * 4) });
    copyMat.uniforms.tSrc.value = rt.texture; pass(copyMat, tmp.t);
    R.readRenderTargetPixels(tmp.t, 0, 0, w, h, tmp.b);
    const out = new Float32Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = tmp.b[i * 4] / 255;
    return out;
  }
  function aoProbe(cur, hist) {
    const c = readR(cur), t = readR(hist), w = cur.width, h = cur.height;
    let bad = 0, n = 0, sc = 0, st = 0;
    for (let y = 0; y < Math.floor(h * 0.6); y++) for (let x = 0; x < w; x++) { const i = y * w + x; n++; sc += c[i]; st += t[i]; if (t[i] - c[i] > 0.3) bad++; }
    // (the mean of each, so the check can tell a failed read, all zeros, from a clean frame)
    (G.__aoProbeOut || (G.__aoProbeOut = [])).push([bad / n, n, sc / n, st / n]);
  }
  // how wet the road is (0..1) and where the road is (see wetMask in js/render3d.js)
  function setWet(k, mask) { WET.k = k; WET.mask = mask || null; }
  F1.R3Post = { setWet, setReversed: n => { revNear = n; }, setSunK: k => { compMat.uniforms.uSunK.value = k; }, init, setSize, setQuality, render, precompile, status, Q, get height() { return RT.h || H; } };
})(typeof window !== 'undefined' ? window : globalThis);
