// Convert one downloaded 2026 car (GLB from Sketchfab, see CREDITS.md) into the game's car file.
// usage (from a folder with @gltf-transform/core, /extensions, meshoptimizer and sharp installed):
//   node car_prep26.mjs SRC.glb OUT_DIR ID ["Display name"]
// writes OUT_DIR/ID.car (geometry, materials, layout) and OUT_DIR/tex/<hash>.webp (textures,
// shared between cars when the source images are the same). OUT_DIR is assets-src/cars; then
// run tools/car_pack.py to pack them into the script files the game loads.
//
// What is kept: every material of the model with its own textures (paint, decals, carbon,
// tyres, steering wheel), so the cars look as their authors made them. What is changed:
//  - axes and placement: game frame is +X forward, +Y up, +Z right; the car is moved along X
//    so its steering wheel sits where the game's driver reaches for it, and down so the tyres
//    stand on the ground;
//  - the four wheels are split out (tyre, rim, hub, disc) into wheel-local space so they turn
//    and steer; the steering wheel is split out into its own frame so it turns about its axis;
//  - two simplified detail levels plus a one-mesh far level with the textures baked into
//    vertex colours;
//  - the model's race numbers are dropped (the game draws each driver's own number);
//  - textures are resized for the web and re-encoded as WebP.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const [SRC, OUT, ID, NAME] = process.argv.slice(2);
await MeshoptDecoder.ready; await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(SRC);
fs.mkdirSync(path.join(OUT, 'tex'), { recursive: true });

// the game's steering wheel centre (js/r3-car.js WHEEL_C): the car is placed so its own wheel lands there
const WHEEL_X = 0.85;

// ---------- read every primitive into the game frame, grouped by material ----------
// glTF: +Y up, +Z forward, +X left  ->  game: +X forward, +Y up, +Z right
const mats = doc.getRoot().listMaterials();
const groups = new Map(); // material -> { pos, nor, uv, idx }
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh(); if (!mesh) continue;
  const m = node.getWorldMatrix();
  // normal matrix: inverse transpose of the upper 3x3
  const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[3] * (a[1] * a[8] - a[2] * a[7]) + a[6] * (a[1] * a[5] - a[2] * a[4]);
  const inv = [
    (a[4] * a[8] - a[5] * a[7]) / det, (a[2] * a[7] - a[1] * a[8]) / det, (a[1] * a[5] - a[2] * a[4]) / det,
    (a[5] * a[6] - a[3] * a[8]) / det, (a[0] * a[8] - a[2] * a[6]) / det, (a[2] * a[3] - a[0] * a[5]) / det,
    (a[3] * a[7] - a[4] * a[6]) / det, (a[1] * a[6] - a[0] * a[7]) / det, (a[0] * a[4] - a[1] * a[3]) / det];
  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== 4) continue; // triangles only
    const mat = prim.getMaterial();
    const info = mat && (mat.getBaseColorTextureInfo() || mat.getNormalTextureInfo());
    const pa = prim.getAttribute('POSITION'), na = prim.getAttribute('NORMAL'), ta = prim.getAttribute('TEXCOORD_' + (info ? info.getTexCoord() : 0)) || prim.getAttribute('TEXCOORD_0');
    const g = groups.get(mat) || { pos: [], nor: [], uv: [], idx: [] };
    groups.set(mat, g);
    const base = g.pos.length / 3, v = [0, 0, 0], w = [0, 0, 0], t = [0, 0];
    for (let i = 0; i < pa.getCount(); i++) {
      pa.getElement(i, v);
      const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], z = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
      g.pos.push(z, y, -x);
      if (na) {
        na.getElement(i, w);
        // (inverse transpose: rows of the inverse used as columns)
        const nx = inv[0] * w[0] + inv[1] * w[1] + inv[2] * w[2], ny = inv[3] * w[0] + inv[4] * w[1] + inv[5] * w[2], nz = inv[6] * w[0] + inv[7] * w[1] + inv[8] * w[2];
        const l = Math.hypot(nx, ny, nz) || 1;
        g.nor.push(nz / l, ny / l, -nx / l);
      } else g.nor.push(0, 1, 0);
      if (ta) { ta.getElement(i, t); g.uv.push(t[0], t[1]); } else g.uv.push(0, 0);
    }
    const ix = prim.getIndices();
    if (ix) { const arr = ix.getArray(); for (let i = 0; i < arr.length; i++) g.idx.push(base + arr[i]); }
    else for (let i = 0; i < pa.getCount(); i++) g.idx.push(base + i);
    // a mirroring transform flips the winding
    if (det < 0) for (let i = g.idx.length - (ix ? ix.getCount() : pa.getCount()); i < g.idx.length; i += 3) { const s = g.idx[i + 1]; g.idx[i + 1] = g.idx[i + 2]; g.idx[i + 2] = s; }
  }
}
const mname = mat => (mat ? mat.getName() : '') || '';

// ---------- connected components (by shared index) of a group ----------
function components(g) {
  const n = g.pos.length / 3, par = new Int32Array(n);
  for (let i = 0; i < n; i++) par[i] = i;
  const find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  for (let t = 0; t < g.idx.length; t += 3) {
    const a = find(g.idx[t]), b = find(g.idx[t + 1]), c = find(g.idx[t + 2]);
    par[a] = c; par[b] = c;
  }
  const comps = new Map();
  for (let t = 0; t < g.idx.length; t += 3) {
    const r = find(g.idx[t]);
    let c = comps.get(r);
    if (!c) comps.set(r, c = { tris: [], b: [1e9, 1e9, 1e9, -1e9, -1e9, -1e9] });
    c.tris.push(t);
    for (let k = 0; k < 3; k++) { const i = g.idx[t + k] * 3; for (let j = 0; j < 3; j++) { c.b[j] = Math.min(c.b[j], g.pos[i + j]); c.b[j + 3] = Math.max(c.b[j + 3], g.pos[i + j]); } }
  }
  return [...comps.values()];
}
const inBox = (b, B) => b[0] >= B[0] && b[1] >= B[1] && b[2] >= B[2] && b[3] <= B[3] && b[4] <= B[4] && b[5] <= B[5];

// ---------- the wheels: tyre materials give the four corners ----------
const isTyre = n => /tyre|tire|tread|sidewall/i.test(n);
const isNumber = n => /number/i.test(n);
let tyreTris = [];
for (const [mat, g] of groups) if (isTyre(mname(mat))) tyreTris.push(g);
if (!tyreTris.length) throw new Error('no tyre material found');
// split the tyre triangles into quadrants about the middle of their spread
let tb = [1e9, -1e9];
for (const g of tyreTris) for (let i = 0; i < g.pos.length; i += 3) { tb[0] = Math.min(tb[0], g.pos[i]); tb[1] = Math.max(tb[1], g.pos[i]); }
const midX = (tb[0] + tb[1]) / 2;
const corner = (x, z) => (x > midX ? 'F' : 'R') + (z > 0 ? 'R' : 'L');
const WB = {};
for (const g of tyreTris) for (let t = 0; t < g.idx.length; t += 3) {
  const i = g.idx[t] * 3, key = corner(g.pos[i], g.pos[i + 2]);
  const b = WB[key] || (WB[key] = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9]);
  for (let k = 0; k < 3; k++) { const q = g.idx[t + k] * 3; for (let j = 0; j < 3; j++) { b[j] = Math.min(b[j], g.pos[q + j]); b[j + 3] = Math.max(b[j + 3], g.pos[q + j]); } }
}
const wheels = {};
for (const [k, b] of Object.entries(WB)) {
  const r = (b[4] - b[1]) / 2;
  wheels[k] = { c: [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2], r, w: b[5] - b[2], box: [(b[0] + b[3]) / 2 - r * 1.03, (b[1] + b[4]) / 2 - r * 1.03, b[2] - 0.03, (b[0] + b[3]) / 2 + r * 1.03, (b[1] + b[4]) / 2 + r * 1.03, b[5] + 0.03] };
}
if (Object.keys(wheels).length !== 4) throw new Error('expected four wheels, found ' + Object.keys(wheels));
const groundY = Math.min(...Object.values(WB).map(b => b[1]));

// ---------- the steering wheel: everything round the dash screen ----------
let lcd = null;
for (const [mat, g] of groups) if (/lcd/i.test(mname(mat)) && (!lcd || g.idx.length > lcd.g.idx.length)) lcd = { mat, g };
if (!lcd) throw new Error('no steering wheel screen (lcd) material');
const Lc = [0, 0, 0]; { const p = lcd.g.pos, n = p.length / 3; for (let i = 0; i < p.length; i++) Lc[i % 3] += p[i] / n; }
// the screen faces the driver: its normal is the steering wheel's axis
let zW;
{
  const p = lcd.g.pos, ix = lcd.g.idx; let nx = 0, ny = 0, nz = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const s = cx < 0 ? 1 : -1; // toward the driver (-X)
    nx += cx * s; ny += cy * s; nz += cz * s;
  }
  const l = Math.hypot(nx, ny, nz); zW = [nx / l, ny / l, nz / l];
}
const SWB = [Lc[0] - 0.035, Lc[1] - 0.16, -0.175, Lc[0] + 0.17, Lc[1] + 0.09, 0.175];
const isSwExcluded = n => /glass|cinture|number/i.test(n);
// the wheel's own materials (its body, buttons, lamps, screen, quick release); a part in any other
// material (dash panels, bodywork, the column's mounting behind the wheel) belongs to the wheel
// only if it lies against the wheel's face, or it would turn with the wheel in mid air
const isSwMat = n => /steer|_sw|^sw_|lcd|led|kers|indicator|revs|whitelight|tag_|chrome|black|plastic|button|handle/i.test(n);

// ---------- classify every component: body, a wheel, or the steering wheel ----------
const parts = { body: new Map(), sw: new Map(), FL: new Map(), FR: new Map(), RL: new Map(), RR: new Map() };
const push = (bucket, mat, g, tris) => { const a = bucket.get(mat) || []; bucket.set(mat, a); for (const t of tris) a.push(g.idx[t], g.idx[t + 1], g.idx[t + 2]); };
for (const [mat, g] of groups) {
  const n = mname(mat);
  if (isNumber(n)) continue;
  if (isTyre(n)) {
    // tyres split per corner by triangle
    const by = {};
    for (let t = 0; t < g.idx.length; t += 3) { const i = g.idx[t] * 3; (by[corner(g.pos[i], g.pos[i + 2])] ||= []).push(t); }
    for (const [k, tris] of Object.entries(by)) push(parts[k], mat, g, tris);
    continue;
  }
  for (const c of components(g)) {
    let dest = 'body';
    if (mat === lcd.mat || (!isSwExcluded(n) && inBox(c.b, SWB) && (isSwMat(n) || c.b[3] - Lc[0] < 0.075))) dest = 'sw';
    if (dest === 'sw' && process.env.SWDEBUG) console.log('  sw', n.padEnd(24), String(c.tris.length).padStart(5), 'x', (c.b[0] - Lc[0]).toFixed(3), (c.b[3] - Lc[0]).toFixed(3), 'y', (c.b[1] - Lc[1]).toFixed(3), (c.b[4] - Lc[1]).toFixed(3), 'z', c.b[2].toFixed(3), c.b[5].toFixed(3));
    else for (const [k, W] of Object.entries(wheels)) if (inBox(c.b, W.box)) { dest = k; break; }
    push(parts[dest], mat, g, c.tris);
  }
}

// steering wheel frame: z toward the driver, x across to the right, y up
const SWc = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
for (const [mat, ix] of parts.sw) { const p = groups.get(mat).pos; for (const i of ix) for (let j = 0; j < 3; j++) { SWc[j] = Math.min(SWc[j], p[i * 3 + j]); SWc[j + 3] = Math.max(SWc[j + 3], p[i * 3 + j]); } }
const swC = [(SWc[0] + SWc[3]) / 2, (SWc[1] + SWc[4]) / 2, (SWc[2] + SWc[5]) / 2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a); return a.map(x => x / l); };
const xW = norm(cross([0, 1, 0], zW)), yW = cross(zW, xW);
const toW = (x, y, z) => { const d = [x - swC[0], y - swC[1], z - swC[2]]; return [d[0] * xW[0] + d[1] * xW[1] + d[2] * xW[2], d[0] * yW[0] + d[1] * yW[1] + d[2] * yW[2], d[0] * zW[0] + d[1] * zW[1] + d[2] * zW[2]]; };
const dirW = (x, y, z) => [x * xW[0] + y * xW[1] + z * xW[2], x * yW[0] + y * yW[1] + z * yW[2], x * zW[0] + y * zW[1] + z * zW[2]];

// placement: steering wheel over the game's, tyres on the ground
const DX = WHEEL_X - swC[0], DY = -groundY;

// ---------- textures ----------
const texOut = new Map(); // gltf Texture -> { file, max, normal }
const roleMax = (n, normal) => {
  if (/tyre|tire|tread|sidewall/i.test(n)) return 1024;
  if (normal) return 512;
  if (/paint|decal|detail|chas+is|generic|wheel_hub|_wheel$|steeringwhee|_sw$|_sw\b|sw_decals/i.test(n)) return 2048;
  if (/lcd|cinture/i.test(n)) return 1024;
  return 512;
};
function wantTex(tex, n, normal) {
  if (!tex) return null;
  const e = texOut.get(tex) || { max: 0, normal: false };
  e.max = Math.max(e.max, roleMax(n, normal)); e.normal = e.normal || normal;
  texOut.set(tex, e);
  return tex;
}
const matOut = [];
const matIndex = new Map();
for (const mat of mats) {
  const n = mname(mat);
  const bc = mat.getBaseColorTexture(), nm = mat.getNormalTexture(), em = mat.getEmissiveTexture();
  const spec = mat.getExtension('KHR_materials_specular');
  const o = {
    n, a: mat.getAlphaMode()[0], cut: mat.getAlphaCutoff(), ds: mat.getDoubleSided(),
    c: mat.getBaseColorFactor(), m: mat.getMetallicFactor(), r: mat.getRoughnessFactor(), e: mat.getEmissiveFactor(),
    map: wantTex(bc, n, false), nmap: wantTex(nm, n, true), ns: nm ? mat.getNormalScale() : 1, emap: wantTex(em, n, false),
    spec: spec ? [spec.getSpecularFactor(), ...spec.getSpecularColorFactor()] : null,
  };
  matIndex.set(mat, matOut.length); matOut.push(o);
}
// encode, deduplicated by content across cars
const far = new Map(); // texture -> raw 256x256 RGBA for baking far colours
for (const [tex, e] of texOut) {
  const src = Buffer.from(tex.getImage());
  const hash = crypto.createHash('sha1').update(src).digest('hex').slice(0, 16);
  const meta = await sharp(src).metadata();
  const max = Math.min(e.max, Math.max(meta.width, meta.height));
  let img = sharp(src).resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true });
  const opaque = !meta.hasAlpha || (await sharp(src).stats()).isOpaque;
  if (opaque) img = img.removeAlpha();
  const file = hash + '_' + max + '.webp';
  const fp = path.join(OUT, 'tex', file);
  if (!fs.existsSync(fp)) await img.webp({ quality: e.normal ? 92 : 84, alphaQuality: 90, effort: 5 }).toFile(fp);
  e.file = file; e.alpha = !opaque;
  if (!e.normal) far.set(tex, await sharp(src).resize(256, 256, { fit: 'fill' }).ensureAlpha().raw().toBuffer());
}
const texList = [...texOut.values()].map(e => e.file);
const texIdx = new Map([...texOut.keys()].map((t, i) => [t, i]));
for (const o of matOut) for (const k of ['map', 'nmap', 'emap']) o[k] = o[k] ? texIdx.get(o[k]) : -1;

// ---------- geometry building ----------
function sub(mat, ix, tf) {
  // compact the referenced vertices of a material group into one geometry, transformed
  const g = groups.get(mat), map = new Map(), pos = [], nor = [], uv = [], idx = [];
  for (const i of ix) {
    let j = map.get(i);
    if (j === undefined) {
      j = pos.length / 3; map.set(i, j);
      const [p, nn] = tf(g.pos.slice(i * 3, i * 3 + 3), g.nor.slice(i * 3, i * 3 + 3));
      pos.push(...p); nor.push(...nn); uv.push(g.uv[i * 2], g.uv[i * 2 + 1]);
    }
    idx.push(j);
  }
  return { mat, pos: Float32Array.from(pos), nor: Float32Array.from(nor), uv: Float32Array.from(uv), idx: Uint32Array.from(idx) };
}
// prune: for the far-away levels, small disconnected pieces are dropped once they are below the
// error (the models are built from many small shells, which simplification alone cannot reduce)
MeshoptSimplifier.useExperimentalFeatures = true;
function simplify(G, ratio, err, prune) {
  const tri = G.idx.length / 3;
  if (ratio >= 1 || tri < 64) return G;
  const target = Math.max(prune ? 0 : 36, Math.floor(G.idx.length * ratio / 3) * 3);
  const [out] = MeshoptSimplifier.simplify(G.idx, G.pos, 3, target, err, prune ? ['Prune'] : []);
  if (!out.length) return null;
  return compact(Object.assign({}, G, { idx: out }));
}
function compact(G) {
  const n = G.pos.length / 3, map = new Int32Array(n).fill(-1); let k = 0;
  for (const i of G.idx) if (map[i] < 0) map[i] = k++;
  const pos = new Float32Array(k * 3), nor = new Float32Array(k * 3), uv = new Float32Array(k * 2);
  for (let i = 0; i < n; i++) if (map[i] >= 0) { pos.set(G.pos.subarray(i * 3, i * 3 + 3), map[i] * 3); nor.set(G.nor.subarray(i * 3, i * 3 + 3), map[i] * 3); uv.set(G.uv.subarray(i * 2, i * 2 + 2), map[i] * 2); }
  return Object.assign({}, G, { pos, nor, uv, idx: Uint32Array.from(G.idx, i => map[i]) });
}
const shiftTf = (p, n) => [[p[0] + DX, p[1] + DY, p[2]], n];
const wheelTf = W => (p, n) => [[p[0] - W.c[0], p[1] - W.c[1], p[2] - W.c[2]], n];
const swTf = (p, n) => [toW(p[0], p[1], p[2]), dirW(n[0], n[1], n[2])];

// interior and small cockpit-only parts are left out of the low detail level
const lowSkip = n => /cinture|chrome|black_s|cockpit|kers|led|lcd|indicator|revs|whitelight|tag_|^black$|negro|colordriver|driver_color|_color(\.|$)/i.test(n);

const chunks = []; let off = 0;
function put(arr) { const b = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength); const pad = (4 - (b.length % 4)) % 4; const o = off; chunks.push(b, Buffer.alloc(pad)); off += b.length + pad; return [o, arr.length]; }
// positions and UVs are stored as 16-bit steps across their own range (decoded on load):
// over a 6 m car that is a step of 0.1 mm
function quant(a, k) {
  const lo = new Array(k).fill(1e9), hi = new Array(k).fill(-1e9);
  for (let i = 0; i < a.length; i++) { lo[i % k] = Math.min(lo[i % k], a[i]); hi[i % k] = Math.max(hi[i % k], a[i]); }
  const sc = lo.map((l, j) => (hi[j] - l) / 65535 || 1);
  const q = Uint16Array.from(a, (x, i) => Math.round((x - lo[i % k]) / sc[i % k]));
  return [...put(q), lo, sc];
}
function pack(G, col) {
  const r = { m: matIndex.get(G.mat), pos: quant(G.pos, 3), nor: put(Int8Array.from(G.nor, x => Math.round(Math.max(-1, Math.min(1, x)) * 127))), uv: quant(G.uv, 2) };
  r.idx = G.pos.length / 3 > 65535 ? ['u32', ...put(G.idx)] : ['u16', ...put(Uint16Array.from(G.idx))];
  if (col) r.col = put(col);
  return r;
}
let triCount = [0, 0, 0];
function lod(level) {
  const ratio = level === 0 ? 0.3 : 0.065, err = level === 0 ? 0.0016 : 0.012;
  const body = [];
  for (const [mat, ix] of parts.body) {
    if (level > 0 && lowSkip(mname(mat))) continue;
    const G = simplify(sub(mat, ix, shiftTf), ratio, err, level > 0);
    if (!G) continue;
    triCount[level] += G.idx.length / 3; body.push(pack(G));
  }
  const W = {};
  for (const k of ['FL', 'FR', 'RL', 'RR']) {
    const w = wheels[k], c = [w.c[0] + DX, w.c[1] + DY, w.c[2]];
    const ps = [];
    for (const [mat, ix] of parts[k]) {
      const G = simplify(sub(mat, ix, wheelTf(w)), level === 0 ? 0.45 : 0.1, level === 0 ? 0.001 : 0.008, level > 0);
      if (!G) continue;
      triCount[level] += G.idx.length / 3; ps.push(pack(G));
    }
    W[k] = { c, r: w.r, w: w.w, parts: ps };
  }
  return { body, wheels: W };
}
const lods = [lod(0), lod(1)];

// far level: one mesh, opaque parts only, textures baked into vertex colours (linear)
function sample(mat, u, v) {
  const o = matOut[matIndex.get(mat)], c = o.c;
  let r = c[0], g = c[1], b = c[2];
  const tex = mat.getBaseColorTexture();
  if (tex && far.has(tex)) {
    const raw = far.get(tex), x = ((Math.floor(u * 256) % 256) + 256) % 256, y = ((Math.floor(v * 256) % 256) + 256) % 256, i = (y * 256 + x) * 4;
    const lin = s => { s /= 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    r *= lin(raw[i]); g *= lin(raw[i + 1]); b *= lin(raw[i + 2]);
  }
  return [r, g, b];
}
{
  const pos = [], nor = [], col = [], idx = [];
  const addG = (G, mat, offset) => {
    if (!G) return;
    const base = pos.length / 3;
    for (let i = 0; i < G.pos.length / 3; i++) {
      pos.push(G.pos[i * 3] + offset[0], G.pos[i * 3 + 1] + offset[1], G.pos[i * 3 + 2] + offset[2]);
      nor.push(G.nor[i * 3], G.nor[i * 3 + 1], G.nor[i * 3 + 2]);
      col.push(...sample(mat, G.uv[i * 2], G.uv[i * 2 + 1]));
    }
    for (const i of G.idx) idx.push(base + i);
  };
  for (const [mat, ix] of parts.body) {
    const o = matOut[matIndex.get(mat)];
    if (o.a === 'B' || lowSkip(o.n)) continue;
    addG(simplify(sub(mat, ix, shiftTf), 0.035, 0.03, true), mat, [0, 0, 0]);
  }
  for (const k of ['FL', 'FR', 'RL', 'RR']) {
    const w = wheels[k];
    for (const [mat, ix] of parts[k]) addG(simplify(sub(mat, ix, wheelTf(w)), 0.05, 0.04, true), mat, [w.c[0] + DX, w.c[1] + DY, w.c[2]]);
  }
  const G = { mat: null, pos: Float32Array.from(pos), nor: Float32Array.from(nor), uv: new Float32Array(pos.length / 3 * 2), idx: Uint32Array.from(idx) };
  triCount[2] = idx.length / 3;
  var farG = pack(G, Uint8Array.from(col, x => Math.round(Math.pow(Math.min(1, x), 1 / 2.2) * 255)));
  delete farG.m;
}

// steering wheel: full detail, in its own frame. The screen's UVs are laid out over its face
// so the game can show its live display there.
const swParts = [];
let swTris = 0;
const swV = [1e9, -1e9]; // grip search
for (const [mat, ix] of parts.sw) {
  const G = mat === lcd.mat ? sub(mat, ix, swTf) : simplify(sub(mat, ix, swTf), 0.6, 0.0004);
  if (mat === lcd.mat) {
    let b = [1e9, 1e9, -1e9, -1e9];
    for (let i = 0; i < G.pos.length; i += 3) { b[0] = Math.min(b[0], G.pos[i]); b[1] = Math.min(b[1], G.pos[i + 1]); b[2] = Math.max(b[2], G.pos[i]); b[3] = Math.max(b[3], G.pos[i + 1]); }
    for (let i = 0; i < G.pos.length / 3; i++) { G.uv[i * 2] = (G.pos[i * 3] - b[0]) / (b[2] - b[0]); G.uv[i * 2 + 1] = (G.pos[i * 3 + 1] - b[1]) / (b[3] - b[1]); }
  }
  for (let i = 0; i < G.pos.length; i += 3) if (Math.abs(G.pos[i + 1]) < 0.025) { swV[0] = Math.min(swV[0], G.pos[i]); swV[1] = Math.max(swV[1], G.pos[i]); }
  swTris += G.idx.length / 3;
  swParts.push(pack(G));
}
// the hands close round the outer bars of the grips, a little in from the outermost edge
const gripX = Math.min(-swV[0], swV[1]) - 0.017;

// race-number plate on the nose: the top of the bodywork 1.9 m ahead of the axle line
function noseTop(x) {
  let y = -1;
  for (const [mat, ix] of parts.body) { if (!/paint|decal/i.test(mname(mat))) continue; const g = groups.get(mat); for (const i of ix) { const px = g.pos[i * 3] + DX; if (Math.abs(px - x) < 0.04 && Math.abs(g.pos[i * 3 + 2]) < 0.04) y = Math.max(y, g.pos[i * 3 + 1] + DY); } }
  return y;
}
const nose = { x: 2.4, y: noseTop(2.4), slope: (noseTop(2.5) - noseTop(2.3)) / 0.2 };

const meta = {
  v: 1, id: ID, name: NAME || ID, src: path.basename(SRC),
  mats: matOut, tex: texList, texAlpha: [...texOut.values()].map(e => !!e.alpha),
  sw: { c: [swC[0] + DX, swC[1] + DY, swC[2]], x: xW, y: yW, z: zW, grip: gripX, parts: swParts, lcd: matIndex.get(lcd.mat) },
  nose, lods, far: farG,
};
const json = Buffer.from(JSON.stringify(meta));
const head = Buffer.alloc(8); head.write('SGPC', 0); head.writeUInt32LE(json.length, 4);
const pad = Buffer.alloc((4 - ((8 + json.length) % 4)) % 4, 32);
const bin = Buffer.concat(chunks);
fs.writeFileSync(path.join(OUT, ID + '.car'), Buffer.concat([head, json, pad, bin]));
console.log(ID, 'tris', triCount.map(Math.round), 'sw', swTris, 'grip', gripX.toFixed(3), 'swC', meta.sw.c.map(x => x.toFixed(3)).join(','), 'axis', zW.map(x => x.toFixed(2)).join(','),
  'wheels', Object.entries(lods[0].wheels).map(([k, w]) => k + ' ' + w.c.map(x => x.toFixed(2)).join(',') + ' r' + w.r.toFixed(3)).join(' | '),
  'nose', nose.y.toFixed(3), nose.slope.toFixed(2), 'bin', (bin.length / 1e6).toFixed(2) + 'MB', 'tex', texList.length);
