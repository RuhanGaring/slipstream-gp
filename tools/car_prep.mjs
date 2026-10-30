// Convert the downloaded F1 car glTF into the game's compact embedded format.
// usage (from a folder with @gltf-transform/core, /extensions and meshoptimizer installed):
//   node car_prep.mjs car.glb OUT_JS
// Model: "Aston Martin F1 AMR23 2023" by Redgrund, CC BY 4.0, via Ron2509.github.io
// (textures removed there). See CREDITS.md. Changes made here: rescaled to the game's
// car (x1.5), re-axed, simplified into two LODs, tyres split from rims, sidewall UVs
// generated, and livery zones assigned per vertex so each team can be painted in code.
import fs from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';

await MeshoptDecoder.ready; await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2]);

const S = 1.5, DX = -0.05;
// model: +z forward, +x left, y up  ->  game: +X forward, +Z right, Y up
const P = (x, y, z) => [z * S + DX, y * S, -x * S];
const N = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [z / l, y / l, -x / l]; };

// material ids
const M = { paint: 0, carbon: 1, carbonGloss: 2, tyre: 3, rim: 4, halo: 5, helmet: 6, visor: 7, mirror: 8, interior: 9, nut: 10 };
function classify(name) {
  const n = name;
  if (/^wheel(Bk|Ft)(L|R)_object$/.test(n)) return 'wheel';
  if (/^r[lr]_wheel_part$/.test(n)) return M.nut;
  if (/wheel_part/.test(n)) return M.carbon;
  if (/^floor_main/.test(n)) return M.carbon;
  if (/arm|gearbox_cover/.test(n)) return M.carbon;
  if (n === 'shell_halo005' || n === 'shell_halo006' || n === 'shell_halo007') return M.helmet;
  if (n === 'shell_halo008') return M.visor;
  if (/^shell_halo/.test(n) || n === 'body_object002' || n === 'body_object003') return M.halo;
  if (n === 'mirror_main_body003' || n === 'mirror_main_body006') return M.mirror;
  if (/^mirror_main_body/.test(n)) return M.carbonGloss;
  if (n === 'rear_wing_no_mod015' || n === 'rear_wing_no_mod016') return M.paint;
  if (/^rear_wing/.test(n)) return M.carbonGloss;
  if (/^front_wing_mixer(00[2-4])?$/.test(n)) return M.paint; // endplates
  if (/^front_wing_mixer021$/.test(n)) return M.carbonGloss;
  if (/^front_wing_mixer|^body_object04[34]$/.test(n)) return M.carbon;
  if (n === 'body_object018') return M.interior;
  const k = +(n.match(/^body_object(\d+)$/) || [])[1];
  if (k >= 9 && k <= 16) return M.carbon;   // front wishbones and pushrods
  if (k >= 19 && k <= 42) return M.carbon;  // engine-cover louvres
  if ((k >= 4 && k <= 8) || k === 45 || k === 46) return M.carbon; // nose camera and antennas
  return M.paint;                           // monocoque, sidepods, engine cover, cockpit surround
}

// livery zones for painted parts: 0 base colour, 1 accent, 2 carbon
function zone(p, n) {
  if (p[1] < 0.27 || n[1] < -0.55) return 2;
  if (Math.abs(p[2]) < 0.15 && n[1] > 0.55 && p[0] > -2.0) return 1;              // spine stripe
  if (Math.abs(p[2]) > 0.42 && p[1] > 0.47 && p[1] < 0.58 && Math.abs(n[2]) > 0.45) return 1; // sidepod flank
  if (p[0] > 2.45) return 1;                                                        // nose tip
  return 0;
}

const parts = [];
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh(); if (!mesh) continue;
  const m = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    const pa = prim.getAttribute('POSITION'), na = prim.getAttribute('NORMAL');
    const cnt = pa.getCount(), v = [0, 0, 0], w = [0, 0, 0];
    const pos = new Float32Array(cnt * 3), nor = new Float32Array(cnt * 3);
    for (let i = 0; i < cnt; i++) {
      pa.getElement(i, v);
      const q = P(m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]);
      pos.set(q, i * 3);
      na.getElement(i, w);
      nor.set(N(m[0] * w[0] + m[4] * w[1] + m[8] * w[2], m[1] * w[0] + m[5] * w[1] + m[9] * w[2], m[2] * w[0] + m[6] * w[1] + m[10] * w[2]), i * 3);
    }
    const idx = prim.getIndices() ? Uint32Array.from(prim.getIndices().getArray()) : Uint32Array.from({ length: cnt }, (_, i) => i);
    parts.push({ name: node.getName(), cls: classify(node.getName()), pos, nor, idx });
  }
}

function simplify(p, ratio, err, minTri) {
  const tri = p.idx.length / 3;
  if (ratio >= 1 || tri < minTri) return p;
  const target = Math.max(36, Math.floor(p.idx.length * ratio / 3) * 3);
  const [out] = MeshoptSimplifier.simplify(p.idx, p.pos, 3, target, err, minTri > 200 ? ['LockBorder'] : []);
  return Object.assign({}, p, { idx: out });
}
// compact: keep only referenced vertices
function compact(p) {
  const map = new Int32Array(p.pos.length / 3).fill(-1);
  let n = 0;
  for (const i of p.idx) if (map[i] < 0) map[i] = n++;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  for (let i = 0; i < map.length; i++) if (map[i] >= 0) { pos.set(p.pos.subarray(i * 3, i * 3 + 3), map[i] * 3); nor.set(p.nor.subarray(i * 3, i * 3 + 3), map[i] * 3); }
  return Object.assign({}, p, { pos, nor, idx: Uint32Array.from(p.idx, i => map[i]) });
}

function build(ratioBody, ratioWheel, err, minTri) {
  // groups: body (one mesh per material) and four wheels (tyre + rim + nut, in wheel-local space)
  const out = { body: {}, wheels: {} };
  const add = (bucket, key, p, extra) => {
    const b = bucket[key] || (bucket[key] = { pos: [], nor: [], idx: [], zone: [], uv: [] });
    const base = b.pos.length / 3;
    for (let i = 0; i < p.pos.length / 3; i++) {
      const q = [p.pos[i * 3], p.pos[i * 3 + 1], p.pos[i * 3 + 2]], nn = [p.nor[i * 3], p.nor[i * 3 + 1], p.nor[i * 3 + 2]];
      const local = extra ? [q[0] - extra.c[0], q[1] - extra.c[1], q[2] - extra.c[2]] : q;
      b.pos.push(...local); b.nor.push(...nn);
      if (key === M.paint) b.zone.push(zone(q, nn));
      if (extra) b.uv.push(local[0] / (2 * extra.r) + 0.5, local[1] / (2 * extra.r) + 0.5);
    }
    for (const i of p.idx) b.idx.push(base + i);
  };
  for (const p0 of parts) {
    if (p0.cls === 'wheel') {
      const p = compact(simplify(p0, ratioWheel, err, minTri));
      // wheel centre and radius from the bounds
      let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
      for (let i = 0; i < p.pos.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p.pos[i + k]); mx[k] = Math.max(mx[k], p.pos[i + k]); }
      const c = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2], r = (mx[1] - mn[1]) / 2;
      const key = (c[0] > 0 ? 'F' : 'R') + (c[2] > 0 ? 'R' : 'L');
      out.wheels[key] = out.wheels[key] || { c, r, w: mx[2] - mn[2], parts: {} };
      // split tyre from rim per triangle by distance from the axle
      const tyre = [], rim = [];
      for (let t = 0; t < p.idx.length; t += 3) {
        let d = 0;
        for (let k = 0; k < 3; k++) { const i = p.idx[t + k] * 3; d += Math.hypot(p.pos[i] - c[0], p.pos[i + 1] - c[1]); }
        (d / 3 > r * 0.74 ? tyre : rim).push(p.idx[t], p.idx[t + 1], p.idx[t + 2]);
      }
      add(out.wheels[key].parts, M.tyre, Object.assign({}, p, { idx: tyre }), { c, r });
      add(out.wheels[key].parts, M.rim, Object.assign({}, p, { idx: rim }), { c, r });
      continue;
    }
    const p = compact(simplify(p0, ratioBody, err, minTri));
    if (p0.cls === M.nut) {
      // hub nut belongs to the nearest rear wheel; attach after wheels are known
      out.nuts = out.nuts || []; out.nuts.push(p); continue;
    }
    add(out.body, p0.cls, p);
  }
  for (const p of out.nuts || []) {
    const z = p.pos[2], key = 'R' + (z > 0 ? 'R' : 'L'), wh = out.wheels[key];
    add(wh.parts, M.nut, p, { c: wh.c, r: wh.r });
  }
  // front wheel nuts do not exist as parts in this model; that is fine
  return out;
}

// pack: float32 positions, int8 normals, uint8 zones, float32 wheel uvs, uint16/32 indices
const chunks = []; let off = 0;
function put(arr) { const b = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength); const pad = (4 - (b.length % 4)) % 4; const o = off; chunks.push(b, Buffer.alloc(pad)); off += b.length + pad; return [o, arr.length]; }
function packGeo(g) {
  const r = { pos: put(Float32Array.from(g.pos)), nor: put(Int8Array.from(g.nor, x => Math.round(x * 127))) };
  const nv = g.pos.length / 3;
  r.idx = nv > 65535 ? ['u32', ...put(Uint32Array.from(g.idx))] : ['u16', ...put(Uint16Array.from(g.idx))];
  if (g.zone.length) r.zone = put(Uint8Array.from(g.zone));
  if (g.uv.length) r.uv = put(Float32Array.from(g.uv));
  return r;
}
const lods = [build(0.25, 0.3, 0.01, 250), build(0.06, 0.08, 0.05, 60)];
const meta = { scale: S, lods: lods.map(L => ({
  body: Object.fromEntries(Object.entries(L.body).map(([k, g]) => [k, packGeo(g)])),
  wheels: Object.fromEntries(Object.entries(L.wheels).map(([k, w]) => [k, { c: w.c, r: w.r, w: w.w, parts: Object.fromEntries(Object.entries(w.parts).map(([m, g]) => [m, packGeo(g)])) }])),
})) };
let tris = lods.map(L => { let t = 0; for (const g of Object.values(L.body)) t += g.idx.length / 3; for (const w of Object.values(L.wheels)) for (const g of Object.values(w.parts)) t += g.idx.length / 3; return t; });
const bin = Buffer.concat(chunks);
const js = '// Generated by tools/car_prep.mjs. Model: "Aston Martin F1 AMR23 2023" by Redgrund, CC BY 4.0\n' +
  '// (https://sketchfab.com/3d-models/aston-martin-f1-amr23-2023-f6ba825a43b146a9b669934a4e1fd529), modified. See CREDITS.md.\n' +
  '(function (G) { const A = G.F1.Assets = G.F1.Assets || {}; A.carModel = ' + JSON.stringify(Object.assign(meta, { bin: bin.toString('base64') })) + '; })(window);\n';
fs.writeFileSync(process.argv[3], js);
console.log('LOD triangles', tris.map(Math.round), 'bytes', bin.length, 'wheels', Object.keys(lods[0].wheels), Object.values(lods[0].wheels).map(w => w.c.map(x => x.toFixed(2)).join(',') + ' r' + w.r.toFixed(3)));
