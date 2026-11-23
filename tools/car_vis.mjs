// which triangles are ever seen from outside: an id buffer drawn in software from many directions
export function dirs(n = 150, yMin = -0.5) { const o = []; for (let i = 0; i < n; i++) { const y = 1 - 2 * (i + 0.5) / n; if (y < yMin) continue; const r = Math.sqrt(1 - y * y), a = i * 2.399963229728653; o.push([r * Math.cos(a), y, r * Math.sin(a)]); } return o; }
export function visible(list, { px = 0.004, n = 150, yMin = -0.5, eps = 0.004, share = 0 } = {}) {
  const b = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
  for (const { G } of list) for (let i = 0; i < G.pos.length; i++) { const j = i % 3; b[j] = Math.min(b[j], G.pos[i]); b[j + 3] = Math.max(b[j + 3], G.pos[i]); }
  const c = [0, 1, 2].map(j => (b[j] + b[j + 3]) / 2), R = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2;
  const N = Math.ceil(2 * R / px), Z = new Float32Array(N * N), ID = new Int32Array(N * N);
  const seen = list.map(({ G }) => new Uint8Array(G.idx.length / 3)), base = []; let tot = 0; for (const { G } of list) { base.push(tot); tot += G.idx.length / 3; }
  const all = new Uint8Array(tot), hitN = new Uint32Array(tot), covN = new Uint32Array(tot), D = dirs(n, yMin);
  const proj = list.map(({ G }) => new Float32Array(G.pos.length));
  for (const d of D) {
    const up = Math.abs(d[1]) > 0.98 ? [1, 0, 0] : [0, 1, 0];
    let u = [up[1] * d[2] - up[2] * d[1], up[2] * d[0] - up[0] * d[2], up[0] * d[1] - up[1] * d[0]]; const l = Math.hypot(...u); u = u.map(x => x / l);
    const v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
    Z.fill(-1e9); ID.fill(-1);
    list.forEach(({ G }, k) => { const P = G.pos, Q = proj[k]; for (let i = 0; i < P.length; i += 3) { const x = P[i] - c[0], y = P[i + 1] - c[1], z = P[i + 2] - c[2]; Q[i] = (x * u[0] + y * u[1] + z * u[2] + R) / px; Q[i + 1] = (x * v[0] + y * v[1] + z * v[2] + R) / px; Q[i + 2] = x * d[0] + y * d[1] + z * d[2]; } });
    const draw = (k, mode) => {
      const { G } = list[k], Q = proj[k], I = G.idx;
      for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, e = I[t + 1] * 3, f = I[t + 2] * 3;
        const ax = Q[a], ay = Q[a + 1], bx = Q[e], by = Q[e + 1], cx = Q[f], cy = Q[f + 1];
        const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay), id = base[k] + t / 3;
        if (mode && all[id] && !share) continue;
        const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5)), x1 = Math.min(N - 1, Math.floor(Math.max(ax, bx, cx) - 0.5)), y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5)), y1 = Math.min(N - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
        if (Math.abs(det) < 1e-9) continue;
        const inv = 1 / det;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const pxx = x + 0.5 - ax, pyy = y + 0.5 - ay;
          const w1 = (pxx * (cy - ay) - (cx - ax) * pyy) * inv, w2 = ((bx - ax) * pyy - pxx * (by - ay)) * inv;
          if (w1 < 0 || w2 < 0 || w1 + w2 > 1) continue;
          const z = Q[a + 2] + w1 * (Q[e + 2] - Q[a + 2]) + w2 * (Q[f + 2] - Q[a + 2]), q = y * N + x;
          if (mode) { covN[id]++; if (z > Z[q] - eps) { hitN[id]++; all[id] = 1; } }
          else if (z > Z[q]) { Z[q] = z; }
        }
      }
    };
    // depth first (opaque surfaces only), then every triangle not seen yet against it, small ones by their middle too
    list.forEach((o, k) => { if (o.occ) draw(k, 0); });
    list.forEach((o, k) => draw(k, 1));
  }
  if (share) for (let i = 0; i < tot; i++) all[i] = covN[i] ? (hitN[i] >= covN[i] * share ? 1 : 0) : 0;
  list.forEach(({ G }, k) => { seen[k].set(all.subarray(base[k], base[k] + G.idx.length / 3)); });
  // one ring more: a triangle touching a seen one stays (slivers a pixel grid can miss)
  const pk = new Map(), key = (G, i) => Math.round(G.pos[i * 3] * 4000) + '|' + Math.round(G.pos[i * 3 + 1] * 4000) + '|' + Math.round(G.pos[i * 3 + 2] * 4000);
  list.forEach(({ G }, k) => { for (let t = 0; t < G.idx.length; t += 3) if (seen[k][t / 3]) for (let j = 0; j < 3; j++) pk.set(key(G, G.idx[t + j]), 1); });
  return list.map(({ G }, k) => { const o = seen[k].slice(); for (let t = 0; t < G.idx.length; t += 3) if (!o[t / 3]) { let h = 0; for (let j = 0; j < 3; j++) if (pk.has(key(G, G.idx[t + j]))) h++; if (h >= (share ? 3 : 2)) o[t / 3] = 1; } return o; });
}
// every kept triangle in one vertex buffer (positions snapped so surfaces that meet stay joined), one range of vertices per surface
export function join(list, keep, grid = 0.0004) {
  const pos = [], attr = [], src = [], idx = [], uv = [];
  const mpu = list.map(G => {
    // metres the surface covers per unit of its texture (the livery's own scale), so a slide of the texture is an error in metres
    let a3 = 0, a2 = 0;
    for (let t = 0; t < G.idx.length; t += 3) { const [a, b, c] = [G.idx[t], G.idx[t + 1], G.idx[t + 2]], P = G.pos, U = G.uv, e = (i, j) => [0, 1, 2].map(q => P[i * 3 + q] - P[j * 3 + q]), u = e(b, a), w = e(c, a); a3 += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]); a2 += Math.abs((U[b * 2] - U[a * 2]) * (U[c * 2 + 1] - U[a * 2 + 1]) - (U[c * 2] - U[a * 2]) * (U[b * 2 + 1] - U[a * 2 + 1])); }
    const m = a2 > 1e-9 ? Math.sqrt(a3 / a2) : 0;
    return m < 0.4 ? m * 0.05 : m; // (a tiled weave may slide)
  });
  list.forEach((G, k) => {
    const map = new Map();
    for (let t = 0; t < G.idx.length; t += 3) if (!keep || keep[k][t / 3]) {
      const tri = [];
      for (let j = 0; j < 3; j++) {
        const i = G.idx[t + j], p = [0, 1, 2].map(c => Math.round(G.pos[i * 3 + c] / grid)), q = p.join() + '|' + [0, 1, 2].map(c => Math.round(G.nor[i * 3 + c] * 100)).join() + '|' + Math.round(G.uv[i * 2] * 8192) + ',' + Math.round(G.uv[i * 2 + 1] * 8192);
        let v = map.get(q);
        if (v === undefined) { v = pos.length / 3; map.set(q, v); pos.push(p[0] * grid, p[1] * grid, p[2] * grid); attr.push(G.nor[i * 3], G.nor[i * 3 + 1], G.nor[i * 3 + 2], G.uv[i * 2] * mpu[k], G.uv[i * 2 + 1] * mpu[k]); src.push(k); uv.push(G.uv[i * 2], G.uv[i * 2 + 1]); }
        tri.push(v);
      }
      if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) idx.push(...tri);
    }
  });
  return { mpu, uv: Float32Array.from(uv), pos: Float32Array.from(pos), attr: Float32Array.from(attr), src: Int32Array.from(src), idx: Uint32Array.from(idx) };
}
