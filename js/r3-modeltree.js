// Modelled trees (no camera-facing pictures). Each species is a few seeded variants, every one a
// real 3D model at unit height: a tapered, slightly bent trunk with limbs, and a crown built the way
// a real one grows, as clumps of foliage on the ends of the limbs, each clump a handful of leaf
// cards facing every way. The crown shades as a volume: card normals lean out from the crown's
// centre (so the sun side is lit and the far side falls into shade), and each card carries its own
// occlusion in the vertex colour (deep inside and underneath darker, the outer shell lighter).
// Conifers are a straight trunk with whorls of drooping needle branches round a dark inner cone.
// Detail: each card is tagged with the distance up to which it is drawn (aLod, metres): far trees
// keep their outer, larger clumps and lose the inner fill, in the vertex shader, so one instanced
// mesh per variant serves near and far. Trunks and limbs are a second mesh (bark).
(function (G) {
  'use strict';
  const F1 = G.F1, THREE = G.THREE;

  // a tiny geometry accumulator: positions, normals, uvs, colour (occlusion), lod distance
  function Acc() { this.p = []; this.n = []; this.u = []; this.c = []; this.l = []; this.i = []; }
  Acc.prototype.v = function (x, y, z, nx, ny, nz, u, v, ao, lod) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.u.push(u, v); this.c.push(ao, ao, ao); this.l.push(lod);
    return this.p.length / 3 - 1;
  };
  Acc.prototype.t = function (a, b, c) { this.i.push(a, b, c); };
  Acc.prototype.geo = function () {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aLod', new THREE.Float32BufferAttribute(this.l, 1));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  // a tapered tube along a polyline (bark): radius r0 at the start to r1 at the end
  function tube(A, pts, r0, r1, sides, ao) {
    const N = pts.length, ring = [];
    for (let k = 0; k < N; k++) {
      const p = pts[k], d = (k < N - 1 ? pts[k + 1].clone().sub(p) : p.clone().sub(pts[k - 1])).normalize();
      const a = Math.abs(d.y) < 0.9 ? V(0, 1, 0) : V(1, 0, 0), s = a.clone().cross(d).normalize(), t = d.clone().cross(s);
      const r = r0 + (r1 - r0) * k / (N - 1), row = [];
      for (let j = 0; j <= sides; j++) {
        const an = j / sides * Math.PI * 2, nx = s.x * Math.cos(an) + t.x * Math.sin(an), ny = s.y * Math.cos(an) + t.y * Math.sin(an), nz = s.z * Math.cos(an) + t.z * Math.sin(an);
        row.push(A.v(p.x + nx * r, p.y + ny * r, p.z + nz * r, nx, ny, nz, j / sides, k / (N - 1) * 3, ao * (0.75 + 0.25 * k / (N - 1)), 1e9));
      }
      ring.push(row);
    }
    for (let k = 0; k < N - 1; k++) for (let j = 0; j < sides; j++) { const a = ring[k][j], b = ring[k][j + 1], c = ring[k + 1][j], d = ring[k + 1][j + 1]; A.t(a, c, b); A.t(b, c, d); }
  }
  // a leaf card: a quad centred at c, size s, facing f, its normal bent toward nb (the volume's normal)
  function card(A, c, s, f, up, nb, ao, lod, rnd) {
    const r = f.clone().cross(up).normalize(), u = r.clone().cross(f).normalize();
    const h = s / 2, uv0 = rnd() < 0.5 ? 0 : 1;
    const n = nb.clone().multiplyScalar(0.78).add(f.clone().multiplyScalar(0.22)).normalize();
    const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => A.v(c.x + (r.x * a + u.x * b) * h, c.y + (r.y * a + u.y * b) * h, c.z + (r.z * a + u.z * b) * h, n.x, n.y, n.z, uv0 ? 1 - (a + 1) / 2 : (a + 1) / 2, (b + 1) / 2, ao, lod));
    A.t(q[0], q[1], q[2]); A.t(q[0], q[2], q[3]);
  }
  function rngOf(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // Broadleaf (oak, ash, plane, lime): an ellipsoid crown of 9 to 13 clumps on limbs.
  // shape: 0 round (lime, maple), 1 tall oval (poplar, hornbeam), 2 spreading (oak, plane: low, wide),
  // 3 irregular (two leaders, a lopsided crown)
  function broadleaf(seed, shape) {
    const rnd = rngOf(seed), leaf = new Acc(), bark = new Acc();
    const tH = [0.2, 0.18, 0.17, 0.22][shape] + rnd() * 0.08, lean = V((rnd() - 0.5) * 0.06, 0, (rnd() - 0.5) * 0.06);
    const rx = [0.29, 0.13, 0.4, 0.3][shape], ry = [0.36, 0.42, 0.27, 0.34][shape];
    const cC = V(lean.x, 1 - ry * 1.02, lean.z), cR = V(rx + rnd() * 0.06, ry, rx + rnd() * 0.06);
    const c2 = shape === 3 ? cC.clone().add(V(0.14, -0.08, 0.05)) : null;
    const trunkTop = V(lean.x * 0.7, tH, lean.z * 0.7);
    tube(bark, [V(0, -0.02, 0), V(lean.x * 0.2, tH * 0.4, lean.z * 0.2), trunkTop, V(lean.x, tH + 0.12, lean.z)], 0.036, 0.016, 7, 0.9);
    const trunkN = bark.i.length;
    const nL = (shape === 2 ? 20 : 16) + Math.floor(rnd() * 6), lobes = [];
    for (let k = 0; k < nL; k++) {
      // clump centres spread over the crown's outer shell, fewer underneath (light reaches the top)
      const y = Math.min(0.95, Math.max(-0.8, (rnd() * 2 - 1) * 0.95 + 0.1)), a = k * 2.39996 + rnd() * 0.6, rr = Math.sqrt(1 - y * y) * (0.45 + rnd() * 0.5);
      const cc = c2 && k % 3 === 0 ? c2 : cC, p = V(cc.x + Math.cos(a) * rr * cR.x, cc.y + y * 0.85 * cR.y, cc.z + Math.sin(a) * rr * cR.z);
      lobes.push({ p, s: 0.09 + rnd() * 0.06 });
      // a limb from the trunk's top to the clump (the main ones only: thin twigs would be lost)
      if (k < 6) { const m = trunkTop.clone().lerp(p, 0.55).add(V(0, 0.04, 0)); tube(bark, [trunkTop.clone().add(V(0, k * 0.012, 0)), m, p.clone().lerp(cC, 0.18)], 0.014, 0.005, 4, 0.7); }
    }
    // an inner clump or two to fill the middle (seen near, dropped far)
    for (let k = 0; k < 4; k++) lobes.push({ p: cC.clone().add(V((rnd() - 0.5) * 0.25, (rnd() - 0.4) * 0.3, (rnd() - 0.5) * 0.25)), s: 0.14, inner: true });
    for (const L of lobes) {
      const out = L.p.clone().sub(cC); const depth = Math.min(1, out.length() / Math.max(cR.x, cR.y)); out.normalize();
      const nCards = L.inner ? 4 : 6;
      for (let j = 0; j < nCards; j++) {
        const o = V(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(L.s * 0.9), c = L.p.clone().add(o);
        const f = V(rnd() - 0.5, (rnd() - 0.5) * 1.2, rnd() - 0.5).normalize();
        const nb = c.clone().sub(cC).normalize().add(o.clone().normalize().multiplyScalar(0.35)).normalize();
        // occlusion: outer shell lit, inner and underside darker
        const under = Math.max(0, -nb.y), ao = Math.max(0.42, (L.inner ? 0.5 : 0.64 + 0.36 * depth) * (1 - 0.3 * under));
        const lod = L.inner ? 35 : j < 2 ? 1e9 : j < 4 ? 160 : 70;
        card(leaf, c, L.s * (j < 2 ? 2.6 : 2.0), f, Math.abs(f.y) > 0.9 ? V(1, 0, 0) : V(0, 1, 0), nb, ao, lod, rnd);
      }
    }
    return { leaf: leaf.geo(), bark: bark.geo(), trunkN };
  }
  // Conifer (spruce, fir): a straight trunk to the tip, whorls of branch cards drooping outward,
  // and a dark inner cone so the tree reads dense as a real spruce does.
  function conifer(seed) {
    const rnd = rngOf(seed), leaf = new Acc(), bark = new Acc();
    const base = 0.06 + rnd() * 0.05, R0 = 0.18 + rnd() * 0.04;
    tube(bark, [V(0, -0.02, 0), V(0, 0.5, 0), V(0, 0.98, 0)], 0.018, 0.005, 6, 0.85);
    const trunkN = bark.i.length;
    const rad = y => R0 * Math.pow(Math.max(0, (1 - y) / (1 - base)), 0.95) + 0.01;
    // inner cone (opaque-ish fill: the dense dark core between the branches)
    {
      const sides = 8, y0 = base + 0.02, y1 = 0.985, b0 = leaf.p.length / 3;
      for (let j = 0; j <= sides; j++) {
        const a = j / sides * Math.PI * 2, r = rad(y0) * 0.92, nx = Math.cos(a), nz = Math.sin(a);
        leaf.v(nx * r, y0, nz * r, nx * 0.8, 0.6, nz * 0.8, 0.02 + 0.06 * j / sides, 0.03, 0.3, 1e9);
        leaf.v(0, y1, 0, nx * 0.6, 0.8, nz * 0.6, 0.02 + 0.06 * j / sides, 0.06, 0.45, 1e9);
      }
      for (let j = 0; j < sides; j++) { const a = b0 + j * 2; leaf.t(a, a + 2, a + 1); leaf.t(a + 1, a + 2, a + 3); }
    }
    const tiers = 13 + Math.floor(rnd() * 3);
    for (let t = 0; t < tiers; t++) {
      const y = base + (0.96 - base) * Math.pow(t / (tiers - 1), 0.92) + (rnd() - 0.5) * 0.015, R = rad(y), nb = 10 + Math.floor(rnd() * 2) - (t > tiers - 4 ? 4 : 0);
      for (let k = 0; k < nb; k++) {
        const a = (k + rnd() * 0.5) / nb * Math.PI * 2 + t * 1.3, dx = Math.cos(a), dz = Math.sin(a);
        const L = R * (0.95 + rnd() * 0.25), d1 = 0.18 + rnd() * 0.1, d2 = 0.5 + rnd() * 0.25;
        // a spruce branch bends: the inner half runs out nearly level from the trunk, the outer half
        // hangs, its tip curling up a little; one card per half, both with the needle texture along
        // their length, so the tree reads as layered drooping skirts, not flat plates
        const across = V(-dz, 0, dx);
        const ao = 0.55 + 0.3 * (t / tiers) + 0.15 * (k % 2);
        const nbv = V(dx, 0.45, dz).normalize();
        const lod = k % 4 === 0 || t > tiers - 3 ? 1e9 : k % 4 === 2 ? 150 : 60;
        const p0 = V(dx * 0.012, y, dz * 0.012), dirA = V(dx, -d1, dz).normalize(), p1 = p0.clone().add(dirA.clone().multiplyScalar(L * 0.5));
        const dirB = V(dx, -d2, dz).normalize(), p2 = p1.clone().add(dirB.clone().multiplyScalar(L * 0.55));
        const n = nbv;
        for (const [a, b, v0, v1, w0, w1, o] of [[p0, p1, 0, 0.5, 0.55, 0.95, ao * 0.85], [p1, p2, 0.5, 1, 0.95, 0.7, ao]]) {
          const b0 = leaf.p.length / 3;
          for (const [sa, end, u] of [[-1, 0, 0], [1, 0, 1], [1, 1, 1], [-1, 1, 0]]) {
            const q = (end ? b : a).clone().add(across.clone().multiplyScalar(sa * L * (end ? w1 : w0) * 0.5)), v = end ? v1 : v0;
            leaf.v(q.x, q.y, q.z, n.x, n.y, n.z, 0.5 + u * 0.5, v, Math.min(1, o), lod);
          }
          leaf.t(b0, b0 + 1, b0 + 2); leaf.t(b0, b0 + 2, b0 + 3);
        }
      }
    }
    return { leaf: leaf.geo(), bark: bark.geo(), trunkN };
  }

  // Textures, drawn once: broadleaf clumps (left half: the leaf photo when present, else drawn
  // leaves) and conifer branches (right half: a stem with needles), on one canvas.
  let tex = null;
  function texture(leafImg) {
    if (tex) return tex;
    const W = 1024, H = 768, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const x = cv.getContext('2d'), rnd = rngOf(77);
    // left: a leaf clump as twigs, each a spray of small leaves, with sky between them (about half
    // the card is leaf); an irregular outline so no card edge reads as a circle
    for (let k = 0; k < 110; k++) {
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 205, tx = 256 + Math.cos(a) * r, ty = 256 + Math.sin(a) * r * 0.9;
      const da = a + (rnd() - 0.5) * 1.2, len = 30 + rnd() * 50;
      x.strokeStyle = 'rgba(60,48,34,0.9)'; x.lineWidth = 2; x.beginPath(); x.moveTo(tx, ty); x.lineTo(tx + Math.cos(da) * len, ty + Math.sin(da) * len); x.stroke();
      const nl = 16 + Math.floor(rnd() * 10), cd = 0.62 + 0.38 * Math.min(1, r / 200);
      for (let j = 0; j < nl; j++) {
        const q = rnd(), px = tx + Math.cos(da) * len * q + (rnd() - 0.5) * 22, py = ty + Math.sin(da) * len * q + (rnd() - 0.5) * 22;
        const g = (0.7 + rnd() * 0.5) * cd, yel = rnd() * 0.2;
        x.fillStyle = 'rgb(' + Math.round((92 + yel * 90) * g) + ',' + Math.round(138 * g) + ',' + Math.round(62 * g) + ')';
        x.save(); x.translate(px, py); x.rotate(rnd() * 6.3); x.beginPath(); x.ellipse(0, 0, 6 + rnd() * 4, 3 + rnd() * 1.6, 0, 0, Math.PI * 2); x.fill(); x.restore();
      }
    }
    // right: a conifer branch, the stem along v (bottom to top), needles out to both sides
    x.save(); x.translate(512, 0);
    for (let s = 0; s < 6; s++) {
      const sx = 256 + (s - 2.5) * 30 * (s % 2 ? 1 : -1) * 0.2, top = 20 + s * 6;
      x.strokeStyle = 'rgb(70,52,36)'; x.lineWidth = 5; x.beginPath(); x.moveTo(256, 500); x.lineTo(sx, top); x.stroke();
      for (let k = 0; k < 900; k++) {
        const t = rnd(), py = 500 - t * (500 - top), px = 256 + (sx - 256) * t, side = rnd() < 0.5 ? -1 : 1, w = (1 - t * 0.55) * (170 + rnd() * 60) * (0.55 + 0.45 * Math.sin(t * 3.14));
        const g = 55 + rnd() * 45; x.strokeStyle = `rgb(${Math.round(g * 0.5)},${Math.round(g * 0.9)},${Math.round(g * 0.42)})`; x.lineWidth = 2 + rnd() * 1.5;
        x.beginPath(); x.moveTo(px, py); x.lineTo(px + side * w * (0.6 + rnd() * 0.4), py + 18 + rnd() * 30); x.stroke();
      }
    }
    x.restore();
    // bottom strip: bark, grey-brown with vertical fissures (trunks and limbs are drawn with this part)
    x.fillStyle = 'rgb(92,80,68)'; x.fillRect(0, 640, W, 128);
    for (let k = 0; k < 900; k++) { const px = rnd() * W, py = 640 + rnd() * 128, g = 50 + rnd() * 70; x.strokeStyle = 'rgb(' + Math.round(g * 1.05) + ',' + Math.round(g * 0.92) + ',' + Math.round(g * 0.78) + ')'; x.lineWidth = 1 + rnd() * 3; x.beginPath(); x.moveTo(px, py); x.lineTo(px + (rnd() - 0.5) * 6, py + 10 + rnd() * 40); x.stroke(); }
    // the empty pixels take the colour of the leaves next to them (spread out a few times), so the
    // filtered and mipmapped edges blend to green, not to the canvas's black: no dark halo round a crown
    const id = x.getImageData(0, 0, W, H), d = id.data;
    for (let pass = 0; pass < 6; pass++) {
      const src = new Uint8ClampedArray(d);
      for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
        const i = (yy * W + xx) * 4; if (src[i + 3] > 8) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = xx + ox * (1 << pass), Y = yy + oy * (1 << pass); if (X < 0 || Y < 0 || X >= W || Y >= H) continue; const j = (Y * W + X) * 4; if (src[j + 3] > 8) { r += src[j]; g += src[j + 1]; b += src[j + 2]; n++; } }
        if (n) { d[i] = r / n; d[i + 1] = g / n; d[i + 2] = b / n; d[i + 3] = 1; }
      }
    }
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3] === 1) d[i + 3] = 0; else if (d[i + 3] < 8 && !d[i] && !d[i + 1]) { d[i] = 70; d[i + 1] = 96; d[i + 2] = 48; } }
    tex = new THREE.DataTexture(d, W, H, THREE.RGBAFormat); tex.flipY = true; tex.needsUpdate = true;
    tex.magFilter = THREE.LinearFilter; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
    return tex;
  }
  // map the conifer cards' uvs (already 0.5..1 in u) and broadleaf cards (0..1) into the halves
  function remapUv(g, half) {
    const uv = g.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, half === 0 ? uv.getX(k) * 0.5 : uv.getX(k), 1 / 3 + uv.getY(k) * 2 / 3);
    uv.needsUpdate = true;
  }
  // a copy of g sharing its vertices, keeping the triangles keep(index, k) says
  function sub(g, keep) {
    const I = g.index.array, out = [];
    for (let k = 0; k < I.length; k += 3) if (keep(I, k)) out.push(I[k], I[k + 1], I[k + 2]);
    const s = new THREE.BufferGeometry();
    for (const n in g.attributes) s.setAttribute(n, g.attributes[n]);
    s.setIndex(out); s.boundingSphere = g.boundingSphere.clone();
    return s;
  }
  // the bark's uvs into the bottom strip (u round the trunk, v up it)
  function barkUv(g) { const uv = g.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k), 0.008 + Math.min(1, uv.getY(k) / 3) * 0.15); uv.needsUpdate = true; }
  // one geometry from two (each with its own index): leaves and bark in one draw
  function merge(a, b) {
    const g = new THREE.BufferGeometry(), na = a.attributes.position.count;
    for (const n of ['position', 'normal', 'uv', 'color', 'aLod']) {
      const A = a.attributes[n], B = b.attributes[n], arr = new Float32Array(A.array.length + B.array.length);
      arr.set(A.array, 0); arr.set(B.array, A.array.length); g.setAttribute(n, new THREE.BufferAttribute(arr, A.itemSize));
    }
    const ia = a.index.array, ib = b.index.array, I = new Uint32Array(ia.length + ib.length);
    I.set(ia, 0); for (let k = 0; k < ib.length; k++) I[ia.length + k] = ib[k] + na;
    g.setIndex(new THREE.BufferAttribute(I, 1)); g.computeBoundingSphere();
    return g;
  }
  const cache = {};
  function variants(kind) {
    if (cache[kind]) return cache[kind];
    const out = [];
    for (let k = 0; k < (kind === 'fir' ? 3 : 4); k++) {
      const m = kind === 'fir' ? conifer(101 + k * 17) : broadleaf(11 + k * 31, k);
      remapUv(m.leaf, kind === 'fir' ? 1 : 0);
      // the far model: the crown's main cards (those drawn at any distance) and the trunk without its limbs
      m.leafFar = sub(m.leaf, (I, k) => { const L = m.leaf.attributes.aLod.array; return L[I[k]] >= 1e8 && L[I[k + 1]] >= 1e8 && L[I[k + 2]] >= 1e8; });
      m.barkFar = sub(m.bark, (I, k) => k < m.trunkN);
      barkUv(m.bark);
      m.full = merge(m.leaf, m.bark); m.far = merge(m.leafFar, m.barkFar);
      out.push(m);
    }
    return (cache[kind] = out);
  }
  // the leaf material's extra: cards past their distance collapse (detail), and a little light
  // through the leaves (translucency) on the side away from the sun
  function leafPatch(sh) {
    sh.vertexShader = 'attribute float aLod;\n' + sh.vertexShader.replace('#include <begin_vertex>', [
      '#include <begin_vertex>',
      '#ifdef USE_INSTANCING',
      '  { vec3 tc = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz; if (distance(tc, cameraPosition) > aLod) transformed = vec3(0.0); }',
      '#endif'].join('\n'));
    // a little light into the shade sides (sky and grass bounce: a crown's shade is never black),
    // and aerial perspective: distant woods fade toward the haze
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <opaque_fragment>', '  outgoingLight += diffuseColor.rgb * 0.05;\n#include <opaque_fragment>')
      .replace('#include <dithering_fragment>', '#ifdef USE_FOG\n  gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogCol, (1.0 - exp(-distance(vFogWorld, cameraPosition) / 1400.0)) * 0.75);\n#endif\n#include <dithering_fragment>');
  }
  // the leaves' shadow: only each crown's main cards cast (a third of them: the shade of a crown
  // is its mass, not its every clump), with the same cut-out
  let depthMat = null;
  function depth(map) {
    if (depthMat) return depthMat;
    depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.32, side: THREE.DoubleSide });
    depthMat.onBeforeCompile = sh => { sh.vertexShader = 'attribute float aLod;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  if (aLod < 1e8) transformed = vec3(0.0);'); };
    depthMat.customProgramCacheKey = () => 'mtreeDepth';
    return depthMat;
  }
  F1.R3ModelTree = { variants, texture, leafPatch, depth };
})(window);
