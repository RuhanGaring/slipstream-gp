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
    const unit = new THREE.BoxGeometry(1, 1, 1), tyreG = new THREE.CylinderGeometry(0.36, 0.36, 0.36, 16); tyreG.rotateX(Math.PI / 2); // (its axis the way its carrier faces: onto the hub)
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
      return { k, team, box: b, gy, side: tr.pit.side, state: 'idle', t: 0, from: null, w: 0, dirty: true, car: null, cur: [], settling: false };
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
    const c = U.clamp(P.crouch || 0, 0, 1), hip = 0.93 - 0.42 * c, sw = Math.sin(P.walk || 0) * 0.5 * (P.walkAmp || 0);
    const TH = 0.46;
    const leg = (side, th, name, shin) => {
      const kx = side * 0.1, kz = -Math.sin(th) * TH, ky = hip - Math.cos(th) * TH;
      set(name, kx, hip, 0, th, 0, 0.17, TH, 0.19, TH / 2);
      return [kx, ky, kz];
    };
    // front leg: thigh forward by up to 75 degrees, the shin straight down from the knee to the ground
    const tF = -(c * 1.3) - sw, kF = leg(-1, tF, 'legL');
    // (the shin's own swing while walking fades as the knee comes up: no step at any crouch)
    set('shinL', kF[0], kF[1], kF[2], (-tF * 0.3 + sw * 0.6) * (1 - U.smooth(c / 0.3)), 0, 0.15, Math.max(0.2, kF[1]), 0.17, Math.max(0.2, kF[1]) / 2);
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
    if (P.tyre && P.tyreW) {
      // (between the car's hub and the hands: placed in the world, turned as the person is)
      E.set(0, P.yaw, 0); Q.setFromEuler(E);
      ms.tyre.setMatrixAt(i, M4.compose(P.tyreW, Q, SC.set(1, 1, 1)));
    } else if (P.tyre) {
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
  // (where the car really stopped, kept until the crew is home again: going back to the painted
  // box when the car left moved the whole crew a metre or two at once)
  function frame(cr) {
    const c = cr.car, b = cr.box;
    if (c && cr.state === 'stop') { const d = SET.get(c); cr.stopF = { x: d ? d.x : c.x, y: d ? d.y : c.y, h: drawnH(c), gy: cr.gy }; return cr.stopF; }
    if (cr.stopF && (cr.state === 'release' || cr.state === 'back')) return cr.stopF;
    return { x: b.x, y: b.y, h: b.h, gy: cr.gy };
  }
  const toWorld = (F, lx, ly) => [F.x + Math.cos(F.h) * lx - Math.sin(F.h) * ly, F.y + Math.sin(F.h) * lx + Math.cos(F.h) * ly];

  // each role's waiting place, in the garage's mouth (box frame)
  function waitAt(cr, q) {
    const side = cr.side, row = q % 2, col = Math.floor(q / 2);
    return [-4.2 + col * 1.2, side * (4.4 + row * 0.9)];
  }

  function pose(cr, dt) {
    const F = frame(cr), BF = { x: cr.box.x, y: cr.box.y, h: cr.box.h }, st = cr.state, u = cr.u || 0;
    for (let q = 0; q < NPER; q++) {
      const R = ROLES[q];
      // where this person is: their place at the car (lx, ly, in the car's frame F) and their place in
      // the garage's mouth (the box's frame), in between by cr.w (0 waiting .. 1 at the car)
      const wa = waitAt(cr, q), w = U.smooth(U.clamp(cr.w, 0, 1));
      let lx = R.x, ly = R.gs ? R.y * cr.side : R.y;
      const P = { crouch: 0, arms: 0, yaw: 0, gun: R.r === 'g', jack: R.r === 'j' ? 0 : null, tyre: R.r === 'n' && (st === 'idle' || st === 'ready') };
      // facing: toward the lane while waiting, their role's way at the box
      const yawBox = R.yaw, yawWait = cr.side > 0 ? -Math.PI / 2 : Math.PI / 2;
      let yaw = w > 0.5 ? yawBox : yawWait;
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
          if (s > 0.17) { P.tyre = true; P.tyreAt = V(0, 0.5, 0.55); ly += R.corner[1] * 0.75 * off; lx += 0.25 * off; if (st === 'stop') P.lerpT = { from: 'hub', f: U.smooth((s - 0.17) / 0.13) }; }
        } else if (R.r === 'n') {
          // the new wheel held upright at hub height, slid onto the hub (0.4..0.55)
          P.crouch = 0.65; P.arms = 0.95; P.tyre = st === 'ready' || s < 0.55;
          const on = U.smooth((s - 0.4) / 0.15);
          if (st === 'stop') { ly -= R.corner[1] * 0.38 * on; lx += 0.3 * on; }
          if (P.tyre) P.tyreAt = V(0, 0.5, 0.55);
          if (st === 'stop' && s > 0.4 && P.tyre) P.lerpT = { from: 'hand', f: on };
        } else if (R.r === 'j') {
          const up = R.front ? U.smooth(s / 0.14) : U.smooth((s - 0.06) / 0.12), down = U.smooth((s - 0.94) / 0.03);
          P.jack = st === 'stop' ? up * (1 - down) : 0; P.lean = 0.3 + 0.3 * P.jack; P.arms = 0.65;
          if (R.front && st === 'stop') { const aside = U.smooth((s - 0.36) / 0.37); ly += cr.side * 1.5 * aside; }
          if (!R.front) {
            // waiting beside the car's path; behind the car once it has stopped
            const into = st === 'stop' ? U.smooth(s / 0.1) : 0, wx = R.waitX, wy = R.waitY * cr.side;
            lx = wx + (R.x - wx) * into; ly = wy + (R.y - wy) * into;
            if (into < 0.5) yaw = -cr.side * Math.PI / 2;
          }
        } else if (R.r === 's') { P.lean = 0.3; P.arms = st === 'stop' && s < 0.92 ? 0.95 : 0.25; }
        else if (R.r === 'w') { P.crouch = 0.8; P.arms = st === 'stop' && s > 0.08 && s < 0.72 ? 0.9 : 0.4; }
        else if (R.r === 'c') { P.arms = 0.15; if (st === 'stop' && s > 0.93) P.armR = -2.4 * U.smooth((s - 0.93) / 0.05); }
      } else if (st === 'release') {
        // stepping back from the car as it goes
        const back = U.smooth(cr.t / 0.6);
        // (everyone at least 1.8 m out from the car's axis, the old wheels carried back with them)
        ly += Math.sign(R.y || cr.side) * Math.max(0, 1.9 - Math.abs(R.y)) * back; if (R.r === 'j') lx += (R.front ? 0 : -1) * back, ly += R.front ? cr.side * 1.5 : 0;
        if (R.r === 'o') { P.tyre = true; P.tyreAt = V(0, 0.5, 0.55); ly += Math.sign(R.y) * 0.75; }
      } else if (st === 'back' && R.r === 'o') {
        // (the old wheels carried back to the garage)
        P.tyre = true; P.tyreAt = V(0, 0.5, 0.55);
        P.crouch = R.r === 'g' ? 1 - back : 0; P.gun = R.r === 'g'; P.arms = 0.3;
      }
      // (the last tenth of the stop: everyone clear of the car before it goes, as the real crews are
      // before the light turns green; the race releases the car the moment its stop time is up)
      if (st === 'stop' && u > 0.88 && R.r !== 'j') {
        const cl = U.smooth((u - 0.88) / 0.1);
        ly += Math.sign(ly || cr.side) * Math.max(0, 1.95 - Math.abs(ly)) * cl;
        if (R.r === 'g') P.crouch = 1 - 0.7 * cl;
      }
      const [ax, az] = toWorld(F, lx, ly), [bx, bz] = toWorld(BF, wa[0], wa[1]);
      P.x = bx + (ax - bx) * w; P.y = cr.gy; P.z = bz + (az - bz) * w;
      // Make way: nobody stands where a moving car is, or is about to be. Each car's footprint (its
      // 5.6 m by 2 m and a margin) runs further ahead the faster it goes; a person inside it goes to
      // its nearer side. Their own car standing in the box is the exception: they work round it.
      for (const c of S.cars || []) {
        if (!c || c.x == null || (c === cr.car && st === 'stop')) continue;
        const dd = SET.get(c), ccx = dd ? dd.x : c.x, ccy = dd ? dd.y : c.y, dx0 = P.x - ccx, dz0 = P.z - ccy;
        if (dx0 * dx0 + dz0 * dz0 > 196) continue;
        const hd = drawnH(c), ch = Math.cos(hd), sh = Math.sin(hd), sp = Math.max(0, c.speed || 0);
        const along = dx0 * ch + dz0 * sh, acr = -dx0 * sh + dz0 * ch, HW = 1.5;
        if (along > -3.2 && along < 3.2 + Math.min(9, sp * 0.45) && Math.abs(acr) < HW) {
          const sd = Math.abs(acr) > 0.05 ? Math.sign(acr) : (c === cr.car ? Math.sign(-Math.sin(c.h - cr.box.h) || 1) * cr.side : cr.side) || 1;
          const a2 = sd * HW;
          P.x = ccx + along * ch - a2 * sh; P.z = ccy + along * sh + a2 * ch;
        }
      }
      // (walking: facing the way they go)
      if (cr.moving && Math.hypot(ax - bx, az - bz) > 0.3) yaw = Math.atan2((az - bz) * cr.dir, (ax - bx) * cr.dir) - F.h;
      // three's y rotation: local +z to (sin, cos); a person faces local +z
      const hW = F.h + yaw;
      P.yaw = Math.PI / 2 - hW;
      // a wheel on its way between the car's hub and the hands (the car's own wheel is hidden
      // meanwhile, wheels() below): the hub of this corner as the car is drawn
      if (P.lerpT && R.corner) {
        const hubs = cr.car && HUBS.get(cr.car), hub = hubs && hubs[(R.corner[0] > 0 ? 0 : 2) + (R.corner[1] > 0 ? 1 : 0)];
        if (hub) {
          const hw = V(P.x + Math.sin(P.yaw) * 0.55, P.y + 0.5, P.z + Math.cos(P.yaw) * 0.55), f = P.lerpT.f;
          P.tyreW = P.lerpT.from === 'hub' ? hub.clone().lerp(hw, f) : hw.lerp(hub, f);
        }
      }
      // Every change of plan eased, never jumped to: the frame moving from the painted box to where
      // the car really stopped, everyone standing up at the release, the step back, the walk home.
      // Each person follows their target with a time constant of 0.09 s (their facing a little
      // slower), and the legs' swing fades in and out with their walking.
      const C = cr.cur[q] || (cr.cur[q] = Object.assign({ walkAmp: 0 }, P, { jack: P.jack }));
      const k = dt > 0 ? 1 - Math.exp(-dt / 0.09) : 1;
      for (const key of ['x', 'y', 'z', 'crouch', 'arms', 'lean', 'armR', 'armL']) C[key] = (C[key] || 0) + ((P[key] || 0) - (C[key] || 0)) * k;
      const dy = Math.atan2(Math.sin(P.yaw - C.yaw), Math.cos(P.yaw - C.yaw)); C.yaw += dy * (dt > 0 ? 1 - Math.exp(-dt / 0.14) : 1);
      C.jack = P.jack == null ? null : C.jack == null ? P.jack : C.jack + (P.jack - C.jack) * k;
      C.walkAmp += ((cr.moving ? 1 : 0) - C.walkAmp) * (dt > 0 ? 1 - Math.exp(-dt / 0.15) : 1);
      C.walk = S.time * 9 + q * 0.7; C.tyre = P.tyre; C.tyreAt = P.tyreAt; C.tyreW = P.tyreW; C.gun = P.gun;
      // (still settling: keep posing this crew)
      if (Math.abs(P.x - C.x) + Math.abs(P.z - C.z) + Math.abs(dy) + Math.abs((P.crouch || 0) - C.crouch) > 0.002 || C.walkAmp > 0.01) cr.settling = true;
      person(cr, q, C);
    }
  }

  // the race's state for this crew: its car on the way in, stopped or leaving
  function update(cars, dt) {
    if (!S) return;
    S.time += dt; S.cars = cars;
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
      if (cr.state === 'idle' || cr.state === 'ready') cr.stopF = null;
      cr.u = cr.state === 'stop' && p && p.service ? U.clamp(1 - (p.serviceT || 0) / p.service, 0, 1) : 0;
      // (re-posed only while something changes: a crew standing still costs nothing)
      let near = false;
      for (const c of cars) if (c && c.x != null && (c.speed || 0) > 0.3 && (c.x - cr.box.x) ** 2 + (c.y - cr.box.y) ** 2 < 900) { near = true; break; }
      if (near || cr.moving || cr.settling || cr.state === 'stop' || cr.state === 'release' || was !== cr.state || cr.dirty) { cr.settling = false; pose(cr, dt); cr.dirty = false; any = true; }
    }
    if (any) for (const p of PARTS) S.meshes[p].instanceMatrix.needsUpdate = true;
  }

  // The car as drawn round its stop. The race brings it to rest in one step from about 3 m/s at its
  // box and releases it the moment the stop's time is up; drawn so, it halted dead and leapt away.
  // Near its box the drawn car follows the race's on a critically damped spring (it brakes into its
  // place and pulls away), stiff everywhere else, so it is never more than centimetres out on the
  // lane. Returns the drawn place's offset from the race's (x, y), or null.
  const SET = new WeakMap(), HUBS = new WeakMap();
  // Through the stop itself the drawn car stands in its painted box, square to it: the race stops a car
  // up to 1.6 m short of the box and at a slant (it halts as soon as it is within 1.6 m), and lets it
  // creep backwards at some 0.2 m/s while it stands (its brakes do not hold at rest). Drawn as the race
  // has it, it rolled slowly back through the wheel change and stood crooked and short of its marks.
  // When it is released the difference fades out over 1.6 s as it pulls away, never back.
  // Returns [dx, dy, dh]: the drawn place's and heading's offsets from the race's, or null.
  const wrapA = a => Math.atan2(Math.sin(a), Math.cos(a));
  function settle(c, dt) {
    const p = c.brain && c.brain.pit;
    let d = SET.get(c);
    if (!p && !d) return null;
    // (its stop done and faded out: drawn as the race has it until it is out of the pit lane)
    if (d && d.done) { if (!p) SET.delete(c); return null; }
    if (!d) { d = { x: c.x, y: c.y, vx: c.vx || 0, vy: c.vy || 0, h: 0, vh: 0, rel: null, stood: false }; SET.set(c, d); }
    if (dt <= 0) return [d.x - c.x, d.y - c.y, d.h];
    // (a reset or a teleport: start again where the car is)
    if (Math.hypot(c.x - d.x, c.y - d.y) > 8) { d.x = c.x; d.y = c.y; d.vx = c.vx || 0; d.vy = c.vy || 0; d.h = 0; d.vh = 0; d.rel = null; d.stood = false; }
    const stop = p && p.phase === 'stop';
    const cr = S && c.team ? S.crews.find(q => q.team === c.team || q.team.id === c.team.id) : null;
    if (stop) d.stood = true;
    if (d.stood && !stop) {
      // released: the offset at that moment fades out as the car pulls away
      if (!d.rel) d.rel = { ox: d.x - c.x, oy: d.y - c.y, oh: d.h, t: 0 };
      d.rel.t += dt;
      const k = 1 - U.smooth(d.rel.t / 1.6);
      d.x = c.x + d.rel.ox * k; d.y = c.y + d.rel.oy * k; d.h = d.rel.oh * k; d.vx = c.vx || 0; d.vy = c.vy || 0; d.vh = 0;
      if (k <= 0) { d.done = true; return null; }
      return [d.x - c.x, d.y - c.y, d.h];
    }
    // the target: the race's place, or through the stop the box's centre and heading
    let tx = c.x, ty = c.y, th = 0, w = 40;
    if (stop && cr) { tx = cr.box.x; ty = cr.box.y; th = wrapA(cr.box.h - c.h); w = 6; }
    else if (p && S && S.tr && c.team) {
      const box = S.tr.pit.boxS[c.team.idx], gap = box == null || !c.loc ? 1e9 : Math.abs(((c.loc.s - box) % S.tr.L + S.tr.L * 1.5) % S.tr.L - S.tr.L / 2);
      w = 7 + 33 * U.smooth((gap - 12) / 30);
    }
    // (critically damped, sub-stepped for the stiff end)
    const n = Math.max(1, Math.ceil(dt * w / 0.5)), hh = dt / n;
    for (let k = 0; k < n; k++) {
      const ax = w * w * (tx - d.x) - 2 * w * d.vx, ay = w * w * (ty - d.y) - 2 * w * d.vy, ah = w * w * (th - d.h) - 2 * w * d.vh;
      d.vx += ax * hh; d.vy += ay * hh; d.vh += ah * hh; d.x += d.vx * hh; d.y += d.vy * hh; d.h += d.vh * hh;
    }
    if (!p && Math.hypot(c.x - d.x, c.y - d.y) < 0.002 && Math.abs(d.h) < 1e-4) { SET.delete(c); return null; }
    return [d.x - c.x, d.y - c.y, d.h];
  }
  // the car's heading as drawn
  const drawnH = c => { const d = SET.get(c); return c.h + (d ? d.h : 0); };

  // The car's wheels through a stop: each corner's own wheel hidden from the moment its old one comes
  // off the hub (u 0.17, the crew carries a wheel away from there) to the moment the new one is on
  // (u 0.55); and the hubs' places noted for the crew. wheels: the model's four, front left, front
  // right, rear left, rear right; o the car's root, body its body.
  const _v = new THREE.Vector3(), YAX = new THREE.Vector3(0, 1, 0);
  function wheels(c, wl, o, body) {
    const p = c.brain && c.brain.pit;
    const stop = p && p.phase === 'stop' && p.service, u = stop ? 1 - (p.serviceT || 0) / p.service : -1;
    if (stop) {
      const hubs = HUBS.get(c) || []; HUBS.set(c, hubs);
      wl.forEach((w, k) => {
        _v.set(w.position.x, w.position.y + body.position.y, w.position.z).applyAxisAngle(YAX, o.rotation.y).add(o.position);
        // (by where it sits: front or rear, and the car's right, +z, or left)
        const ci = (w.position.x > 0 ? 0 : 2) + (w.position.z > 0 ? 1 : 0);
        (hubs[ci] || (hubs[ci] = new THREE.Vector3())).copy(_v);
      });
    }
    const hide = stop && u > 0.17 && u < 0.55;
    if (!hide && !c.__crewHid) return;
    for (const w of wl) { const sp = w.userData && w.userData.spin; if (sp) sp.scale.setScalar(hide ? 1e-4 : 1); }
    c.__crewHid = hide;
  }

  // how far up the jacks have the car (m), for the renderer to lift the car model
  function lift(c) {
    const p = c.brain && c.brain.pit;
    if (!p || p.phase !== 'stop' || !p.service) return 0;
    const u = 1 - (p.serviceT || 0) / p.service;
    // (some 5 cm: the tyres just clear the ground; up as the jacks go in, down in a few hundredths)
    return 0.05 * U.smooth((u - 0.1) / 0.08) * (1 - U.smooth((u - 0.94) / 0.03));
  }

  F1.R3Crew = { build, update, lift, settle, wheels, ROLES, get state() { return S; } };
})(typeof window !== 'undefined' ? window : globalThis);
