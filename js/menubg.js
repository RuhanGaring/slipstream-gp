// The picture behind the menus and the loading screen: solid slats with slanted ends, stacked like
// bodywork, one of them red. They slide slowly over each other, each at its own depth, so moving the
// mouse shifts them against one another and turns the whole stack a little; a shallow depth of field
// keeps the red one sharp and softens the rest. On the loading screen they slide in one by one with
// the loading itself. One fragment shader on a canvas of its own, above the game's picture and below
// the menus; while it covers the picture the race behind it is neither stepped nor drawn.
(function (G) {
  'use strict';
  const F1 = G.F1;
  if (typeof document === 'undefined') return;
  const cv = document.getElementById('menubg');
  if (!cv) return;
  let gl = null, U = null, on = false, raf = 0, t = 0, last = 0, since = 0, slow = 0, scale = 1, lost = false;
  let began = 0, load = 0, loadTo = 0, prog = 0, progTo = 0, dim = 1.4, dimTo = 1.4, intro = 0;
  const M = { x: 0, y: 0, tx: 0, ty: 0 }; // the mouse, -1 to 1 from the middle, eased and wanted
  const still = !!(G.matchMedia && G.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const VS = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';
  const FS = `precision highp float;
uniform vec2 uR, uM; uniform float uT, uLoad, uP, uDim, uIn;
float h2(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float ease(float x){ x = clamp(x, 0.0, 1.0); return 1.0 - pow(1.0 - x, 4.0); }
float edge(float a, float x, float b){ return smoothstep(a - b, a + b, x); }   // an edge b soft
void main(){
  vec2 q = (gl_FragCoord.xy - 0.5 * uR) / uR.y;
  float asp = uR.x / uR.y, px = 0.75 / uR.y, wide = clamp(asp / 1.7778, 0.42, 1.25);
  // the stack turns a little toward the mouse
  q /= 1.0 + dot(q, uM) * 0.095;
  vec3 c = mix(vec3(0.048, 0.052, 0.062), vec3(0.094, 0.100, 0.116), clamp(0.5 + 0.5 * q.x / asp + 0.28 * q.y, 0.0, 1.0));
  // a light far behind, moving against the mouse
  c *= 1.0 + 0.10 * exp(-dot(q - vec2(0.45, 0.2) + uM * 0.12, q - vec2(0.45, 0.2) + uM * 0.12) * 3.0);
  const float N = 9.0;
  float corner = smoothstep(0.35, 1.05, length(q / vec2(asp * 0.62, 0.62)));   // the lens is softer toward its edge
  float H = 1.0 / N;
  for (int j = 0; j < 10; j++) {
    float id = float(j), v = h2(vec2(id, 6.0)), red = id == 5.0 ? 1.0 : id == 2.0 ? 0.6 : 0.0;
    // how near it is: the red one at the plane of focus
    float z = id == 5.0 ? 0.62 : id == 2.0 ? 0.40 : mix(0.05, 1.0, h2(vec2(id, 17.0)));
    float off = abs(z - 0.62) * 0.044, coc = off + corner * 0.020;
    float b = px + coc;
    vec2 p = q + uM * vec2(0.105, 0.046) * (z - 0.30);
    float s = p.x - p.y * 0.364;
    float y0 = id * H - 0.5 - H * 0.12 - off * 0.4, h = H * 1.16 + off * 1.1 + 0.020 * abs(uM.y);   // (a soft one overlaps more, or the row under it shows through)
    float e = 0.15 + 0.41 * v + 0.045 * sin(uT * (0.20 + 0.12 * v) + id * 2.2);
    e += (1.0 - ease(uIn * 1.35 - id * 0.05)) * 1.25;
    float in1 = ease(uP * 1.45 - id * 0.050);
    e = mix(e, e - 0.03 + (1.0 - in1) * 0.95, uLoad);
    e *= wide;
    float d = p.y - y0, x = s - e;
    float body = edge(0.0, d, b) * (1.0 - edge(h, d, b)) * edge(0.0, x, b);
    // its shadow on what lies under it: to the left of its end, and below it
    float far = 0.014 + 0.030 * z;
    float sl = exp(-max(-x, 0.0) / far) * edge(0.0, d + 0.006, 0.022 + b) * (1.0 - edge(h, d, 0.012 + b)) * (1.0 - smoothstep(0.02, 0.06, x - b));
    float sb = exp(min(d, 0.0) / (0.014 + 0.022 * z + b)) * smoothstep(-0.07, 0.16, x) * (1.0 - smoothstep(0.4, 0.7, d / h));
    c *= 1.0 - 0.44 * sl * smoothstep(-0.2, 0.0, x);
    c *= 1.0 - 0.34 * sb;
    // the thickness of its end, seen more when the mouse is to its left
    float th = (0.0055 + 0.0080 * z) * (0.8 - 0.75 * uM.x);
    float face = edge(-th, x, b) * (1.0 - edge(0.0, x, b)) * edge(0.0, d, b) * (1.0 - edge(h, d, b));
    vec3 k = vec3(0.076 + 0.022 * v) * 1.18 + 0.028; k *= vec3(1.0, 1.04, 1.15);
    vec3 r = mix(vec3(0.46, 0.050, 0.042), vec3(0.80, 0.105, 0.075), smoothstep(-0.6, 0.6, p.y + 0.12 * p.x));
    k = red > 0.9 ? r * 1.02 : red > 0.1 ? r * 0.62 : k;
    vec3 fk = k * (red > 0.1 ? 0.42 : 0.50);
    c = mix(c, fk, face);
    float u = clamp(d / h, 0.0, 1.0);
    k *= 0.78 + 0.30 * u + 0.16 * smoothstep(0.0, 0.9, x);
    // satin: a soft light that passes now and then, and leans with the mouse
    float sw = (s - id * 0.02 + uM.x * 0.10 - (mod(uT, 11.0) * 0.50 - 1.7)) / 0.15;
    k *= 1.0 + 0.18 * exp(-sw * sw) + 0.05 * uM.y * (u - 0.5);
    k += (0.06 + 0.05 * red) * smoothstep(0.0035 + b, 0.0, abs(d - h + 0.002)) * (1.0 - 0.75 * min(1.0, coc * 90.0));
    c = mix(c, k, body);
  }
  c *= 1.0 - 0.16 * corner;
  c *= uDim;
  c += (h2(gl_FragCoord.xy * 0.71) - 0.5) * 0.011;
  gl_FragColor = vec4(c, 1.0);
}`;
  function init() {
    gl = cv.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
    if (!gl) { flat(); return; }
    const mk = (ty, src) => { const s = gl.createShader(ty); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const pr = gl.createProgram();
    gl.attachShader(pr, mk(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, mk(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) { console.warn('menu background: ' + gl.getProgramInfoLog(pr)); gl = null; flat(); return; }
    gl.useProgram(pr);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    U = {}; for (const n of ['uR', 'uM', 'uT', 'uLoad', 'uP', 'uDim', 'uIn']) U[n] = gl.getUniformLocation(pr, n);
  }
  // (no WebGL for it: a still picture in plain CSS)
  function flat() { cv.style.background = 'linear-gradient(110deg, #0d0f13 0 62%, #17191e 62.2% 74%, #8c1812 74.2% 88%, #14161b 88.2%)'; }
  cv.addEventListener('webglcontextlost', e => { e.preventDefault(); lost = true; });
  cv.addEventListener('webglcontextrestored', () => { lost = false; init(); });
  G.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch') return; // (a finger is on a button, not looking round)
    M.tx = Math.max(-1, Math.min(1, e.clientX / Math.max(1, G.innerWidth) * 2 - 1));
    M.ty = Math.max(-1, Math.min(1, 1 - e.clientY / Math.max(1, G.innerHeight) * 2));
  }, { passive: true });
  document.addEventListener('mouseleave', () => { M.tx = M.ty = 0; });

  function size() {
    const r = Math.min(1.5, G.devicePixelRatio || 1) * scale, w = Math.max(2, Math.round(cv.clientWidth * r)), h = Math.max(2, Math.round(cv.clientHeight * r));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; gl.viewport(0, 0, w, h); }
  }
  function frame(now) {
    raf = on ? requestAnimationFrame(frame) : 0;
    const gap = (now - last) / 1000, dt = Math.max(0, Math.min(0.05, gap)); last = now;
    if (!gl || lost) return;
    // a machine that cannot keep up gets a smaller picture (the circuit being built does not count)
    if (!loadTo) { slow = gap > 0.028 && gap < 0.2 ? slow + 1 : Math.max(0, slow - 0.5); if (slow > 60 && scale > 0.5) { scale -= 0.25; slow = 0; } }
    if (!still) t += dt;
    intro = still ? 2 : Math.min(2, intro + dt / 1.1);
    const e = 1 - Math.exp(-dt * 6);
    M.x += ((still ? 0 : M.tx) - M.x) * e; M.y += ((still ? 0 : M.ty) - M.y) * e;
    load += (loadTo - load) * (1 - Math.exp(-dt * 5)); prog += (progTo - prog) * (1 - Math.exp(-dt * 3)); dim += (dimTo - dim) * e;
    // (they come in on a clock up to the middle at least, so a stage that reports nothing is not an empty screen)
    if (loadTo) progTo = Math.max(progTo, Math.min(0.62, 0.16 + (now - began) / 5000));
    size();
    gl.uniform2f(U.uR, cv.width, cv.height); gl.uniform2f(U.uM, M.x, M.y); gl.uniform1f(U.uT, 14 + t % 3600);
    gl.uniform1f(U.uLoad, load); gl.uniform1f(U.uP, prog); gl.uniform1f(U.uDim, dim); gl.uniform1f(U.uIn, intro);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  // kind: 'menu' | 'load' | null (hidden)
  function set(kind) {
    const want = !!kind;
    if (kind === 'load' && !loadTo) { prog = 0; progTo = 0.16; began = performance.now(); }
    if (want) { loadTo = kind === 'load' ? 1 : 0; dimTo = (kind === 'load' ? 1.0 : 1.4) * (document.body.classList.contains('compact') ? 1.7 : 1); }
    if (want === on) return;
    on = want;
    cv.classList.toggle('on', on);
    if (on) {
      since = last = performance.now();
      if (kind === 'load') load = 1; else { load = 0; intro = 0; }
      if (!gl && !cv.style.background) init();
      if (!raf) raf = requestAnimationFrame(frame);
    } else loadTo = 0;
  }
  // how far the loading is, 0 to 1 (it never goes back within one load)
  function progress(p) { progTo = Math.max(progTo, Math.min(1, p)); }
  F1.MenuBg = { set, progress, covers: () => on && performance.now() - since > 700, get on() { return on; }, get scale() { return scale; }, mouse: M };
})(typeof window !== 'undefined' ? window : globalThis);
