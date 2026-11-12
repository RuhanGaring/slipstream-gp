// Shader system for the 3D renderer: one patcher that every scene material goes through.
// It replaces three.js' distance fog with exponential height fog (denser in the valleys,
// glowing toward the sun), adds world-space macro variation where a material asks for it,
// and keeps all of this driven by shared uniforms so a venue change updates every shader.
(function (G) {
  'use strict';
  const F1 = G.F1;

  // shared uniform objects: the same {value} is referenced by every patched program
  const U = {
    // the circuit's traced sky shade on the road (js/r3-carshade.js bakeRoad): lap length, the
    // grid's first lateral offset and width; off until a circuit has one
    uRoadShade: { value: null }, uRoadShadeP: { value: new THREE.Vector3(1, -8, 16) }, uRoadShadeOn: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Color(1, 1, 1) },
    uFogCol: { value: new THREE.Color(0.5, 0.5, 0.5) },
    uFogDensity: { value: 0.0003 },
    uFogFalloff: { value: 0.004 },
    macroMap: { value: null },
    // lawn: xy the direction the mower laid the stripes, z stripe width (m), w stripe strength
    uLawn: { value: new THREE.Vector4(1, 0, 10, 0) },
    uWet: { value: 0 }, // how wet the road is, 0..1
    uRooms: { value: 1 }, // rooms behind town windows, 1 on, 0 off
    // the venue's turf map (render3d.js turfMap): r how dry the site is (0.5 neutral), g wear
    // beside the track; uTurfB its world rectangle (x0, z0, width, depth)
    uTurf: { value: null },
    uTurfB: { value: new THREE.Vector4(0, 0, 1, 1) },
    uWindT: { value: 0 }, // seconds, for the wind's gusts over the field
    uLawnK: { value: 2 },
    // the venue's light on the turf: rgb a tint, w how far toward a grey olive (overcast skies)
    uLawnGrade: { value: new THREE.Vector4(1, 1, 1, 0) },
    uFarLawn: { value: new THREE.Vector4(0, 0, 0, 0) },
    uFarTex: { value: null },
    uRingH: { value: new THREE.Vector4(0, 0, 1e9, 0) },
    uFootT: { value: new THREE.Vector3(1, 1, 1) },
    uLodJit: { value: 0 },
    uFieldK: { value: 0.7 },
    uRoadSky: { value: 3.2 },
    // the 3D grass map (js/r3-grass.js), so the ground can wear where the turf meets other surfaces
    uGrassMask: { value: null }, uGrassMaskB: { value: new THREE.Vector4(0, 0, 1, 1) }, // strength of the lawn colour variation (debug: larger exaggerates it to inspect the pattern)
  };
  { const t = new THREE.DataTexture(new Uint8Array([128, 0, 0, 255]), 1, 1); t.needsUpdate = true; U.uTurf.value = t; }
  { const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); t.needsUpdate = true; U.uGrassMask.value = t; }
  // value noise for the lawn: random texels, read with bilinear filtering
  {
    const n = 256, d = new Uint8Array(n * n * 4), r = F1.U.rng(1187);
    for (let k = 0; k < d.length; k += 4) d[k] = Math.floor(r() * 256);
    const t = new THREE.DataTexture(d, n, n, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
    U.uTfTex = { value: t };
  }
  if (F1.R3Shadow) Object.assign(U, F1.R3Shadow.U); // the cascaded sun shadow (js/r3-shadow.js)

  // Lawn shading shared by the park ground and the grass blades, so the two always agree.
  // lawnTint colours turf by what actually varies it at a circuit, all as gentle multipliers on
  // the grass photo (an irrigated, mown venue: nothing goes fully brown):
  // - water: the site's drainage from the turf map (crests, steep and sun-facing slopes dry out,
  //   hollows stay wet) plus soil variation over tens of metres. Wet turf is a deeper, bluer
  //   green; drought stress turns it yellow-green and, where it is driest, toward straw.
  // - species: sports turf is a mix, and each grass grows in its own clumps a metre or two
  //   across with fairly sharp edges: perennial ryegrass (the base), annual meadow grass (Poa
  //   annua: paler, yellower), fescue (finer, blue-green). Domain-warped noise, thresholded,
  //   draws those clumps; it is not left as soft blotches.
  // - weeds: clover and other broadleaves in small spots, gathered in some areas.
  // - yellow patches: now and then a patch a few metres across has gone yellow (a dry spot over
  //   compacted or shallow soil, disease, or something left lying on it), irregular in outline,
  //   with a slightly paler rim where it fades into the green. Rare, and not evenly spread.
  // - wear: the strip beside the track, where cars run wide, is scuffed toward soil.
  // - mowing stripes: blades laid in alternate directions read light along their lay and dark
  //   against it, as from a grandstand.
  // lawnFar (the ground only): past the 3D grass the ground stands in for it. Tufts at two
  // scales lighten and darken it and tilt its normal (so the sun picks out their lit and
  // shaded sides), and at low angles the blades' upper parts hide the soil, so it reads a
  // little lighter and greener toward the horizon. It grows in with distance and grazing
  // angle, which is where the 3D grass fades out, so the two meet without a seam.
  // lawnBreak: the ground photo again at 11.3 m and rotated, as brightness only, so its
  // 3.2 m tile stops repeating visibly across a field.
  const LAWN_ROUGH = 0.78;
  const LAWN = [
    'uniform sampler2D uGrassMask; uniform vec4 uGrassMaskB;',
    'uniform vec4 uLawn; uniform sampler2D uTurf; uniform vec4 uTurfB; uniform float uLawnK; uniform float uWindT; uniform vec4 uLawnGrade; uniform vec4 uFarLawn; uniform sampler2D uFarTex; uniform vec4 uRingH; uniform vec3 uFootT; uniform float uFieldK;',
    // the venue grade: tint, then part of the way toward a grey olive of the same brightness
    'vec3 lawnGrade(vec3 c) { float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); return mix(c * uLawnGrade.rgb, vec3(l) * vec3(0.98, 1.04, 0.80), uLawnGrade.w); }',
    'float tfH(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }',
    'uniform sampler2D uTfTex;',
    'float tfN(vec2 p) { return texture2D(uTfTex, p / 256.0).r; }',
    'float tfF(vec2 p) { return tfN(p) * 0.5 + tfN(p * 2.03 + 7.1) * 0.3 + tfN(p * 4.07 + 3.3) * 0.2; }',
    'float lawnFarK(vec3 wp, vec3 eye) { vec3 v = normalize(eye - wp); return smoothstep(5.0, 32.0, distance(wp.xz, eye.xz)) * (0.45 + 0.55 * (1.0 - clamp(v.y, 0.0, 1.0))); }',
    'float lawnTuft(vec2 w) { return tfN(w * 1.7) * 0.4 + tfN(w * 3.9 + 2.0) * 0.35 + tfN(w * 8.3 + 5.1) * 0.25; }',
    'vec3 lawnFar(vec2 w, vec3 wp, vec3 eye, vec3 sunDir) {',
    '  float k = lawnFarK(wp, eye), graze = 1.0 - clamp(normalize(eye - wp).y, 0.0, 1.0);',
    '  float tf = mix(0.86, 1.1, lawnTuft(w));',
    // the gusts that bend the 3D grass, seen from afar as lighter bands rolling across the field
    '  vec2 gd = vec2(0.8, 0.6); float gg = 0.5 + 0.5 * sin(dot(w, gd) * 0.16 - uWindT * 2.1 + sin(dot(w, vec2(-gd.y, gd.x)) * 0.05 + uWindT * 0.3) * 2.4);',
    // and the pale sheen of the blades looking toward the sun at a low angle
    '  vec3 v = normalize(wp - eye); float sh = pow(clamp(dot(v, sunDir), 0.0, 1.0), 2.0) * pow(graze, 3.0);',
    '  return mix(vec3(1.0), tf * (1.0 + 0.06 * gg * graze + 0.12 * sh) * mix(vec3(1.0), vec3(1.05, 1.08, 0.93), graze), k);',
    '}',
    'vec3 lawnTint(sampler2D mm, vec2 w, vec3 eye) {',
    '  vec4 site = texture2D(uTurf, clamp((w - uTurfB.xy) / uTurfB.zw, 0.0, 1.0));',
    // water: drainage of the site plus warped soil variation (positive wet, negative dry)
    '  vec2 wq = w + (vec2(tfN(w / 37.0), tfN(w / 37.0 + 5.2)) - 0.5) * 22.0;',
    '  float moist = (0.5 - site.r) * 1.6 + (tfF(wq / 26.0) - 0.5) * 1.5;',
    '  float wet = clamp(moist, 0.0, 1.0), dry = clamp(-moist, 0.0, 1.0);',
    // species clumps: warped, then cut at thresholds so each clump has an edge
    '  vec2 sq = w / 1.7 + (vec2(tfN(w / 5.3), tfN(w / 5.3 + 9.7)) - 0.5) * 2.4;',
    '  float sp = tfF(sq);',
    '  float poa = smoothstep(0.63, 0.67, sp) * (0.6 + 0.4 * tfN(w / 23.0));',
    '  float fes = 1.0 - smoothstep(0.31, 0.35, sp);',
    '  float clov = smoothstep(0.80, 0.83, tfN(w * 2.1 + 3.0)) * smoothstep(0.45, 0.7, tfN(w / 9.0 + 1.7));',
    '  vec3 c = vec3(1.0);',
    '  c *= mix(vec3(1.0), vec3(1.09, 1.06, 0.80), poa);',
    '  c *= mix(vec3(1.0), vec3(0.88, 0.95, 1.03), fes);',
    '  c *= mix(vec3(1.0), vec3(0.96, 1.07, 0.93), clov);',
    '  c *= mix(vec3(1.0), vec3(0.95, 0.97, 0.96), wet * 0.35);',
    '  vec3 stress = mix(vec3(1.10, 1.05, 0.76), vec3(1.32, 1.12, 0.62), smoothstep(0.55, 1.0, dry));',
    '  c *= mix(vec3(1.0), stress, smoothstep(0.12, 0.75, dry));',
    // yellow patches: warped cells of about 6 m, only the highest few percent, and only where a
    // coarser field allows (so they cluster in some areas and are absent from others)
    '  vec2 yq = w / 3.2 + (vec2(tfN(w / 1.7 + 2.0), tfN(w / 1.7 + 6.3)) - 0.5) * 1.4;',
    '  float yv = tfN(yq) * 0.7 + tfN(yq * 2.6 + 1.9) * 0.3;',
    '  float ya = smoothstep(0.25, 0.6, tfN(w / 45.0 + 3.7));',
    // the patch is broken up by green growing through it, at a few centimetres
    '  float ybr = smoothstep(0.3, 0.62, tfN(w * 4.3 + 1.1) * 0.6 + tfN(w * 11.0) * 0.4);',
    '  float yp = smoothstep(0.66, 0.70, yv) * ya * ybr;',
    '  c *= mix(vec3(1.0), vec3(1.22, 1.02, 0.56), yp * 0.9);',
    // wear beside the track: patchy, toward bare soil
    '  float wr = site.g * smoothstep(0.4, 0.75, tfF(w / 1.3 + 4.4));',
    '  c *= mix(vec3(1.0), vec3(0.98, 0.86, 0.64), wr * 0.45);',
    // the worn strip at the edge of the track: wheels running wide and the mower turning there
    // leave a ragged band, under a metre to two wide, of thin tired grass over sandy soil
    '  float sdE = site.b * 63.75;',
    '  float ew = (1.0 - smoothstep(0.1, 1.4 + 1.6 * tfN(w * 0.45 + 8.0), sdE)) * smoothstep(0.3, 0.62, tfN(w * 2.7 + 1.3) * 0.6 + tfN(w * 9.0) * 0.4 + 0.12);',
    '  c *= mix(vec3(1.0), vec3(1.04, 0.86, 0.58), ew * 0.75);',
    '  { float rg = smoothstep(14.0, 34.0, site.b * 63.75 + (tfN(w / 11.0) - 0.5) * 12.0);',
    '    c *= mix(vec3(1.0), mix(vec3(1.12, 1.02, 0.74), vec3(0.94, 0.95, 0.8), tfN(w / 6.0)), rg * 0.8); }',
    '  c *= mix(vec3(0.9, 0.93, 0.92), vec3(1.1, 1.06, 0.98), tfN(w / 90.0) * 0.6 + tfN(w / 37.0) * 0.4);',
    '  c = max(mix(vec3(1.0), c, uLawnK), vec3(0.05));',
    // mowing stripes: the mower runs alongside the track, so the bands lie at constant distances
    // from its edge (site.b, quarter metres from the tarmac up to 63 m), 4 m wide, fading out past 40 m; light along the
    // lay, dark against it, strongest seen at a low angle
    '  float sd = site.b * 63.75, sband = smoothstep(-0.25, 0.25, sin(sd * 3.14159 / 4.0)) * 2.0 - 1.0;',
    '  vec2 vd0 = w - eye.xz; float vgl = clamp(length(vd0) / max(abs(eye.y - 0.0) + 1.0, 1.0), 0.0, 6.0);',
    '  { float sk = sband * step(sd, 60.0) * smoothstep(0.0, 1.2, sd) * (1.0 - smoothstep(40.0, 60.0, sd)); c *= 1.0 + sk * vec3(0.11, 0.1, 0.06); }',
    '  vec2 perp = vec2(-uLawn.y, uLawn.x);',
    '  float band = smoothstep(-0.3, 0.3, sin(dot(w, perp) * 3.14159 / uLawn.z)) * 2.0 - 1.0;',
    '  vec2 vd = w - eye.xz; vd /= max(length(vd), 1e-3);',
    // a real field is never one colour: the warped patches of a sward that has grown, dried and been
    // walked on unevenly, from tens of metres down to the clump (see the owner's reference shots)
    '  float fw = tfN(w / 53.0) - 0.5; vec2 fq = w + vec2(fw, -fw * 0.7 + tfN(w / 31.0 + 4.0) - 0.5) * 38.0;',
    '  float fBig = tfN(fq / 61.0) * 0.62 + tfN(fq / 23.0 + 3.1) * 0.38, fMid = tfN(fq / 8.7 + 1.3) * 0.6 + tfN(fq / 3.3 + 7.7) * 0.4;',
    '  vec3 fC = mix(vec3(0.82, 1.0, 0.8), vec3(1.18, 1.03, 0.68), smoothstep(0.36, 0.6, fBig + (fMid - 0.5) * 0.4));',
    '  fC *= mix(0.72, 1.14, smoothstep(0.3, 0.68, fMid + (fBig - 0.5) * 0.3)) * (0.84 + 0.32 * sp);',
    '  fC = mix(fC, vec3(1.16, 0.98, 0.66), smoothstep(0.72, 0.84, fMid * 0.62 + sp * 0.26 + (1.0 - fBig) * 0.3) * 0.7);',
    '  float fCl = tfN(fq / 1.3 + 2.2) * 0.62 + tfN(fq / 0.47 + 5.0) * 0.38;',
    '  fC *= mix(0.66, 1.12, smoothstep(0.3, 0.6, fCl));',
    '  fC = mix(fC, vec3(1.14, 0.94, 0.6), smoothstep(0.6, 0.7, fCl * 0.55 + fMid * 0.5) * smoothstep(0.42, 0.6, fBig) * 0.8);',
    '  c *= mix(vec3(1.0), fC, uFieldK);',
    '  return c * (1.0 + uLawn.w * band * (0.6 * dot(vd, uLawn.xy) + 0.35));',
    '}',
    'float lawnBreak(sampler2D tex, vec2 w) {',
    '  vec3 s = texture2D(tex, mat2(0.8, -0.6, 0.6, 0.8) * w / 11.3).rgb;',
    '  return mix(1.0, dot(s, vec3(0.2126, 0.7152, 0.0722)) / 0.0921, 0.15);',
    '}'].join('\n');

  const FOG_VERT_PARS = 'varying vec3 vFogWorld;\n';
  const FOG_VERT = [
    '#include <fog_vertex>',
    '#ifdef USE_INSTANCING',
    '  vFogWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;',
    '#else',
    '  vFogWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
    '#endif'].join('\n');
  const FOG_FRAG_PARS = 'varying vec3 vFogWorld;\nuniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uFogCol; uniform float uFogDensity; uniform float uFogFalloff;\n';
  // Exponential height fog: density(y) = d * exp(-k * y), integrated analytically along the
  // view ray. Inscattered light is the horizon colour plus a forward-scattering sun lobe.
  const FOG_FRAG = [
    '#ifdef USE_FOG',
    '  vec3 fRay = vFogWorld - cameraPosition;',
    '  float fDist = length(fRay);',
    '  float fk = uFogFalloff * fRay.y;',
    '  float fLine = abs(fk) > 1e-4 ? (1.0 - exp(-fk)) / fk : 1.0;',
    '  float fAmt = 1.0 - exp(-uFogDensity * exp(-uFogFalloff * cameraPosition.y) * fDist * fLine);',
    '  vec3 fDir = fRay / max(fDist, 1e-3);',
    '  float fSun = pow(max(dot(fDir, uSunDir), 0.0), 6.0);',
    '  vec3 fCol = uFogCol + uSunCol * fSun * 0.12;',
    '  gl_FragColor.rgb = mix(gl_FragColor.rgb, fCol, clamp(fAmt, 0.0, 1.0));',
    '#endif'].join('\n');

  // Livery painted per pixel from object-space position and normal, so stripe edges stay
  // crisp on a simplified mesh: bare-carbon lower bodywork, a spine stripe over the nose,
  // airbox and engine cover, a sweep rising along the sidepods, and an accent nose tip.
  const LIVERY_VERT = 'varying vec3 vLivP; varying vec3 vLivN;\n';
  const LIVERY_FRAG = [
    '#include <color_fragment>',
    '  vec3 lp = vLivP, ln = normalize(vLivN);',
    '  float aa = 0.006;',
    '  float carbonZ = 1.0 - smoothstep(0.26 - aa, 0.26 + aa, lp.y - 0.025 * clamp(lp.x, -2.0, 2.0)) ;',
    '  carbonZ = max(carbonZ, step(ln.y, -0.6));',
    // the cockpit tub inside: bare carbon (any surface in the opening that does not face out)
    '  float tub = step(-0.05, lp.x) * step(lp.x, 1.12) * step(abs(lp.z), 0.36) * step(0.22, lp.y) * step(lp.y, 0.82) * step(ln.z * sign(lp.z), 0.25);',
    '  carbonZ = max(carbonZ, tub);',
    '  float spine = (1.0 - smoothstep(0.105, 0.105 + aa, abs(lp.z))) * smoothstep(0.35, 0.5, ln.y) * step(-2.15, lp.x);',
    // no stripe over the cockpit opening and the halo: that area is bare carbon on a real car
    '  spine *= 1.0 - step(0.12, lp.x) * step(lp.x, 1.08) * step(0.6, lp.y);',
    '  float yb = 0.505 + 0.13 * clamp((0.75 - lp.x) / 2.4, 0.0, 1.0);',
    '  float sweep = (1.0 - smoothstep(0.032, 0.032 + aa, abs(lp.y - yb))) * smoothstep(0.3, 0.45, abs(ln.z)) * step(-1.75, lp.x) * step(lp.x, 0.95);',
    '  float tip = smoothstep(2.42, 2.42 + aa, lp.x);',
    '  vec3 lc = mix(uLivBase, uLivAccent, max(max(spine, sweep), tip));',
    '  diffuseColor.rgb = mix(lc, uLivCarbon, carbonZ);'].join('\n');

  function patchShader(sh, mac, liv, ao, wk, opaque) {
    Object.assign(sh.uniforms, U);
    // the sun's shadow from the cascades; opaque surfaces also write how much sun reaches them
    // into the scene's alpha, for the ambient occlusion pass
    if (F1.R3Shadow && sh.fragmentShader.includes('#include <lights_fragment_begin>')) {
      sh.fragmentShader = F1.R3Shadow.PARS + sh.fragmentShader.replace('#include <lights_fragment_begin>', F1.R3Shadow.lightsChunk())
        .replace('#include <shadowmap_pars_fragment>', '#include <shadowmap_pars_fragment>\n' + F1.R3Shadow.CAR_FN);
      // the share of the surface's light that comes straight from the sun: ambient occlusion
      // can only take away the rest (sky and bounce light)
      if (opaque) sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', '#include <opaque_fragment>\n' +
        '  { vec3 r3L = vec3(0.2126, 0.7152, 0.0722); float r3Dir = dot(reflectedLight.directDiffuse + reflectedLight.directSpecular, r3L), r3Ind = dot(reflectedLight.indirectDiffuse + reflectedLight.indirectSpecular, r3L);\n' +
        '    gl_FragColor.a = mix(gl_FragColor.a, r3Dir / max(r3Dir + r3Ind, 1e-5), r3SunA); }');
    }
    // Every lit surface hands the post stack a sane colour: never NaN, never below zero, never
    // past 32 times white. Measured in a race: a few hundred pixels a frame came out of the scene
    // negative (down to -22 on the asphalt) or blown (a sun glint on car paint or a fence wire up
    // to 30000), single pixels that tone mapping and bloom turned into one-frame flashes, green,
    // yellow or white with a purple fringe, on the road ahead.
    if (sh.fragmentShader.includes('#include <dithering_fragment>'))
      sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n' +
        '  gl_FragColor.rgb = (gl_FragColor.r == gl_FragColor.r && gl_FragColor.g == gl_FragColor.g && gl_FragColor.b == gl_FragColor.b) ? clamp(gl_FragColor.rgb, 0.0, 32.0) : vec3(0.0);');
    // Specular anti-aliasing: where the shading normal (the normal maps included) turns faster
    // than a pixel can show, as on asphalt and kerbs far ahead or a distant car's wheel rim, the
    // gloss is widened by the normal's spread over the pixel (Kaplanyan's filtered roughness), so a
    // sub-pixel bump no longer flashes a highlight on one frame and not the next (the shimmer on
    // the road ahead). Close up, where the normal changes slowly, nothing changes.
    if (sh.fragmentShader.includes('#include <lights_physical_fragment>')) {
      sh.fragmentShader = sh.fragmentShader.replace('#include <lights_physical_fragment>', [
        '#include <lights_physical_fragment>',
        '  { vec3 r3dx = dFdx(normal), r3dy = dFdy(normal);',
        '    float r3k = min(0.5 * (dot(r3dx, r3dx) + dot(r3dy, r3dy)), 0.18), r3a = material.roughness * material.roughness;',
        '    material.roughness = min(1.0, sqrt(sqrt(r3a * r3a + r3k)));',
        '#ifdef USE_CLEARCOAT',
        '    vec3 r3cx = dFdx(clearcoatNormal), r3cy = dFdy(clearcoatNormal);',
        '    float r3ck = min(0.5 * (dot(r3cx, r3cx) + dot(r3cy, r3cy)), 0.18), r3ca = material.clearcoatRoughness * material.clearcoatRoughness;',
        '    material.clearcoatRoughness = min(1.0, sqrt(sqrt(r3ca * r3ca + r3ck)));',
        '#endif',
        '  }'].join('\n'));
    }
    if (liv) {
      Object.assign(sh.uniforms, liv);
      sh.vertexShader = LIVERY_VERT + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vLivP = position; vLivN = normal;');
      sh.fragmentShader = LIVERY_VERT + 'uniform vec3 uLivBase; uniform vec3 uLivAccent; uniform vec3 uLivCarbon;\n' + sh.fragmentShader.replace('#include <color_fragment>', LIVERY_FRAG);
    }
    sh.vertexShader = FOG_VERT_PARS + (mac ? 'varying vec2 vMacroW;\n' : '') + sh.vertexShader.replace('#include <fog_vertex>', FOG_VERT);
    sh.fragmentShader = FOG_FRAG_PARS + (mac ? 'uniform sampler2D macroMap; varying vec2 vMacroW;\n' : '') + (mac && mac.lawn ? LAWN + '\n' : '') + sh.fragmentShader.replace('#include <fog_fragment>', FOG_FRAG);
    if (wk) {
      // a wet surface: darker, and glassy where water collects in puddles (low spots are
      // noise in world space), so the sky and the lights reflect in it
      const WF = [
        'uniform float uWet;',
        'float wxH(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }',
        'float wxN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(wxH(i), wxH(i + vec2(1.0, 0.0)), f.x), mix(wxH(i + vec2(0.0, 1.0)), wxH(i + vec2(1.0, 1.0)), f.x), f.y); }',
      ].join('\n');
      sh.fragmentShader = WF + '\n' + sh.fragmentShader
        .replace('#include <map_fragment>', '#include <map_fragment>\n  float wxP = smoothstep(0.5 - 0.14 * uWet, 0.74, wxN(vFogWorld.xz * 0.28) * 0.6 + wxN(vFogWorld.xz * 1.1) * 0.4);\n  diffuseColor.rgb *= 1.0 - uWet * ' + wk[0].toFixed(2) + ' * (0.36 + 0.24 * wxP);')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, mix(roughnessFactor * 0.32, 0.03, wxP), clamp(uWet * ' + wk[1].toFixed(2) + ' * 1.4, 0.0, 1.0));');
    }
    if (ao) {
      // skylight occlusion near the road: height above the car's own ground (the mesh's origin
      // sits at the car's ground, or at the wheel centre for tyres, hence ao.lift)
      // (plus the car's own shade, traced once per model: aSky, js/r3-carshade.js; 1 where a mesh has none)
      sh.vertexShader = 'varying float vAOh; attribute float aSky; varying float vSky;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vSky = aSky;\n  vAOh = (modelMatrix * vec4(transformed, 1.0)).y - modelMatrix[3].y + ' + ao.lift.toFixed(3) + ';');
      sh.fragmentShader = 'varying float vAOh; varying float vSky;\n' + sh.fragmentShader.replace('#include <aomap_fragment>', [
        '#include <aomap_fragment>',
        '  {',
        '    float aoUp = dot(normalize(normal), normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz));',
        '    float aoAmt = 0.6 + 0.4 * (1.0 - clamp(aoUp, 0.0, 1.0));', // surfaces that face up still see the sky
        '    float aoG = 1.0 - aoAmt * ' + ao.k.toFixed(2) + ' * (1.0 - smoothstep(0.0, 0.8, vAOh));',
        '    reflectedLight.indirectDiffuse *= aoG; reflectedLight.indirectSpecular *= aoG;',
        // the car's own shade: the sky light, and the sky's reflection a little more (a reflection
        // comes from one direction, more often a hidden one where the surface is shut in)
        '    float sk = clamp(vSky, 0.0, 1.0);',
        '    reflectedLight.indirectDiffuse *= sk; reflectedLight.indirectSpecular *= sk * sqrt(sk);',
        '  }'].join('\n'));
    }
    if (mac) {
      sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vMacroW = (modelMatrix * vec4(transformed, 1.0)).xz;');
      const f = n => n.toFixed(3);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <map_fragment>', '#include <map_fragment>\n' + FAR_AVG + '\n' +
          `  float mcr = texture2D(macroMap, vMacroW / ${f(mac.scale)}).r * 0.6 + texture2D(macroMap, vMacroW / ${f(mac.scale * 0.21)}).g * 0.4;\n` +
          `  diffuseColor.rgb *= mix(${f(1 - mac.amt)}, ${f(1 + mac.amt)}, mcr);` +
          (mac.lawn ? '\n  diffuseColor.rgb *= lawnTint(macroMap, vMacroW, cameraPosition) * lawnBreak(map, vMacroW) * lawnFar(vMacroW, vFogWorld, cameraPosition, uSunDir);\n'
            + '  { float gm = texture2D(uGrassMask, (vMacroW - uGrassMaskB.xy) / uGrassMaskB.zw).r;\n'
            + '    diffuseColor.rgb *= mix(vec3(1.0), vec3(0.92, 0.8, 0.62), (1.0 - smoothstep(0.15, 0.75, gm)) * 0.55); }\n'
            + '  diffuseColor.rgb = lawnGrade(diffuseColor.rgb);\n#ifdef USE_FOG\n  float fFar = smoothstep(110.0, 520.0, length(vFogWorld - cameraPosition));\n  if (fFar > 0.001) {\n    vec2 fW = vFogWorld.xz;\n    float fA = textureLod(uFarTex, fW / 1500.0, 2.0).g, fB = textureLod(uFarTex, fW / 530.0 + 0.4, 1.0).g;\n    vec3 fC = mix(diffuseColor.rgb, uFarLawn.rgb * (0.5 + dot(diffuseColor.rgb, vec3(1.2))), uFarLawn.a);\n    fC *= 0.64 + fA * 0.76 + smoothstep(0.34, 0.16, fB) * 0.08;\n    fC = mix(fC, fC * vec3(1.16, 1.03, 0.72), smoothstep(0.3, 0.6, fB) * uFarLawn.a);\n    fC = mix(fC, fC * vec3(0.56, 0.6, 0.54), smoothstep(0.34, 0.62, fA * 0.65 + fB * 0.5));\n    fC = mix(fC, vec3(0.74, 0.68, 0.46) * (0.9 + fA * 0.3), smoothstep(650.0, 1500.0, length(vFogWorld - cameraPosition)) * uFarLawn.a * 0.6);\n    diffuseColor.rgb = mix(diffuseColor.rgb, fC, fFar);\n  }\n#endif' : ''))
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' +
          `  roughnessFactor = clamp(roughnessFactor * mix(${f(1 - mac.ramt)}, ${f(1 + mac.ramt)}, 1.0 - mcr), 0.04, 1.0);` +
          // turf is a matte tangle of blades: the photo's own 0.55 left a glassy sky sheen on it
          (mac.lawn ? `\n  roughnessFactor = max(roughnessFactor, ${f(LAWN_ROUGH)});` : ''));
      if (mac.lawn) {
        // turf is a matte tangle: no mirror-like glancing reflection off it toward a low sun
        sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', '#include <opaque_fragment>\n#ifdef USE_FOG\n  if (uRingH.w > 0.0) { float rP = textureLod(uFarTex, vFogWorld.xz / 2300.0, 2.0).g, rQ = textureLod(uFarTex, vFogWorld.xz / 640.0 + 0.3, 1.0).g; vec3 rC = uFogCol * uFootT * (0.82 + rP * 0.2 + rQ * 0.2); rC = mix(rC, rC * vec3(0.84, 0.84, 0.8), smoothstep(0.36, 0.72, rP * 0.6 + rQ * 0.6)); rC = mix(rC, vec3(0.03, 0.042, 0.026), smoothstep(0.53, 0.62, rP * 0.7 + rQ * 0.46) * step(0.75, uRingH.w)); gl_FragColor.rgb = mix(gl_FragColor.rgb, rC, smoothstep(uRingH.z * 0.62, uRingH.z * 0.86, length(vFogWorld.xz - uRingH.xy))); }\n#endif');
        sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n  reflectedLight.directSpecular *= 0.06 + 0.5 * diffuseColor.rgb; reflectedLight.indirectSpecular *= 0.15 + 0.6 * diffuseColor.rgb;');
        // the tufts tilt the surface: the gradient of the tuft field, in world space, into the view-space normal
        sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_maps>', [
          '#include <normal_fragment_maps>',
          '  { float lk = lawnFarK(vFogWorld, cameraPosition);',
          '    if (lk > 0.01) { vec2 lw = vMacroW; float e = 0.12, t0 = lawnTuft(lw);',
          '      vec3 lg = vec3(t0 - lawnTuft(lw + vec2(e, 0.0)), 0.0, t0 - lawnTuft(lw + vec2(0.0, e))) / e * 0.22 * lk;',
          '      normal = normalize(normal + (viewMatrix * vec4(lg, 0.0)).xyz); } }'].join('\n'));
      }
    }
  }

  // A car's detail levels dissolve into one another: the fade value comes down the normal matrix's
  // scale (F1.R3Car lodHook: 0 steady, 0 to 1 coming in, 1 to 2 going out). Going and coming keep
  // exactly opposite pixels, so nothing shows through. Interleaved gradient noise, moved each frame.
  const LOD_CUT = [
    '  if (vLodF > 0.004) {',
    '    float lodN = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uLodJit, vec2(0.06711056, 0.00583715))));',
    '    if (vLodF <= 1.002 ? lodN > vLodF : lodN < vLodF - 1.0) discard;',
    '  }'].join('\n');
  function patchLodFade(sh) {
    sh.uniforms.uLodJit = U.uLodJit;
    sh.vertexShader = 'varying float vLodF;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vLodF = length(normalMatrix[0]) - 1.0;');
    sh.fragmentShader = 'varying float vLodF; uniform float uLodJit;\n' + sh.fragmentShader.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n' + LOD_CUT);
  }

  // The car's shaders read per-vertex attributes some meshes do not carry: aSky (the car's traced
  // shade, js/r3-carshade.js; not on the wheels) and, on the tyres, aWc (the wheel centre in a
  // merged set of wheels). WebGL gives a missing attribute whatever value the last draw left in
  // its slot, not one of its own (three sets a material's defaults only when a mesh's vertex
  // setup is first made), so a tyre read the shade of whatever was drawn before it and flickered
  // between bright and dark. Each car mesh gets the real attributes when its tree is patched:
  // aSky 1 (open sky; the bake replaces it where it runs) and aWc 0 (a single wheel's centre).
  // Debris pieces copy their part's attributes, so they carry them too.
  function fillCarAttrs(geo, tyre) {
    const P = geo.attributes.position;
    if (!P) return;
    if (!geo.attributes.aSky) geo.setAttribute('aSky', new THREE.BufferAttribute(new Uint8Array(P.count).fill(255), 1, true));
    if (tyre && !geo.attributes.aWc) geo.setAttribute('aWc', new THREE.BufferAttribute(new Float32Array(P.count * 3), 3));
  }
  // Patch a lit material once. Basic/shader materials (sky, particles, UI decals) keep theirs.
  function patch(m) {
    if (!m || m.userData.r3s || !(m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial)) return m;
    m.userData.r3s = true;
    const mac = m.userData.macro || null, liv = m.userData.livery || null, gr = m.userData.grass || null, ao = m.userData.carAO || null, wk = m.userData.wetK || null;
    if (mac && !U.macroMap.value) U.macroMap.value = F1.R3T.macro();
    const ex = m.userData.patchExtra || null, exKey = m.userData.patchKey || '', lf = !!m.userData.lodFade;
    const opaque = !m.transparent;
    m.onBeforeCompile = sh => { patchShader(sh, mac, liv, ao, wk, opaque); if (gr) F1.R3Grass.patchShader(sh, gr); if (ex) ex(sh); if (lf) patchLodFade(sh); };
    m.customProgramCacheKey = () => 'r3s3' + (opaque ? 'o' : 't') + (mac ? '_m' + mac.scale + '_' + mac.amt + '_' + mac.ramt + (mac.lawn ? 'L' : '') : '') + (liv ? '_liv' : '') + (gr ? '_grass' + (gr.uGBlade ? 'B' : '') + (gr.uGShell ? 'S' : '') : '') + (ao ? '_ao' + ao.lift : '') + (wk ? '_wet' : '') + (ex ? '_x' + exKey : '') + (lf ? '_lf' : '');
    m.needsUpdate = true;
    return m;
  }
  function patchTree(obj) {
    obj.traverse(o => {
      if (!o.material) return;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      ms.forEach(patch);
      if (o.isMesh && o.geometry) for (const m of ms) if (m.userData.carAO) fillCarAttrs(o.geometry, /^wtyre/.test(m.userData.patchKey || ''));
    });
  }

  // Radiance RGBE bytes (from tools/hdr_prep.py) to a half-float equirectangular texture
  function hdrTexture(a) {
    const bin = atob(a.rgbe), n = a.w * a.h;
    const data = new Uint16Array(n * 4), toHalf = THREE.DataUtils.toHalfFloat;
    for (let i = 0; i < n; i++) {
      const e = bin.charCodeAt(i * 4 + 3);
      const f = e ? Math.pow(2, e - 136) : 0;
      data[i * 4] = toHalf(bin.charCodeAt(i * 4) * f);
      data[i * 4 + 1] = toHalf(bin.charCodeAt(i * 4 + 1) * f);
      data[i * 4 + 2] = toHalf(bin.charCodeAt(i * 4 + 2) * f);
      data[i * 4 + 3] = toHalf(1);
    }
    const t = new THREE.DataTexture(data, a.w, a.h, THREE.RGBAFormat, THREE.HalfFloatType);
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.colorSpace = THREE.LinearSRGBColorSpace;
    t.magFilter = t.minFilter = THREE.LinearFilter;
    t.wrapS = THREE.RepeatWrapping;
    t.needsUpdate = true;
    return t;
  }

  // ---------- wear: a raced-on circuit, not a new one ----------
  // value noise on a hash (stable at world coordinates of kilometres)
  // (value noise read from a tiling texture: the road shaders ask for it many times a pixel)
  const NOISE = 'uniform sampler2D uTfTex;\nfloat wNoise(vec2 p) { return texture2D(uTfTex, p / 256.0).r; }';
  const LUM = 'vec3(0.2126, 0.7152, 0.0722)';
  // Far ahead the ground is seen so edge-on that a pixel covers a strip of a photo many times
  // longer than it is wide, beyond what anisotropic filtering samples (16 taps): the asphalt's
  // light stones and the kerbs' paint edges were caught on one frame and missed on the next, a
  // shimmer over the road ahead. There the photo is read once more, averaged over the strip's
  // full length, and blended in as the stretch grows.
  // (on every ground photo with macro variation, and on the asphalt and kerbs; once per shader,
  // always straight after three's map_fragment, where diffuseColor is still the material colour
  // times the photo: the averaged read replaces the photo there. The first version swapped them
  // by dividing by the photo, and a near-black texel made a pixel hundreds of times too bright
  // for a frame, which the bloom spread into a green, yellow or white flash on the road ahead)
  const FAR_AVG = [
    '#if defined( USE_MAP ) && !defined( R3_FARAVG )',
    '#define R3_FARAVG',
    '  { vec2 aDx = dFdx(vMapUv), aDy = dFdy(vMapUv); float aLx = length(aDx), aLy = length(aDy);',
    '    float aSt = smoothstep(6.0, 20.0, max(aLx, aLy) / max(min(aLx, aLy), 1e-7));',
    '    if (aSt > 0.0) { vec2 aM = aLx > aLy ? aDx : aDy, aN = vec2(-aM.y, aM.x);',
    '      diffuseColor.rgb = mix(diffuseColor.rgb, diffuse * textureGrad(map, vMapUv, aM, aN).rgb, aSt); } }',
    '#endif'].join('\n');
  const ext = (m, key, fn) => { m.userData.patchExtra = fn; m.userData.patchKey = key; return m; };

  // Track asphalt. The geometry carries trk = (distance along the lap, lateral offset, the
  // racing line's offset, braking/cornering load). The photo is a dark, brownish fresh
  // asphalt: it is lifted to the mid grey of a used circuit, then the racing line is
  // rubbered in, and tyre streaks run along the lap, densest on the line and heaviest where
  // cars brake and turn (with short skid marks there), while the edges stay dusty.
  function asphaltWear(m, gain) {
    if (!U.uRubber) U.uRubber = { value: F1.R3T.photo('rubber', 1, false) };
    return ext(m, 'asph', sh => {
      sh.vertexShader = 'attribute vec4 trk; varying vec4 vTrk;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vTrk = trk;');
      // (the circuit's traced sky shade on the racing road, js/r3-carshade.js bakeRoad: the sky
      // light and its reflection dimmed at the foot of walls, under bridges, between buildings;
      // side streets carry a lateral 11 m, outside the grid, and are left alone)
      sh.fragmentShader = sh.fragmentShader.replace('#include <aomap_fragment>', [
        '#include <aomap_fragment>',
        '  if (uRoadShadeOn > 0.5 && abs(vTrk.y - uRoadShadeP.y - uRoadShadeP.z * 0.5) < uRoadShadeP.z * 0.5) {',
        '    float rsk = texture2D(uRoadShade, vec2(vTrk.x / uRoadShadeP.x, (vTrk.y - uRoadShadeP.y) / uRoadShadeP.z)).r;',
        '    reflectedLight.indirectDiffuse *= rsk; reflectedLight.indirectSpecular *= rsk;',
        '  }'].join('\n'));
      sh.fragmentShader = 'varying vec4 vTrk;\nuniform sampler2D uRubber; uniform sampler2D uRoadShade; uniform vec3 uRoadShadeP; uniform float uRoadShadeOn;\n' + NOISE + '\n' + sh.fragmentShader
        .replace('#include <map_fragment>', [
          '#include <map_fragment>',
          FAR_AVG,
          '  float aLum = dot(diffuseColor.rgb, ' + LUM + ');',
          '  diffuseColor.rgb = mix(vec3(aLum), diffuseColor.rgb, 0.3) * ' + gain.toFixed(2) + ';',
          '  float aL = vTrk.y - vTrk.z, aW = vTrk.w;',
          // Real rubber follows the racing line: two tyre tracks (the car's wheels run about 0.8 m
          // either side of the line), laid down hardest where the cars brake and turn, broken up
          // along their length. Round them a wide polished band, and loose marbles (pale, dusty
          // grey) collect outside it, mostly in corners where cars are pushed off the line.
          '  float aT1 = exp(-pow(aL - 0.82, 2.0) / 0.07), aT2 = exp(-pow(aL + 0.82, 2.0) / 0.07);',
          '  float aTr = max(aT1, aT2) * (0.75 + 0.25 * wNoise(vec2(vTrk.y * 9.0, vTrk.x * 0.5)));',
          '  float aBand = exp(-aL * aL / 1.1), aWide = exp(-aL * aL / 7.0), aWider = exp(-aL * aL / 22.0);',
          '  float aBreak = 0.55 + 0.45 * smoothstep(0.25, 0.8, wNoise(vec2(vTrk.y * 4.0, vTrk.x * 0.09)) * 0.65 + wNoise(vec2(vTrk.y * 13.0, vTrk.x * 0.3) + 9.0) * 0.35);',
          '  float aLoad = 0.3 + 0.7 * aW;',
          '  float aSkid = smoothstep(0.72, 0.95, wNoise(vec2(vTrk.y * 3.2, vTrk.x * 0.03) + 41.0)) * aW * aWide;',
          // many separate tyre-track pairs, each a car's own path, baked (tools/rubber_bake.py)
          '  float aMany = texture2D(uRubber, vec2(vTrk.x / 512.0, clamp(aL / 20.0 + 0.5, 0.01, 0.99))).r * 0.5;',
          '  float aRub = aTr * aBreak * (0.28 + 0.5 * aLoad) + aBand * 0.14 * aLoad + aWide * 0.1 + aWider * 0.05 + aSkid * 0.35 + aMany * (0.5 + 0.5 * aLoad);',
          '  diffuseColor.rgb *= (1.0 - clamp(aRub, 0.0, 0.5));',
          '  float aMar = smoothstep(2.4, 4.5, abs(aL)) * (1.0 - smoothstep(0.0, 1.3, min(abs(vTrk.y) - 0.0, 20.0) * 0.0)) * (0.35 + 0.65 * aW) * smoothstep(0.45, 0.85, wNoise(vec2(vTrk.y * 5.0, vTrk.x * 0.35) + 3.0));',
          '  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.34, 0.33, 0.32) * dot(diffuseColor.rgb, vec3(0.333)) * 3.0, aMar * 0.28);',
        ].join('\n'))
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor *= 1.0 - 0.28 * aBand;');
    });
  }
  // Kerbs: paint chipped back to concrete in patches, black tyre rubber smeared along the
  // kerb (uv.x runs along it), and grime.
  function kerbWear(m) {
    return ext(m, 'kerb', sh => {
      sh.fragmentShader = NOISE + '\n' + sh.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n' + FAR_AVG).replace('#include <color_fragment>', [
        '#include <color_fragment>',
        '  vec2 kW = vFogWorld.xz;',
        '  float kN = wNoise(kW * 1.4) * 0.6 + wNoise(kW * 6.0) * 0.4;',
        '  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3, 0.29, 0.27), smoothstep(0.64, 0.8, kN) * 0.75);',
        '#if defined( USE_NORMALMAP )',
        '  vec2 kU = vNormalMapUv;',
        '#else',
        '  vec2 kU = kW;',
        '#endif',
        '  float kS = wNoise(vec2(kU.y * 11.0, kU.x * 0.5)) * 0.65 + wNoise(vec2(kU.y * 31.0, kU.x * 1.3)) * 0.35;',
        '  diffuseColor.rgb *= 1.0 - (smoothstep(0.42, 0.85, kS) * 0.6 + 0.1);',
        '  diffuseColor.rgb *= mix(0.82, 1.0, wNoise(kW * 0.35));',
      ].join('\n'));
    });
  }
  // Road paint: worn through to the asphalt where wheels cross it, with dirt and rubber.
  function paintWear(m) {
    return ext(m, 'paint', sh => {
      sh.vertexShader = '#define R3_ZK 1.006\n' + sh.vertexShader;
      sh.fragmentShader = NOISE + '\n' + sh.fragmentShader.replace('#include <logdepthbuf_fragment>', '#include <logdepthbuf_fragment>\n#if defined( USE_LOGDEPTHBUF ) && defined( USE_LOGDEPTHBUF_EXT )\n  gl_FragDepthEXT -= 0.0012;\n#endif').replace('#include <color_fragment>', [
        '#include <color_fragment>',
        '  vec2 pW = vFogWorld.xz;',
        // how much ground one pixel covers here (m): far ahead a line is only a pixel or two across
        '  vec2 pFw = fwidth(pW); float pFp = max(pFw.x, pFw.y);',
        // fine pitting, thin in places, a little dirt: paint stays paint, it does not go patchy
        '  float pN = wNoise(pW * 9.0) * 0.5 + wNoise(pW * 31.0) * 0.5;',
        // (the pits are a few centimetres: only cut where a pixel can hold one, or far ahead they
        // flickered as holes caught on one frame and missed on the next)
        '  if (pFp < 0.025 && wNoise(pW * 53.0) * 0.6 + wNoise(pW * 17.0) * 0.4 > 0.9 - 0.16 * wNoise(pW * 1.1 + 9.0)) discard;',
        '  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.14), smoothstep(0.62, 0.86, pN) * 0.4);',
        '  diffuseColor.rgb *= (1.0 - smoothstep(0.5, 0.9, wNoise(pW * 0.5 + 5.0)) * 0.14) * 0.9;',
        // a line thinner than a few pixels shows mostly its edges, and they crawl as the car moves:
        // there the paint is toned toward the asphalt it lies on, as the eye sees a far line anyway
        '  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2), smoothstep(0.03, 0.3, pFp) * 0.5);',
      ].join('\n'));
    });
  }
  // Galvanised steel. The metal photo averages rust brown, which read as rotten railings:
  // keep only 30% of its brightness variation, on a zinc grey with a faint warm trace.
  function zincTone(m, mean) {
    return ext(m, 'zinc', sh => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', [
        '#include <map_fragment>',
        '  float zL = dot(diffuseColor.rgb, ' + LUM + ') / ' + mean.toFixed(5) + ';',
        '  diffuseColor.rgb = vec3(0.5, 0.51, 0.53) * (1.0 + (zL - 1.0) * 0.3) * mix(vec3(1.0), vec3(1.06, 1.0, 0.92), clamp(zL - 1.0, 0.0, 1.0));',
      ].join('\n'));
    });
  }

  // ---------- photo tiles that do not repeat ----------
  // A photo tile repeated over a field shows its blotches in a grid however good the photo. Here
  // every sample is taken twice, from two copies of the tile shifted by amounts picked by a slow
  // noise over the surface, and the two are blended where the noise moves from one pick to the
  // next (favouring whichever is darker, so the seam follows the grains instead of a soft fade);
  // the texture's own gradients are kept so filtering stays sharp (after Inigo Quilez,
  // "texture repetition", technique 3). bump: relief from the photo itself (its brightness as
  // height), sampled the same way, for a photo that comes without a normal map.
  const NOTILE = [
    'float ntH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
    'float ntN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(ntH(i), ntH(i + vec2(1.0, 0.0)), f.x), mix(ntH(i + vec2(0.0, 1.0)), ntH(i + vec2(1.0, 1.0)), f.x), f.y); }',
    'vec4 noTile(sampler2D s, vec2 uv) {',
    '  float k = ntN(uv * 0.55) * 0.65 + ntN(uv * 1.9 + 5.3) * 0.35;',
    '  vec2 gx = dFdx(uv), gy = dFdy(uv);',
    '  float l = k * 9.0, f = fract(l), ia = floor(l);',
    '  vec2 oa = sin(vec2(3.0, 7.0) * ia), ob = sin(vec2(3.0, 7.0) * (ia + 1.0));',
    '  vec4 a = textureGrad(s, uv + oa, gx, gy), b = textureGrad(s, uv + ob, gx, gy);',
    '  return mix(a, b, smoothstep(0.2, 0.8, f - 0.1 * dot(a - b, vec4(1.0))));',
    '}'].join('\n');
  function noTile(m, bump) {
    const prev = m.userData.patchExtra || null, key = m.userData.patchKey || '';
    if (bump) { m.bumpMap = m.map; m.bumpScale = bump; }
    m.userData.patchKey = key + '_nt' + (bump || '');
    m.userData.patchExtra = sh => {
      if (prev) prev(sh);
      const C = THREE.ShaderChunk, swap = (chunk, from, to) => C[chunk].split(from).join(to);
      sh.fragmentShader = NOTILE + '\n' + sh.fragmentShader
        .replace('#include <map_fragment>', swap('map_fragment', 'texture2D( map,', 'noTile( map,'))
        .replace('#include <roughnessmap_fragment>', swap('roughnessmap_fragment', 'texture2D( roughnessMap,', 'noTile( roughnessMap,'))
        .replace('#include <normal_fragment_maps>', swap('normal_fragment_maps', 'texture2D( normalMap,', 'noTile( normalMap,'))
        .replace('#include <bumpmap_pars_fragment>', swap('bumpmap_pars_fragment', 'texture2D( bumpMap,', 'noTile( bumpMap,'));
    };
    m.needsUpdate = true;
    return m;
  }

  // three draws a transparent double-sided material in two passes (back faces, then front), and
  // switches the material's side between them with needsUpdate, which makes it look the shader up
  // again, twice per mesh per frame (the car decals, glass and lights: about fifty a frame, 4% of
  // the main thread). Each such mesh is split instead into a back-side mesh (the original, so it
  // keeps its place in the draw order) and a front-side copy as its child (same place, same depth
  // in the sort, a later id, so it draws right after): the same two passes in the same order,
  // and no material ever changes side. The copy casts no shadow (the original still does).
  const splitOf = new WeakMap();
  function splitTwoSided(root) {
    const todo = [];
    root.traverse(o => {
      if (!o.isMesh || o.userData.twoSidedCopy || Array.isArray(o.material)) return;
      const m = o.material;
      if ((m.transparent && m.side === THREE.DoubleSide && !m.forceSinglePass) || splitOf.has(m)) todo.push(o);
    });
    for (const o of todo) {
      const m = o.material;
      let pair = splitOf.get(m);
      if (!pair) {
        // (userData is shared, not copied: three's clone copies it through JSON, and ours holds
        // shader uniforms and textures)
        const ud = m.userData; m.userData = {};
        const back = m.clone(), front = m.clone();
        m.userData = ud;
        for (const x of [back, front]) { x.userData = ud; x.defaultAttributeValues = m.defaultAttributeValues; x.onBeforeRender = m.onBeforeRender; x.onBeforeCompile = m.onBeforeCompile; if (m.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey) x.customProgramCacheKey = m.customProgramCacheKey; }
        back.side = THREE.BackSide; front.side = THREE.FrontSide;
        pair = { back, front };
        splitOf.set(m, pair); splitOf.set(back, pair); splitOf.set(front, pair);
      }
      o.material = pair.back;
      const c = new THREE.Mesh(o.geometry, pair.front);
      c.userData.twoSidedCopy = true; c.castShadow = false; c.receiveShadow = o.receiveShadow;
      c.renderOrder = o.renderOrder; c.frustumCulled = o.frustumCulled; c.layers.mask = o.layers.mask;
      if (o.lodS) c.lodS = o.lodS;
      if (!o.matrixAutoUpdate) { c.matrixAutoUpdate = false; c.updateMatrix(); }
      o.add(c);
    }
    return todo.length;
  }

  F1.R3S = { U, patch, patchTree, splitTwoSided, noTile, hdrTexture, LAWN, LAWN_ROUGH, wear: { asphalt: asphaltWear, kerb: kerbWear, paint: paintWear, zinc: zincTone } };
})(typeof window !== 'undefined' ? window : globalThis);
