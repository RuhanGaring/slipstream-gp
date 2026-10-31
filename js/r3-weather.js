// Weather for the 3D renderer: falling rain as streaks that stretch with the relative speed
// between the drops and the camera, and an overcast storm sky laid over the venue's sky.
// The track's wetness, the dimmer light and the heavier fog live in render3d and r3-shaders.
(function (G) {
  'use strict';
  const F1 = G.F1, THREE = G.THREE;

  const N = 14000, BOX = [56, 24, 56], FALL = 9.5;

  const RAIN_VS = [
    '#include <common>',
    '#include <logdepthbuf_pars_vertex>',
    'attribute vec3 aSeed; attribute float aEnd;',
    'uniform vec3 uCam; uniform vec3 uCamV; uniform float uTime; uniform vec3 uBox; uniform float uFall;',
    'varying float vA;',
    'void main(){',
    // a fixed field of drops falling and wrapping round the camera
    '  vec3 b = aSeed * uBox + vec3(0.0, -uFall * uTime, 0.0);',
    '  vec3 p = uCam + mod(b - uCam + uBox * 0.5, uBox) - uBox * 0.5;',
    // streak: where the drop was a few milliseconds ago, in the camera's frame
    '  vec3 rel = vec3(0.0, -uFall, 0.0) - uCamV;',
    '  p -= rel * 0.018 * (1.0 - aEnd);',
    '  float dc = length(p - uCam);',
    // a drop smeared over a long streak by a fast camera is fainter all along it (its light
    // is spread over more of the frame), so a fast car does not see a bright starfield
    '  float len = length(rel) * 0.018;',
    '  vA = (0.15 + 0.85 * aEnd) * (1.0 - smoothstep(10.0, 28.0, dc)) * smoothstep(0.8, 2.5, dc) / (1.0 + len * 1.6);',
    '  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);',
    '  #include <logdepthbuf_vertex>',
    '}'].join('\n');
  const RAIN_FS = [
    '#include <logdepthbuf_pars_fragment>',
    'uniform float uAlpha; varying float vA;',
    'void main(){',
    '  #include <logdepthbuf_fragment>',
    '  gl_FragColor = vec4(vec3(0.78, 0.82, 0.88) * 0.85, vA * uAlpha);',
    '}'].join('\n');

  const STORM_FS = [
    'uniform float uRain; uniform vec3 uFog; uniform float uTime; varying vec3 vDir;',
    'float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
    'float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }',
    'float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int k = 0; k < 5; k++){ s += a * vn(p); p *= 2.03; a *= 0.5; } return s; }',
    'void main(){',
    '  vec3 d = normalize(vDir); float y = max(d.y, 0.0);',
    '  vec2 uv = d.xz / (y + 0.18) * 1.2 + vec2(uTime * 0.004, uTime * 0.0015);',
    '  float n = fbm(uv);',
    '  vec3 low = uFog * 0.95, high = uFog * mix(0.42, 0.62, n);',
    '  vec3 c = mix(low, high, pow(clamp(y, 0.0, 1.0), 0.45));',
    '  c *= 0.82 + 0.3 * fbm(uv * 3.0 + 4.0);',
    '  gl_FragColor = vec4(c, clamp(uRain * 1.15, 0.0, 0.96));',
    '  #include <tonemapping_fragment>',
    '  #include <colorspace_fragment>',
    '}'].join('\n');

  function create(scene) {
    // rain
    const pos = new Float32Array(N * 2 * 3), seed = new Float32Array(N * 2 * 3), end = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const a = Math.random(), b = Math.random(), c = Math.random();
      for (let k = 0; k < 2; k++) { seed.set([a, b, c], (i * 2 + k) * 3); end[i * 2 + k] = k; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: { uCam: { value: new THREE.Vector3() }, uCamV: { value: new THREE.Vector3() }, uTime: { value: 0 }, uBox: { value: new THREE.Vector3(...BOX) }, uFall: { value: FALL }, uAlpha: { value: 0.4 } },
      vertexShader: RAIN_VS, fragmentShader: RAIN_FS, transparent: true, depthWrite: false, fog: false,
    });
    const rain = new THREE.LineSegments(g, m);
    rain.frustumCulled = false; rain.renderOrder = 8; rain.visible = false;
    scene.add(rain);
    // storm sky
    const sm = new THREE.ShaderMaterial({
      uniforms: { uRain: { value: 0 }, uFog: { value: new THREE.Color(0.5, 0.53, 0.58) }, uTime: { value: 0 } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: STORM_FS, side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: true, fog: false,
    });
    const storm = new THREE.Mesh(new THREE.SphereGeometry(8800, 24, 12), sm);
    storm.renderOrder = -9; storm.frustumCulled = false; storm.visible = false;
    scene.add(storm);
    const lastCam = new THREE.Vector3(); let have = false; const vel = new THREE.Vector3();
    return {
      rain, storm,
      // k: rain intensity 0..1; cam: the camera; dt in seconds; fog: the venue's fog colour (linear)
      update(k, cam, dt, time, fog) {
        rain.visible = k > 0.03; storm.visible = k > 0.03;
        if (!rain.visible) { have = false; return; }
        if (have && dt > 0) vel.lerp(new THREE.Vector3().subVectors(cam.position, lastCam).divideScalar(dt), Math.min(1, dt * 12));
        else if (!have) vel.set(0, 0, 0);
        have = true; lastCam.copy(cam.position);
        const u = m.uniforms;
        u.uCam.value.copy(cam.position); u.uCamV.value.copy(vel); u.uTime.value = time; u.uAlpha.value = 0.1 + 0.3 * k;
        g.setDrawRange(0, Math.floor(N * (0.25 + 0.75 * k) * Math.min(1, this.density == null ? 1 : this.density)) * 2); // density: advanced graphics
        storm.position.copy(cam.position);
        sm.uniforms.uRain.value = k; sm.uniforms.uTime.value = time; if (fog) sm.uniforms.uFog.value.copy(fog).multiplyScalar(0.8);
      },
    };
  }

  F1.R3W = { create };
})(typeof window !== 'undefined' ? window : globalThis);
