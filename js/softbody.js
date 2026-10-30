// Node-and-beam soft body for the cars (the race setting Damage: FULL), in the manner of
// BeamNG: the car's structure is a network of point masses (nodes) joined by beams. Every
// beam has a rest length, a stiffness, a yield strain past which it bends for good (its rest
// length moves) and a breaking strain past which it snaps. An impact drives a contact plane
// into the nodes it reaches; the beams carry the load into the rest of the structure, the
// parts crumple, bend and snap, and whatever is no longer joined to the survival cell falls off.
//
// The survival cell (the monocoque, which no real crash deforms) is the fixed frame: its
// nodes are anchored in the car's own frame, so the network is solved relative to the rigid
// car that js/car.js drives. Handling stays with the calibrated tyre model; the soft body
// decides what that model sees: wing and floor damage (downforce), bent suspension (the
// toe and camber are read from the deformed uprights), broken links (wheels coming off),
// crushed sidepods (cooling) and the shape the colliders and the 3D model take.
//
// Frame: x forward, y right, z up, metres, matching the 3D model (whose own axes are x, z, y).
// The network sleeps until it is hit, so a car costs nothing until it crashes.
(function simModule(G) {
  'use strict';
  (G.F1simMods = G.F1simMods || []).push(simModule);
  const F1 = G.F1;

  // beam materials: [stiffness per iteration (0..1), yield strain, breaking strain, yield force N]
  const MAT = {
    gbox: [1, 0.03, 0.18, 120e3],     // gearbox casing: very stiff, cracks late
    nose: [0.45, 0.012, 0.5, 20e3],   // crash structure: crumples progressively
    rcs: [0.45, 0.012, 0.5, 30e3],    // rear crash structure
    wing: [0.8, 0.012, 0.075, 4e3],   // carbon wing elements: stiff but brittle
    pylon: [0.9, 0.02, 0.1, 10e3],    // wing mounts
    susp: [1, 0.016, 0.11, 25e3],     // wishbones, push rods, track rods
    upright: [1, 0.06, 0.4, 60e3],    // the uprights and hubs
    pod: [0.3, 0.008, 0.65, 6e3],     // sidepod bodywork and radiators: soft, deforms a long way
    floor: [0.55, 0.01, 0.15, 8e3],   // floor edges and diffuser
  };
  // how far (m) the nodes of a group may move before it counts as fully damaged
  const SCALE = { rcs: 0.3, gbox: 0.25, nose: 0.3, fwL: 0.15, fwR: 0.15, rw: 0.15, podL: 0.3, podR: 0.3, floor: 0.2 };
  const CORNER = ['sFL', 'sFR', 'sRL', 'sRR'];
  // the force (N) it takes to crush the material around a node of each part: a contact plane
  // pressing on a node must do this much work per metre it drives on (on top of what the
  // beams soak up as they bend), so crumple zones crush only as far as the energy allows
  const CRUSH = { gbox: 150e3, rcs: 45e3, nose: 28e3, fwL: 3e3, fwR: 3e3, rw: 3e3, sFL: 15e3, sFR: 15e3, sRL: 15e3, sRR: 15e3, podL: 9e3, podR: 9e3, floor: 10e3 };
  const LABEL = { fwL: 'FRONT WING', fwR: 'FRONT WING', rw: 'REAR WING', nose: 'NOSE', podL: 'SIDEPOD', podR: 'SIDEPOD', floor: 'FLOOR', gbox: 'GEARBOX' };

  // ---------------- the structure (built once, shared by every car) ----------------
  let TPL = null;
  function template() {
    if (TPL) return TPL;
    const N = [], B = [], groups = {}, keys = new Set();
    const node = (g, x, y, z, o) => {
      N.push({ g, x, y, z, fixed: !!(o && o.fixed), mass: (o && o.mass) || 1, rad: (o && o.rad) || 0.02, skin: (o && o.skin) || [1e6, 0.015], crush: (o && o.crush) || CRUSH[g] || 1e4 });
      (groups[g] = groups[g] || []).push(N.length - 1);
      return N.length - 1;
    };
    const dist = (a, b) => Math.hypot(N[a].x - N[b].x, N[a].y - N[b].y, N[a].z - N[b].z);
    const beam = (a, b, mat) => {
      if (a === b || (N[a].fixed && N[b].fixed)) return;
      const k = a < b ? a + ',' + b : b + ',' + a;
      if (keys.has(k)) return;
      keys.add(k); B.push([a, b, mat]);
    };
    // join every pair from two sets that are closer than maxD
    const mesh = (A, Bs, maxD, mat, ok) => { for (const a of A) for (const b of Bs) if (a !== b && dist(a, b) <= maxD && (!ok || ok(a, b))) beam(a, b, mat); };
    const sameSide = (a, b) => N[a].y * N[b].y >= -1e-6 || Math.abs(N[a].y) < 0.01 || Math.abs(N[b].y) < 0.01;
    const at = (g, f) => (groups[g] || []).filter(i => f(N[i]));

    // survival cell: anchored
    const TUB = [[-1.2, 0.3, 0.14, 0.72], [-0.3, 0.3, 0.14, 0.74], [0.6, 0.3, 0.14, 0.72], [1.4, 0.24, 0.14, 0.7], [2.1, 0.17, 0.16, 0.62]];
    for (const [x, w, z0, z1] of TUB) for (const s of [-1, 1]) for (const z of [z0, z1]) node('tub', x, s * w, z, { fixed: true });
    const tub = (x, s, top) => groups.tub.find(i => Math.abs(N[i].x - x) < 0.01 && Math.sign(N[i].y) === s && (top ? N[i].z > 0.4 : N[i].z < 0.4));

    // gearbox behind the engine, and the rear crash structure behind that (it crumples; the
    // gearbox, which carries the rear suspension, barely does)
    for (const s of [-1, 1]) { node('gbox', -1.7, s * 0.22, 0.18, { mass: 3 }); node('gbox', -1.7, s * 0.22, 0.62, { mass: 3 }); node('gbox', -2.05, s * 0.13, 0.25, { mass: 2 }); node('gbox', -2.05, s * 0.13, 0.52, { mass: 2 }); }
    mesh(groups.gbox, groups.gbox.concat(at('tub', n => n.x < -1)), 1.05, 'gbox');
    const rcs = [];
    for (const s of [-1, 1]) for (const z of [0.26, 0.44]) rcs.push(node('rcs', -2.28, s * 0.08, z));
    mesh(rcs, rcs.concat(at('gbox', n => n.x < -2)), 0.5, 'rcs');

    // nose cone: rings tapering to the tip
    for (const [x, w, z0, z1] of [[2.45, 0.14, 0.3, 0.6], [2.8, 0.1, 0.27, 0.47]]) for (const s of [-1, 1]) for (const z of [z0, z1]) node('nose', x, s * w, z);
    for (const s of [-1, 1]) node('nose', 3.15, s * 0.05, 0.31);
    mesh(groups.nose, groups.nose.concat(at('tub', n => n.x > 2)), 0.62, 'nose');

    // front wing: two halves, leading and trailing edge nodes across the span, endplate tops
    for (const [g, s] of [['fwL', -1], ['fwR', 1]]) {
      for (const y of [0.15, 0.45, 0.75, 0.97]) { node(g, 3.1 - (y > 0.7 ? 0.08 : 0), s * y, 0.14); node(g, 2.6, s * y, 0.3); }
      node(g, 2.78, s * 0.97, 0.42);
      mesh(groups[g], groups[g], 0.72, 'wing');
    }
    mesh(at('fwL', n => Math.abs(n.y) < 0.2), at('fwR', n => Math.abs(n.y) < 0.2), 0.6, 'wing');
    mesh(at('nose', n => n.x > 2.7), at('fwL', n => Math.abs(n.y) < 0.2).concat(at('fwR', n => Math.abs(n.y) < 0.2)), 0.5, 'pylon');

    // suspension: each corner an upright (hub, top and bottom ball joints, steering arm),
    // joined to the chassis by six links (two wishbones, push rod, track rod)
    const corner = (g, x, s, front) => {
      const H = node(g, x, s * 0.81, 0.38, { mass: 4, rad: 0.3, skin: [3e5, 0.07], crush: 30e3 }), // the tyre squashes before the hub moves
            Uu = node(g, x, s * 0.66, 0.55, { mass: 1.5 }), L = node(g, x, s * 0.66, 0.21, { mass: 1.5 }), S = node(g, x + (front ? 0.14 : -0.2), s * 0.66, 0.38);
      for (const [a, b] of [[H, Uu], [H, L], [H, S], [Uu, L], [Uu, S], [L, S]]) beam(a, b, 'upright');
      if (front) {
        beam(Uu, tub(1.4, s, true), 'susp'); beam(Uu, tub(2.1, s, true), 'susp');
        beam(L, tub(1.4, s, false), 'susp'); beam(L, tub(2.1, s, false), 'susp');
        beam(S, tub(2.1, s, false), 'susp'); beam(L, tub(1.4, s, true), 'susp'); // track rod, push rod
      } else {
        const gb = (x2, top) => groups.gbox.find(i => Math.abs(N[i].x - x2) < 0.01 && Math.sign(N[i].y) === s && (top ? N[i].z > 0.4 : N[i].z < 0.4));
        beam(Uu, tub(-1.2, s, true), 'susp'); beam(Uu, gb(-1.7, true), 'susp');
        beam(L, tub(-1.2, s, false), 'susp'); beam(L, gb(-1.7, false), 'susp');
        beam(S, gb(-2.05, false), 'susp'); beam(L, gb(-1.7, true), 'susp');
      }
      return { H, U: Uu, L, S };
    };
    const corners = [corner('sFL', 1.964, -1, true), corner('sFR', 1.964, 1, true), corner('sRL', -1.57, -1, false), corner('sRR', -1.57, 1, false)];

    // sidepods
    for (const [g, s] of [['podL', -1], ['podR', 1]]) {
      for (const [x, w, z0, z1] of [[-1.0, 0.56, 0.2, 0.6], [-0.2, 0.72, 0.18, 0.64], [0.6, 0.78, 0.18, 0.62], [1.2, 0.7, 0.24, 0.58]]) { node(g, x, s * w, z0); node(g, x, s * w, z1); }
      mesh(groups[g], groups[g].concat(at('tub', n => Math.sign(n.y) === s && n.x < 1.5)), 0.98, 'pod', sameSide);
    }
    // floor edges and the diffuser
    for (const s of [-1, 1]) {
      for (const x of [-1.3, -0.4, 0.5, 1.3]) node('floor', x, s * 0.82, 0.08);
      node('floor', -2.0, s * 0.48, 0.14);
    }
    const podLow = i => (N[i].g === 'podL' || N[i].g === 'podR') && N[i].z < 0.3;
    mesh(groups.floor, groups.floor.concat(groups.podL, groups.podR, groups.tub.filter(i => N[i].z < 0.4), groups.gbox.filter(i => N[i].z < 0.4)), 0.98, 'floor', (a, b) => sameSide(a, b) && (N[b].g === 'floor' || podLow(b) || N[b].g === 'tub' || N[b].g === 'gbox'));

    // rear wing on its pylon
    for (const x of [-1.95, -2.25]) for (const y of [-0.62, -0.2, 0.2, 0.62]) node('rw', x, y, 0.95);
    for (const s of [-1, 1]) node('rw', -2.1, s * 0.62, 0.55);
    mesh(groups.rw, groups.rw, 0.72, 'wing');
    mesh(at('rw', n => Math.abs(n.y) < 0.3), at('gbox', n => n.x < -2 && n.z > 0.4), 0.6, 'pylon');

    // flatten into typed arrays
    const n = N.length, nb = B.length;
    const T = {
      N, groups, corners, n, nb,
      rest: new Float32Array(n * 3), fixed: new Uint8Array(n), inv: new Float32Array(n), rad: new Float32Array(n), skinK: new Float32Array(n), skinMax: new Float32Array(n), crush: new Float32Array(n), grp: [],
      a: new Uint16Array(nb), b: new Uint16Array(nb), L0: new Float32Array(nb), k: new Float32Array(nb), yld: new Float32Array(nb), brk: new Float32Array(nb), F: new Float32Array(nb),
      gname: Object.keys(groups),
    };
    T.gid = {}; T.gname.forEach((g, i) => { T.gid[g] = i; });
    N.forEach((q, i) => { T.rest[i * 3] = q.x; T.rest[i * 3 + 1] = q.y; T.rest[i * 3 + 2] = q.z; T.fixed[i] = q.fixed ? 1 : 0; T.inv[i] = q.fixed ? 0 : 1 / q.mass; T.rad[i] = q.rad; T.skinK[i] = q.skin[0]; T.skinMax[i] = q.skin[1]; T.crush[i] = q.crush; T.grp.push(T.gid[q.g]); });
    B.forEach(([a, b, mat], i) => { T.a[i] = a; T.b[i] = b; T.L0[i] = dist(a, b); const M = MAT[mat]; T.k[i] = M[0]; T.yld[i] = M[1]; T.brk[i] = M[2]; T.F[i] = M[3]; });
    // beams touching each group (for the damage figures)
    T.gbeams = T.gname.map(() => []);
    // (a part counts its own beams; a suspension corner also counts the links that hold it, which
    // end on the chassis or the gearbox, and those do not count against the gearbox)
    const isCorner = gi => CORNER.includes(T.gname[gi]);
    for (let i = 0; i < nb; i++) {
      const ga = T.grp[T.a[i]], gb = T.grp[T.b[i]];
      if (ga === gb) T.gbeams[ga].push(i);
      else { if (isCorner(ga)) T.gbeams[ga].push(i); if (isCorner(gb)) T.gbeams[gb].push(i); }
    }
    // rest axle directions of the four corners (for toe and camber)
    T.axle0 = corners.map((c, k) => axle(T.rest, c, k));
    TPL = T;
    return T;
  }

  // The wheel's axle from its upright: the hub minus the middle of the kingpin. Returns
  // [heading, tilt] in radians: heading > 0 turns the wheel to the right (+y), tilt > 0 lifts
  // the axle's outer end (the top of the wheel leans in: negative camber).
  function axle(p, c, k) {
    const s = k % 2 ? 1 : -1;
    const mx = (p[c.U * 3] + p[c.L * 3]) / 2, my = (p[c.U * 3 + 1] + p[c.L * 3 + 1]) / 2, mz = (p[c.U * 3 + 2] + p[c.L * 3 + 2]) / 2;
    const hx = p[c.H * 3] - mx, hy = p[c.H * 3 + 1] - my, hz = p[c.H * 3 + 2] - mz;
    return [Math.atan2(-s * hx, s * hy), Math.atan2(hz, s * hy)];
  }

  // ---------------- per car ----------------
  function init(c) {
    const T = template();
    const s = {
      p: Float32Array.from(T.rest), q: Float32Array.from(T.rest), L0: Float32Array.from(T.L0),
      broken: new Uint8Array(T.nb), off: new Uint8Array(T.n), planes: [], awake: 0, idle: 0,
      ver: 0, offVer: 0, gp: new Float32Array(T.gname.length), toe: [0, 0, 0, 0], camber: [0, 0, 0, 0], hubOff: [false, false, false, false],
      events: [], cc: null, energy: 0,
    };
    return s;
  }

  // An impact at a point (lx, ly) in the car's frame, the contact normal (nx, ny) pointing into
  // the car, closing speed vn (m/s). A contact plane drives into the structure carrying the
  // energy of the hit (the car's effective mass at the closing speed); it slows as the beams
  // it bends and breaks soak that energy up (each beam resists with its yield force), so a
  // stiff part gives a little and a soft one a lot. It never passes the survival cell. A
  // car-to-car hit has a contact of limited size; a wall is flat and long.
  const M_EFF = 650;
  // (tx, ty): how fast the other surface slides past the car at the contact (car frame); the
  // contact drags what it presses on with it (Coulomb friction), which is what tears wings
  // and wheels off in a glancing hit
  function impact(s, lx, ly, nx, ny, vn, patch, tx, ty) {
    const T = template();
    if (vn < 1.6) return null;
    const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
    const R = patch || 2.2;
    let Dmax = 1.5;
    for (let i = 0; i < T.n; i++) {
      if (!T.fixed[i]) continue;
      const px = T.rest[i * 3] - lx, py = T.rest[i * 3 + 1] - ly;
      const dn = px * nx + py * ny, tx = px - dn * nx, ty = py - dn * ny;
      if (tx * tx + ty * ty > R * R) continue;
      Dmax = Math.min(Dmax, Math.max(0, dn - 0.03));
    }
    if (Dmax <= 0.001) return null;
    // (below a couple of metres a second the contact is elastic: tyres and bodywork just bounce;
    // car-to-car contact is softer still, both cars' tyres and panels give)
    const v0 = patch ? 2.4 : 1.2;
    if (vn <= v0) return null;
    const E = 0.5 * M_EFF * (vn - v0) * (vn - v0);
    // the rigid collision circles are approximate: start the plane at the outermost surface of
    // the structure in the patch, so nothing begins the hit already pushed in
    let d0 = 0;
    for (let i = 0; i < T.n; i++) {
      if (T.fixed[i] || s.off[i]) continue;
      const px = s.p[i * 3] - lx, py = s.p[i * 3 + 1] - ly;
      const dn = px * nx + py * ny, tx = px - dn * nx, ty = py - dn * ny;
      if (tx * tx + ty * ty > R * R) continue;
      d0 = Math.min(d0, dn + T.rad[i]);
    }
    // keep only the sliding part along the plane
    let vt = (tx || 0) * -ny + (ty || 0) * nx;
    s.planes.push({ x: lx, y: ly, nx, ny, R, Dmax, d: d0, v: vn, E, E0: E, hold: 0, tx: -ny * vt, ty: nx * vt, vt: Math.abs(vt), skin: new Float32Array(T.n), seen: new Int32Array(T.n) });
    s.awake = 1; s.idle = 0; s.age = 0;
    return E;
  }

  const SUB = 2, ITER = 6, DAMP = 0.9, MU = 0.6;
  // one race step for the car's structure; returns true when something broke off
  function step(s, dt) {
    if (!s.awake) return false;
    const T = template(), p = s.p, q = s.q, L0 = s.L0, br = s.broken, off = s.off;
    const h = dt / SUB;
    let snapped = false, moved = 0;
    for (let sub = 0; sub < SUB; sub++) {
      // planes advance at the speed their remaining energy gives; spent or at the survival
      // cell, they hold for a moment and let go (the elastic part springs back)
      for (const P of s.planes) {
        const d0 = P.d;
        if (P.E > 0 && P.d < P.Dmax) P.d = Math.min(P.Dmax, P.d + P.v * Math.sqrt(P.E / P.E0) * h);
        else P.hold += h;
        P.adv = P.d - d0; P.tick = (P.tick || 0) + 1;
      }
      s.planes = s.planes.filter(P => P.hold < 0.02);
      let work = 0;
      // integrate (positions only; no gravity in the car's frame)
      for (let i = 0; i < T.n; i++) {
        if (T.fixed[i] || off[i]) continue;
        const i3 = i * 3;
        for (let k = 0; k < 3; k++) { const x = p[i3 + k], v = (x - q[i3 + k]) * DAMP; q[i3 + k] = x; p[i3 + k] = x + v; }
      }
      for (let it = 0; it < ITER; it++) {
        for (let e = 0; e < T.nb; e++) {
          if (br[e]) continue;
          const a = T.a[e], b = T.b[e], wa = off[a] ? 0 : T.inv[a], wb = off[b] ? 0 : T.inv[b], w = wa + wb;
          if (w === 0) continue;
          const a3 = a * 3, b3 = b * 3;
          const dx = p[b3] - p[a3], dy = p[b3 + 1] - p[a3 + 1], dz = p[b3 + 2] - p[a3 + 2];
          const L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
          const f = T.k[e] * (L - L0[e]) / (L * w);
          p[a3] += dx * f * wa; p[a3 + 1] += dy * f * wa; p[a3 + 2] += dz * f * wa;
          p[b3] -= dx * f * wb; p[b3 + 1] -= dy * f * wb; p[b3 + 2] -= dz * f * wb;
        }
        // contact planes: nothing in the contact patch stays on the wrong side
        for (const P of s.planes) {
          for (let i = 0; i < T.n; i++) {
            if (T.fixed[i] || off[i]) continue;
            const i3 = i * 3, px = p[i3] - P.x, py = p[i3 + 1] - P.y;
            const dn = px * P.nx + py * P.ny, tx = px - dn * P.nx, ty = py - dn * P.ny;
            if (tx * tx + ty * ty > P.R * P.R) continue;
            // overlap with the node's surface, as squashed so far by this contact
            let pen = P.d - (dn + T.rad[i] - P.skin[i]);
            // the surface first gives elastically (a tyre squashes, a panel flexes): that costs
            // the plane energy but moves nothing for good
            if (pen > 0 && P.skin[i] < T.skinMax[i]) {
              const s0 = P.skin[i], s1 = Math.min(T.skinMax[i], s0 + pen);
              work += 0.5 * T.skinK[i] * (s1 * s1 - s0 * s0); P.skin[i] = s1; pen -= s1 - s0;
            }
            if (pen > 0) {
              p[i3] += P.nx * pen; p[i3 + 1] += P.ny * pen;
              if (P.seen[i] !== P.tick) { P.seen[i] = P.tick; work += T.crush[i] * P.adv; } // crushing it as the plane drives on
              // friction: dragged along by the sliding surface while the plane drives in, at most
              // mu times as far as it pushes (once per substep)
              if (it === 0 && P.vt > 0.1 && P.adv > 0) { const f = Math.min(P.vt * h, MU * P.adv) / P.vt; p[i3] += P.tx * f; p[i3 + 1] += P.ty * f; work += T.crush[i] * f * P.vt; }
            }
          }
        }
      }
      // plasticity and fracture
      for (let e = 0; e < T.nb; e++) {
        if (br[e]) continue;
        const a3 = T.a[e] * 3, b3 = T.b[e] * 3;
        const L = Math.hypot(p[b3] - p[a3], p[b3 + 1] - p[a3 + 1], p[b3 + 2] - p[a3 + 2]);
        // it snaps past its breaking strain (counted from its original length) and bends for
        // good past its yield strain (counted from its present rest length)
        if (Math.abs(L - T.L0[e]) > T.brk[e] * T.L0[e]) { br[e] = 1; snapped = true; work += T.F[e] * T.L0[e] * 0.25; continue; }
        const strain = (L - L0[e]) / L0[e];
        if (Math.abs(strain) > T.yld[e]) { const n0 = L / (1 + Math.sign(strain) * T.yld[e]); work += T.F[e] * Math.abs(n0 - L0[e]); L0[e] = n0; }
      }
      // the energy the structure soaked up comes off the planes driving into it
      if (work > 0 && s.planes.length) { const share = work / s.planes.length; for (const P of s.planes) P.E -= share; }
      s.energy += work;
    }
    for (let i = 0; i < T.n; i++) { if (T.fixed[i] || off[i]) continue; const i3 = i * 3; moved = Math.max(moved, Math.abs(p[i3] - q[i3]) + Math.abs(p[i3 + 1] - q[i3 + 1]) + Math.abs(p[i3 + 2] - q[i3 + 2])); }
    s.ver++;
    let detached = false;
    if (snapped) detached = connectivity(s);
    measure(s);
    // asleep once it has stopped moving and nothing is pushing
    // (a part left dangling by broken links can keep swinging: it is put to sleep after a while)
    s.age = (s.age || 0) + dt;
    if (!s.planes.length && (moved < 1e-4 || s.age > 1.5)) { s.idle += dt; if (s.idle > 0.08) s.awake = 0; } else s.idle = 0;
    return detached;
  }

  // nodes no longer joined (through unbroken beams) to the survival cell come off
  function connectivity(s) {
    const T = template(), seen = new Uint8Array(T.n), stack = [];
    for (let i = 0; i < T.n; i++) if (T.fixed[i]) { seen[i] = 1; stack.push(i); }
    if (!T.adj) {
      T.adj = Array.from({ length: T.n }, () => []);
      for (let e = 0; e < T.nb; e++) { T.adj[T.a[e]].push(e); T.adj[T.b[e]].push(e); }
    }
    while (stack.length) {
      const i = stack.pop();
      for (const e of T.adj[i]) {
        if (s.broken[e]) continue;
        const j = T.a[e] === i ? T.b[e] : T.a[e];
        if (!seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    let any = false;
    for (let i = 0; i < T.n; i++) if (!seen[i] && !s.off[i]) { s.off[i] = 1; any = true; }
    if (any) s.offVer++;
    return any;
  }

  // damage figures per group, wheel geometry, part losses, colliders
  function measure(s) {
    const T = template(), p = s.p;
    T.gname.forEach((g, gi) => {
      if (g === 'tub') return;
      const nodes = T.groups[g];
      let d = 0, nOff = 0;
      for (const i of nodes) {
        if (s.off[i]) { nOff++; continue; }
        const i3 = i * 3; d += Math.hypot(p[i3] - T.rest[i3], p[i3 + 1] - T.rest[i3 + 1], p[i3 + 2] - T.rest[i3 + 2]);
      }
      const live = nodes.length - nOff;
      const disp = live ? d / live : 0;
      let nb = 0; for (const e of T.gbeams[gi]) nb += s.broken[e];
      const bf = nb / Math.max(1, T.gbeams[gi].length);
      s.gp[gi] = Math.min(1, Math.max(disp / (SCALE[g] || 0.1), bf * 2.5, nOff / nodes.length > 0.5 ? 1 : 0));
    });
    T.corners.forEach((c, k) => {
      const a = axle(p, c, k), a0 = T.axle0[k];
      s.toe[k] = a[0] - a0[0];
      s.camber[k] = -(a[1] - a0[1]) * 57.3; // degrees, as js/car.js counts camber
      s.hubOff[k] = !!s.off[c.H];
      const gi = T.gid[CORNER[k]];
      let nb = 0; for (const e of T.gbeams[gi]) nb += s.broken[e];
      s.gp[gi] = s.hubOff[k] ? 1 : Math.min(1, Math.max(Math.abs(s.toe[k]) / 0.06, Math.abs(s.camber[k]) / 4, nb / T.gbeams[gi].length * 2.5));
    });
    colliders(s);
  }

  // part names that have come off (most of their nodes gone)
  function lost(s) {
    const T = template(), out = [];
    for (const g of T.gname) {
      if (g === 'tub' || CORNER.includes(g)) continue;
      const nodes = T.groups[g];
      let n = 0; for (const i of nodes) n += s.off[i];
      if (n / nodes.length >= 0.5) out.push(g);
    }
    return out;
  }

  // The rigid collision circles (race.js) follow the structure: each is tied to its nearest
  // node and moves with it, and goes when that node comes off.
  function colliders(s) {
    const CC = F1.Race && F1.Race.CC;
    if (!CC) return;
    const T = template();
    if (!T.ccBind) {
      T.ccBind = CC.map(([x, y]) => {
        let best = -1, bd = 1e9;
        for (let i = 0; i < T.n; i++) { const d = (T.rest[i * 3] - x) ** 2 + (T.rest[i * 3 + 1] - y) ** 2; if (d < bd) { bd = d; best = i; } }
        return best;
      });
    }
    const cc = s.cc || (s.cc = new Float32Array(CC.length * 3));
    CC.forEach(([x, y, r], k) => {
      const i = T.ccBind[k];
      if (s.off[i]) { cc[k * 3] = 0; cc[k * 3 + 1] = 0; cc[k * 3 + 2] = 0; return; }
      cc[k * 3] = x + s.p[i * 3] - T.rest[i * 3];
      cc[k * 3 + 1] = y + s.p[i * 3 + 1] - T.rest[i * 3 + 1];
      cc[k * 3 + 2] = r;
    });
  }

  // the pit crew: a new nose and front wing (nodes back to their rest places, beams renewed)
  function repair(s, gnames) {
    const T = template(), want = new Set(gnames.map(g => T.gid[g]));
    for (let i = 0; i < T.n; i++) {
      if (!want.has(T.grp[i])) continue;
      for (let k = 0; k < 3; k++) s.p[i * 3 + k] = s.q[i * 3 + k] = T.rest[i * 3 + k];
      s.off[i] = 0;
    }
    for (let e = 0; e < T.nb; e++) if (want.has(T.grp[T.a[e]]) || want.has(T.grp[T.b[e]])) { s.broken[e] = 0; s.L0[e] = T.L0[e]; }
    s.offVer++; s.ver++; s.repairs = (s.repairs || 0) + 1;
    connectivity(s);
    measure(s);
    s.awake = 1; s.idle = 0;
  }

  F1.Soft = { MAT, LABEL, CORNER, template, init, impact, step, measure, lost, repair, get gid() { return template().gid; } };
})(typeof window !== 'undefined' ? window : globalThis);
