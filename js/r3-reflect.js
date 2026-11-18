// The circuit's reflection copy: a low-detail stand-in for the scenery, drawn only into the cube the
// cars reflect (js/render3d.js probeStep), as the racing games keep a "reflection LOD" of their
// worlds. The real scenery is a hundred and more draw calls a cube face on a town circuit (it is
// merged circuit-wide per material, so every face sees nearly all of it), and a draw costs some
// 25 us on this engine: six faces a frame of it would halve the frame rate. This copy is a handful
// of draws a face, so the cube can be drawn whole every frame and the reflections on the car move
// with it at the frame rate (a tunnel's lamps slide along the bodywork).
//
// How it is made, once per circuit (and kept in the browser's storage, so a circuit loads it at
// once the next time): every scenery mesh, in world space, is snapped to a grid of cells (1.5 m;
// 1 m on Ultra) and each cell's vertices become one (vertex clustering, Rossignac and Borrel):
// triangles that fall inside a cell vanish, the rest keep the shape at the grid's size. Each vertex
// carries its surface's colour (the material's colour, times its texture's average, worked out on
// the GPU so compressed textures count too, times any vertex colours) and its glow (emissive), and
// the cells average them. Glowing parts (the tunnel's lamps) are snapped to a fine grid of their own
// so they keep their shape. The work is shared out over worker threads. The result is cut into
// tiles of 150 m, so each face of the cube draws only what is in front of it.
//
// It is lit as the scenery is: the sky's light from the circuit's light probe, the sun with the
// shadow from the real shadow maps (drawn that frame), the hemisphere light (the tunnel's lamps
// take it over inside), and the fog. No cars, grass, cut-out fences or glass: the cars are not in
// the reflections (a car's own body would fill its cube), fences would become solid walls.
(function () {
  'use strict';
  const F1 = window.F1 || (window.F1 = {}), THREE = window.THREE, G = window;
  if (!THREE) return;
  const VERSION = 4, TILE = 150;

  // ---------- the worker: vertex clustering ----------
  // A job: meshes (local positions, index, world matrix, a colour and glow per mesh, optional
  // vertex colours) and a cell size. Back: one entry per occupied cell (its key and the sums of
  // its vertices' positions, colours and glows, and their number) and the triangles left, as
  // indices into those cells, each once.
  function workerMain(self) {
    let run = null;
    self.onmessage = e => {
      const d = e.data;
      if (d.type === 'start') run = begin(d.cell);
      else if (d.type === 'job') run.job(d.job);
      else if (d.type === 'end') run.end();
    };
    function begin(cell) {
      const inv = 1 / cell;
      const keys = new Map();
      // per cell: position sum (3), vertex count, colour and glow sums weighted by the area of the
      // triangles touching the cell (3 + 3), that area. (By area, not by vertex: the dense, thin
      // things, painted lines and kerbs, would otherwise outweigh the road they lie on.)
      const W = 11;
      let cap = 1 << 16, n = 0;
      let sums = new Float64Array(cap * W), ck = new Float64Array(cap);
      const cellOf = (x, y, z) => {
        const ix = Math.floor(x * inv) + 32768, iz = Math.floor(z * inv) + 32768, iy = Math.floor(y * inv) + 512;
        const key = (ix * 65536 + iz) * 1024 + iy;
        let i = keys.get(key);
        if (i === undefined) {
          i = n++;
          if (i >= cap) { cap *= 2; const s2 = new Float64Array(cap * W); s2.set(sums); sums = s2; const k2 = new Float64Array(cap); k2.set(ck); ck = k2; }
          keys.set(key, i); ck[i] = key;
        }
        const o = i * W;
        sums[o] += x; sums[o + 1] += y; sums[o + 2] += z; sums[o + 3] += 1;
        return i;
      };
      const paint = (i, A, r, g, b, er, eg, eb) => {
        const o = i * W;
        sums[o + 4] += A * r; sums[o + 5] += A * g; sums[o + 6] += A * b; sums[o + 7] += A * er; sums[o + 8] += A * eg; sums[o + 9] += A * eb; sums[o + 10] += A;
      };
      // triangles, each once whatever its winding (open addressing on the sorted cell triple)
      let tcap = 1 << 18, tn = 0, tab = new Int32Array(tcap * 3).fill(-1), tris = new Int32Array(tcap * 3), tri = 0;
      const grow = () => {
        const old = tab, oc = tcap; tcap *= 2; tab = new Int32Array(tcap * 3).fill(-1);
        for (let s = 0; s < oc; s++) { if (old[s * 3] < 0) continue; put(old[s * 3], old[s * 3 + 1], old[s * 3 + 2]); }
        const t2 = new Int32Array(tcap * 3); t2.set(tris); tris = t2;
      };
      const put = (a, b, c) => {
        let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) >>> 0, m = tcap - 1, s = h & m;
        for (;;) {
          const q = s * 3;
          if (tab[q] < 0) { tab[q] = a; tab[q + 1] = b; tab[q + 2] = c; return true; }
          if (tab[q] === a && tab[q + 1] === b && tab[q + 2] === c) return false;
          s = (s + 1) & m;
        }
      };
      let vbuf = new Int32Array(1 << 16), wp = new Float32Array(3 << 16), wc = new Float32Array(3 << 16);
      const job = J => {
        const P = J.pos, M = J.m, vc = J.vcol, vs = J.vstride || 3, cnt = P.length / 3;
        if (vbuf.length < cnt) { vbuf = new Int32Array(cnt); wp = new Float32Array(cnt * 3); wc = new Float32Array(cnt * 3); }
        const [r0, g0, b0] = J.col, [er, eg, eb] = J.em;
        const inst = J.inst || null, ni = inst ? inst.length / 16 : 1;
        const I = J.idx, a0 = J.range ? J.range[0] : 0, a1 = J.range ? Math.min(J.range[0] + J.range[1], I ? I.length : cnt) : (I ? I.length : cnt);
        for (let k = 0; k < ni; k++) {
          // the world matrix, times this instance's own
          let m = M;
          if (inst) {
            const A = M, B = inst, o = k * 16, C = new Float64Array(16);
            for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) C[j * 4 + i] = A[i] * B[o + j * 4] + A[4 + i] * B[o + j * 4 + 1] + A[8 + i] * B[o + j * 4 + 2] + A[12 + i] * B[o + j * 4 + 3];
            m = C;
          }
          const ic = J.icol ? J.icol.subarray(k * 3, k * 3 + 3) : null;
          for (let v = 0; v < cnt; v++) {
            const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
            const wx = m[0] * x + m[4] * y + m[8] * z + m[12], wy = m[1] * x + m[5] * y + m[9] * z + m[13], wz = m[2] * x + m[6] * y + m[10] * z + m[14];
            wp[v * 3] = wx; wp[v * 3 + 1] = wy; wp[v * 3 + 2] = wz;
            let r = r0, g = g0, b = b0;
            if (vc) { r *= vc[v * vs]; g *= vc[v * vs + 1]; b *= vc[v * vs + 2]; }
            if (ic) { r *= ic[0]; g *= ic[1]; b *= ic[2]; }
            wc[v * 3] = r; wc[v * 3 + 1] = g; wc[v * 3 + 2] = b;
            vbuf[v] = cellOf(wx, wy, wz);
          }
          for (let t = a0; t + 2 < a1; t += 3) {
            const i0 = I ? I[t] : t, i1 = I ? I[t + 1] : t + 1, i2 = I ? I[t + 2] : t + 2;
            const ux = wp[i1 * 3] - wp[i0 * 3], uy = wp[i1 * 3 + 1] - wp[i0 * 3 + 1], uz = wp[i1 * 3 + 2] - wp[i0 * 3 + 2];
            const qx = wp[i2 * 3] - wp[i0 * 3], qy = wp[i2 * 3 + 1] - wp[i0 * 3 + 1], qz = wp[i2 * 3 + 2] - wp[i0 * 3 + 2];
            const cx = uy * qz - uz * qy, cy = uz * qx - ux * qz, cz = ux * qy - uy * qx, A = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
            const a = vbuf[i0], b = vbuf[i1], c = vbuf[i2];
            if (A > 0) {
              const r = (wc[i0 * 3] + wc[i1 * 3] + wc[i2 * 3]) / 3, g = (wc[i0 * 3 + 1] + wc[i1 * 3 + 1] + wc[i2 * 3 + 1]) / 3, bl = (wc[i0 * 3 + 2] + wc[i1 * 3 + 2] + wc[i2 * 3 + 2]) / 3;
              paint(a, A, r, g, bl, er, eg, eb);
              if (b !== a) paint(b, A, r, g, bl, er, eg, eb);
              if (c !== a && c !== b) paint(c, A, r, g, bl, er, eg, eb);
            }
            if (a === b || b === c || a === c) continue;
            let s0 = a, s1 = b, s2 = c, w;
            if (s0 > s1) { w = s0; s0 = s1; s1 = w; } if (s1 > s2) { w = s1; s1 = s2; s2 = w; } if (s0 > s1) { w = s0; s0 = s1; s1 = w; }
            if (!put(s0, s1, s2)) continue;
            if (++tn * 2 > tcap) grow();
            if ((tri + 1) * 3 > tris.length) { const t2 = new Int32Array(tris.length * 2); t2.set(tris); tris = t2; }
            tris[tri * 3] = a; tris[tri * 3 + 1] = b; tris[tri * 3 + 2] = c; tri++;
          }
        }
      };
      const end = () => {
        const outK = ck.slice(0, n), outS = new Float32Array(n * W), outT = tris.slice(0, tri * 3);
        for (let i = 0; i < n * W; i++) outS[i] = sums[i];
        self.postMessage({ keys: outK, sums: outS, tris: outT }, [outK.buffer, outS.buffer, outT.buffer]);
      };
      return { job, end };
    }
  }
  let wurl = null;
  const workerUrl = () => wurl || (wurl = URL.createObjectURL(new Blob(['(' + workerMain.toString() + ')(self);'], { type: 'text/javascript' })));
  // (each mesh its own message, with a pause for the page between: handing a mesh over copies it,
  // and the scenery is tens of millions of vertices)
  function runJobs(jobs, cell, onDone, pause) {
    return new Promise((res, rej) => {
      let w;
      try { w = new Worker(workerUrl()); } catch (e) { rej(e); return; }
      w.onmessage = e => { w.terminate(); if (onDone) onDone(); res(e.data); };
      w.onerror = e => { w.terminate(); rej(e); };
      w.postMessage({ type: 'start', cell });
      (async () => {
        for (const job of jobs) { w.postMessage({ type: 'job', job: job.make ? job.make() : job }); await pause(); }
        w.postMessage({ type: 'end' });
      })().catch(rej);
    });
  }
  // a pause for the page once a slice of main-thread work has run on long enough
  function pacer(ms) {
    let t = performance.now();
    return async () => { if (performance.now() - t < ms) return; await new Promise(r => setTimeout(r, 0)); t = performance.now(); };
  }

  // ---------- a texture's average colour, on the GPU ----------
  let avgRig = null;
  function texAverage(renderer, tex) {
    if (!avgRig) {
      const m = new THREE.ShaderMaterial({
        uniforms: { t: { value: null } }, depthTest: false, depthWrite: false,
        vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: 'uniform sampler2D t; void main() { vec4 s = vec4(0.0); for (int i = 0; i < 16; i++) for (int j = 0; j < 16; j++) s += texture2D(t, (vec2(i, j) + 0.5) / 16.0); gl_FragColor = s / 256.0; }',
      });
      const sc = new THREE.Scene(), q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m); q.frustumCulled = false; sc.add(q);
      avgRig = { m, sc, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), rt: new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType }), buf: new Float32Array(4), cache: new WeakMap() };
    }
    if (avgRig.cache.has(tex)) return avgRig.cache.get(tex);
    let out = [1, 1, 1, 1];
    try {
      avgRig.m.uniforms.t.value = tex;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(avgRig.rt); renderer.render(avgRig.sc, avgRig.cam); renderer.setRenderTarget(prev);
      renderer.readRenderTargetPixels(avgRig.rt, 0, 0, 1, 1, avgRig.buf);
      out = [avgRig.buf[0], avgRig.buf[1], avgRig.buf[2], avgRig.buf[3]];
      if (!(out[0] >= 0) || out.some(v => !isFinite(v))) out = [1, 1, 1, 1];
    } catch (e) { /* unreadable: plain white */ }
    avgRig.cache.set(tex, out);
    return out;
  }
  // a material's colour and glow (linear), or null to leave its mesh out
  function surfaceOf(renderer, mt, instanced) {
    if (!mt || mt.visible === false || mt.transparent || mt.colorWrite === false) return null;
    let col = [0.3, 0.3, 0.3], alpha = 1;
    if (mt.color && mt.color.isColor) col = [mt.color.r, mt.color.g, mt.color.b];
    else if (mt.uniforms && mt.uniforms.diffuse && mt.uniforms.diffuse.value && mt.uniforms.diffuse.value.isColor) { const c = mt.uniforms.diffuse.value; col = [c.r, c.g, c.b]; }
    else if (mt.isShaderMaterial) col = [0.09, 0.09, 0.09]; // (the road and its kin: dark asphalt grey)
    const map = mt.map || (mt.uniforms && mt.uniforms.map && mt.uniforms.map.value);
    if (map && map.isTexture) { const a = texAverage(renderer, map); col = [col[0] * a[0], col[1] * a[1], col[2] * a[2]]; alpha = a[3]; }
    // cut-outs: dense ones (foliage) stay as blobs; sparse ones (fences, nets) would become walls
    if ((mt.alphaTest > 0 || mt.alphaToCoverage) && !instanced && alpha < 0.55) return null;
    let em = [0, 0, 0];
    if (mt.emissive && mt.emissive.isColor) {
      const k = mt.emissiveIntensity != null ? mt.emissiveIntensity : 1;
      em = [mt.emissive.r * k, mt.emissive.g * k, mt.emissive.b * k];
      if (mt.emissiveMap) { const a = texAverage(renderer, mt.emissiveMap); em = [em[0] * a[0], em[1] * a[1], em[2] * a[2]]; }
    }
    return { col, em, glow: em[0] + em[1] + em[2] > 0.5 };
  }
  const posArray = A => {
    if (!A) return null;
    if (!A.isInterleavedBufferAttribute && A.array instanceof Float32Array && A.itemSize === 3 && !A.normalized) return A.array;
    const n = A.count, o = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { o[i * 3] = A.getX(i); o[i * 3 + 1] = A.getY(i); o[i * 3 + 2] = A.getZ(i); }
    return o;
  };
  const colArray = A => {
    if (!A) return null;
    const n = A.count, o = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { o[i * 3] = A.getX(i); o[i * 3 + 1] = A.getY(i); o[i * 3 + 2] = A.getZ(i); }
    return o;
  };

  // ---------- building ----------
  // root: the circuit's scenery; skip(o): objects to leave out (the grass); onProgress(0..1)
  // near(x, z): whether a point is close enough to the circuit to show in a reflection
  async function build(renderer, root, cell, skip, onProgress, near) {
    const t0 = performance.now(), pause = pacer(8);
    root.updateMatrixWorld(true);
    const coarse = [], fine = [];
    let verts = 0;
    const meshes = [];
    root.traverse(o => { if (o.isMesh && o.geometry && !(skip && skip(o))) meshes.push(o); });
    for (const o of meshes) {
      await pause();
      // (in the scene as drawn: layer 0, and not hidden for good; the far scenery that hides by
      // distance is hidden only for now)
      if (!o.layers.isEnabled(0)) continue;
      let p = o, gone = false;
      for (; p && p !== root; p = p.parent) if (p.visible === false && !p.userData.far) { gone = true; break; }
      if (gone && !o.userData.far) continue;
      const g = o.geometry, PA = g.attributes.position;
      if (!PA || PA.count < 3) continue;
      if (g.isInstancedBufferGeometry) {
        // trees (js/r3-trees.js: a card per tree, placed by tPos = x, ground, z, height): each a
        // crown of its leaves' colour, a double pyramid over the trunk's height. Other geometry
        // placed by attributes of its own is left out.
        const tp = g.attributes.tPos, mt = Array.isArray(o.material) ? o.material[0] : o.material;
        if (!tp || !mt) continue;
        const a = mt.map ? texAverage(renderer, mt.map) : [0.1, 0.14, 0.06, 1], k = a[3] > 0.05 ? 1 / a[3] : 1;
        const col = [Math.min(1, a[0] * k), Math.min(1, a[1] * k), Math.min(1, a[2] * k)], nT = Math.min(tp.count, g.instanceCount || tp.count);
        const job = { size: nT * 6, make: () => {
          const P = new Float32Array(nT * 18), I = new Uint32Array(nT * 24);
          for (let t = 0; t < nT; t++) {
            const x = tp.getX(t), y = tp.getY(t), z = tp.getZ(t), h = tp.getW(t), r = h * 0.32, cy = y + h * 0.62, o6 = t * 6;
            const V = [[x, cy + h * 0.38, z], [x, y + h * 0.25, z], [x + r, cy, z], [x - r, cy, z], [x, cy, z + r], [x, cy, z - r]];
            V.forEach((v, j) => P.set(v, (o6 + j) * 3));
            [[0, 2, 4], [0, 4, 3], [0, 3, 5], [0, 5, 2], [1, 4, 2], [1, 3, 4], [1, 5, 3], [1, 2, 5]].forEach((f, j) => I.set([o6 + f[0], o6 + f[1], o6 + f[2]], t * 24 + j * 3));
          }
          return { pos: P, idx: I, m: Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1), col, em: [0, 0, 0], vcol: null, vstride: 3, range: null };
        } };
        verts += job.size; coarse.push(job);
        continue;
      }
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const groups = Array.isArray(o.material) && g.groups.length ? g.groups : [{ start: g.drawRange.start, count: g.drawRange.count, materialIndex: 0 }];
      const idx = g.index ? g.index.array : null;
      for (const gr of groups) {
        const s = surfaceOf(renderer, mats[gr.materialIndex || 0], !!o.isInstancedMesh);
        if (!s) continue;
        // (the arrays are gathered as each mesh goes to its worker, not all at once)
        const mt = mats[gr.materialIndex || 0], range = [gr.start || 0, isFinite(gr.count) ? gr.count : Infinity];
        const job = { size: PA.count * (o.isInstancedMesh ? o.count : 1), make: () => {
          const J = { pos: posArray(PA), idx, m: Float64Array.from(o.matrixWorld.elements), col: s.col, em: s.em,
            vcol: mt.vertexColors && g.attributes.color ? colArray(g.attributes.color) : null, vstride: 3, range };
          if (o.isInstancedMesh) {
            J.inst = Float64Array.from(o.instanceMatrix.array.subarray(0, o.count * 16));
            if (o.instanceColor) J.icol = Float32Array.from(o.instanceColor.array.subarray(0, o.count * 3));
          }
          return J;
        } };
        verts += job.size;
        (s.glow ? fine : coarse).push(job);
      }
    }
    if (onProgress) onProgress(0.1);
    // shared out by size over the workers (each its own grid of the same cells; merged below)
    const N = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
    const bins = Array.from({ length: N }, () => ({ jobs: [], n: 0 }));
    const size = j => j.size;
    coarse.sort((a, b) => size(b) - size(a));
    for (const j of coarse) { const b = bins.reduce((x, y) => (y.n < x.n ? y : x)); b.jobs.push(j); b.n += size(j); }
    let done = 0;
    const total = bins.filter(b => b.jobs.length).length + (fine.length ? 1 : 0);
    const tick = () => { done++; if (onProgress) onProgress(0.1 + 0.75 * done / Math.max(1, total)); };
    const parts = await Promise.all(bins.filter(b => b.jobs.length).map(b => runJobs(b.jobs, cell, tick, pause)).concat(fine.length ? [runJobs(fine, 0.15, tick, pause).then(r => Object.assign(r, { fine: true }))] : []));
    // merge: the same cell from two workers becomes one vertex (the fine grid's cells stay apart)
    const ids = new Map();
    let n = 0;
    for (const r of parts) n += r.keys.length;
    const SW = 11, S = new Float64Array(n * SW);
    const remaps = [];
    for (const r of parts) {
      const map = new Int32Array(r.keys.length);
      for (let i = 0; i < r.keys.length; i++) {
        if ((i & 16383) === 0) await pause();
        let gid = r.fine ? undefined : ids.get(r.keys[i]);
        if (gid === undefined) { gid = ids.size; ids.set(r.fine ? 'f' + i : r.keys[i], gid); }
        map[i] = gid;
        for (let k = 0; k < SW; k++) S[gid * SW + k] += r.sums[i * SW + k];
      }
      remaps.push(map);
    }
    const V = ids.size, pos = new Float32Array(V * 3), col = new Float32Array(V * 3), em = new Float32Array(V * 3);
    for (let i = 0; i < V; i++) {
      const o = i * SW, c = S[o + 3] || 1, A = S[o + 10];
      for (let k = 0; k < 3; k++) { pos[i * 3 + k] = S[o + k] / c; col[i * 3 + k] = A > 0 ? S[o + 4 + k] / A : 0.3; em[i * 3 + k] = A > 0 ? S[o + 7 + k] / A : 0; }
    }
    let T = 0;
    for (const r of parts) T += r.tris.length / 3;
    const tri = new Uint32Array(T * 3);
    let t = 0;
    parts.forEach((r, k) => { const mp = remaps[k], R = r.tris; for (let i = 0; i < R.length; i++) tri[t++] = mp[R[i]]; });
    if (onProgress) onProgress(0.9);
    const out = await tiles(pos, col, em, tri, near, pause);
    let kept = 0; for (const t of out.tiles) kept += t.idx.length / 3;
    out.stats = { srcVerts: verts, verts: V, tris: kept, ms: Math.round(performance.now() - t0), tiles: out.tiles.length, cell };
    if (onProgress) onProgress(1);
    return out;
  }
  // cut into tiles by triangle centre, each tile its own small indexed mesh, with smooth normals
  async function tiles(pos, col, em, tri, near, pause) {
    const by = new Map(), T = tri.length / 3;
    for (let t = 0; t < T; t++) {
      if ((t & 16383) === 0) await pause();
      const a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2];
      const x = (pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3, z = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3;
      if (near && !near(x, z)) continue; // (the backdrop, terrain and sea far off: the fog and the sky have them)
      const key = Math.floor(x / TILE) * 100000 + Math.floor(z / TILE);
      let L = by.get(key);
      if (!L) by.set(key, (L = []));
      L.push(t);
    }
    const out = [];
    for (const L of by.values()) {
      await pause();
      const map = new Map(), P = [], C = [], E = [], I = new Uint32Array(L.length * 3);
      let k = 0;
      for (const t of L) for (let j = 0; j < 3; j++) {
        const v = tri[t * 3 + j];
        let w = map.get(v);
        if (w === undefined) { w = map.size; map.set(v, w); P.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); C.push(col[v * 3], col[v * 3 + 1], col[v * 3 + 2]); E.push(em[v * 3], em[v * 3 + 1], em[v * 3 + 2]); }
        I[k++] = w;
      }
      out.push({ pos: new Float32Array(P), col: new Float32Array(C), em: new Float32Array(E), idx: I });
    }
    return { v: VERSION, tiles: out };
  }

  // ---------- the browser's storage ----------
  const DB = 'slip-reflect', STORE = 'copies';
  function db() {
    return new Promise((res, rej) => {
      let q;
      try { q = indexedDB.open(DB, 1); } catch (e) { rej(e); return; }
      q.onupgradeneeded = () => q.result.createObjectStore(STORE);
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  }
  // A copy is some 20 MB of arrays. Written as one record it was copied whole on the page's own
  // thread at the moment the race began (up to 0.8 s of stall the first time a circuit loaded). So
  // it is kept as a small header and one record per tile, and the tiles are written one at a time
  // with a pause between: a few milliseconds each, spread over the race's first seconds.
  async function load(key) {
    try {
      const d = await db();
      const get = k => new Promise(res => { const q = d.transaction(STORE).objectStore(STORE).get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); });
      const head = await get(key);
      if (!head || head.v !== VERSION || !(head.n > 0)) return null;
      const tiles = await Promise.all(Array.from({ length: head.n }, (_, i) => get(key + '#' + i)));
      if (tiles.some(t => !t)) return null; // (a save that was cut short: built again)
      return { v: head.v, stats: head.stats, tiles };
    } catch (e) { return null; }
  }
  async function save(key, data) {
    try {
      const d = await db(), track = key.split('|')[0];
      const run = fn => new Promise(res => { const tx = d.transaction(STORE, 'readwrite'); fn(tx.objectStore(STORE)); tx.oncomplete = res; tx.onerror = res; tx.onabort = res; });
      const wait = ms => new Promise(r => setTimeout(r, ms));
      // (one copy per circuit: an older build's, or another level's, goes first)
      await run(st => { const c = st.openKeyCursor(); c.onsuccess = () => { const cur = c.result; if (!cur) return; const k = String(cur.key); if (k.split('|')[0] === track) st.delete(cur.key); cur.continue(); }; });
      for (let i = 0; i < data.tiles.length; i++) { await run(st => st.put(data.tiles[i], key + '#' + i)); await wait(120); }
      // (the header last: a copy without it is not there)
      await run(st => st.put({ v: data.v, n: data.tiles.length, stats: data.stats || null }, key));
    } catch (e) { /* no storage: built again next time */ }
  }

  // ---------- drawing it ----------
  // one material for every tile: lit like the scenery (see the top), drawn with both faces
  function material(defs) {
    const R3S = F1.R3S && F1.R3S.U;
    const U = {
      uEnv: { value: null }, uEnvK: { value: 1 }, uSunDir: R3S ? R3S.uSunDir : { value: new THREE.Vector3(0, 1, 0) }, uSunCol: R3S ? R3S.uSunCol : { value: new THREE.Color(1, 1, 1) },
      uSky: { value: new THREE.Color() }, uGround: { value: new THREE.Color() }, uFogCol: { value: new THREE.Color() }, uFogD: { value: 0 },
      uSh: { value: [null, null, null] }, uShM: { value: [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()] }, uShOn: { value: 0 },
    };
    return new THREE.ShaderMaterial({
      uniforms: U, side: THREE.DoubleSide, defines: defs,
      vertexShader: [
        'attribute vec3 color; attribute vec3 aEm; varying vec3 vCol; varying vec3 vEm; varying vec3 vW; varying vec3 vN;',
        'void main() { vCol = color; vEm = aEm; vW = position; vN = normal; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }',
      ].join('\n'),
      fragmentShader: [
        '#define ENVMAP_TYPE_CUBE_UV',
        'uniform sampler2D uEnv; uniform float uEnvK; uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uSky; uniform vec3 uGround;',
        'uniform vec3 uFogCol; uniform float uFogD; uniform sampler2D uSh[3]; uniform mat4 uShM[3]; uniform int uShOn;',
        'varying vec3 vCol; varying vec3 vEm; varying vec3 vW; varying vec3 vN;',
        '#include <common>', '#include <packing>',
        THREE.ShaderChunk.cube_uv_reflection_fragment.replace('#ifdef ENVMAP_TYPE_CUBE_UV', '#if 1'),
        // the sun's shadow, from the nearest of the real shadow maps that covers this point
        'float shadowAt(sampler2D m, mat4 M, vec3 p, out bool inside) {',
        '  vec4 c = M * vec4(p, 1.0); c.xyz /= c.w; inside = all(greaterThan(c.xy, vec2(0.0))) && all(lessThan(c.xy, vec2(1.0))) && c.z < 1.0;',
        '  return inside ? step(c.z - 0.003, unpackRGBAToDepth(texture2D(m, c.xy))) : 1.0; }',
        'void main() {',
        '  vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);',
        '  float ndl = max(dot(n, normalize(uSunDir)), 0.0), vis = 1.0; bool inside = false;',
        '  if (uShOn > 0 && ndl > 0.0) { vec3 p = vW + n * 0.4;',
        '    vis = shadowAt(uSh[0], uShM[0], p, inside);',
        '    if (!inside) vis = shadowAt(uSh[1], uShM[1], p, inside);',
        '    if (!inside) vis = shadowAt(uSh[2], uShM[2], p, inside); }',
        '  vec3 amb = textureCubeUV(uEnv, n, 1.0).rgb * uEnvK + mix(uGround, uSky, n.y * 0.5 + 0.5) * RECIPROCAL_PI;',
        '  vec3 c = vCol * (amb + uSunCol * ndl * vis * RECIPROCAL_PI) + vEm;',
        '  float d = length(vW - cameraPosition), f = exp(-uFogD * uFogD * d * d);',
        '  gl_FragColor = vec4(mix(uFogCol, c, f), 1.0);',
        '}',
      ].join('\n'),
    });
  }
  // the meshes for a built copy (a scene of their own, no lights: the material does the lighting)
  function meshes(data, mat) {
    const sc = new THREE.Scene();
    sc.matrixAutoUpdate = false; sc.matrixWorldAutoUpdate = true;
    for (const t of data.tiles) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(t.pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(t.col, 3));
      g.setAttribute('aEm', new THREE.BufferAttribute(t.em, 3));
      g.setIndex(new THREE.BufferAttribute(t.idx, 1));
      g.computeVertexNormals(); g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mat);
      m.matrixAutoUpdate = false;
      sc.add(m);
    }
    return sc;
  }

  F1.R3Reflect = { build, load, save, material, meshes, VERSION, surfaceOf };
})();
