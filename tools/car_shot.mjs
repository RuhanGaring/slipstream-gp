// software render of a .car level, textured, no GPU: node shot.mjs out.png size rowspec... rowspec = file:level
import os from 'node:os'; os.setPriority(19);
import fs from 'node:fs'; import sharp from 'sharp'; import path from 'node:path';
const [out, sizeS, upS, azS, elS, ...specs] = process.argv.slice(2), size = +sizeS, up = +upS, els = elS.split(',').map(Number), azs = azS.split(',').map(Number);
const texC = new Map();
async function tex(dir, f) { if (!texC.has(f)) { const { data, info } = await sharp(path.join(dir, 'tex', f)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const lv = [{ w: info.width, h: info.height, d: data }]; while (lv[lv.length - 1].w > 4) { const p = lv[lv.length - 1], w = p.w >> 1, h = Math.max(1, p.h >> 1), d = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) d[(y * w + x) * 4 + c] = (p.d[(2 * y * p.w + 2 * x) * 4 + c] + p.d[(2 * y * p.w + 2 * x + 1) * 4 + c] + p.d[((2 * y + 1) * p.w + 2 * x) * 4 + c] + p.d[((2 * y + 1) * p.w + 2 * x + 1) * 4 + c]) >> 2; lv.push({ w, h, d }); }
  texC.set(f, lv); } return texC.get(f); }
async function load(file, level) {
  const b = fs.readFileSync(file), n = b.readUInt32LE(4), meta = JSON.parse(b.slice(8, 8 + n)), off = 8 + n + ((4 - ((8 + n) % 4)) % 4), bin = b.buffer.slice(b.byteOffset + off, b.byteOffset + b.length);
  const dq = (q, k) => { const u = new Uint16Array(bin, q[0], q[1]), f = new Float32Array(q[1]); for (let i = 0; i < f.length; i++) f[i] = q[2][i % k] + u[i] * q[3][i % k]; return f; };
  const geo = g => ({ m: meta.mats[g.m], pos: dq(g.pos, 3), nor: Float32Array.from(new Int8Array(bin, g.nor[0], g.nor[1]), x => x / 127), uv: dq(g.uv, 2), idx: g.idx[0] === 'u32' ? new Uint32Array(bin, g.idx[1], g.idx[2]) : new Uint16Array(bin, g.idx[1], g.idx[2]) });
  const L = level === 2 ? meta.farL : meta.lods[level], parts = L.body.map(geo);
  for (const W of Object.values(L.wheels)) for (const [arr, spin] of [[W.parts, 1], [W.hub, 0]]) for (const g0 of arr) { const g = geo(g0), q = W.q; for (let i = 0; i < g.pos.length; i += 3) { let v = [g.pos[i], g.pos[i + 1], g.pos[i + 2]]; if (spin) { const [x, y, z, w] = q, tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]); v = [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx]; } for (let j = 0; j < 3; j++) g.pos[i + j] = v[j] + W.c[j]; } parts.push(g); }
  let tris = 0; for (const p of parts) { tris += p.idx.length / 3; p.tex = p.m.map >= 0 ? await tex(path.dirname(file), meta.tex[p.m.map]) : null; }
  return { parts, tris };
}
const SS = 3;
function render(car, az, el, size) {
  const N = size * SS, H = Math.round(size * 0.5) * SS, img = new Float32Array(N * H * 3), Z = new Float32Array(N * H).fill(-1e9); for (let i = 0; i < N * H; i++) { img[i * 3] = 0.33; img[i * 3 + 1] = 0.36; img[i * 3 + 2] = 0.34; }
  const ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el), d = [ce * ca, se, ce * sa], u = [-sa, 0, ca].map(x => -x), v = [-se * ca, ce, -se * sa], sc = N / 6.4, sun = [0.35, 0.8, 0.48];
  for (const blend of [0, 1]) for (const p of car.parts) {
    if ((p.m.a === 'B') !== !!blend) continue;
    const P = p.pos, I = p.idx, T = p.tex, c = p.m.c;
    for (let t = 0; t < I.length; t += 3) {
      const q = [0, 1, 2].map(j => { const i = I[t + j] * 3, x = P[i] - 0.1, y = P[i + 1] - 0.45, z = P[i + 2]; return [(x * u[0] + z * u[2]) * sc + N / 2, H / 2 - (x * v[0] + y * v[1] + z * v[2]) * sc, x * d[0] + y * d[1] + z * d[2]]; });
      const [A, B, C] = q, det = (B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1]); if (Math.abs(det) < 1e-9) continue;
      const ua = I[t] * 2, ub = I[t + 1] * 2, uc = I[t + 2] * 2, na = I[t] * 3, nb = I[t + 1] * 3, nc = I[t + 2] * 3, U = p.uv, Nn = p.nor;
      let lv = null; if (T) { const ta = Math.abs((U[ub] - U[ua]) * (U[uc + 1] - U[ua + 1]) - (U[uc] - U[ua]) * (U[ub + 1] - U[ua + 1])) * T[0].w * T[0].h; lv = T[Math.max(0, Math.min(T.length - 1, Math.round(0.5 * Math.log2(Math.max(1e-6, ta / Math.abs(det))))))]; }
      const x0 = Math.max(0, Math.ceil(Math.min(A[0], B[0], C[0]) - 0.5)), x1 = Math.min(N - 1, Math.floor(Math.max(A[0], B[0], C[0]) - 0.5)), y0 = Math.max(0, Math.ceil(Math.min(A[1], B[1], C[1]) - 0.5)), y1 = Math.min(H - 1, Math.floor(Math.max(A[1], B[1], C[1]) - 0.5));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5 - A[0], py = y + 0.5 - A[1], w1 = (px * (C[1] - A[1]) - (C[0] - A[0]) * py) / det, w2 = ((B[0] - A[0]) * py - px * (B[1] - A[1])) / det; if (w1 < 0 || w2 < 0 || w1 + w2 > 1) continue;
        const w0 = 1 - w1 - w2, z = w0 * A[2] + w1 * B[2] + w2 * C[2] + (blend ? 0.006 : 0), o = y * N + x; if (z <= Z[o]) continue;
        let r = c[0], g = c[1], b = c[2], a = c[3];
        if (lv) { const uu = w0 * U[ua] + w1 * U[ub] + w2 * U[uc], vv = w0 * U[ua + 1] + w1 * U[ub + 1] + w2 * U[uc + 1], tx = Math.min(lv.w - 1, Math.floor((uu - Math.floor(uu)) * lv.w)), ty = Math.min(lv.h - 1, Math.floor((vv - Math.floor(vv)) * lv.h)), k = (ty * lv.w + tx) * 4; r *= (lv.d[k] / 255) ** 2.2; g *= (lv.d[k + 1] / 255) ** 2.2; b *= (lv.d[k + 2] / 255) ** 2.2; a *= lv.d[k + 3] / 255; }
        if (p.m.a === 'M' && a < p.m.cut) continue;
        let nx = w0 * Nn[na] + w1 * Nn[nb] + w2 * Nn[nc], ny = w0 * Nn[na + 1] + w1 * Nn[nb + 1] + w2 * Nn[nc + 1], nz = w0 * Nn[na + 2] + w1 * Nn[nb + 2] + w2 * Nn[nc + 2]; const l = Math.hypot(nx, ny, nz) || 1; let s = (nx * d[0] + ny * d[1] + nz * d[2]) < 0 ? -1 / l : 1 / l; nx *= s; ny *= s; nz *= s;
        const sh = 0.35 + 0.25 * ny + 0.75 * Math.max(0, nx * sun[0] + ny * sun[1] + nz * sun[2]); const col = [r * sh, g * sh, b * sh];
        if (blend) { for (let j = 0; j < 3; j++) img[o * 3 + j] = img[o * 3 + j] * (1 - a) + col[j] * a; } else { Z[o] = z; for (let j = 0; j < 3; j++) img[o * 3 + j] = col[j]; }
      }
    }
  }
  const w = size, h = H / SS, o8 = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let j = 0; j < 3; j++) { let s = 0; for (let a = 0; a < SS; a++) for (let b = 0; b < SS; b++) s += Math.min(1, img[((y * SS + a) * N + x * SS + b) * 3 + j]); o8[(y * w + x) * 3 + j] = 255 * (s / SS / SS) ** (1 / 2.2); }
  return { w, h, d: o8 };
}
const views = []; for (const az of azs) for (const el of els) views.push([az * Math.PI / 180, el * Math.PI / 180]);
const rows = []; for (const sp of specs) { const k = sp.lastIndexOf(':'), car = await load(sp.slice(0, k), +sp.slice(k + 1)); rows.push(views.map(([a, e]) => render(car, a, e, size))); console.log(sp, car.tris, rows.length > 1 ? 'mean abs diff vs first row ' + rows[rows.length - 1].map((r, i) => (r.d.reduce((s, x, j) => s + Math.abs(x - rows[0][i].d[j]), 0) / r.d.length).toFixed(2)).join(' ') : ''); }
const { w, h } = rows[0][0], W = w * views.length, Hh = h * rows.length, buf = Buffer.alloc(W * Hh * 3);
rows.forEach((r, j) => r.forEach((im, i) => { for (let y = 0; y < h; y++) for (let x = 0; x < w * 3; x++) buf[((j * h + y) * W + i * w) * 3 + x] = im.d[y * w * 3 + x]; }));
await sharp(buf, { raw: { width: W, height: Hh, channels: 3 } }).resize(W * up, Hh * up, { kernel: 'nearest' }).png().toFile(out);
