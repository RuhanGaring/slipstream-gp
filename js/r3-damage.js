// Soft-body damage for the 3D cars (the race setting Damage: FULL, physics in js/damage.js).
// Dents: each impact pushes the bodywork's vertices near the contact point in along the impact
// direction, most at the centre and fading to nothing at the dent's radius, with a little
// noise so the panel crumples rather than bending as a smooth bowl. The car's body geometry is
// shared by every car of its team until it is first hit; then it gets its own copy.
// Breakages: a wing that breaks is cut out of the body (its triangles move into a new mesh)
// and a wheel that comes off leaves with its hub; either one then flies, bounces and slides
// as a rigid body until it comes to rest on the ground, where it stays as debris.
(function (G) {
  'use strict';
  const F1 = G.F1, THREE = G.THREE;
  const Tracks = F1.Tracks;

  // regions of the model cut out when a part breaks (car frame: x forward, y up, z right)
  const REGIONS = {
    fwL: (x, y, z) => x > 2.72 && z <= 0.02 && y < 0.55,
    fwR: (x, y, z) => x > 2.72 && z > 0.02 && y < 0.55,
    rw: (x, y, z) => x < -1.9 && y > 0.6,
  };

  // give a mesh its own copy of its geometry before it is changed
  function own(m) {
    if (m.userData.ownGeo) return m.geometry;
    const g = m.geometry = m.geometry.clone();
    // the model packs its normals into 8-bit integers; recomputed in that form after a dent
    // they saturate and wreck the shading, so the copy gets full-precision normals
    const n = g.attributes.normal;
    if (n && !(n.array instanceof Float32Array)) {
      const f = new Float32Array(n.count * 3);
      for (let i = 0; i < n.count; i++) { f[i * 3] = n.getX(i); f[i * 3 + 1] = n.getY(i); f[i * 3 + 2] = n.getZ(i); }
      g.setAttribute('normal', new THREE.BufferAttribute(f, 3));
    }
    m.userData.ownGeo = true;
    return g;
  }
  function bodyMeshes(root) {
    const out = [];
    for (const g of root.userData.lodGroups || []) g.traverse(m => { if (m.isMesh && m.geometry.attributes.position) out.push(m); });
    return out;
  }
  const hash = (a, b, c) => { const s = Math.sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453; return s - Math.floor(s); };

  function dent(root, h) {
    const hx = h.x, hz = h.y, hy = h.z, r = h.r, depth = h.depth;
    // the impact direction in the car frame (sim lateral y is the model's z)
    const dl = Math.hypot(h.dx, h.dy) || 1, dx = h.dx / dl, dz = h.dy / dl;
    for (const m of bodyMeshes(root)) {
      const G2 = m.geometry, p = G2.attributes.position;
      let touched = false;
      // quick reject on the bounding sphere
      if (G2.boundingSphere) { const c = G2.boundingSphere.center; if (Math.hypot(c.x - hx, c.y - hy, c.z - hz) > G2.boundingSphere.radius + r) continue; }
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const d = Math.hypot(x - hx, (y - hy) * 0.7, z - hz);
        if (d >= r) continue;
        if (!touched) { own(m); touched = true; }
        const f = (1 - d / r) ** 2 * depth * (0.7 + 0.6 * hash(x, y, z));
        const pa = m.geometry.attributes.position;
        pa.setXYZ(i, x + dx * f, y - f * 0.25, z + dz * f);
      }
      if (touched) { m.geometry.attributes.position.needsUpdate = true; m.geometry.computeVertexNormals(); m.geometry.computeBoundingSphere(); }
    }
  }

  // move the triangles of a region out of the body into a new group of meshes
  function cut(root, test) {
    const parts = new THREE.Group();
    for (const m of bodyMeshes(root)) {
      const shown = m.parent.visible; // the detail level on show gives the flying piece; the other just loses it
      const G2 = m.geometry, p = G2.attributes.position, ix = G2.index;
      if (!ix) continue;
      const keep = [], take = [];
      const a = ix.array;
      for (let t = 0; t < a.length; t += 3) {
        const i0 = a[t], i1 = a[t + 1], i2 = a[t + 2];
        const cx = (p.getX(i0) + p.getX(i1) + p.getX(i2)) / 3, cy = (p.getY(i0) + p.getY(i1) + p.getY(i2)) / 3, cz = (p.getZ(i0) + p.getZ(i1) + p.getZ(i2)) / 3;
        (test(cx, cy, cz) ? take : keep).push(i0, i1, i2);
      }
      if (!take.length) continue;
      own(m).setIndex(keep);
      if (!shown) continue;
      const g = new THREE.BufferGeometry();
      for (const k of Object.keys(G2.attributes)) g.setAttribute(k, G2.attributes[k]);
      g.setIndex(take); g.computeBoundingSphere();
      const piece = new THREE.Mesh(g, m.material); piece.castShadow = true;
      parts.add(piece);
    }
    return parts.children.length ? parts : null;
  }

  // ---- debris: rigid pieces that fly, bounce and settle ----
  const debris = [];
  function launch(scene, obj, outer, c, kick, isWheel) {
    outer.updateMatrixWorld(true);
    const m = new THREE.Matrix4().copy(obj.matrixWorld);
    const holder = new THREE.Group();
    m.decompose(holder.position, holder.quaternion, holder.scale);
    if (!isWheel) {
      // pieces cut from the body keep their car-frame vertices: re-centre them on their middle
      const ctr = new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3());
      const local = ctr.clone().applyMatrix4(new THREE.Matrix4().copy(m).invert());
      obj.traverse(q => { if (q.isMesh) { q.geometry = q.geometry.clone(); q.geometry.translate(-local.x, -local.y, -local.z); } });
      holder.position.copy(ctr);
    }
    obj.parent.remove(obj);
    obj.position.set(0, 0, 0); obj.quaternion.identity(); obj.scale.set(1, 1, 1); obj.updateMatrix();
    holder.add(obj);
    scene.add(holder);
    const R = () => Math.random() - 0.5;
    debris.push({
      o: holder, wheel: isWheel, life: 0,
      v: new THREE.Vector3(c.vx * 0.85 + kick.x + R() * 4, 2.5 + Math.random() * 4 + (isWheel ? 1.5 : 0), c.vy * 0.85 + kick.z + R() * 4),
      w: new THREE.Vector3(R() * 14, R() * 14, R() * 14), r: isWheel ? 0.36 : 0.12,
    });
    while (debris.length > Math.max(0, F1.R3 && F1.R3.GFX.debris != null ? F1.R3.GFX.debris : 40)) { const d = debris.shift(); scene.remove(d.o); }
  }
  const _q = new THREE.Quaternion(), _a = new THREE.Vector3();
  function stepDebris(dt, tr) {
    if (!tr || !dt) return;
    for (const d of debris) {
      if (d.rest) continue;
      d.life += dt;
      d.v.y -= 9.81 * dt;
      d.o.position.addScaledVector(d.v, dt);
      const wl = d.w.length();
      if (wl > 1e-3) { _q.setFromAxisAngle(_a.copy(d.w).divideScalar(wl), wl * dt); d.o.quaternion.premultiply(_q); }
      const gy = Tracks.groundAt(tr, d.o.position.x, d.o.position.z) + d.r;
      if (d.o.position.y < gy) {
        d.o.position.y = gy;
        if (d.v.y < 0) d.v.y = -d.v.y * (d.wheel ? 0.35 : 0.25);
        const fr = d.wheel ? 0.985 : 0.9; // a wheel keeps rolling, a wing slides and stops
        d.v.x *= fr; d.v.z *= fr; d.w.multiplyScalar(d.wheel ? 0.98 : 0.85);
        if (d.v.lengthSq() < 0.05 && d.life > 1) d.rest = true;
      }
      d.v.multiplyScalar(1 - 0.05 * dt);
    }
  }
  function clearDebris(scene) { for (const d of debris) scene.remove(d.o); debris.length = 0; }

  // ---- node-and-beam skinning (js/softbody.js) ----
  // Every vertex of the bodywork is tied to the two nearest pieces of the structure (a beam, at
  // the point along it nearest the vertex, or an anchored node of the survival cell) and moves
  // with their weighted displacement, so the panels crumple, bend and tear with the beams under
  // them. The binding is made once per model geometry and shared by every car.
  const binds = new Map();
  const mx = (p, i) => p[i * 3], my = (p, i) => p[i * 3 + 2], mz = (p, i) => p[i * 3 + 1]; // structure (x fwd, y right, z up) -> model (x, y up, z right)
  function bindGeo(g) {
    let B = binds.get(g.uuid);
    if (B) return B;
    const T = F1.Soft.template(), R = T.rest, pos = g.attributes.position, nv = pos.count;
    // candidate pieces: beams, and the anchored nodes (which have no beams among themselves)
    const ca = [], cb = [];
    for (let e = 0; e < T.nb; e++) { ca.push(T.a[e]); cb.push(T.b[e]); }
    for (let i = 0; i < T.n; i++) if (T.fixed[i]) { ca.push(i); cb.push(i); }
    const nc = ca.length;
    const ax = new Float32Array(nc), ay = new Float32Array(nc), az = new Float32Array(nc), dx = new Float32Array(nc), dy = new Float32Array(nc), dz = new Float32Array(nc), ll = new Float32Array(nc);
    for (let k = 0; k < nc; k++) {
      ax[k] = mx(R, ca[k]); ay[k] = my(R, ca[k]); az[k] = mz(R, ca[k]);
      dx[k] = mx(R, cb[k]) - ax[k]; dy[k] = my(R, cb[k]) - ay[k]; dz[k] = mz(R, cb[k]) - az[k];
      ll[k] = dx[k] * dx[k] + dy[k] * dy[k] + dz[k] * dz[k];
    }
    const ia = new Uint16Array(nv * 2), ib = new Uint16Array(nv * 2), tt = new Float32Array(nv * 2), ww = new Float32Array(nv * 2), prim = new Uint16Array(nv);
    for (let v = 0; v < nv; v++) {
      const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
      let b1 = 1e9, b2 = 1e9, k1 = 0, k2 = 0, t1 = 0, t2 = 0;
      for (let k = 0; k < nc; k++) {
        let t = ll[k] > 0 ? ((x - ax[k]) * dx[k] + (y - ay[k]) * dy[k] + (z - az[k]) * dz[k]) / ll[k] : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax[k] + dx[k] * t - x, ey = ay[k] + dy[k] * t - y, ez = az[k] + dz[k] * t - z;
        const d = ex * ex + ey * ey + ez * ez;
        if (d < b1) { b2 = b1; k2 = k1; t2 = t1; b1 = d; k1 = k; t1 = t; } else if (d < b2) { b2 = d; k2 = k; t2 = t; }
      }
      // blend only within one part: a vertex shared out between, say, the rear wing and the
      // chassis would be stretched between them; this way parts move whole and tear at seams
      const g1 = T.grp[t1 < 0.5 ? ca[k1] : cb[k1]], g2 = T.grp[t2 < 0.5 ? ca[k2] : cb[k2]];
      const w1 = 1 / (b1 + 0.004), w2 = g1 === g2 ? 1 / (b2 + 0.004) : 0, sw = w1 + w2;
      ia[v * 2] = ca[k1]; ib[v * 2] = cb[k1]; tt[v * 2] = t1; ww[v * 2] = w1 / sw;
      ia[v * 2 + 1] = ca[k2]; ib[v * 2 + 1] = cb[k2]; tt[v * 2 + 1] = t2; ww[v * 2 + 1] = w2 / sw;
      prim[v] = t1 < 0.5 ? ca[k1] : cb[k1]; // the node the vertex belongs to (for parts coming off)
    }
    B = { ia, ib, tt, ww, prim, src: Float32Array.from(pos.array) };
    binds.set(g.uuid, B);
    return B;
  }

  // bring one mesh to the structure's present shape
  function skin(m, s) {
    const T = F1.Soft.template(), R = T.rest, P = s.p;
    if (!m.userData.bindSrc) m.userData.bindSrc = m.geometry; // the shared model geometry
    const B = bindGeo(m.userData.bindSrc);
    const g = own(m), pa = g.attributes.position, arr = pa.array;
    const { ia, ib, tt, ww, src } = B, nv = pa.count;
    for (let v = 0; v < nv; v++) {
      let ox = 0, oy = 0, oz = 0;
      for (let j = 0; j < 2; j++) {
        const q = v * 2 + j, a = ia[q], b = ib[q], t = tt[q], w = ww[q], u = 1 - t;
        ox += w * (u * (P[a * 3] - R[a * 3]) + t * (P[b * 3] - R[b * 3]));
        oz += w * (u * (P[a * 3 + 1] - R[a * 3 + 1]) + t * (P[b * 3 + 1] - R[b * 3 + 1]));
        oy += w * (u * (P[a * 3 + 2] - R[a * 3 + 2]) + t * (P[b * 3 + 2] - R[b * 3 + 2]));
      }
      arr[v * 3] = src[v * 3] + ox; arr[v * 3 + 1] = src[v * 3 + 1] + oy; arr[v * 3 + 2] = src[v * 3 + 2] + oz;
    }
    pa.needsUpdate = true;
    g.computeVertexNormals();
    g.computeBoundingSphere();
  }

  // drop the triangles of parts that came off (and spawn them as debris); a pit repair puts them back
  function cutOff(scene, outer, c, m, s) {
    if (!m.userData.bindSrc) m.userData.bindSrc = m.geometry;
    const g = own(m), ix = g.index;
    if (!ix) return;
    const B = bindGeo(m.userData.bindSrc || m.geometry);
    const base = m.userData.baseIndex || (m.userData.baseIndex = Uint32Array.from(ix.array));
    const was = m.userData.triOff || (m.userData.triOff = new Uint8Array(base.length / 3));
    const keep = [], take = [];
    for (let t = 0; t < base.length; t += 3) {
      const gone = s.off[B.prim[base[t]]] || s.off[B.prim[base[t + 1]]] || s.off[B.prim[base[t + 2]]];
      if (!gone) { keep.push(base[t], base[t + 1], base[t + 2]); was[t / 3] = 0; continue; }
      if (!was[t / 3]) take.push(base[t], base[t + 1], base[t + 2]);
      was[t / 3] = 1;
    }
    g.setIndex(keep);
    if (!take.length || !m.parent.visible) return;
    // the piece keeps its present (deformed) shape
    const pg = new THREE.BufferGeometry();
    for (const k of Object.keys(g.attributes)) pg.setAttribute(k, g.attributes[k].clone());
    pg.setIndex(take); pg.computeBoundingSphere();
    const piece = new THREE.Mesh(pg, m.material); piece.castShadow = true;
    const holder = new THREE.Group(); holder.add(piece);
    outer.userData.body.add(holder); holder.updateMatrixWorld(true);
    const ch = Math.cos(c.h), sh = Math.sin(c.h);
    launch(scene, holder, outer, c, new THREE.Vector3(ch * -2, 0, sh * -2), false);
  }

  // wheels follow their hubs: position, toe and camber from the bent suspension
  function wheelPose(bu, c, s) {
    const T = F1.Soft.template(), R = T.rest, P = s.p;
    T.corners.forEach((cn, k) => {
      const w = bu.wheels[k];
      if (!w || !w.parent || s.hubOff[k]) return;
      const wd = w.userData, H = cn.H;
      if (wd.baseX == null) { wd.baseX = w.position.x; wd.baseZ = w.position.z; }
      w.position.x = wd.baseX + P[H * 3] - R[H * 3];
      w.position.z = wd.baseZ + P[H * 3 + 1] - R[H * 3 + 1];
      w.position.y += P[H * 3 + 2] - R[H * 3 + 2];
      w.rotation.y = -((wd.front ? c.steer || 0 : 0) + Math.max(-0.6, Math.min(0.6, s.toe[k])));
      w.rotation.x = (k % 2 ? 1 : -1) * Math.max(-0.5, Math.min(0.5, s.camber[k] / 57.3));
    });
  }

  function syncSoft(scene, outer, c, s) {
    const body = outer.userData.body, bu = body.userData;
    const st = outer.userData.softState || (outer.userData.softState = { ver: -1, offVer: 0, n: 0 });
    // bind the model to the structure up front (once per model, at the start of the race),
    // not in the middle of the first crash
    if (!st.bound) { for (const m of bodyMeshes(body)) { if (!m.userData.bindSrc) m.userData.bindSrc = m.geometry; bindGeo(m.userData.bindSrc); } st.bound = true; }
    // while the structure is still moving, reshape every other frame (the last shape always lands)
    if (s.awake && st.n++ % 2) return s.ver > 0 && wheelPose(bu, c, s);
    if (st.ver !== s.ver) {
      for (const m of bodyMeshes(body)) if (m.parent.visible && m.userData.sver !== s.ver) { skin(m, s); m.userData.sver = s.ver; }
      if (st.offVer !== s.offVer) { for (const m of bodyMeshes(body)) cutOff(scene, outer, c, m, s); st.offVer = s.offVer; }
      st.ver = s.ver;
    } else {
      // a detail level that has just come into view catches up
      for (const m of bodyMeshes(body)) if (m.parent.visible && m.userData.sver != null && m.userData.sver !== s.ver) { skin(m, s); m.userData.sver = s.ver; }
    }
    if (s.ver > 0) wheelPose(bu, c, s);
  }

  // per frame, per car: apply new dents and breakages
  function sync(scene, outer, c, dt) {
    const dm = c.dm, body = outer.userData.body, bu = body.userData;
    if (!dm || !bu.lodGroups) return;
    if (dm.soft && F1.Soft) syncSoft(scene, outer, c, dm.soft);
    const st = outer.userData.dmgState || (outer.userData.dmgState = { hits: 0, off: {} });
    // new dents (dm.hits is a rolling list; the count says how many we have applied)
    if (dm.hits.length && dm.hits[dm.hits.length - 1] !== st.last) {
      for (let k = dm.hits.length - 1; k >= 0 && dm.hits[k] !== st.last; k--) dent(body, dm.hits[k]);
      st.last = dm.hits[dm.hits.length - 1];
    }
    // (a part that already came off on an earlier model of this car, which a replay or a
    // detail switch rebuilt, is just left off: it does not fly off a second time)
    const flown = dm.flown || (dm.flown = new Set());
    for (const key of Object.keys(dm.off)) {
      if (st.off[key]) continue;
      st.off[key] = true;
      const ch = Math.cos(c.h), sh = Math.sin(c.h), again = flown.has(key);
      flown.add(key);
      if (key.startsWith('wheel')) {
        const k = +key.slice(5), wheel = bu.wheels[k];
        if (!wheel) continue;
        const side = k % 2 ? 1 : -1, kick = new THREE.Vector3(-sh * side * 6, 0, ch * side * 6);
        if (again) { if (wheel.parent) wheel.parent.remove(wheel); } else launch(scene, wheel, outer, c, kick, true);
        bu.wheels[k] = new THREE.Group(); bu.wheels[k].userData = { spin: new THREE.Group(), front: k < 2, lods: [], stripes: [] }; // a stand-in the renderer can still turn
        bu.lod = -1; // re-pick the detail level: the merged low-detail wheels can no longer stand in
      } else if (!dm.soft && REGIONS[key]) {
        const piece = cut(body, REGIONS[key]);
        if (!piece) continue;
        if (again) continue; // cut away, not thrown
        body.add(piece); piece.updateMatrixWorld(true);
        launch(scene, piece, outer, c, new THREE.Vector3(ch * -3, 0, sh * -3), false);
      }
    }
  }

  F1.R3D = { sync, stepDebris, clearDebris, dent };
})(typeof window !== 'undefined' ? window : globalThis);
