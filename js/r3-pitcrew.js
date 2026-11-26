// Pit crews: each team's people at its pit box, animated in time with the race's own stop.
// The race (js/ai.js pitDrive) gives a car in the pit lane car.brain.pit = { phase: 'in' | 'stop' |
// 'out', service (s), serviceT (s left) }. A team's crew waits in its garage's mouth; when one of
// its cars is on its way in they walk out to their places round the box, and through the stop they
// follow its clock: jacks in, the car up, wheel guns on, the old tyres off and the new ones on, the
// guns again, hands up, the car down, the crew back as it leaves, then back to the garage.
// Sixteen people a team: four wheel gunners, four on the old tyres, four with the new ones, the front
// and rear jack men, two on the sides. Low-poly figures in the team's overalls, one instanced mesh a
// body part for every crew on the lap (a handful of draws), only the moving ones re-posed.
(function (G) {
  'use strict';
  const F1 = G.F1, U = F1.U, Tracks = F1.Tracks;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  // The crew's places in the car's frame: x forward from the car's centre, y to its right (m), from
  // the F1 broadcast and the teams' own explainers (F1.com 'Anatomy of a pit stop', Mercedes 'Box box'):
  // a gunner kneeling at each wheel, the wheel-off man just ahead of the axle and the wheel-on man just
  // behind it with the new tyre, the front jack man in the car's path ahead of the nose, the rear jack
  // man waiting beside the car's path and stepping in behind it once it stops, a stabiliser at each
  // sidepod, a front-wing man at each endplate, the release controller ahead on the garage side.
  // yaw: the way a person faces, turned from the car's heading (+pi/2 to its right); gs: y is taken on
  // the garage's side
  const AX = 1.8; // the axles from the car's centre (a 3.6 m wheelbase)
  const ROLES = [];
  for (const [fx, sx] of [[1, -1], [1, 1], [-1, -1], [-1, 1]]) {
    ROLES.push({ r: 'g', x: fx * AX, y: sx * 1.22, yaw: -sx * Math.PI / 2, corner: [fx, sx] });
    ROLES.push({ r: 'o', x: fx * AX + 0.5, y: sx * 1.5, yaw: -sx * Math.PI / 2, corner: [fx, sx] });
    ROLES.push({ r: 'n', x: fx * AX - 0.55, y: sx * 1.55, yaw: -sx * Math.PI / 2, corner: [fx, sx] });
  }
  ROLES.push({ r: 'j', x: 3.6, y: 0, yaw: Math.PI, front: true });
  ROLES.push({ r: 'j', x: -3.6, y: 0, yaw: 0, front: false, waitX: -2.7, waitY: 1.8 });
  ROLES.push({ r: 's', x: -0.1, y: -1.2, yaw: Math.PI / 2 });
  ROLES.push({ r: 's', x: -0.1, y: 1.2, yaw: -Math.PI / 2 });
  ROLES.push({ r: 'w', x: 2.65, y: -1.25, yaw: Math.PI / 2 });
  ROLES.push({ r: 'w', x: 2.65, y: 1.25, yaw: -Math.PI / 2 });
  ROLES.push({ r: 'c', x: 4.4, y: 2.5, gs: true, yaw: Math.PI });
  const NPER = ROLES.length;

  // parts (unit boxes and a tyre), each an instanced mesh over every crew
  const PARTS = ['torso', 'head', 'armL', 'armR', 'legL', 'legR', 'shinL', 'shinR', 'tyre', 'gun', 'jack'];
  let S = null; // the lap's crews: { meshes, crews, tr }
  const M4 = new THREE.Matrix4(), M5 = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), PV = new THREE.Vector3(), SC = new THREE.Vector3();
  const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);

  function build(tr, W2, root, opt) {
    S = null;
    const boxes = W2.decor.filter(it => it.type === 'box');
    if (!boxes.length || W2.town && !boxes.length) return;
    const std = opt.std, col = opt.col;
    const unit = new THREE.BoxGeometry(1, 1, 1), tyreG = new THREE.CylinderGeometry(0.33, 0.33, 0.3, 14); tyreG.rotateX(Math.PI / 2); // (its axis the way its carrier faces: onto the hub)
    const geo = { torso: unit, head: unit, armL: unit, armR: unit, legL: unit, legR: unit, shinL: unit, shinR: unit, tyre: tyreG, gun: unit, jack: unit };
    const n = boxes.length * NPER;
    const mat = std({ color: '#ffffff', roughness: 0.75 });
    const dark = std({ color: '#ffffff', roughness: 0.5, metalness: 0.2 });
    const meshes = {};
    for (const p of PARTS) {
      const im = new THREE.InstancedMesh(geo[p], p === 'tyre' || p === 'gun' || p === 'jack' ? dark : mat, n);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.castShadow = true; im.receiveShadow = true;
      im.userData.cat = 'venue';
      meshes[p] = im;
      root.add(im);
    }
    // where every crew can be: the pit lane, a sphere over it, for the cull (the instances move)
    let cx = 0, cz = 0; for (const b of boxes) { cx += b.x; cz += b.y; } cx /= boxes.length; cz /= boxes.length;
    let rad = 0; for (const b of boxes) rad = Math.max(rad, Math.hypot(b.x - cx, b.y - cz));
    const cy = Tracks.groundAt(tr, cx, cz);
    for (const p of PARTS) meshes[p].boundingSphere = new THREE.Sphere(V(cx, cy, cz), rad + 30);
    const c = new THREE.Color();
    const crews = boxes.map((b, k) => {
      const team = b.team, base = team.base === '#121417' ? '#2a2d33' : team.base;
      // per person: overalls in the team's colour, helmet in its accent, kit dark
      for (let q = 0; q < NPER; q++) {
        const i = k * NPER + q;
        c.set(base); for (const p of ['torso', 'armL', 'armR', 'legL', 'legR', 'shinL', 'shinR']) meshes[p].setColorAt(i, c);
        c.set(team.accent || '#ffffff'); meshes.head.setColorAt(i, c);
        c.set('#141517'); meshes.tyre.setColorAt(i, c); meshes.jack.setColorAt(i, c);
        c.set('#c9ccd0'); meshes.gun.setColorAt(i, c);
      }
      const gy = Tracks.groundAt(tr, b.x, b.y);
      return { k, team, box: b, gy, side: tr.pit.side, state: 'idle', t: 0, from: null, w: 0, dirty: true, car: null };
    });
    for (const p of PARTS) { if (meshes[p].instanceColor) meshes[p].instanceColor.needsUpdate = true; }
    S = { meshes, crews, tr, time: 0 };
    for (const cr of crews) pose(cr, 0);
    for (const p of PARTS) meshes[p].instanceMatrix.needsUpdate = true;
  }

  // a person's pose: place, heading, crouch (0 standing .. 1 kneeling), lean, arms forward (0..1),
  // walk phase (legs swinging), and what they carry
  function person(cr, q, P) {
    const ms = S.meshes, i = cr.k * NPER + q;
    // root frame
    E.set(0, P.yaw, 0); Q.setFromEuler(E);
    const R = new THREE.Matrix4().compose(V(P.x, P.y, P.z), Q, V(1, 1, 1));
    const set = (name, ox, oy, oz, rx, rz, sx, sy, sz, pivotY) => {
      // a part hung from a pivot at (ox, oy, oz), turned rx about the person's x (forward swing) then
      // rz about z, the box's centre pivotY below the pivot
      E.set(rx, 0, rz); Q.setFromEuler(E);
      M5.compose(PV.set(ox, oy, oz), Q, SC.set(1, 1, 1));
      M4.makeTranslation(0, -pivotY, 0); M5.multiply(M4);
      M4.makeScale(sx, sy, sz); M5.multiply(M4);
      ms[name].setMatrixAt(i, M4.multiplyMatrices(R, M5));
    };
    // Legs, a thigh and a shin each. Kneeling (crouch 1, a wheel gunner): the front knee up, its
    // thigh forward and its shin down to the foot; the back knee on the ground, its shin back along it.
    // A squat between. (About x a negative turn takes a hanging limb forward, to +z.)
    const c = U.clamp(P.crouch || 0, 0, 1), hip = 0.93 - 0.42 * c, sw = P.walk ? Math.sin(P.walk) * 0.5 : 0;
    const TH = 0.46;
    const leg = (side, th, name, shin) => {
      const kx = side * 0.1, kz = -Math.sin(th) * TH, ky = hip - Math.cos(th) * TH;
      set(name, kx, hip, 0, th, 0, 0.17, TH, 0.19, TH / 2);
      return [kx, ky, kz];
    };
    // front leg: thigh forward by up to 75 degrees, the shin straight down from the knee to the ground
    const tF = -(c * 1.3) - sw, kF = leg(-1, tF, 'legL');
    set('shinL', kF[0], kF[1], kF[2], c > 0.3 ? 0 : -tF * 0.3 + sw * 0.6, 0, 0.15, Math.max(0.2, kF[1]), 0.17, Math.max(0.2, kF[1]) / 2);
    // back leg: the thigh down and a little back, the shin back along the ground when kneeling
    const tB = c * 0.2 + sw, kB = leg(1, tB, 'legR');
    const shinB = c > 0.5 ? 1.45 * U.smooth((c - 0.5) / 0.4) : 0;
    set('shinR', kB[0], kB[1], kB[2], shinB - sw * 0.6, 0, 0.15, Math.max(0.2, kB[1] / Math.max(0.2, Math.cos(shinB))), 0.17, Math.max(0.2, kB[1] / Math.max(0.2, Math.cos(shinB))) / 2);
    const lean = 0.3 * c + (P.lean || 0);
    // torso from the hip, leaning forward; head on top
    E.set(lean, 0, 0); Q.setFromEuler(E);
    const top = V(0, 0.62, 0).applyQuaternion(Q).add(V(0, hip, 0));
    set('torso', 0, hip, 0, lean, 0, 0.42, 0.62, 0.26, -0.31);
    set('head', top.x, top.y + 0.15, top.z, lean * 0.5, 0, 0.23, 0.26, 0.26, 0);
    const arm = -((P.arms || 0) * 1.45 + lean * 0.5), sh = top.clone().add(V(0, -0.05, 0));
    set('armL', sh.x - 0.27, sh.y, sh.z, arm + (P.armL || 0), 0.08, 0.11, 0.6, 0.11, 0.3);
    set('armR', sh.x + 0.27, sh.y, sh.z, arm + (P.armR || 0), -0.08, 0.11, 0.6, 0.11, 0.3); // (armR < 0: the hand up)
    // the hands, roughly: the arm's end
    const hand = V(0, -0.6, 0).applyEuler(new THREE.Euler(arm, 0, 0)).add(sh);
    if (P.tyre) {
      const tp = P.tyreAt || V(hand.x, hand.y - 0.05, hand.z + 0.25);
      ms.tyre.setMatrixAt(i, M4.multiplyMatrices(R, M5.makeTranslation(tp.x, tp.y, tp.z)));
    } else ms.tyre.setMatrixAt(i, HIDE);
    if (P.gun) ms.gun.setMatrixAt(i, M4.multiplyMatrices(R, M5.compose(PV.set(hand.x + 0.27, hand.y, hand.z + 0.15), Q.identity(), SC.set(0.09, 0.14, 0.34))));
    else ms.gun.setMatrixAt(i, HIDE);
    if (P.jack != null) {
      // the jack's long handle from the hands down to the car (P.jack 0 out .. 1 under the car)
      E.set(0.42 - 0.2 * P.jack, 0, 0); Q.setFromEuler(E);
      ms.jack.setMatrixAt(i, M4.multiplyMatrices(R, M5.compose(PV.set(0, 0.55, 0.85 + 0.35 * P.jack), Q, SC.set(0.08, 0.08, 1.9))));
    } else ms.jack.setMatrixAt(i, HIDE);
  }

  // the box's frame (or the car's, while it stands there) to the world
  function frame(cr) {
    const c = cr.car, b = cr.box;
    if (c && cr.state === 'stop') return { x: c.x, y: c.y, h: c.h, gy: cr.gy };
    return { x: b.x, y: b.y, h: b.h, gy: cr.gy };
  }
  const toWorld = (F, lx, ly) => [F.x + Math.cos(F.h) * lx - Math.sin(F.h) * ly, F.y + Math.sin(F.h) * lx + Math.cos(F.h) * ly];

  // each role's waiting place, in the garage's mouth (box frame)
  function waitAt(cr, q) {
    const side = cr.side, row = q % 2, col = Math.floor(q / 2);
    return [-4.2 + col * 1.2, side * (4.4 + row * 0.9)];
  }

  function pose(cr, dt) {
    const F = frame(cr), st = cr.state, u = cr.u || 0;
    for (let q = 0; q < NPER; q++) {
      const R = ROLES[q];
      // where this person is: between waiting and ready places by cr.w (0 waiting .. 1 at the box)
      const wa = waitAt(cr, q), w = U.smooth(U.clamp(cr.w, 0, 1));
      let lx = wa[0] + (R.x - wa[0]) * w, ly = wa[1] + (R.y - wa[1]) * w;
      const P = { crouch: 0, arms: 0, yaw: 0, walk: cr.moving ? cr.t * 9 + q : 0 };
      // facing: toward the lane while waiting, their role's way at the box
      const yawBox = R.yaw, yawWait = cr.side > 0 ? -Math.PI / 2 : Math.PI / 2;
      let yaw = w > 0.5 ? yawBox : yawWait;
      // (walking: facing the way they go)
      if (cr.moving) yaw = Math.atan2((R.y - wa[1]) * cr.dir, (R.x - wa[0]) * cr.dir);
      if (R.gs) ly = wa[1] + (R.y * cr.side - wa[1]) * w;
      if (st === 'stop' || st === 'ready') {
        // The stop's own clock, u 0..1 of its length, timed from a 2.2 s stop (F1.com): the front jack
        // in and the car up by 0.3 s (u 0.14), the rear by 0.4 s; wheels off by 0.6 s; the front jack
        // man swivels aside from 0.8 s; new wheels on by 1.2 s, guns on by 1.4 s; hands up at 1.9 s;
        // the jacks drop at 2.1 s, the light goes green, the car goes.
        const s = st === 'stop' ? u : 0;
        if (R.r === 'g') { P.crouch = 1; P.gun = true; P.arms = 0.8; P.lean = 0.25; if (s > 0.84) P.armR = -2.3 * U.smooth((s - 0.84) / 0.06); }
        else if (R.r === 'o') {
          // the old wheel off the hub and pulled out (0.18..0.3), then held as he backs away
          P.crouch = 0.75; P.arms = 0.95;
          const off = U.smooth((s - 0.17) / 0.12);
          if (s > 0.17) { P.tyre = true; P.tyreAt = V(0, 0.5, 0.55); ly += R.corner[1] * 0.75 * off; lx += 0.25 * off; }
        } else if (R.r === 'n') {
          // the new wheel held upright at hub height, slid onto the hub (0.4..0.55)
          P.crouch = 0.65; P.arms = 0.95; P.tyre = st === 'ready' || s < 0.55;
          const on = U.smooth((s - 0.4) / 0.15);
          if (st === 'stop') { ly -= R.corner[1] * 0.38 * on; lx += 0.3 * on; }
          if (P.tyre) P.tyreAt = V(0, 0.5, 0.55);
        } else if (R.r === 'j') {
          const up = R.front ? U.smooth(s / 0.14) : U.smooth((s - 0.06) / 0.12), down = U.smooth((s - 0.94) / 0.03);
          P.jack = st === 'stop' ? up * (1 - down) : 0; P.lean = 0.3 + 0.3 * P.jack; P.arms = 0.65;
          if (R.front && st === 'stop') { const aside = U.smooth((s - 0.36) / 0.37); ly += cr.side * 1.5 * aside; }
          if (!R.front) {
            // waiting beside the car's path; behind the car once it has stopped
            const into = st === 'stop' ? U.smooth(s / 0.1) : 0, wx = R.waitX, wy = R.waitY * cr.side;
            lx = wa[0] + (wx + (R.x - wx) * into - wa[0]) * w; ly = wa[1] + (wy + (R.y - wy) * into - wa[1]) * w;
            if (into < 0.5) yaw = -cr.side * Math.PI / 2;
          }
        } else if (R.r === 's') { P.lean = 0.3; P.arms = st === 'stop' && s < 0.92 ? 0.95 : 0.25; }
        else if (R.r === 'w') { P.crouch = 0.8; P.arms = st === 'stop' && s > 0.08 && s < 0.72 ? 0.9 : 0.4; }
        else if (R.r === 'c') { P.arms = 0.15; if (st === 'stop' && s > 0.93) P.armR = -2.4 * U.smooth((s - 0.93) / 0.05); }
      } else if (st === 'release') {
        // stepping back from the car as it goes
        const back = U.smooth(cr.t / 0.6);
        if (R.gs) ly = R.y * cr.side;
        // (everyone at least 1.8 m out from the car's axis, the old wheels carried back with them)
        ly += Math.sign(R.y || cr.side) * Math.max(0, 1.9 - Math.abs(R.y)) * back; if (R.r === 'j') lx += (R.front ? 0 : -1) * back, ly += R.front ? cr.side * 1.5 : 0;
        if (R.r === 'o') { P.tyre = true; P.tyreAt = V(0, 0.5, 0.55); ly += Math.sign(R.y) * 0.75; }
        P.crouch = R.r === 'g' ? 1 - back : 0; P.gun = R.r === 'g'; P.arms = 0.3;
      }
      const [wx, wz] = toWorld(F, lx, ly);
      P.x = wx; P.y = F.gy; P.z = wz;
      // three's y rotation: local +z to (sin, cos); a person faces local +z
      const hW = F.h + yaw;
      P.yaw = Math.PI / 2 - hW;
      person(cr, q, P);
    }
  }

  // the race's state for this crew: its car on the way in, stopped or leaving
  function update(cars, dt) {
    if (!S) return;
    S.time += dt;
    let any = false;
    for (const cr of S.crews) {
      let car = null, best = 1e9;
      for (const c of cars) {
        const p = c.brain && c.brain.pit;
        if (!p || !c.team || c.team !== cr.team && c.team.id !== cr.team.id) continue;
        const rank = p.phase === 'stop' ? 0 : p.phase === 'in' && !p.served ? 1 : p.phase === 'in' || p.phase === 'out' ? 2 : 3;
        if (rank < best) { best = rank; car = c; }
      }
      const was = cr.state;
      cr.car = car;
      const p = car && car.brain.pit;
      let next = 'idle';
      if (p && p.phase === 'stop') next = 'stop';
      // (out to their marks while the car is in the lane, or on its in-lap within 900 m of the entry:
      // the real crews are in place some 15 to 20 s before it arrives)
      else if (p && !p.served && (p.phase === 'in' || p.phase === 'approach' && car.loc && Tracks.fwd(S.tr, car.loc.s, S.tr.pit.sIn) < 900)) next = 'ready';
      else if (p && p.served && (p.phase === 'in' || p.phase === 'out') && was !== 'idle') next = was === 'release' && cr.t > 1.2 ? 'back' : (was === 'back' ? 'back' : 'release');
      else if (was === 'release' || was === 'back') next = 'back';
      if (next !== was) { cr.state = next; cr.t = 0; }
      cr.t += dt;
      // walking out to the box while a car is on its way, back to the garage afterwards (about 2 s)
      const target = cr.state === 'idle' || cr.state === 'back' ? 0 : 1, w0 = cr.w;
      cr.w += U.clamp(target - cr.w, -dt / 2.2, dt / 2.2);
      cr.moving = Math.abs(cr.w - w0) > 1e-5; cr.dir = target > w0 ? 1 : -1;
      if (cr.state === 'back' && cr.w <= 0) cr.state = 'idle';
      cr.u = cr.state === 'stop' && p && p.service ? U.clamp(1 - (p.serviceT || 0) / p.service, 0, 1) : 0;
      // (re-posed only while something changes: a crew standing still costs nothing)
      if (cr.moving || cr.state === 'stop' || cr.state === 'release' || was !== cr.state || cr.dirty) { pose(cr, dt); cr.dirty = false; any = true; }
    }
    if (any) for (const p of PARTS) S.meshes[p].instanceMatrix.needsUpdate = true;
  }

  // how far up the jacks have the car (m), for the renderer to lift the car model
  function lift(c) {
    const p = c.brain && c.brain.pit;
    if (!p || p.phase !== 'stop' || !p.service) return 0;
    const u = 1 - (p.serviceT || 0) / p.service;
    // (some 5 cm: the tyres just clear the ground; up as the jacks go in, down in a few hundredths)
    return 0.05 * U.smooth((u - 0.1) / 0.08) * (1 - U.smooth((u - 0.94) / 0.03));
  }

  F1.R3Crew = { build, update, lift, ROLES, get state() { return S; } };
})(typeof window !== 'undefined' ? window : globalThis);
