// Shader system for the 3D renderer: one patcher that every scene material goes through.
// It replaces three.js' distance fog with exponential height fog (denser in the valleys,
// glowing toward the sun), adds world-space macro variation where a material asks for it,
// and keeps all of this driven by shared uniforms so a venue change updates every shader.
(function (G) {
  'use strict';
  const F1 = G.F1;

  // shared uniform objects: the same {value} is referenced by every patched program
  const U = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Color(1, 1, 1) },
    uFogCol: { value: new THREE.Color(0.5, 0.5, 0.5) },
    uFogDensity: { value: 0.0003 },
    uFogFalloff: { value: 0.004 },
    macroMap: { value: null },
    // lawn: xy the direction the mower laid the stripes, z stripe width (m), w stripe strength
    uLawn: { value: new THREE.Vector4(1, 0, 10, 0) },
    uWet: { value: 0 }, // how wet the road is, 0..1
    // the venue's turf map (render3d.js turfMap): r how dry the site is (0.5 neutral), g wear
    // beside the track; uTurfB its world rectangle (x0, z0, width, depth)
    uTurf: { value: null },
    uTurfB: { value: new THREE.Vector4(0, 0, 1, 1) },
    uWindT: { value: 0 }, // seconds, for the wind's gusts over the field
    uLawnK: { value: 2 },
    // the venue's light on the turf: rgb a tint, w how far toward a grey olive (overcast skies)
    uLawnGrade: { value: new THREE.Vector4(1, 1, 1, 0) },
    // the 3D grass map (js/r3-grass.js), so the ground can wear where the turf meets other surfaces
    uGrassMask: { value: null }, uGrassMaskB: { value: new THREE.Vector4(0, 0, 1, 1) }, // strength of the lawn colour variation (debug: larger exaggerates it to inspect the pattern)
  };
  { const t = new THREE.DataTexture(new Uint8Array([128, 0, 0, 255]), 1, 1); t.needsUpdate = true; U.uTurf.value = t; }
  { const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); t.needsUpdate = true; U.uGrassMask.value = t; }
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
    'uniform vec4 uLawn; uniform sampler2D uTurf; uniform vec4 uTurfB; uniform float uLawnK; uniform float uWindT; uniform vec4 uLawnGrade;',
    // the venue grade: tint, then part of the way toward a grey olive of the same brightness
    'vec3 lawnGrade(vec3 c) { float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); return mix(c * uLawnGrade.rgb, vec3(l) * vec3(0.98, 1.04, 0.80), uLawnGrade.w); }',
    'float tfH(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }',
    'float tfN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(tfH(i), tfH(i + vec2(1.0, 0.0)), f.x), mix(tfH(i + vec2(0.0, 1.0)), tfH(i + vec2(1.0, 1.0)), f.x), f.y); }',
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
    '  c = max(mix(vec3(1.0), c, uLawnK), vec3(0.05));',
    // mowing stripes: the mower runs alongside the track, so the bands lie at constant distances
    // from its edge (site.b, quarter metres from the tarmac up to 63 m), 4 m wide, fading out past 40 m; light along the
    // lay, dark against it, strongest seen at a low angle
    '  float sd = site.b * 63.75, sband = smoothstep(-0.25, 0.25, sin(sd * 3.14159 / 4.0)) * 2.0 - 1.0;',
    '  vec2 vd0 = w - eye.xz; float vgl = clamp(length(vd0) / max(abs(eye.y - 0.0) + 1.0, 1.0), 0.0, 6.0);',
    '  { float sk = sband * step(sd, 60.0) * smoothstep(0.0, 1.2, sd) * (1.0 - smoothstep(40.0, 60.0, sd)); c *= 1.0 + sk * vec3(0.05, 0.045, 0.025); }',
    '  vec2 perp = vec2(-uLawn.y, uLawn.x);',
    '  float band = smoothstep(-0.3, 0.3, sin(dot(w, perp) * 3.14159 / uLawn.z)) * 2.0 - 1.0;',
    '  vec2 vd = w - eye.xz; vd /= max(length(vd), 1e-3);',
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
      sh.fragmentShader = F1.R3Shadow.PARS + sh.fragmentShader.replace('#include <lights_fragment_begin>', F1.R3Shadow.lightsChunk());
      // the share of the surface's light that comes straight from the sun: ambient occlusion
      // can only take away the rest (sky and bounce light)
      if (opaque) sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', '#include <opaque_fragment>\n' +
        '  { vec3 r3L = vec3(0.2126, 0.7152, 0.0722); float r3Dir = dot(reflectedLight.directDiffuse + reflectedLight.directSpecular, r3L), r3Ind = dot(reflectedLight.indirectDiffuse + reflectedLight.indirectSpecular, r3L);\n' +
        '    gl_FragColor.a = mix(gl_FragColor.a, r3Dir / max(r3Dir + r3Ind, 1e-5), r3SunA); }');
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
        .replace('#include <map_fragment>', '#include <map_fragment>\n  float wxP = smoothstep(0.42, 0.72, wxN(vFogWorld.xz * 0.28) * 0.6 + wxN(vFogWorld.xz * 1.1) * 0.4);\n  diffuseColor.rgb *= 1.0 - uWet * ' + wk[0].toFixed(2) + ' * (0.28 + 0.2 * wxP);')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, mix(roughnessFactor * 0.4, 0.05, wxP), clamp(uWet * ' + wk[1].toFixed(2) + ' * 1.4, 0.0, 1.0));');
    }
    if (ao) {
      // skylight occlusion near the road: height above the car's own ground (the mesh's origin
      // sits at the car's ground, or at the wheel centre for tyres, hence ao.lift)
      sh.vertexShader = 'varying float vAOh;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vAOh = (modelMatrix * vec4(transformed, 1.0)).y - modelMatrix[3].y + ' + ao.lift.toFixed(3) + ';');
      sh.fragmentShader = 'varying float vAOh;\n' + sh.fragmentShader.replace('#include <aomap_fragment>', [
        '#include <aomap_fragment>',
        '  {',
        '    float aoUp = dot(normalize(normal), normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz));',
        '    float aoAmt = 0.6 + 0.4 * (1.0 - clamp(aoUp, 0.0, 1.0));', // surfaces that face up still see the sky
        '    float aoG = 1.0 - aoAmt * ' + ao.k.toFixed(2) + ' * (1.0 - smoothstep(0.0, 0.8, vAOh));',
        '    reflectedLight.indirectDiffuse *= aoG; reflectedLight.indirectSpecular *= aoG;',
        '  }'].join('\n'));
    }
    if (mac) {
      sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vMacroW = (modelMatrix * vec4(transformed, 1.0)).xz;');
      const f = n => n.toFixed(3);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <map_fragment>', '#include <map_fragment>\n' +
          `  float mcr = texture2D(macroMap, vMacroW / ${f(mac.scale)}).r * 0.6 + texture2D(macroMap, vMacroW / ${f(mac.scale * 0.21)}).g * 0.4;\n` +
          `  diffuseColor.rgb *= mix(${f(1 - mac.amt)}, ${f(1 + mac.amt)}, mcr);` +
          (mac.lawn ? '\n  diffuseColor.rgb *= lawnTint(macroMap, vMacroW, cameraPosition) * lawnBreak(map, vMacroW) * lawnFar(vMacroW, vFogWorld, cameraPosition, uSunDir);\n'
            + '  { float gm = texture2D(uGrassMask, (vMacroW - uGrassMaskB.xy) / uGrassMaskB.zw).r;\n'
            + '    diffuseColor.rgb *= mix(vec3(1.0), vec3(0.92, 0.8, 0.62), (1.0 - smoothstep(0.15, 0.75, gm)) * 0.55); }\n'
            + '  diffuseColor.rgb = lawnGrade(diffuseColor.rgb);' : ''))
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' +
          `  roughnessFactor = clamp(roughnessFactor * mix(${f(1 - mac.ramt)}, ${f(1 + mac.ramt)}, 1.0 - mcr), 0.04, 1.0);` +
          // turf is a matte tangle of blades: the photo's own 0.55 left a glassy sky sheen on it
          (mac.lawn ? `\n  roughnessFactor = max(roughnessFactor, ${f(LAWN_ROUGH)});` : ''));
      if (mac.lawn) {
        // turf is a matte tangle: no mirror-like glancing reflection off it toward a low sun
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

  // Patch a lit material once. Basic/shader materials (sky, particles, UI decals) keep theirs.
  function patch(m) {
    if (!m || m.userData.r3s || !(m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial)) return m;
    m.userData.r3s = true;
    const mac = m.userData.macro || null, liv = m.userData.livery || null, gr = m.userData.grass || null, ao = m.userData.carAO || null, wk = m.userData.wetK || null;
    if (mac && !U.macroMap.value) U.macroMap.value = F1.R3T.macro();
    const ex = m.userData.patchExtra || null, exKey = m.userData.patchKey || '';
    const opaque = !m.transparent;
    m.onBeforeCompile = sh => { patchShader(sh, mac, liv, ao, wk, opaque); if (gr) F1.R3Grass.patchShader(sh, gr); if (ex) ex(sh); };
    m.customProgramCacheKey = () => 'r3s2' + (opaque ? 'o' : 't') + (mac ? '_m' + mac.scale + '_' + mac.amt + '_' + mac.ramt + (mac.lawn ? 'L' : '') : '') + (liv ? '_liv' : '') + (gr ? '_grass' + (gr.uGBlade ? 'B' : '') + (gr.uGShell ? 'S' : '') : '') + (ao ? '_ao' + ao.lift : '') + (wk ? '_wet' : '') + (ex ? '_x' + exKey : '');
    m.needsUpdate = true;
    return m;
  }
  function patchTree(obj) {
    obj.traverse(o => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(patch); });
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
  const NOISE = [
    'float wHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }',
    'float wNoise(vec2 p) {',
    '  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), f.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), f.x), f.y);',
    '}'].join('\n');
  const LUM = 'vec3(0.2126, 0.7152, 0.0722)';
  const ext = (m, key, fn) => { m.userData.patchExtra = fn; m.userData.patchKey = key; return m; };

  // Track asphalt. The geometry carries trk = (distance along the lap, lateral offset, the
  // racing line's offset, braking/cornering load). The photo is a dark, brownish fresh
  // asphalt: it is lifted to the mid grey of a used circuit, then the racing line is
  // rubbered in, and tyre streaks run along the lap, densest on the line and heaviest where
  // cars brake and turn (with short skid marks there), while the edges stay dusty.
  function asphaltWear(m, gain) {
    return ext(m, 'asph', sh => {
      sh.vertexShader = 'attribute vec4 trk; varying vec4 vTrk;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vTrk = trk;');
      sh.fragmentShader = 'varying vec4 vTrk;\n' + NOISE + '\n' + sh.fragmentShader
        .replace('#include <map_fragment>', [
          '#include <map_fragment>',
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
          // many separate tyre-track pairs, each a car's own path: they cross the road in lazy
          // curves, clustered loosely round the racing line (not following the road's edges),
          // fading in and out along their length, more spread out in corners
          '  float aMany = 0.0;',
          '  for (int k = 0; k < 16; k++) {',
          '    float fk = float(k), h1 = wHash(vec2(fk, 1.7)), h2 = wHash(vec2(fk, 5.3)), h3 = wHash(vec2(fk, 9.1)), h4 = wHash(vec2(fk, 13.9)), h5 = wHash(vec2(fk, 21.7));',
          '    float off = (h1 + h2 - 1.0) * (3.2 + 2.2 * aW);',
          '    off += sin(vTrk.x * (0.008 + 0.02 * h3) + h4 * 6.283) * (0.5 + 1.5 * h5) + sin(vTrk.x * (0.031 + 0.03 * h2) + h1 * 6.283) * 0.35;',
          '    float dd = aL - off;',
          '    float tr2 = max(exp(-pow(dd - 0.8, 2.0) / 0.022), exp(-pow(dd + 0.8, 2.0) / 0.022));',
          '    float seg = smoothstep(0.38, 0.62, wNoise(vec2(vTrk.x * (0.02 + 0.03 * h3) + fk * 13.0, fk)));',
          '    aMany += tr2 * seg * (0.22 + 0.4 * h4) * (0.7 + 0.3 * wNoise(vec2(vTrk.y * 14.0, vTrk.x * 0.6 + fk)));',
          '  }',
          '  aMany *= 1.0 - smoothstep(0.0, 1.0, (abs(vTrk.y) - 6.0) / 3.0) * 0.0;',
          '  float aRub = aTr * aBreak * (0.28 + 0.5 * aLoad) + aBand * 0.14 * aLoad + aWide * 0.1 + aWider * 0.05 + aSkid * 0.35 + aMany * (0.5 + 0.5 * aLoad);',
          '  diffuseColor.rgb *= (1.0 - clamp(aRub, 0.0, 0.78));',
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
      sh.fragmentShader = NOISE + '\n' + sh.fragmentShader.replace('#include <color_fragment>', [
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
      sh.fragmentShader = NOISE + '\n' + sh.fragmentShader.replace('#include <color_fragment>', [
        '#include <color_fragment>',
        '  vec2 pW = vFogWorld.xz;',
        '  float pN = wNoise(pW * 2.5) * 0.5 + wNoise(pW * 11.0) * 0.5;',
        '  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.06), smoothstep(0.52, 0.82, pN) * 0.6);',
        '  diffuseColor.rgb *= (1.0 - smoothstep(0.55, 0.9, wNoise(pW * 0.7 + 5.0)) * 0.35) * 0.86;',
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

  F1.R3S = { U, patch, patchTree, hdrTexture, LAWN, LAWN_ROUGH, wear: { asphalt: asphaltWear, kerb: kerbWear, paint: paintWear, zinc: zincTone } };
})(typeof window !== 'undefined' ? window : globalThis);
