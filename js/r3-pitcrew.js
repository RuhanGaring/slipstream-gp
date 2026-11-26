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

  // Parts, each an instanced mesh over every crew. Low-poly but shaped as a person is: a torso wider
  // at the shoulders than the waist, hips, a rounded helmet with its dark visor, upper arms and
  // forearms with gloved hands, thighs and shins with boots. Limbs are unit long and hang from their
  // top (their length is a scale); their widths taper.
  const PARTS = ['torso', 'pelvis', 'head', 'visor', 'uarmL', 'uarmR', 'farmL', 'farmR', 'handL', 'handR', 'legL', 'legR', 'shinL', 'shinR', 'bootL', 'bootR', 'tyre', 'gun', 'jack'];
  const SUIT = ['torso', 'pelvis', 'uarmL', 'uarmR', 'farmL', 'farmR', 'legL', 'legR', 'shinL', 'shinR'];
  let S = null; // the lap's crews: { meshes, crews, tr }
  const M4 = new THREE.Matrix4(), M5 = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), PV = new THREE.Vector3(), SC = new THREE.Vector3();
  const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);
  // A limb or trunk from y 0 down to -1: an n-sided ring at each [t, width, depth] of its profile (t 0 at
  // the top, 1 at the bottom), smooth shaded, so it reads round in the light at a few dozen triangles.
  function limb(prof, n) {
    const rows = prof.length, pos = [], idx = [];
    for (const [t, w, d] of prof) for (let k = 0; k < n; k++) { const a = (k + 0.5) / n * Math.PI * 2; pos.push(Math.sin(a) * w / 2, -t, Math.cos(a) * d / 2); }
    for (let r = 0; r < rows - 1; r++) for (let k = 0; k < n; k++) { const a = r * n + k, b = r * n + (k + 1) % n, c = a + n, d = b + n; idx.push(a, c, b, b, c, d); }
    // (the ends closed by a fan round a centre point)
    const top = pos.length / 3; pos.push(0, -prof[0][0], 0);
    const bot = pos.length / 3; pos.push(0, -prof[rows - 1][0], 0);
    for (let k = 0; k < n; k++) { idx.push(top, k, (k + 1) % n); idx.push(bot, (rows - 1) * n + (k + 1) % n, (rows - 1) * n + k); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  function build(tr, W2, root, opt) {
    S = null;
    const boxes = W2.decor.filter(it => it.type === 'box');
    if (!boxes.length) return;
    const std = opt.std;
    const tyreG = new THREE.CylinderGeometry(0.36, 0.36, 0.36, 16); tyreG.rotateX(Math.PI / 2); // (its axis the way its carrier faces: onto the hub)
    // (overalls: a chest deeper than the waist and shoulders rounded off at the top; the helmet smooth,
    // its visor a band wrapped round its front)
    const torsoG = limb([[0, 0.3, 0.17], [0.08, 0.44, 0.23], [0.3, 0.46, 0.26], [0.65, 0.4, 0.23], [1, 0.35, 0.21]], 8);
    const pelvisG = limb([[0, 0.35, 0.21], [0.6, 0.36, 0.23], [1, 0.3, 0.2]], 8);
    const headG = new THREE.SphereGeometry(0.135, 10, 8); headG.scale(1, 1.08, 1.12);
    const visorG = new THREE.SphereGeometry(0.139, 9, 3, Math.PI / 2 - 0.85, 1.7, 1.25, 0.42); visorG.scale(1, 1.08, 1.12); visorG.translate(0, 0.005, -0.135);
    const uarmG = limb([[0, 0.1, 0.11], [0.15, 0.115, 0.115], [1, 0.085, 0.09]], 6), farmG = limb([[0, 0.085, 0.09], [0.35, 0.09, 0.09], [1, 0.07, 0.065]], 6);
    const handG = limb([[0, 0.07, 0.06], [0.5, 0.085, 0.07], [1, 0.06, 0.05]], 6); handG.scale(1, 0.11, 1);
    const thighG = limb([[0, 0.17, 0.18], [0.25, 0.165, 0.18], [1, 0.12, 0.13]], 7), shinG = limb([[0, 0.12, 0.13], [0.3, 0.125, 0.14], [1, 0.085, 0.095]], 7);
    const bootG = new THREE.BoxGeometry(0.12, 0.09, 0.27); bootG.translate(0, 0.045, 0.05);
    const unit = new THREE.BoxGeometry(1, 1, 1);
    const geo = { torso: torsoG, pelvis: pelvisG, head: headG, visor: visorG, uarmL: uarmG, uarmR: uarmG, farmL: farmG, farmR: farmG, handL: handG, handR: handG, legL: thighG, legR: thighG, shinL: shinG, shinR: shinG, bootL: bootG, bootR: bootG, tyre: tyreG, gun: unit, jack: unit };
    const n = boxes.length * NPER;
    // Overalls black, as the teams' are, with lines in the team's colour (the instance colour): down the
    // outside of each arm and leg and the sides of the body, and a yoke over the shoulders. Drawn by the
    // surface's own direction and height in the part (its normal and position before placing), so the
    // lines cost no geometry. kind: 0 limb, 1 torso, 2 hips.
    const suit = kind => {
      const m = std({ color: '#ffffff', roughness: 0.7 });
      m.userData.patchKey = 'crewSuit' + kind;
      m.userData.patchExtra = sh => {
        const VAR = '#include <common>\nvarying vec3 vSuitP; varying vec3 vSuitN;';
        sh.vertexShader = sh.vertexShader.replace('#include <common>', VAR)
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSuitP = position; vSuitN = normal;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', VAR)
          .replace('#include <color_fragment>', `#include <color_fragment>
          {
            vec3 sn = normalize(vSuitN);
            float line = smoothstep(${kind === 2 ? '0.97, 0.985' : '0.88, 0.91'}, abs(sn.x));
            ${kind === 1 ? 'line = max(line, smoothstep(-0.17, -0.15, vSuitP.y));' : ''}
            diffuseColor.rgb = mix(vec3(0.022, 0.024, 0.028), diffuseColor.rgb, line);
          }`);
      };
      return m;
    };
    const mat = std({ color: '#ffffff', roughness: 0.6 }), suitL = suit(0), suitT = suit(1), suitH = suit(2);
    const dark = std({ color: '#ffffff', roughness: 0.45, metalness: 0.15 });
    const meshes = {};
    for (const p of PARTS) {
      const im = new THREE.InstancedMesh(geo[p], p === 'torso' ? suitT : p === 'pelvis' ? suitH : SUIT.includes(p) ? suitL : p === 'head' ? mat : dark, n);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.castShadow = p !== 'visor' && p !== 'handL' && p !== 'handR'; im.receiveShadow = true;
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
      // per person: the lines on the overalls and the helmet in the team's colour (its accent where the
      // colour itself is near black), visor, gloves and boots dark
      const team = b.team, lum = new THREE.Color(team.base).getHSL({}).l, line = lum < 0.16 ? (team.accent || '#ffffff') : team.base;
      for (let q = 0; q < NPER; q++) {
        const i = k * NPER + q;
        c.set(line); for (const p of SUIT) meshes[p].setColorAt(i, c);
        meshes.head.setColorAt(i, c);
        c.set('#101215'); for (const p of ['visor', 'handL', 'handR', 'bootL', 'bootR', 'tyre', 'jack']) meshes[p].setColorAt(i, c);
        c.set('#c9ccd0'); meshes.gun.setColorAt(i, c);
      }
      const gy = Tracks.groundAt(tr, b.x, b.y);
      return { k, team, box: b, gy, side: tr.pit.side, state: 'idle', t: 0, w: 0, dirty: true, car: null, cur: [], settling: false };
    });
    for (const p of PARTS) { if (meshes[p].instanceColor) meshes[p].instanceColor.needsUpdate = true; }
    S = { meshes, crews, tr, time: 0 };
    for (const cr of crews) pose(cr, 0);
    for (const p of PARTS) meshes[p].instanceMatrix.needsUpdate = true;
  }

  // A person's pose: place, heading, crouch (0 standing .. 1 kneeling), lean, reach (arms 0 hanging .. 1
  // forward at the hands' work), a raised arm (armL/armR, negative up), walk phase and amplitude, and
  // what they carry. (About x a negative turn takes a hanging limb forward, to +z, the way they face.)
  const _R = new THREE.Matrix4(), _P = new THREE.Vector3(), _Q2 = new THREE.Quaternion(), _E2 = new THREE.Euler();
  function person(cr, q, P) {
    const ms = S.meshes, i = cr.k * NPER + q;
    E.set(0, P.yaw, 0); Q.setFromEuler(E);
    _R.compose(_P.set(P.x, P.y, P.z), Q, SC.set(1, 1, 1));
    // a part at a pivot (person frame), turned rx about x then rz about z, its length a y scale
    const put = (name, ox, oy, oz, rx, rz, len) => {
      _E2.set(rx, 0, rz); _Q2.setFromEuler(_E2);
      M5.compose(PV.set(ox, oy, oz), _Q2, SC.set(1, len, 1));
      ms[name].setMatrixAt(i, M4.multiplyMatrices(_R, M5));
    };
    const end = (ox, oy, oz, rx, rz, len) => V(0, -len, 0).applyEuler(new THREE.Euler(rx, 0, rz)).add(V(ox, oy, oz));
    const c = U.clamp(P.crouch || 0, 0, 1), amp = P.walkAmp || 0, sw = Math.sin(P.walk || 0) * 0.5 * amp;
    const TH = 0.45, hip = 0.95 - 0.44 * c;
    // legs: kneeling, the front knee up (thigh forward, shin down to the boot) and the back knee on the
    // ground (shin back along it); squatting between; walking, the legs swing
    const tF = -(c * 1.3) - sw, kF = end(-0.1, hip, 0, tF, 0, TH);
    put('legL', -0.1, hip, 0, tF, 0, TH);
    const sLF = (-tF * 0.3 + sw * 0.6) * (1 - U.smooth(c / 0.3)), lenF = Math.max(0.2, kF.y / Math.max(0.3, Math.cos(sLF)));
    put('shinL', kF.x, kF.y, kF.z, sLF, 0, lenF);
    const fF = end(kF.x, kF.y, kF.z, sLF, 0, lenF);
    put('bootL', fF.x, Math.max(0, fF.y - 0.06), fF.z, 0, 0, 1);
    const tB = c * 0.2 + sw, kB = end(0.1, hip, 0, tB, 0, TH);
    put('legR', 0.1, hip, 0, tB, 0, TH);
    const sLB = c > 0.5 ? 1.45 * U.smooth((c - 0.5) / 0.4) : -sw * 0.6 * (1 - c), lenB = Math.max(0.2, kB.y / Math.max(0.2, Math.cos(sLB)));
    put('shinR', kB.x, kB.y, kB.z, sLB, 0, lenB);
    const fB = end(kB.x, kB.y, kB.z, sLB, 0, lenB);
    put('bootR', fB.x, Math.max(0, fB.y - 0.06), fB.z, sLB * 0.85, 0, 1);
    // hips, then the torso leaning forward from them, the helmet on top with its visor ahead
    const lean = 0.3 * c + (P.lean || 0);
    put('pelvis', 0, hip + 0.12, 0, 0, 0, 0.2);
    E.set(lean, 0, 0); Q.setFromEuler(E);
    const top = V(0, 0.6, 0).applyQuaternion(Q).add(V(0, hip + 0.06, 0));
    put('torso', top.x, top.y, top.z, lean, 0, 0.58);
    const hl = lean * 0.55, hc = V(0, 0.19, 0.01).applyEuler(new THREE.Euler(hl, 0, 0)).add(top);
    _E2.set(hl, 0, 0); _Q2.setFromEuler(_E2);
    ms.head.setMatrixAt(i, M4.multiplyMatrices(_R, M5.compose(hc, _Q2, SC.set(1, 1, 1))));
    const vc = V(0, -0.005, 0.135).applyEuler(new THREE.Euler(hl, 0, 0)).add(hc);
    ms.visor.setMatrixAt(i, M4.multiplyMatrices(_R, M5.compose(vc, _Q2, SC.set(1, 1, 1))));
    // arms: the upper arm forward by the reach (and swinging against the legs when walking), the
    // elbow bending more as the hands come up to their work; a raised arm straight up
    const reach = P.arms || 0;
    const arm = (side, name1, name2, nameH, raise) => {
      const sh = V(side * 0.235, -0.07, 0).applyQuaternion(Q).add(top);
      const up = raise < -0.3;
      const sA = up ? raise : -(reach * 1.2 + lean * 0.6) + side * sw * 0.55 + (raise || 0);
      const eA = up ? -0.15 : -(0.3 + reach * 0.75);
      put(name1, sh.x, sh.y, sh.z, sA, side * -0.1, 0.3);
      const el = end(sh.x, sh.y, sh.z, sA, side * -0.1, 0.3);
      put(name2, el.x, el.y, el.z, sA + eA, side * -0.05, 0.28);
      const hd = end(el.x, el.y, el.z, sA + eA, side * -0.05, 0.28);
      put(nameH, hd.x, hd.y, hd.z, sA + eA, 0, 1);
      return hd;
    };
    arm(-1, 'uarmL', 'farmL', 'handL', P.armL || 0);
    const hand = arm(1, 'uarmR', 'farmR', 'handR', P.armR || 0);
    if (P.tyre && P.tyreW) {
      // (between the car's hub and the hands: placed in the world, turned as the person is)
      E.set(0, P.yaw, 0); Q.setFromEuler(E);
      ms.tyre.setMatrixAt(i, M4.compose(P.tyreW, Q, SC.set(1, 1, 1)));
    } else if (P.tyre) {
      const tp = P.tyreAt || V(0, 0.5, 0.55);
      ms.tyre.setMatrixAt(i, M4.multiplyMatrices(_R, M5.makeTranslation(tp.x, tp.y, tp.z)));
    } else ms.tyre.setMatrixAt(i, HIDE);
    if (P.gun) { _E2.set(-1.1 * reach, 0, 0); _Q2.setFromEuler(_E2); ms.gun.setMatrixAt(i, M4.multiplyMatrices(_R, M5.compose(PV.set(hand.x - 0.12, hand.y + 0.02, hand.z + 0.12), _Q2, SC.set(0.1, 0.15, 0.36)))); }
    else ms.gun.setMatrixAt(i, HIDE);
    if (P.jack != null) {
      // the jack's long handle from the hands down to the car (P.jack 0 out .. 1 under the car)
      _E2.set(0.42 - 0.2 * P.jack, 0, 0); _Q2.setFromEuler(_E2);
      ms.jack.setMatrixAt(i, M4.multiplyMatrices(_R, M5.compose(PV.set(0, 0.55, 0.85 + 0.35 * P.jack), _Q2, SC.set(0.08, 0.08, 1.9))));
    } else ms.jack.setMatrixAt(i, HIDE);
  }

  // the box's frame (or the car's, while it stands there) to the world
  // (where the car really stopped, kept until the crew is home again: going back to the painted
  // box when the car left moved the whole crew a metre or two at once)
  // (always the box: the car as drawn ends its stop square in the box, settle() below, and placing
  // the crew from the car while it eased in made them slide along with it)
  function frame(cr) {
    const b = cr.box;
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
        const sg = Math.sign(R.y || cr.side);
        ly += sg * Math.max(0, (sg === -cr.side ? 2.5 : 1.9) - Math.abs(R.y)) * back; if (R.r === 'j') lx += (R.front ? 0 : -1) * back, ly += R.front ? cr.side * 1.5 : 0;
        if (R.r === 'o') { P.tyre = true; P.tyreAt = V(0, 0.5, 0.55); ly += Math.sign(R.y) * 0.75; }
      } else if (st === 'back' && R.r === 'o') {
        // (the old wheels carried back to the garage)
        P.tyre = true; P.tyreAt = V(0, 0.5, 0.55);
        P.crouch = R.r === 'g' ? 1 - back : 0; P.gun = R.r === 'g'; P.arms = 0.3;
      }
      // Their marks while the car comes in are a step back from their places at it (out from its side,
      // ahead of its nose); they step in as it comes to rest, in the stop's first 0.2 s or so.
      if (st === 'ready' || st === 'stop') {
        const back = st === 'ready' ? 1 : 1 - U.smooth(u / 0.08);
        if (back > 0) {
          if (Math.abs(ly) > 0.6 && R.r !== 'c') ly += Math.sign(ly) * 0.55 * back;
          if (lx > 2.3 && R.r !== 'c') lx += 0.8 * back;
        }
      }
      // (the last tenth of the stop: everyone clear of the car before it goes, as the real crews are
      // before the light turns green; the race releases the car the moment its stop time is up)
      if (st === 'stop' && u > 0.88 && R.r !== 'j') {
        const cl = U.smooth((u - 0.88) / 0.1);
        // (further out on the lane side, the way the car turns as it leaves)
        const sg = Math.sign(ly || cr.side);
        ly += sg * Math.max(0, (sg === -cr.side ? 2.5 : 1.95) - Math.abs(ly)) * cl;
        if (R.r === 'g') P.crouch = 1 - 0.7 * cl;
      }
      const [ax, az] = toWorld(F, lx, ly), [bx, bz] = toWorld(BF, wa[0], wa[1]);
      P.x = bx + (ax - bx) * w; P.y = cr.gy; P.z = bz + (az - bz) * w;
      // Make way: nobody stands where a moving car is, or is about to be. Each car's footprint (its
      // 5.6 m by 2 m and a margin) runs further ahead the faster it goes; a person inside it goes to
      // its nearer side. Their own car standing in the box is the exception: they work round it.
      // (softly: the push grows with how far in a person would be, and fades at the footprint's ends;
      // and no margin ahead for their own car coming into its box: they wait for it at their marks)
      for (const c of S.cars || []) {
        if (!c || c.x == null || (c === cr.car && st === 'stop')) continue;
        const dd = SET.get(c), ccx = dd ? dd.x : c.x, ccy = dd ? dd.y : c.y, dx0 = P.x - ccx, dz0 = P.z - ccy;
        if (dx0 * dx0 + dz0 * dz0 > 196) continue;
        const hd = drawnH(c), ch = Math.cos(hd), sh = Math.sin(hd), sp = Math.max(0, c.speed || 0);
        const along = dx0 * ch + dz0 * sh, acr = -dx0 * sh + dz0 * ch, HW = 1.55, HL = 3.15;
        const ahead = c === cr.car && (st === 'ready' || st === 'idle') ? 0.3 : Math.min(6, 1 + sp * 0.35);
        const wA = U.smooth((along + HL + 0.6) / 0.6) * U.smooth((HL + ahead + 0.6 - along) / 0.6), pen = Math.max(0, HW - Math.abs(acr)) * wA;
        if (pen > 0) {
          const sd = Math.abs(acr) > 0.05 ? Math.sign(acr) : cr.side || 1;
          P.x += -sh * sd * pen; P.z += ch * sd * pen;
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
      // (a person moves no faster than a sprint, 4.5 m/s, and turns no faster than 7 rad/s: nothing
      // slides or spins however the plan changes)
      const k = dt > 0 ? 1 - Math.exp(-dt / 0.11) : 1;
      for (const key of ['y', 'crouch', 'arms', 'lean', 'armR', 'armL']) C[key] = (C[key] || 0) + ((P[key] || 0) - (C[key] || 0)) * k;
      {
        let mx = (P.x - C.x) * k, mz = (P.z - C.z) * k;
        const lim = dt > 0 ? 4.5 * dt : 1e9, l = Math.hypot(mx, mz);
        if (l > lim) { mx *= lim / l; mz *= lim / l; }
        C.x += mx; C.z += mz;
      }
      let dy = Math.atan2(Math.sin(P.yaw - C.yaw), Math.cos(P.yaw - C.yaw)) * (dt > 0 ? 1 - Math.exp(-dt / 0.16) : 1);
      if (dt > 0) dy = U.clamp(dy, -7 * dt, 7 * dt);
      C.yaw += dy;
      C.jack = P.jack == null ? null : C.jack == null ? P.jack : C.jack + (P.jack - C.jack) * k;
      C.walkAmp += ((cr.moving || Math.hypot(P.x - C.x, P.z - C.z) > 0.15 ? 1 : 0) - C.walkAmp) * (dt > 0 ? 1 - Math.exp(-dt / 0.15) : 1);
      C.walk = S.time * 9 + q * 0.7; C.tyre = P.tyre; C.tyreAt = P.tyreAt; C.tyreW = P.tyreW; C.gun = P.gun;
      // (still settling: keep posing this crew)
      // (walking while their place moves under them by more than a stroll)
      const mv = Math.hypot(P.x - C.x, P.z - C.z);
      if (mv + Math.abs(dy) + Math.abs((P.crouch || 0) - C.crouch) > 0.002 || C.walkAmp > 0.01) cr.settling = true;
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
      // Coming in: the race (ai.js) brakes the car at 4.5 m/s^2 toward its box and, once it is within
      // 1.6 m, stops it dead from 3 to 4 m/s. Drawn that way it slammed to a halt short of the box, and
      // pulling it on from there read as a slide. So the car as drawn runs its own last metres: x, the
      // race's distance to the point where it will stop it, is drawn as x^2 / 2X over the last X = 4 m
      // (and x - X / 2 before that), which comes to rest at the box at the very moment the race stops the
      // car, braking at about the race's own rate; the lead fades in from 40 m out to 15 m.
      const box = S.tr.pit.boxS[c.team.idx], L = S.tr.L, r = box == null || !c.loc ? 1e9 : ((box - c.loc.s) % L + L * 1.5) % L - L / 2;
      if (r > -3 && r < 40 && cr && !p.served) {
        const X = 4, x = Math.max(0, r - 1.6), f = x < X ? x * x / (2 * X) : x - X / 2;
        const far = 1 - U.smooth((r - 15) / 25), D = (r - f) * far;
        // (and square on the box by then too: its sideways offset and its angle to the box eased out
        // over the same last metres, so nothing is left to pull in once it is stopped)
        const bh = cr.box.h, ch = Math.cos(bh), sh = Math.sin(bh), lat = -(c.x - cr.box.x) * sh + (c.y - cr.box.y) * ch;
        const g = (1 - U.smooth(x / 6)) * far;
        tx += ch * D + sh * lat * g; ty += sh * D - ch * lat * g; th = wrapA(bh - c.h) * g;
      }
      w = 40;
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
