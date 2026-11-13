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

  // ---- debris: rigid bodies that fly, bounce, roll and settle ----
  // Each piece is a rigid body with its own mass and inertia: a wheel a short cylinder (tyre and rim,
  // the mass mostly out at the tread), a piece of bodywork the box round it. It carries angular
  // momentum, so a loose wheel that lands upright rolls on, leans, turns as it leans (gyroscopic
  // precession) and falls over flat, where it rests on its sidewall; a wing tumbles and slides.
  // Contacts with the ground are impulses at the touching points (restitution, then Coulomb
  // friction, which is what turns sliding into rolling), with air drag in flight, more drag in the
  // gravel and grass, and the barriers where the track has them.
  const debris = [];
  const SURF = F1.SURF;
  function launch(scene, obj, outer, c, kick, isWheel) {
    outer.updateMatrixWorld(true);
    const m = new THREE.Matrix4().copy(obj.matrixWorld);
    const holder = new THREE.Group();
    m.decompose(holder.position, holder.quaternion, holder.scale);
    let half = null, axle = null;
    if (!isWheel) {
      // pieces cut from the body keep their car-frame vertices: re-centre them on their middle
      const ctr = new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3());
      const local = ctr.clone().applyMatrix4(new THREE.Matrix4().copy(m).invert());
      const bb = new THREE.Box3();
      obj.traverse(q => { if (q.isMesh) { q.geometry = q.geometry.clone(); q.geometry.translate(-local.x, -local.y, -local.z); q.geometry.computeBoundingBox(); bb.union(q.geometry.boundingBox); } });
      holder.position.copy(ctr);
      half = bb.isEmpty() ? new THREE.Vector3(0.2, 0.05, 0.2) : bb.getSize(new THREE.Vector3()).multiplyScalar(0.5).max(new THREE.Vector3(0.02, 0.02, 0.02));
    } else {
      // the axle in the pivot's frame: the spinning group's z, turned by the wheel's camber
      const spin = obj.userData && obj.userData.spin, tilt = spin && spin.parent;
      axle = new THREE.Vector3(0, 0, 1);
      if (tilt && tilt !== obj) axle.applyQuaternion(tilt.quaternion);
    }
    obj.parent.remove(obj);
    obj.position.set(0, 0, 0); obj.quaternion.identity(); obj.scale.set(1, 1, 1); obj.updateMatrix();
    holder.add(obj);
    scene.add(holder);
    const R = () => Math.random() - 0.5;
    const v = new THREE.Vector3(c.vx * 0.85 + kick.x + R() * 4, 2.5 + Math.random() * 4 + (isWheel ? 1.5 : 0), c.vy * 0.85 + kick.z + R() * 4);
    let mass, I, rad = 0, hw = 0, cda;
    if (isWheel) {
      const front = !!(obj.userData && obj.userData.front);
      rad = 0.36; hw = front ? 0.155 : 0.19; mass = front ? 14 : 16; cda = 0.22;
      const Ia = 0.8 * mass * rad * rad, Ip = 0.5 * Ia + mass * (2 * hw) * (2 * hw) / 12;
      I = new THREE.Vector3(Ip, Ia, 0); // (about any diameter, about the axle: see invI)
    } else {
      const sx = 2 * half.x, sy = 2 * half.y, sz = 2 * half.z;
      mass = Math.max(2, Math.min(12, 30 * sx * sz * Math.max(0.05, sy)));
      cda = Math.max(0.05, Math.min(0.5, 0.6 * Math.max(sx * sz, sx * sy, sy * sz)));
      I = new THREE.Vector3(mass * (sy * sy + sz * sz) / 12, mass * (sx * sx + sz * sz) / 12, mass * (sx * sx + sy * sy) / 12);
    }
    // the wheel leaves spinning as it rolled (its spin is -speed / radius about the axle), with a
    // wobble from the blow; a piece tumbles
    const L = new THREE.Vector3();
    if (isWheel) {
      // rolling: spin (up x velocity) / radius, about whichever way the axle points
      const aw = axle.clone().applyQuaternion(holder.quaternion), roll = new THREE.Vector3(0, 1, 0).cross(new THREE.Vector3(c.vx, 0, c.vy)).dot(aw) / rad;
      L.copy(aw).multiplyScalar(roll * I.y).add(new THREE.Vector3(R() * 3, R() * 3, R() * 3).multiplyScalar(I.x));
    } else L.set(R() * 14 * I.x, R() * 14 * I.y, R() * 14 * I.z).applyQuaternion(holder.quaternion);
    debris.push({ o: holder, wheel: isWheel, life: 0, v, L, m: mass, I, axle, rad, hw, half, cda, still: 0, h: 1 / 240, loc: { i: -1 } });
    while (debris.length > Math.max(0, F1.R3 && F1.R3.GFX.debris != null ? F1.R3.GFX.debris : 40)) { const d = debris.shift(); scene.remove(d.o); }
  }

  const _qi = new THREE.Quaternion(), _w = new THREE.Vector3(), _t = new THREE.Vector3(), _n = new THREE.Vector3(), _r = new THREE.Vector3(), _vp = new THREE.Vector3(), _p = new THREE.Vector3(), _k = new THREE.Vector3(), _a = new THREE.Vector3(), _ax = new THREE.Vector3(), _dq = new THREE.Quaternion();
  // the inverse inertia in world space applied to a vector: R I^-1 R^T x. A wheel's is the same about
  // every diameter (I.x) and different about its axle a (I.y): I^-1 x = x / I.x + a (a.x)(1 / I.y - 1 / I.x)
  function invI(d, x, out) {
    if (d.wheel) {
      _a.copy(d.axle).applyQuaternion(d.o.quaternion);
      const ax = _a.dot(x);
      return out.copy(x).divideScalar(d.I.x).addScaledVector(_a, ax * (1 / d.I.y - 1 / d.I.x));
    }
    _qi.copy(d.o.quaternion).invert();
    out.copy(x).applyQuaternion(_qi);
    out.set(out.x / d.I.x, out.y / d.I.y, out.z / d.I.z);
    return out.applyQuaternion(d.o.quaternion);
  }
  // an impulse at contact point p (world) on ground of normal n: restitution (only for a real
  // bounce), then Coulomb friction against the sliding of that point
  function contact(d, p, n, e, mu) {
    _r.copy(p).sub(d.o.position);
    invI(d, d.L, _w);
    _vp.copy(_w).cross(_r).add(d.v);
    const vn = _vp.dot(n);
    let jn = 0;
    if (vn < 0) {
      _k.copy(_r).cross(n); invI(d, _k, _k); _k.cross(_r);
      jn = -(1 + (vn < -0.8 ? e : 0)) * vn / (1 / d.m + n.dot(_k));
      d.v.addScaledVector(n, jn / d.m); d.L.add(_k.copy(_r).cross(n).multiplyScalar(jn));
    }
    // resting on the ground it carries at least its weight over the step: friction has that to work with
    jn = Math.max(jn, d.m * 9.81 * d.h * 0.5);
    invI(d, d.L, _w);
    _vp.copy(_w).cross(_r).add(d.v);
    _t.copy(_vp).addScaledVector(n, -_vp.dot(n));
    const vt = _t.length();
    if (vt > 1e-4) {
      _t.divideScalar(vt);
      _k.copy(_r).cross(_t); invI(d, _k, _k); _k.cross(_r);
      const jt = Math.min(vt / (1 / d.m + _t.dot(_k)), mu * jn);
      d.v.addScaledVector(_t, -jt / d.m); d.L.add(_k.copy(_r).cross(_t).multiplyScalar(-jt));
    }
    return true;
  }
  // (a point found inside the ground is eased out over a few steps, not all at once: lifting the
  // whole body out each time a tumbling wheel's edge dug in added height on top of the bounce's
  // own impulse, and a loose wheel climbed tens of metres)
  const SLOP = 0.005;
  // Turn a body by its spin over a step. A wheel's free motion is exact in two parts: it turns about
  // its angular momentum at |L| / I (diameter), and about its own axle at the rest of its spin.
  // Both keep the axle's share of L, so the energy holds however fast it spins (a step of the
  // plain update turned a 90 rad/s wheel a third of a radian at once and fed its tumble energy).
  // A piece turns at its present spin, its energy held to what it had.
  function turn(d, h) {
    const o = d.o, Ll = d.L.length();
    if (Ll < 1e-9) return;
    if (d.wheel) {
      _dq.setFromAxisAngle(_t.copy(d.L).divideScalar(Ll), Ll / d.I.x * h); o.quaternion.premultiply(_dq);
      _ax.copy(d.axle).applyQuaternion(o.quaternion);
      const sp = _ax.dot(d.L) * (1 / d.I.y - 1 / d.I.x) * h;
      if (sp) { _dq.setFromAxisAngle(_ax, sp); o.quaternion.premultiply(_dq); }
      o.quaternion.normalize();
      return;
    }
    invI(d, d.L, _w);
    const wl = _w.length(), E0 = _w.dot(d.L);
    if (wl < 1e-6) return;
    _dq.setFromAxisAngle(_t.copy(_w).divideScalar(wl), wl * h); o.quaternion.premultiply(_dq).normalize();
    const E1 = invI(d, d.L, _w).dot(d.L);
    if (E1 > E0) d.L.multiplyScalar(Math.sqrt(E0 / E1));
  }
  const barrierFace = (tr, side, i) => tr.barr[side][i] + (tr.runT[side][i] === SURF.GRAVEL ? -0.5 : 0.4);
  const _c8 = Array.from({ length: 8 }, () => new THREE.Vector3());
  function stepDebris(dt, tr) {
    if (!tr || !dt) return;
    dt = Math.min(dt, 1 / 20);
    const nSub = Math.ceil(dt / (1 / 240) - 1e-6), h = dt / nSub;
    for (const d of debris) {
      if (d.rest) continue;
      d.life += dt; d.h = h;
      const o = d.o, x = o.position;
      // The ground under it as a plane, read once a frame (Tracks.groundAt searches the circuit near
      // the point, too slow to ask at every corner of every piece every substep), and re-read if it
      // has travelled far from where it was read; the surface likewise.
      const G = d.gp || (d.gp = { x: 0, z: 0, y: 0, sx: 0, sz: 0, soft: 0, ok: false });
      const ground = () => {
        G.x = x.x; G.z = x.z; G.y = Tracks.groundAt(tr, x.x, x.z);
        G.sx = (Tracks.groundAt(tr, x.x + 0.5, x.z) - G.y) / 0.5; G.sz = (Tracks.groundAt(tr, x.x, x.z + 0.5) - G.y) / 0.5;
        _n.set(-G.sx, 1, -G.sz).normalize(); G.nx = _n.x; G.ny = _n.y; G.nz = _n.z;
        Tracks.locate(tr, x.x, x.z, d.loc.i >= 0 ? d.loc.i : null, d.loc);
        const surf = Tracks.surfaceAt(tr, d.loc.i, d.loc.d);
        G.soft = surf === SURF.GRAVEL ? 3 : surf === SURF.GRASS ? 0.8 : 0;
        G.ok = true;
      };
      const gh = (px, pz) => G.y + G.sx * (px - G.x) + G.sz * (pz - G.z);
      // (read again only once it has moved a metre: a piece lying or sliding keeps its plane)
      if (!G.ok || (x.x - G.x) ** 2 + (x.z - G.z) ** 2 > 1) ground();
      // In free flight, well clear of the ground, nothing can touch it this frame: one step for the
      // whole frame (gravity exactly, drag and spin as below), not a substep per 240th of a second.
      const reach0 = d.wheel ? d.rad + d.hw : d.half.length();
      if (x.y - gh(x.x, x.z) > reach0 + 0.3 + Math.max(0, -d.v.y) * dt + 4.9 * dt * dt) {
        const sp = d.v.length();
        if (sp > 0) d.v.multiplyScalar(Math.max(0, 1 - 0.6 * d.cda / d.m * sp * dt));
        x.addScaledVector(d.v, dt); x.y -= 4.905 * dt * dt; d.v.y -= 9.81 * dt;
        turn(d, dt);
        d.still = 0;
        continue;
      }
      for (let sub = 0; sub < nSub; sub++) {
        // flight: gravity and air drag
        d.v.y -= 9.81 * h;
        const sp = d.v.length();
        if (sp > 0) d.v.multiplyScalar(Math.max(0, 1 - 0.6 * d.cda / d.m * sp * h));
        x.addScaledVector(d.v, h);
        turn(d, h);
        if ((x.x - G.x) ** 2 + (x.z - G.z) ** 2 > 4) ground();
        // near the ground?
        if (x.y - gh(x.x, x.z) > (d.wheel ? d.rad + d.hw : d.half.length()) + 0.05) continue;
        _n.set(G.nx, G.ny, G.nz);
        // the surface: rubber or carbon on asphalt, or ploughing through gravel and grass
        const soft = G.soft;
        let touched = false;
        if (d.wheel) {
          // the lowest point of the tyre: on the tread's edge toward the ground, on the lower side
          const a = _ax.copy(d.axle).applyQuaternion(o.quaternion);
          const ay = a.dot(_n);
          _p.copy(_n).multiplyScalar(-1).addScaledVector(a, ay);
          const pl = _p.length();
          if (pl > 1e-4) _p.multiplyScalar(d.rad / pl); else _p.set(0, 0, 0);
          _p.addScaledVector(a, -d.hw * (ay < 0 ? -1 : 1)).add(x);
          const pen = gh(_p.x, _p.z) - _p.y;
          // (rubber grips the road; a wheel lying on its sidewall slides a little more easily)
          if (pen > 0) { const fix = Math.max(0, pen - SLOP) * 0.3; x.addScaledVector(_n, fix); _p.addScaledVector(_n, fix); touched = contact(d, _p, _n, 0.35, Math.abs(ay) > 0.8 ? 0.7 : 1.0); }
        } else {
          // the corners of the box round the piece: the deepest pushes it out, each one touching acts
          let deep = 0;
          for (let k = 0; k < 8; k++) {
            _c8[k].set(k & 1 ? d.half.x : -d.half.x, k & 2 ? d.half.y : -d.half.y, k & 4 ? d.half.z : -d.half.z).applyQuaternion(o.quaternion).add(x);
            deep = Math.max(deep, gh(_c8[k].x, _c8[k].z) - _c8[k].y);
          }
          if (deep > 0) {
            const fix = Math.max(0, deep - SLOP) * 0.3;
            x.addScaledVector(_n, fix);
            for (let k = 0; k < 8; k++) _c8[k].addScaledVector(_n, fix);
            for (let it = 0; it < 2; it++) for (let k = 0; k < 8; k++) {
              const c = _c8[k];
              if (gh(c.x, c.z) - c.y > -SLOP) touched = contact(d, c, _n, 0.2, 0.45) || touched;
            }
          }
        }
        if (touched) {
          // gravel and grass soak it up; a rolling tyre loses a little to its own flexing
          if (soft) { const k = Math.max(0, 1 - soft * h); d.v.multiplyScalar(k); d.L.multiplyScalar(k); }
          d.L.multiplyScalar(1 - 0.04 * h);
        }
        // the barrier: a wall or tyre wall stands where the track says, along its edge
        const li = d.loc.i, dl = d.loc.d + (x.x - G.x) * tr.nx[li] + (x.z - G.z) * tr.ny[li]; // (lateral offset now, from where the surface was read)
        const side = dl > 0 ? 1 : 0, face = barrierFace(tr, side, li), reach = d.wheel ? d.rad : Math.max(d.half.x, d.half.z);
        if (Math.abs(dl) + reach > face) {
          const sg = side ? 1 : -1, nx = -tr.nx[li] * sg, nz = -tr.ny[li] * sg, push = Math.abs(dl) + reach - face;
          x.x += nx * push; x.z += nz * push;
          const vn = d.v.x * nx + d.v.z * nz;
          if (vn < 0) { d.v.x -= 1.3 * vn * nx; d.v.z -= 1.3 * vn * nz; d.v.multiplyScalar(0.7); d.L.multiplyScalar(0.7); }
        }
        // asleep once it has come to rest on the ground
        invI(d, d.L, _w);
        if (touched && d.v.lengthSq() < 0.02 && _w.lengthSq() < 0.1) d.still += h; else d.still = 0;
        if (d.still > 0.6 || d.life > 40) { d.rest = true; break; }
      }
    }
  }
  function clearDebris(scene) { for (const d of debris) scene.remove(d.o); debris.length = 0; rowOwner.length = 0; rowVer.length = 0; }

  // ---- node-and-beam skinning (js/softbody.js) ----
  // Every vertex of the bodywork is tied to the two nearest pieces of the structure (a beam, at
  // the point along it nearest the vertex, or an anchored node of the survival cell) and moves
  // with their weighted displacement, so the panels crumple, bend and tear with the beams under
  // them. The binding is made once per model geometry and shared by every car.
  const binds = new Map();
  const mx = (p, i) => p[i * 3], my = (p, i) => p[i * 3 + 2], mz = (p, i) => p[i * 3 + 1]; // structure (x fwd, y right, z up) -> model (x, y up, z right)
  // (the search goes through a grid: each piece is listed in every cell within BIND_R of it, so the
  // pieces within BIND_R of a vertex are all in that vertex's own cell; the nearest two are taken
  // from there when both lie that close, and from the whole structure otherwise. The dense
  // structure's two thousand beams made the plain search take tens of seconds per model)
  const BIND_C = 0.3, BIND_R = 0.3;
  function bindGeo(g, kind) {
    const key = g.uuid + (kind === 'beam' ? ':beam' : '');
    let B = binds.get(key);
    if (B) return B;
    const T = F1.Soft.template(kind), R = T.rest, pos = g.attributes.position, nv = pos.count;
    // candidate pieces: beams, and the anchored nodes (which have no beams among themselves)
    const ca = [], cb = [];
    for (let e = 0; e < T.nb; e++) { ca.push(T.a[e]); cb.push(T.b[e]); }
    for (let i = 0; i < T.n; i++) if (T.fixed[i]) { ca.push(i); cb.push(i); }
    const nc = ca.length;
    const ax = new Float32Array(nc), ay = new Float32Array(nc), az = new Float32Array(nc), dx = new Float32Array(nc), dy = new Float32Array(nc), dz = new Float32Array(nc), ll = new Float32Array(nc);
    let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
    for (let k = 0; k < nc; k++) {
      ax[k] = mx(R, ca[k]); ay[k] = my(R, ca[k]); az[k] = mz(R, ca[k]);
      dx[k] = mx(R, cb[k]) - ax[k]; dy[k] = my(R, cb[k]) - ay[k]; dz[k] = mz(R, cb[k]) - az[k];
      ll[k] = dx[k] * dx[k] + dy[k] * dy[k] + dz[k] * dz[k];
      x0 = Math.min(x0, ax[k], ax[k] + dx[k]); x1 = Math.max(x1, ax[k], ax[k] + dx[k]);
      y0 = Math.min(y0, ay[k], ay[k] + dy[k]); y1 = Math.max(y1, ay[k], ay[k] + dy[k]);
      z0 = Math.min(z0, az[k], az[k] + dz[k]); z1 = Math.max(z1, az[k], az[k] + dz[k]);
    }
    x0 -= BIND_R; y0 -= BIND_R; z0 -= BIND_R;
    const gx = Math.ceil((x1 + BIND_R - x0) / BIND_C) + 1, gy = Math.ceil((y1 + BIND_R - y0) / BIND_C) + 1, gz = Math.ceil((z1 + BIND_R - z0) / BIND_C) + 1;
    const cells = new Array(gx * gy * gz);
    const cl = (v, o, n) => Math.max(0, Math.min(n - 1, Math.floor((v - o) / BIND_C)));
    for (let k = 0; k < nc; k++) {
      const ex = [Math.min(ax[k], ax[k] + dx[k]) - BIND_R, Math.max(ax[k], ax[k] + dx[k]) + BIND_R];
      const ey = [Math.min(ay[k], ay[k] + dy[k]) - BIND_R, Math.max(ay[k], ay[k] + dy[k]) + BIND_R];
      const ez = [Math.min(az[k], az[k] + dz[k]) - BIND_R, Math.max(az[k], az[k] + dz[k]) + BIND_R];
      for (let i = cl(ex[0], x0, gx); i <= cl(ex[1], x0, gx); i++) for (let j = cl(ey[0], y0, gy); j <= cl(ey[1], y0, gy); j++) for (let l = cl(ez[0], z0, gz); l <= cl(ez[1], z0, gz); l++) {
        const c = (i * gy + j) * gz + l; (cells[c] || (cells[c] = [])).push(k);
      }
    }
    const ia = new Uint16Array(nv * 2), ib = new Uint16Array(nv * 2), tt = new Float32Array(nv * 2), ww = new Float32Array(nv * 2), prim = new Uint16Array(nv);
    let b1, b2, k1, k2, t1, t2;
    const test = (k, x, y, z) => {
      let t = ll[k] > 0 ? ((x - ax[k]) * dx[k] + (y - ay[k]) * dy[k] + (z - az[k]) * dz[k]) / ll[k] : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax[k] + dx[k] * t - x, ey = ay[k] + dy[k] * t - y, ez = az[k] + dz[k] * t - z;
      const d = ex * ex + ey * ey + ez * ez;
      if (d < b1) { b2 = b1; k2 = k1; t2 = t1; b1 = d; k1 = k; t1 = t; } else if (d < b2) { b2 = d; k2 = k; t2 = t; }
    };
    for (let v = 0; v < nv; v++) {
      const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
      b1 = 1e9; b2 = 1e9; k1 = 0; k2 = 0; t1 = 0; t2 = 0;
      const ci = Math.floor((x - x0) / BIND_C), cj = Math.floor((y - y0) / BIND_C), ck = Math.floor((z - z0) / BIND_C);
      const list = ci >= 0 && ci < gx && cj >= 0 && cj < gy && ck >= 0 && ck < gz ? cells[(ci * gy + cj) * gz + ck] : null;
      if (list) for (const k of list) test(k, x, y, z);
      if (!list || b2 > BIND_R * BIND_R) { b1 = 1e9; b2 = 1e9; for (let k = 0; k < nc; k++) test(k, x, y, z); }
      // blend only within one part: a vertex shared out between, say, the rear wing and the
      // chassis would be stretched between them; this way parts move whole and tear at seams
      const g1 = T.grp[t1 < 0.5 ? ca[k1] : cb[k1]], g2 = T.grp[t2 < 0.5 ? ca[k2] : cb[k2]];
      const w1 = 1 / (b1 + 0.004), w2 = g1 === g2 ? 1 / (b2 + 0.004) : 0, sw = w1 + w2;
      ia[v * 2] = ca[k1]; ib[v * 2] = cb[k1]; tt[v * 2] = t1; ww[v * 2] = w1 / sw;
      ia[v * 2 + 1] = ca[k2]; ib[v * 2 + 1] = cb[k2]; tt[v * 2 + 1] = t2; ww[v * 2 + 1] = w2 / sw;
      prim[v] = t1 < 0.5 ? ca[k1] : cb[k1]; // the node the vertex belongs to (for parts coming off)
    }
    B = { ia, ib, tt, ww, prim, src: Float32Array.from(pos.array) };
    binds.set(key, B);
    return B;
  }

  // bring one mesh to the structure's present shape
  function skin(m, s) {
    const T = F1.Soft.template(s.kind), R = T.rest, P = s.p;
    if (!m.userData.bindSrc) m.userData.bindSrc = m.geometry; // the shared model geometry
    const B = bindGeo(m.userData.bindSrc, s.kind);
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

  // On the GPU path a mesh needs only its own list of triangles: the vertices stay the model's,
  // shared with every car of the team (a full copy of every body mesh took ~60 ms when a part broke)
  function ownIndex(m) {
    if (m.userData.ownGeo || m.userData.ownIdx) return m.geometry;
    const s = m.geometry, g = new THREE.BufferGeometry();
    for (const k of Object.keys(s.attributes)) g.setAttribute(k, s.attributes[k]);
    if (s.index) g.setIndex(s.index);
    for (const q of s.groups) g.addGroup(q.start, q.count, q.materialIndex);
    if (s.boundingSphere) g.boundingSphere = s.boundingSphere.clone();
    if (s.boundingBox) g.boundingBox = s.boundingBox.clone();
    m.geometry = g; m.userData.ownIdx = true;
    return g;
  }
  // a piece of its own: just the vertices its triangles use (every attribute, so the shaders find them)
  function compact(g, take) {
    const nv = g.attributes.position.count, map = new Int32Array(nv).fill(-1), used = [];
    const idx = new Uint32Array(take.length);
    for (let t = 0; t < take.length; t++) { const v = take[t]; if (map[v] < 0) { map[v] = used.length; used.push(v); } idx[t] = map[v]; }
    const pg = new THREE.BufferGeometry(), n = used.length;
    for (const k of Object.keys(g.attributes)) {
      const A = g.attributes[k], sz = A.itemSize, Arr = (A.isInterleavedBufferAttribute ? A.data.array : A.array).constructor;
      const B2 = new THREE.BufferAttribute(new (k === 'position' || k === 'normal' ? Float32Array : Arr)(n * sz), sz, k === 'position' || k === 'normal' ? false : A.normalized);
      for (let i = 0; i < n; i++) {
        const v = used[i];
        B2.setX(i, A.getX(v)); if (sz > 1) B2.setY(i, A.getY(v)); if (sz > 2) B2.setZ(i, A.getZ(v)); if (sz > 3) B2.setW(i, A.getW(v));
      }
      pg.setAttribute(k, B2);
    }
    pg.setIndex(new THREE.BufferAttribute(idx, 1));
    return { pg, used };
  }

  // drop the triangles of parts that came off (and spawn them as debris); a pit repair puts them back
  // (gpu: the body is shaped on the GPU, so the piece's vertices are put into that shape here, once)
  function cutOff(scene, outer, c, m, s, gpu) {
    if (!m.userData.bindSrc) m.userData.bindSrc = m.geometry;
    const g = gpu ? ownIndex(m) : own(m), ix = g.index;
    if (!ix) return;
    const B = bindGeo(m.userData.bindSrc || m.geometry, s.kind);
    const base = m.userData.baseIndex || (m.userData.baseIndex = Uint32Array.from(ix.array));
    const was = m.userData.triOff || (m.userData.triOff = new Uint8Array(base.length / 3));
    const keep = new Uint32Array(base.length), take = [];
    let nk = 0, any = false;
    for (let t = 0; t < base.length; t += 3) {
      const gone = s.off[B.prim[base[t]]] || s.off[B.prim[base[t + 1]]] || s.off[B.prim[base[t + 2]]];
      if (!gone) { keep[nk++] = base[t]; keep[nk++] = base[t + 1]; keep[nk++] = base[t + 2]; was[t / 3] = 0; continue; }
      any = true;
      if (!was[t / 3]) take.push(base[t], base[t + 1], base[t + 2]);
      was[t / 3] = 1;
    }
    // (nothing gone from this mesh and nothing put back: its triangles stand as they are)
    if (any || nk !== ix.count) g.setIndex(new THREE.BufferAttribute(keep.slice(0, nk), 1));
    if (!take.length || !m.parent.visible) return;
    // the piece keeps its present (deformed) shape
    const { pg, used } = compact(g, take);
    if (gpu) {
      const T = F1.Soft.template(s.kind), R = T.rest, P = s.p, arr = pg.attributes.position.array, { ia, ib, tt, ww, src } = B;
      for (let i = 0; i < used.length; i++) {
        const v = used[i];
        let ox = 0, oy = 0, oz = 0;
        for (let j = 0; j < 2; j++) {
          const q = v * 2 + j, a = ia[q], b = ib[q], t = tt[q], w = ww[q], u = 1 - t;
          ox += w * (u * (P[a * 3] - R[a * 3]) + t * (P[b * 3] - R[b * 3]));
          oz += w * (u * (P[a * 3 + 1] - R[a * 3 + 1]) + t * (P[b * 3 + 1] - R[b * 3 + 1]));
          oy += w * (u * (P[a * 3 + 2] - R[a * 3 + 2]) + t * (P[b * 3 + 2] - R[b * 3 + 2]));
        }
        arr[i * 3] = src[v * 3] + ox; arr[i * 3 + 1] = src[v * 3 + 1] + oy; arr[i * 3 + 2] = src[v * 3 + 2] + oz;
      }
      pg.computeVertexNormals();
    }
    pg.computeBoundingSphere();
    const piece = new THREE.Mesh(pg, m.material); piece.castShadow = true;
    const holder = new THREE.Group(); holder.add(piece);
    outer.userData.body.add(holder); holder.updateMatrixWorld(true);
    const ch = Math.cos(c.h), sh = Math.sin(c.h);
    launch(scene, holder, outer, c, new THREE.Vector3(ch * -2, 0, sh * -2), false);
  }

  // ---- the GPU path (js/r3-shaders.js patchSoft) ----
  // The binding goes onto the shared model geometry as two vertex attributes: the node pairs, and
  // the place along each beam with its weight (in bytes). Each crashed car writes its structure's
  // present shape into its own row of one small texture (row = car id + 1), and its body's draws
  // read that row; nothing of the model is reshaped or uploaded again.
  const bound = new WeakMap(); // (not in userData: three copies that through JSON when it clones a geometry)
  function bindAttrs(g, B) {
    if (bound.get(g) === B) return;
    const nv = g.attributes.position.count, I = new Uint16Array(nv * 4), W = new Uint8Array(nv * 4);
    for (let v = 0; v < nv; v++) for (let j = 0; j < 2; j++) {
      const q = v * 2 + j;
      I[v * 4 + j * 2] = B.ia[q]; I[v * 4 + j * 2 + 1] = B.ib[q];
      W[v * 4 + j * 2] = Math.round(B.tt[q] * 255); W[v * 4 + j * 2 + 1] = Math.round(B.ww[q] * 255);
    }
    g.setAttribute('aSkI', new THREE.BufferAttribute(I, 4));
    g.setAttribute('aSkT', new THREE.BufferAttribute(W, 4, true));
    // the bodywork can now move a little past the model's bounds: culled a little later
    if (g.boundingSphere) g.boundingSphere.radius += 0.4;
    bound.set(g, B);
  }
  const rowOwner = [], rowVer = [];
  let restDone = null, _str = null; // (restDone: which structure's rest shape row 0 holds)
  const rowOf = (c, s) => (!G.__softCPU && F1.R3S && F1.R3S.SOFT_W >= F1.Soft.template(s && s.kind).n && c.id >= 0 && c.id + 1 < F1.R3S.SOFT_H ? c.id + 1 : 0);
  function writeRow(r, s) {
    const T = F1.Soft.template(s.kind), tex = F1.R3S.U.uSoftTex.value, d = tex.image.data, W = F1.R3S.SOFT_W, R = T.rest, P = s.p;
    const restNew = restDone !== T.kind;
    if (restNew) { for (let i = 0; i < T.n; i++) { d[i * 4] = R[i * 3]; d[i * 4 + 1] = R[i * 3 + 2]; d[i * 4 + 2] = R[i * 3 + 1]; d[i * 4 + 3] = 0; } restDone = T.kind; }
    // how far each node's beams were pushed or pulled from their made length (a snapped one counts in full)
    const st = _str && _str.length >= T.n ? _str : (_str = new Float32Array(T.n));
    st.fill(0);
    for (let e = 0; e < T.nb; e++) {
      const a = T.a[e], b = T.b[e];
      let v = 1;
      if (!s.broken[e]) { const a3 = a * 3, b3 = b * 3, ex = P[b3] - P[a3], ey = P[b3 + 1] - P[a3 + 1], ez = P[b3 + 2] - P[a3 + 2]; v = Math.abs(Math.sqrt(ex * ex + ey * ey + ez * ez) / T.L0[e] - 1); }
      if (v > st[a]) st[a] = v;
      if (v > st[b]) st[b] = v;
    }
    for (let i = 0; i < T.n; i++) {
      const o = (r * W + i) * 4, i3 = i * 3;
      d[o] = P[i3]; d[o + 1] = P[i3 + 2]; d[o + 2] = P[i3 + 1];
      const ex = P[i3] - R[i3], ey = P[i3 + 1] - R[i3 + 1], ez = P[i3 + 2] - R[i3 + 2], disp = Math.sqrt(ex * ex + ey * ey + ez * ez);
      d[o + 3] = T.fixed[i] ? 0 : Math.min(1, Math.max(disp / 0.18, st[i] / 0.08));
    }
    // To the GPU: just this car's row (and the rest shape when it changed), not the whole texture
    // (512 x 33 texels, 270 kB) every frame a car is crumpling; the whole of it the first time.
    if (!uploadRows(tex, T.n, restNew ? [0, r] : [r])) tex.needsUpdate = true;
    rowOwner[r] = s; rowVer[r] = s.ver;
  }
  // Rows of the node texture straight to the GPU, once three has made the texture and uploaded its
  // current version (otherwise false, and the caller asks for a whole upload).
  function uploadRows(tex, n, rows) {
    const rn = F1.R3 && F1.R3.renderer;
    if (!rn || !rn.properties || !rn.getContext) return false;
    const tp = rn.properties.get(tex), gl = rn.getContext();
    if (!tp || !tp.__webglTexture || tp.__version !== tex.version || !gl.texSubImage2D) return false;
    const W = tex.image.width, d = tex.image.data;
    rn.state.bindTexture(gl.TEXTURE_2D, tp.__webglTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    for (const r of rows) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r, n, 1, gl.RGBA, gl.FLOAT, d.subarray(r * W * 4, r * W * 4 + n * 4));
    return true;
  }
  // the driver's number rides the tip of the nose
  function nosePose(bu, s, st) {
    const n = bu.nose;
    if (!n) return;
    const T = F1.Soft.template(s.kind), R = T.rest, P = s.p;
    if (st.noseNode == null) {
      let best = -1, bd = 1e9;
      for (let i = 0; i < T.n; i++) { const d = (R[i * 3] - n.position.x) ** 2 + (R[i * 3 + 2] - n.position.y) ** 2 + (R[i * 3 + 1] - n.position.z) ** 2; if (d < bd) { bd = d; best = i; } }
      st.noseNode = best; st.noseBase = n.position.clone();
    }
    const i = st.noseNode;
    n.position.set(st.noseBase.x + P[i * 3] - R[i * 3], st.noseBase.y + P[i * 3 + 2] - R[i * 3 + 2], st.noseBase.z + P[i * 3 + 1] - R[i * 3 + 1]);
    n.scale.setScalar(s.off[i] ? 1e-4 : 1);
  }

  // wheels follow their hubs: position, toe and camber from the bent suspension
  function wheelPose(bu, c, s) {
    const T = F1.Soft.template(s.kind), R = T.rest, P = s.p;
    T.corners.forEach((cn, k) => {
      const w = bu.wheels[k];
      if (!w || !w.parent || s.hubOff[k]) return;
      const wd = w.userData, H = cn.H;
      if (wd.baseX == null) { wd.baseX = w.position.x; wd.baseZ = w.position.z; }
      w.position.x = wd.baseX + P[H * 3] - R[H * 3];
      w.position.z = wd.baseZ + P[H * 3 + 1] - R[H * 3 + 1];
      w.position.y += P[H * 3 + 2] - R[H * 3 + 2];
      // (a wheel that has lost its track rod trails the way it is rolling: js/car.js w.flop)
      w.rotation.y = s.noSteer && s.noSteer[k] && c.wheels && c.wheels[k] ? -(c.wheels[k].flop || 0) : -((wd.front ? c.steer || 0 : 0) + Math.max(-0.6, Math.min(0.6, s.toe[k])));
      w.rotation.x = (k % 2 ? 1 : -1) * Math.max(-0.5, Math.min(0.5, s.camber[k] / 57.3));
    });
  }

  function syncSoft(scene, outer, c, s) {
    const body = outer.userData.body, bu = body.userData;
    const st = outer.userData.softState || (outer.userData.softState = { ver: -1, offVer: 0, n: 0, row: { v: 0 } });
    const r = rowOf(c, s);
    // bind the model to the structure up front (once per model, at the start of the race),
    // not in the middle of the first crash
    if (!st.bound) {
      for (const m of bodyMeshes(body)) {
        if (!m.userData.bindSrc) m.userData.bindSrc = m.geometry;
        const B = bindGeo(m.userData.bindSrc, s.kind);
        if (r) { bindAttrs(m.userData.bindSrc, B); if (m.geometry !== m.userData.bindSrc) bindAttrs(m.geometry, B); m.softRow = st.row; }
      }
      st.bound = true;
    }
    if (r) {
      // on the GPU: the car's row, written whenever the structure has moved
      if (s.ver > 0 && (rowOwner[r] !== s || rowVer[r] !== s.ver)) writeRow(r, s);
      st.row.v = s.ver > 0 ? r : 0;
      // (pieces come away at most ten times a second: the dense structure sheds small pieces many
      // times in a crash, and each time every body mesh's triangles are sorted again)
      if (st.offVer !== s.offVer && !(performance.now() - (st.cutT || 0) < 100)) {
        st.cutT = performance.now();
        // (and only the meshes that use a node that has come off, or been put back, since)
        const T = F1.Soft.template(s.kind), was = st.offSnap || (st.offSnap = new Uint8Array(T.n)), chg = [];
        for (let i = 0; i < T.n; i++) if (was[i] !== s.off[i]) { chg.push(i); was[i] = s.off[i]; }
        for (const m of bodyMeshes(body)) {
          const B = bindGeo(m.userData.bindSrc || m.geometry, s.kind);
          const used = B.used || (B.used = (() => { const u = new Uint8Array(T.n); for (let v = 0; v < B.prim.length; v++) u[B.prim[v]] = 1; return u; })());
          if (chg.some(i => used[i])) cutOff(scene, outer, c, m, s, true);
        }
        st.offVer = s.offVer;
      }
      st.ver = s.ver;
    } else {
      // (a car with no row is reshaped on the CPU, as before)
      // while the structure is still moving, reshape every other frame (the last shape always lands)
      if (s.awake && st.n++ % 2) return s.ver > 0 && wheelPose(bu, c, s);
      if (st.ver !== s.ver) {
        for (const m of bodyMeshes(body)) if (m.parent.visible && m.userData.sver !== s.ver) { skin(m, s); m.userData.sver = s.ver; }
        if (st.offVer !== s.offVer) { for (const m of bodyMeshes(body)) cutOff(scene, outer, c, m, s, false); st.offVer = s.offVer; }
        st.ver = s.ver;
      } else {
        // a detail level that has just come into view catches up
        for (const m of bodyMeshes(body)) if (m.parent.visible && m.userData.sver != null && m.userData.sver !== s.ver) { skin(m, s); m.userData.sver = s.ver; }
      }
    }
    if (s.ver > 0) { wheelPose(bu, c, s); nosePose(bu, s, st); }
  }

  // per frame, per car: apply new dents and breakages
  function sync(scene, outer, c, dt) {
    const dm = c.dm, body = outer.userData.body, bu = body.userData;
    if (!dm || !bu.lodGroups) return;
    if (dm.soft && F1.Soft) syncSoft(scene, outer, c, dm.soft);
    if (dm.hits.length || (dm.soft && dm.soft.ver > 0)) bu.hurt = true; // the far level has no dents to show
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

  F1.R3D = { sync, stepDebris, clearDebris, dent, dbgLaunch: launch, get debris() { return debris; } };
})(typeof window !== 'undefined' ? window : globalThis);
