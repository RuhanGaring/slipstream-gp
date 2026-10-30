// Post-processing for the 3D renderer. The scene renders into a multisampled half-float
// target in linear radiance (white ground = 1.0); everything below works in that space
// and only the final composite applies exposure, tone mapping and the sRGB transfer.
//   SSAO        Alchemy-style ambient obscurance from the log depth buffer, depth-aware blur
//   bloom       soft-threshold prefilter + 6-level downsample / upsample chain
//   sun shafts  screen-space radial scattering of the visible sky around the sun
//   motion blur camera reprojection for the static world; cars (and the ground their shadows
//               fall on) carry their own screen velocity from a velocity pass, so a car running
//               alongside at your speed stays sharp
//   composite   AgX or ACES tone mapping, vignette, chromatic aberration, grain dither
(function (G) {
  'use strict';
  const F1 = G.F1;

  let R = null, W = 2, H = 2;
  const Q = { on: true, scale: 1, msaa: 4, ssao: true, aoSamples: 12, aoK: 0.85, bloom: true, bloomK: 0.06, shafts: true, shaftK: 0.45, motion: true, shutter: 180, lens: true, grain: true, tone: 'agx' };
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
    'float viewW(vec2 uv){ return exp2(texture2D(tDepth, uv).x * uLogFar) - 1.0; }',
    'vec3 viewPos(vec2 uv){ float w = viewW(uv); vec2 n = uv * 2.0 - 1.0; return vec3(n.x * w / uProj.x, n.y * w / uProj.y, -w); }'].join('\n');
  const ALL = []; // every pass material, for precompile()
  const mk = (frag, uniforms, o = {}) => { const m = new THREE.ShaderMaterial(Object.assign({ vertexShader: VS, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false }, o)); ALL.push(m); return m; };
  const depthU = () => ({ tDepth: { value: null }, uLogFar: { value: 1 }, uProj: { value: new THREE.Vector2(1, 1) } });

  // ---------- SSAO ----------
  // (plus the sky the cars hide from the road under them, js/r3-shadow.js, evaluated per pixel)
  const ssaoMat = mk([
    'varying vec2 vUv;', DEPTH,
    'uniform vec2 uTexel; uniform float uRadius; uniform float uFar; uniform int uSamples; uniform mat4 uInvView;',
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
    '  float a0 = ign(gl_FragCoord.xy) * 6.2831853, sum = 0.0;',
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
    // the cars' sky occlusion, on surfaces that face up, kept in its own channel (g) so it is
    // not limited like the screen-space term: deep under a floor in the shade only a little
    // bounce light gets in
    '  vec3 wn = normalize((uInvView * vec4(n, 0.0)).xyz);',
    '  float car = 1.0;',
    '  if (wn.y > 0.3 && uOccN > 0) car = mix(1.0, 0.03 + 0.97 * r3CarSky((uInvView * vec4(p, 1.0)).xyz, wn), smoothstep(0.3, 0.7, wn.y));',
    '  gl_FragColor = vec4(ao, car, 1.0, 1.0);',
    '}'].join('\n'), Object.assign(depthU(), { uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1.5 }, uFar: { value: 14000 }, uSamples: { value: 12 }, uInvView: { value: new THREE.Matrix4() } },
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
    uniforms: { uPrevMVP: { value: new THREE.Matrix4() } },
    vertexShader: [
      'uniform mat4 uPrevMVP; varying vec4 vCur; varying vec4 vPrev; varying float vZ;',
      'void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vCur = projectionMatrix * mv; vPrev = uPrevMVP * vec4(position, 1.0); vZ = -mv.z; gl_Position = vCur; }'].join('\n'),
    fragmentShader: [
      'varying vec4 vCur; varying vec4 vPrev; varying float vZ;',
      'void main(){ vec2 a = vCur.xy / vCur.w * 0.5 + 0.5, b = vPrev.xy / vPrev.w * 0.5 + 0.5; gl_FragColor = vec4(a - b, vZ, 1.0); }'].join('\n'),
    side: THREE.DoubleSide,
  });
  const CC = new THREE.Color();
  velMat.onBeforeRender = (r, sc, cam, geo, obj) => {
    const pw = obj.userData.prevMW || obj.matrixWorld;
    velMat.uniforms.uPrevMVP.value.multiplyMatrices(prevVP, pw);
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
    'varying vec2 vUv;',
    'uniform sampler2D tScene; uniform sampler2D tAO; uniform sampler2D tBloom; uniform sampler2D tShaft; uniform sampler2D tSun;',
    'uniform float uExposure; uniform float uAO; uniform float uBloom; uniform float uShaft; uniform vec3 uShaftCol; uniform int uDbg;',
    'uniform float uLens; uniform float uTime; uniform int uTone; uniform vec2 uRes; uniform float uGrain;',
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
    '  c = pow(max(c, 0.0), vec3(1.3));',
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
    // AO is sky light being blocked, so it scales only the share of the light that is not
    // direct sun (the scene alpha, written by the lit materials): full in shade or overcast,
    // faint in bright sun
    // (never more than 80% of the sky light: a crease still sees some bounce light)
    // only the light that is not direct sun is occluded: the screen-space term (r, limited) and the cars' sky occlusion (g, full depth)
    '  { float dirS = clamp(texture2D(tSun, vUv).a, 0.0, 1.0); vec2 o = texture2D(tAO, vUv).rg; c *= dirS + (1.0 - dirS) * mix(1.0, max(o.r, 0.2), uAO) * o.g; }',
    '  c += texture2D(tBloom, vUv).rgb * uBloom;',
    '  c += texture2D(tShaft, vUv).rgb * uShaftCol * uShaft;',
    '  c *= uExposure;',
    '  if (uLens > 0.5) c *= mix(1.0, smoothstep(0.95, 0.2, length(d * vec2(1.0, 0.8))), 0.45);', // optical vignetting
    '  c = uTone == 1 ? aces(c) : agx(c);',
    '  c = toSRGB(c);',
    // grain doubles as dither, which also hides 8-bit banding in skies and fog
    '  float g = hash(vUv * uRes + fract(uTime) * 61.0) - 0.5;',
    '  c += g * (uLens > 0.5 ? 0.016 : 0.006) * uGrain;',
    '  if (uDbg == 1) c = vec3(texture2D(tAO, vUv).r); else if (uDbg == 2) c = vec3(texture2D(tSun, vUv).a);', // debug views (window.__postDbg)
    '  gl_FragColor = vec4(c, 1.0);',
    '}'].join('\n'), {
    tScene: { value: null }, tAO: { value: null }, tBloom: { value: null }, tShaft: { value: null }, tSun: { value: null }, uDbg: { value: 0 },
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
    RT.w = w; RT.h = h;
  }

  let dirty = true;
  function init(renderer) { R = renderer; }
  function setSize(w, h) { if (w !== W || h !== H) { W = w; H = h; dirty = true; } }
  function setQuality(o) {
    const need = o.scale !== Q.scale || o.msaa !== Q.msaa;
    Object.assign(Q, o);
    if (need) dirty = true;
  }

  const prevVP = new THREE.Matrix4(), curVP = new THREE.Matrix4(), SUN = new THREE.Vector3();
  let hadPrev = false, lastCam = null;

  // view: { exposure, sunDir (world), sunCol, dt }
  function render(scene, camera, view) {
    if (dirty || !RT.scene) { build(); dirty = false; hadPrev = false; }
    const w = RT.w, h = RT.h;
    camera.updateMatrixWorld();
    // 1. scene in linear HDR
    R.setRenderTarget(RT.scene);
    R.render(scene, camera);
    const logFar = Math.log2(camera.far + 1), proj = new THREE.Vector2(camera.projectionMatrix.elements[0], camera.projectionMatrix.elements[5]);
    const setDepth = m => { m.uniforms.tDepth.value = RT.scene.depthTexture; m.uniforms.uLogFar.value = logFar; m.uniforms.uProj.value.copy(proj); };
    let src = RT.scene.texture;
    // 2. motion blur from camera movement
    curVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (Q.motion && hadPrev && lastCam === camera && view.dt > 0) {
      setDepth(motionMat);
      motionMat.uniforms.tScene.value = src;
      if (view.vel) { velocityPass(view.vel, camera); motionMat.uniforms.tVel.value = RT.vel.texture; }
      else motionMat.uniforms.tVel.value = black;
      motionMat.uniforms.uInvView.value.copy(camera.matrixWorld);
      motionMat.uniforms.uPrevVP.value.copy(prevVP);
      motionMat.uniforms.uScale.value = Math.min(1, Q.shutter / 360 / 60 / view.dt); // shutter angle, 180 degrees by default
      motionMat.uniforms.uNear.value = view.motionNear || 9;
      pass(motionMat, RT.motion);
      src = RT.motion.texture;
    }
    prevVP.copy(curVP); hadPrev = true; lastCam = camera;
    if (view.vel) storeMovers(view.vel.meshes);
    // 3. ambient obscurance
    let ao = white;
    // the pass also carries the cars' sky occlusion, so with screen-space AO off it still runs
    // (no samples) whenever there are cars near the camera
    const carOcc = F1.R3Shadow && F1.R3Shadow.U.uOccN.value > 0;
    if ((Q.ssao || carOcc) && !ssaoMat.userData.broken && !blurAOMat.userData.broken) {
      // start from "nothing occluded": should the pass not run (a shader this GPU will not
      // compile) the scene keeps its sky light instead of going black
      clearTo(RT.ao, 0xffffff); clearTo(RT.ao2, 0xffffff);
      setDepth(ssaoMat);
      ssaoMat.uniforms.uTexel.value.set(1 / w, 1 / h);
      ssaoMat.uniforms.uFar.value = camera.far;
      ssaoMat.uniforms.uSamples.value = Q.ssao ? Q.aoSamples : 0;
      ssaoMat.uniforms.uInvView.value.copy(camera.matrixWorld);
      pass(ssaoMat, RT.ao);
      setDepth(blurAOMat);
      blurAOMat.uniforms.tAO.value = RT.ao.texture; blurAOMat.uniforms.uDir.value.set(2 / w, 0); pass(blurAOMat, RT.ao2);
      blurAOMat.uniforms.tAO.value = RT.ao2.texture; blurAOMat.uniforms.uDir.value.set(0, 2 / h); pass(blurAOMat, RT.ao);
      ao = ssaoMat.userData.broken || blurAOMat.userData.broken ? white : RT.ao.texture;
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
    u.tScene.value = src; u.tAO.value = ao; u.tBloom.value = bloom; u.tShaft.value = shaft; u.tSun.value = RT.scene.texture;
    u.uDbg.value = G.__postDbg || 0;
    u.uExposure.value = view.exposure; u.uAO.value = Q.ssao ? Q.aoK : 0; u.uBloom.value = Q.bloom ? Q.bloomK : 0;
    u.uShaft.value = shaftK * Q.shaftK; if (view.sunCol) u.uShaftCol.value.copy(view.sunCol);
    u.uGrain.value = view.dt > 0 && Q.grain ? 1 : 0; // no grain on the frozen frame behind the pause menu
    u.uLens.value = Q.lens ? 1 : 0; u.uTime.value = performance.now() / 1000; u.uTone.value = Q.tone === 'aces' ? 1 : 0;
    u.uRes.value.set(R.domElement.width, R.domElement.height);
    pass(compMat, null);
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
  function status() { const b = ALL.filter(m => m.userData.broken).length; return { on: Q.on, ssao: Q.ssao && !ssaoMat.userData.broken, brokenPasses: b }; }
  F1.R3Post = { init, setSize, setQuality, render, precompile, status, Q, get height() { return RT.h || H; } };
})(typeof window !== 'undefined' ? window : globalThis);
