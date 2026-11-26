// Frame-time readout: where each frame's time goes. F8 shows or hides it (so does ?perf in the
// address); the choice is kept. Off, it costs one test of a flag per hook.
//
// Buckets, in ms per frame (averaged over the last second, with the worst frame beside):
//   sim     the fixed physics steps (F1.Race.step with the player's input), and how many ran
//   game    the rest of the game's frame outside the renderer: effects, HUD, audio, replay
//           recorder, minimap
//   scene   the renderer's own work before it hands anything to WebGL: cars, camera, weather,
//           culling of far scenery, shadow fitting
//   shadow  three.js drawing the shadow maps (their draw calls)
//   main    three.js drawing the scene itself (culling, sorting, state, draw calls)
//   post    the post stack's passes (velocity, TAA, AO, bloom, composite)
//   gpu     the GPU's own time for the whole frame (EXT_disjoint_timer_query_webgl2, when the
//           browser offers it; a few frames late)
// F1.Perf.snapshot() returns the same averages, for test tools.
(function (G) {
  'use strict';
  const F1 = G.F1 || (G.F1 = {});
  const now = () => performance.now();
  const KEYS = ['sim', 'game', 'scene', 'shadow', 'main', 'post'];
  const COL = { sim: '#ff5a4e', game: '#ffb347', scene: '#ffe066', shadow: '#7fd6a0', main: '#5ab0ff', post: '#b58cff' };
  const N = 240; // frames of history

  const P = { on: false, cur: null, hist: [], el: null, cv: null, txt: null, t: 0 };
  const blank = () => ({ sim: 0, game: 0, scene: 0, shadow: 0, main: 0, post: 0, steps: 0, frame: 0, cpu: 0, gpu: -1, calls: 0, shCalls: 0, tris: 0 });
  P.cur = blank();

  // ---- hooks the game calls (each a no-op while the readout is off) ----
  let tFrame = 0, tPrev = 0, tR3 = 0, subT = 0, depth = 0;
  P.frameBegin = () => {
    if (!P.on) return;
    hook();
    const t = now();
    P.cur = blank();
    P.cur.frame = tPrev ? t - tPrev : 0; tPrev = t; tFrame = t;
    subT = 0;
    gpuBegin();
  };
  P.frameEnd = () => {
    if (!P.on || !tFrame) return;
    gpuEnd();
    const c = P.cur;
    c.cpu = now() - tFrame;
    c.game = Math.max(0, c.cpu - c.sim - tR3);
    P.hist.push(c); if (P.hist.length > N) P.hist.shift();
    if (P.rec) P.rec.push(c); // (test tools: every frame, set P.rec = [])
    tR3 = 0; tFrame = 0;
    draw();
  };
  // time spent in one bucket: const t = P.t0(); ... P.add('sim', t)
  P.t0 = () => (P.on ? now() : 0);
  P.add = (k, t) => { if (P.on && t) P.cur[k] += now() - t; };
  P.step = () => { if (P.on) P.cur.steps++; };
  // the renderer's whole frame (scene = this minus what three.js spent submitting)
  P.r3 = t => { if (!P.on || !t) return; tR3 = now() - t; P.cur.scene = Math.max(0, tR3 - subT); };

  const R = () => F1.R3 && F1.R3.renderer;
  // three.js's render and shadow-map entry points, timed by wrapping them (installed once, the
  // first time the readout is on; the wrappers already in place in js/render3d.js stay inside)
  let hooked = null;
  function hook() {
    const r = R();
    if (!r || hooked === r) return;
    hooked = r;
    const rr = r.render, sm = r.shadowMap, sr = sm.render;
    let inShadow = 0;
    r.render = function (sc, cam) {
      if (!P.on || depth) return rr.call(this, sc, cam);
      depth++;
      const t = now(), c0 = P.cur, sh0 = c0.shadow;
      try { return rr.call(this, sc, cam); } finally {
        depth--;
        const d = now() - t, c = P.cur;
        subT += d;
        const main = F1.R3 && sc === F1.R3.scene;
        // (the shadow maps are drawn from inside the scene's render: theirs is taken out)
        if (main) c.main += d - (c.shadow - sh0); else c.post += d;
        c.calls += r.info.render.calls; c.tris += r.info.render.triangles;
      }
    };
    sm.render = function (l, sc, cam) {
      if (!P.on || inShadow) return sr.call(this, l, sc, cam);
      inShadow++;
      const t = now(), k0 = r.info.render.calls;
      try { return sr.call(this, l, sc, cam); } finally {
        inShadow--;
        P.cur.shadow += now() - t;
        P.cur.shCalls += r.info.render.calls - k0;
      }
    };
  }

  // ---- GPU time: one query per frame, read back when ready ----
  let gl = null, ext = null, q = null, pend = [], gpuLast = -1;
  function gpuBegin() {
    if (G.__perfNoGpu) return; // (timer queries can stall the pipeline: off for stall hunts)
    const r = R();
    if (!r) return;
    if (!gl) { gl = r.getContext(); ext = gl.getExtension('EXT_disjoint_timer_query_webgl2'); }
    if (!ext) return;
    // results come back a few frames late
    while (pend.length && gl.getQueryParameter(pend[0], gl.QUERY_RESULT_AVAILABLE)) {
      const pq = pend.shift();
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) gpuLast = gl.getQueryParameter(pq, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(pq);
    }
    P.cur.gpu = gpuLast;
    if (pend.length > 6) return; // (a stuck query: skip rather than pile up)
    q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
  }
  function gpuEnd() {
    if (G.__perfNoGpu) return; // (timer queries can stall the pipeline: off for stall hunts)
    if (!q) return;
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    pend.push(q); q = null;
  }

  // ---- averages ----
  function stats(frames) {
    const h = P.hist.slice(-frames), n = h.length || 1, o = { n: h.length };
    for (const k of KEYS.concat(['steps', 'frame', 'cpu', 'calls', 'shCalls', 'tris'])) o[k] = h.reduce((s, c) => s + c[k], 0) / n;
    const g = h.filter(c => c.gpu >= 0); o.gpu = g.length ? g.reduce((s, c) => s + c.gpu, 0) / g.length : -1;
    const ft = h.map(c => c.frame).sort((a, b) => a - b);
    o.p95 = ft.length ? ft[Math.floor(ft.length * 0.95)] : 0;
    o.max = {}; for (const k of KEYS.concat(['cpu'])) o.max[k] = h.reduce((s, c) => Math.max(s, c[k]), 0);
    o.submit = o.shadow + o.main + o.post;
    o.fps = o.frame ? 1000 / o.frame : 0;
    return o;
  }
  P.snapshot = (frames = 60) => {
    const s = stats(frames), r = R(), g = F1.R3 && F1.R3.GFX;
    if (r) { const v = r.getDrawingBufferSize(new G.THREE.Vector2()); s.res = v.x + 'x' + v.y; }
    if (g) s.preset = g.preset;
    return s;
  };
  P.reset = () => { P.hist.length = 0; };

  // ---- the readout ----
  function build() {
    const el = document.createElement('div');
    el.id = 'perf-hud';
    el.style.cssText = 'position:fixed;right:12px;top:12px;z-index:95;padding:8px 10px 6px;background:rgba(8,10,13,.86);color:#e8e8ee;font:11px/1.45 Consolas,monospace;pointer-events:none;border-top:2px solid #e10600;white-space:pre';
    const txt = document.createElement('div');
    const cv = document.createElement('canvas'); cv.width = N; cv.height = 70;
    cv.style.cssText = 'display:block;margin-top:5px;width:' + N + 'px;height:70px';
    el.append(txt, cv);
    document.body.appendChild(el);
    P.el = el; P.txt = txt; P.cv = cv;
  }
  const f = (x, d = 1) => (x < 0 ? ' -- ' : x.toFixed(d).padStart(5));
  function draw() {
    if (!P.el) build();
    const t = now();
    if (t - P.t < 250) return; // text 4 times a second
    P.t = t;
    const s = stats(60);
    const sw = k => '<span style="color:' + COL[k] + '">■</span> ';
    P.txt.innerHTML =
      'FRAME ' + f(s.frame) + ' ms ' + f(s.fps, 0) + ' fps  p95 ' + f(s.p95) + '\n' +
      'CPU   ' + f(s.cpu) + ' ms   GPU ' + f(s.gpu) + ' ms\n' +
      sw('sim') + 'sim    ' + f(s.sim, 2) + '  max ' + f(s.max.sim) + '  (' + s.steps.toFixed(1) + ' steps)\n' +
      sw('game') + 'game   ' + f(s.game, 2) + '  max ' + f(s.max.game) + '\n' +
      sw('scene') + 'scene  ' + f(s.scene, 2) + '  max ' + f(s.max.scene) + '\n' +
      sw('shadow') + 'shadow ' + f(s.shadow, 2) + '  max ' + f(s.max.shadow) + '\n' +
      sw('main') + 'main   ' + f(s.main, 2) + '  max ' + f(s.max.main) + '\n' +
      sw('post') + 'post   ' + f(s.post, 2) + '  max ' + f(s.max.post) + '\n' +
      'draws ' + Math.round(s.calls) + ' (shadow ' + Math.round(s.shCalls) + ')  tris ' + (s.tris / 1e6).toFixed(2) + ' M';
    // stacked bars, one per frame; the line is 16.7 ms, the dots are the GPU time
    const c = P.cv.getContext('2d'), H = P.cv.height, k = H / 25;
    c.clearRect(0, 0, N, H);
    const h = P.hist, x0 = N - h.length;
    for (let i = 0; i < h.length; i++) {
      let y = H;
      for (const key of KEYS) { const v = h[i][key] * k; if (v > 0) { c.fillStyle = COL[key]; c.fillRect(x0 + i, y - v, 1, v); y -= v; } }
      if (h[i].gpu >= 0) { c.fillStyle = '#fff'; c.fillRect(x0 + i, H - h[i].gpu * k, 1, 1); }
    }
    c.fillStyle = 'rgba(255,255,255,.35)'; c.fillRect(0, Math.round(H - 16.7 * k), N, 1);
  }

  P.set = on => {
    P.on = !!on;
    try { localStorage.setItem('slip_perf', P.on ? '1' : '0'); } catch (e) { /* private window */ }
    if (!P.on) { if (P.el) P.el.style.display = 'none'; tPrev = 0; P.hist.length = 0; }
    else if (P.el) P.el.style.display = '';
  };
  P.toggle = () => P.set(!P.on);
  if (typeof window !== 'undefined') {
    let want = false;
    try { want = /[?&]perf\b/.test(location.search) || localStorage.getItem('slip_perf') === '1'; } catch (e) { /* none */ }
    if (want) P.on = true;
    window.addEventListener('keydown', e => { if (e.code === 'F8' && !e.repeat) { e.preventDefault(); P.toggle(); } });
  }
  F1.Perf = P;
})(typeof window !== 'undefined' ? window : globalThis);
