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
    ROLES.push({ r: 'g', x: fx * AX, y: sx * 1.6, yaw: -sx * Math.PI / 2, corner: [fx, sx] }); // (far enough out for the gun's length to the nut)
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
  // each corner's wheel-off man, by the corner's index (front 0 / rear 2, plus 1 on the car's right)
  const OQ = [];
  const NQ = []; // (and its wheel-on man)
  ROLES.forEach((R, q) => { if (R.r === 'o') OQ[(R.corner[0] > 0 ? 0 : 2) + (R.corner[1] > 0 ? 1 : 0)] = q; if (R.r === 'n') NQ[(R.corner[0] > 0 ? 0 : 2) + (R.corner[1] > 0 ? 1 : 0)] = q; });

  // Parts, each an instanced mesh over every crew. Low-poly but shaped as a person is: a torso wider
  // at the shoulders than the waist, hips, a rounded helmet with its dark visor, upper arms and
  // forearms with gloved hands, thighs and shins with boots. Limbs are unit long and hang from their
  // top (their length is a scale); their widths taper.
  const PARTS = ['torso', 'pelvis', 'head', 'visor', 'uarmL', 'uarmR', 'farmL', 'farmR', 'handL', 'handR', 'legL', 'legR', 'shinL', 'shinR', 'bootL', 'bootR', 'tyre', 'rim', 'gun', 'jack'];
  const SUIT = ['torso', 'pelvis', 'uarmL', 'uarmR', 'farmL', 'farmR', 'legL', 'legR', 'shinL', 'shinR'];
  let S = null; // the lap's crews: { meshes, crews, tr }
  const M4 = new THREE.Matrix4(), M5 = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), PV = new THREE.Vector3(), SC = new THREE.Vector3();
  const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);
  const TYW = []; // per person, where the wheel in their hands is (world), or null
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
    // A spare wheel as the car's own are: an 18 inch rim inside a 720 mm tyre, rounded at the shoulders,
    // its sidewall ringed in the compound's colour (the instance colour; the rubber black). Its axis the
    // way its carrier faces: onto the hub.
    const tyreG = new THREE.LatheGeometry([[0.232, -0.165], [0.3, -0.172], [0.345, -0.16], [0.36, -0.12], [0.362, 0], [0.36, 0.12], [0.345, 0.16], [0.3, 0.172], [0.232, 0.165]].map(([r, y]) => new THREE.Vector2(r, y)), 28);
    tyreG.rotateX(Math.PI / 2); tyreG.computeVertexNormals();
    const rimG = new THREE.CylinderGeometry(0.234, 0.234, 0.31, 24, 1, false); rimG.rotateX(Math.PI / 2);
    const tyreM = std({ color: '#ffffff', roughness: 0.85 });
    tyreM.userData.patchKey = 'crewTyre';
    tyreM.userData.patchExtra = sh => {
      const VAR = '#include <common>\nvarying vec3 vTyP; varying vec3 vTyN;';
      sh.vertexShader = sh.vertexShader.replace('#include <common>', VAR).replace('#include <begin_vertex>', '#include <begin_vertex>\nvTyP = position; vTyN = normal;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', VAR).replace('#include <color_fragment>', `#include <color_fragment>
        {
          float r = length(vTyP.xy), side = smoothstep(0.55, 0.75, abs(normalize(vTyN).z));
          float ring = side * smoothstep(0.278, 0.284, r) * (1.0 - smoothstep(0.3, 0.306, r));
          diffuseColor.rgb = mix(vec3(0.03, 0.03, 0.032), diffuseColor.rgb, ring);
        }`);
    };
    const rimM = std({ color: '#ffffff', roughness: 0.38, metalness: 0.6 });
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
    const geo = { torso: torsoG, pelvis: pelvisG, head: headG, visor: visorG, uarmL: uarmG, uarmR: uarmG, farmL: farmG, farmR: farmG, handL: handG, handR: handG, legL: thighG, legR: thighG, shinL: shinG, shinR: shinG, bootL: bootG, bootR: bootG, tyre: tyreG, rim: rimG, gun: unit, jack: unit };
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
      const im = new THREE.InstancedMesh(geo[p], p === 'tyre' ? tyreM : p === 'rim' ? rimM : p === 'torso' ? suitT : p === 'pelvis' ? suitH : SUIT.includes(p) ? suitL : p === 'head' ? mat : dark, n);
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
        c.set('#101215'); for (const p of ['visor', 'handL', 'handR', 'bootL', 'bootR', 'jack']) meshes[p].setColorAt(i, c);
        c.set('#c9ccd0'); meshes.gun.setColorAt(i, c);
        c.set('#26292e'); meshes.rim.setColorAt(i, c);
        c.set('#ffd400'); meshes.tyre.setColorAt(i, c);
      }
      const gy = Tracks.groundAt(tr, b.x, b.y);
      return { k, team, box: b, gy, side: tr.pit.side, state: 'idle', t: 0, w: 0, dirty: true, car: null, cur: [], settling: false };
    });
    for (const p of PARTS) { if (meshes[p].instanceColor) meshes[p].instanceColor.needsUpdate = true; }
    S = { meshes, crews, tr, time: 0, root };
    for (const cr of crews) pose(cr, 0);
    for (const p of PARTS) meshes[p].instanceMatrix.needsUpdate = true;
  }

  // A person's pose: place, heading, crouch (0 standing .. 1 kneeling), lean, reach (arms 0 hanging .. 1
  // forward at the hands' work), a raised arm (armL/armR, negative up), walk phase and amplitude, and
  // what they carry. (About x a negative turn takes a hanging limb forward, to +z, the way they face.)
  const _wl = new THREE.Vector3(), _gl = new THREE.Vector3(), _gt = new THREE.Vector3();
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
    const amp = U.clamp(P.walkAmp || 0, 0, 1), ph = P.walk || 0, spd = P.spd || 0;
    // (nobody walks on their knees: walking stands a person up)
    const c = U.clamp(P.crouch || 0, 0, 1) * (1 - (P.up == null ? amp : P.up));
    const TH = 0.45, SL = 0.47, ANK = 0.06;
    // the body's rise and fall: lowest as the weight passes from one foot to the other
    let hip = 0.95 - 0.44 * c + amp * 0.028 * (Math.cos(2 * (ph - 0.6 * Math.PI)) - 1) / 2 - amp * 0.05 * U.smooth((spd - 2) / 2.5);
    // Feet where they stand: kneeling, the front knee up and the back knee on the ground; squatting
    // between (the same pose as ever, its feet the targets below)
    const tF0 = -(c * 1.3), kF0 = end(-0.1, hip, 0, tF0, 0, TH);
    const sLF0 = (-tF0 * 0.3) * (1 - U.smooth(c / 0.3)), lenF0 = Math.max(0.2, kF0.y / Math.max(0.3, Math.cos(sLF0))), fF0 = end(kF0.x, kF0.y, kF0.z, sLF0, 0, lenF0);
    const tB0 = c * 0.2, kB0 = end(0.1, hip, 0, tB0, 0, TH);
    const sLB0 = c > 0.5 ? 1.45 * U.smooth((c - 0.5) / 0.4) : 0, lenB0 = Math.max(0.2, kB0.y / Math.max(0.2, Math.cos(sLB0))), fB0 = end(kB0.x, kB0.y, kB0.z, sLB0, 0, lenB0);
    // (one solve for every pose, kneeling to running: the legs reach for their feet, and the feet move
    // continuously between the kneeling places and the walking footfalls, so a leg never jumps from
    // one pose to the other)
    {
      // Walking: each foot planted on the ground while the body passes over it (stance, back along the
      // way they go exactly as fast as they move, so it does not slide), then lifted and swung through
      // to the next footfall; the legs bend to reach their feet (two-bone, the knee forward). The
      // phase runs with the distance covered, the step lengthening and the stance shortening with speed.
      // (the feet's places on the ground come from feet() below, in the world; here into the person's frame)
      const cyw = Math.cos(P.yaw), syw = Math.sin(P.yaw);
      const foot = (f0, side, u0) => {
        const fw = P.fw && P.fw[side < 0 ? 0 : 1];
        if (!fw || amp <= 0.001) return f0.clone();
        const dx = fw.x - P.x, dz = fw.z - P.z, lx = dx * cyw - dz * syw, lz = dx * syw + dz * cyw;
        const wl = U.smooth(amp / 0.35) * (1 - U.smooth((c - 0.25) / 0.3));
        // (the ankle its own height off the ground, so a lifted foot clears it by the whole lift)
        const y0 = Math.max(f0.y, ANK * wl);
        return V(f0.x + (lx - f0.x) * wl, y0 + fw.lift * wl, f0.z + (lz - f0.z) * wl);
      };
      const leg = (nT, nS, nB, hx, f0, u0, kneel) => {
        const H = V(hx, hip, 0), F = foot(f0, hx, u0);
        // (and never further from under the hip than a long stride, whatever the footfalls ask)
        { const ex = F.x - hx, ez = F.z, el = Math.hypot(ex, ez), mx = 0.7; if (el > mx) { F.x = hx + ex * mx / el; F.z = ez * mx / el; } }
        const D = F.clone().sub(H), d = U.clamp(D.length(), 0.05, TH + SL - 0.002); D.normalize();
        // (a foot out of reach is drawn at the end of the straight leg, never the leg stretched to it)
        { const fd = Math.min(F.distanceTo(H), TH + SL); F.copy(H).addScaledVector(D, fd); }
        const a = Math.acos(U.clamp((TH * TH + d * d - SL * SL) / (2 * TH * d), -1, 1));
        const pole = V(0, 0, 1).addScaledVector(D, -D.z); if (pole.lengthSq() < 1e-6) pole.set(0, 1, 0); pole.normalize();
        const tD = D.clone().multiplyScalar(Math.cos(a)).addScaledVector(pole, Math.sin(a));
        const K = H.clone().addScaledVector(tD, TH), sD = F.clone().sub(K); const sl = sD.length(); sD.divideScalar(sl || 1);
        // (a unit limb hanging down, turned rx about x then rz about z, points (sin rz, -cos rz cos rx, -cos rz sin rx))
        put(nT, H.x, H.y, H.z, Math.atan2(-tD.z, -tD.y), Math.asin(U.clamp(tD.x, -1, 1)), TH);
        put(nS, K.x, K.y, K.z, Math.atan2(-sD.z, -sD.y), Math.asin(U.clamp(sD.x, -1, 1)), sl);
        // (the boot flat on the ground in stance, toe down a little as it swings)
        const toe = F.y - Math.max(f0.y, ANK) > 0.005 ? -0.25 * U.clamp((F.y - Math.max(f0.y, ANK)) / 0.1, 0, 1) : 0;
        put(nB, F.x, Math.max(0, F.y - ANK), F.z, kneel + toe, 0, 1);
      };
      leg('legL', 'shinL', 'bootL', -0.1, fF0, ph, 0);
      leg('legR', 'shinR', 'bootR', 0.1, fB0, ph + Math.PI, sLB0 * 0.85);
    }
    // (the arms swing against the legs)
    const sw = -Math.cos(ph) * 0.5 * amp * (1 + 0.6 * U.smooth((spd - 2) / 2));
    // What the hands hold, and where they take hold of it (the person's frame). The wheel: by its tread
    // at either side as it is carried or worked, by its top as it stands on the floor; the wheel gun:
    // the right hand on its grip, the left along its barrel, its nose on the wheel nut; the jack: both
    // hands along its handle; the stabilisers on the car's flanks, the wing men on the front wing.
    const R0 = ROLES[q], cyw = Math.cos(P.yaw), syw = Math.sin(P.yaw);
    const toLocal = (w, out) => { const dx = w.x - P.x, dz = w.z - P.z; return out.set(dx * cyw - dz * syw, w.y - P.y, dx * syw + dz * cyw); };
    const hubs = cr.car && HUBS.get(cr.car), hubW = R0.corner && hubs && hubs[(R0.corner[0] > 0 ? 0 : 2) + (R0.corner[1] > 0 ? 1 : 0)];
    const atCar = cr.state === 'stop', u = cr.u || 0;
    let gL = null, gR = null;
    // the wheel: where it is (in the world between hub and hands, else in the hands' frame)
    let Wc = null;
    if (P.tyre && P.tyreW) Wc = toLocal(P.tyreW, _wl);
    else if (P.tyre) Wc = _wl.copy(P.tyreAt || V(0, 1.0, 0.38));
    else if (R0.r === 'o' && atCar && u < 0.17 && hubW) Wc = toLocal(hubW, _wl); // (on the car, about to come off)
    if (Wc) {
      if (Wc.y < TYRE_R + 0.08) { gL = V(Wc.x - 0.15, Wc.y + 0.31, Wc.z - 0.05); gR = V(Wc.x + 0.15, Wc.y + 0.31, Wc.z - 0.05); }
      else { gL = V(Wc.x - 0.33, Wc.y + 0.05, Wc.z - 0.02); gR = V(Wc.x + 0.33, Wc.y + 0.05, Wc.z - 0.02); }
    }
    // the gun: nose on the nut (the hub as the car stands), else held ready before the chest
    let gunC = null;
    if (P.gun) {
      const tip = atCar && hubW && u < 0.88 ? toLocal(hubW, _gl).add(_gt.set(0, 0, -0.18)) : _gl.set(0.06, 1.02, 0.5);
      gunC = tip.clone().add(_gt.set(0, 0, -0.18));
      gR = V(gunC.x + 0.07, gunC.y - 0.07, gunC.z - 0.1); gL = V(gunC.x - 0.07, gunC.y + 0.02, gunC.z + 0.08);
    }
    // the jack's handle: from the hands down to the car (P.jack 0 out .. 1 under it)
    let jC = null, jD = null;
    if (P.jack != null) {
      // (its foot under the car's nose or tail 1.75 m out, its handle's end at the waist, pulled down
      // a third of a metre to lift the car)
      const nE = V(0, 1.02 - 0.32 * P.jack, 0.12), fE = V(0, 0.1 + 0.04 * P.jack, 1.75);
      jD = fE.clone().sub(nE); const jl = jD.length(); jD.divideScalar(jl); jC = nE.clone().add(fE).multiplyScalar(0.5); jC.len = jl;
      gR = nE.clone().addScaledVector(jD, 0.06).add(_gt.set(0.1, 0, 0)); gL = nE.clone().addScaledVector(jD, 0.4).add(_gt.set(-0.1, 0, 0));
    }
    if (!gL && atCar && R0.r === 's' && u < 0.92) { gL = V(-0.2, 0.74, 0.46); gR = V(0.2, 0.74, 0.46); }
    if (!gL && atCar && R0.r === 'w' && u > 0.08 && u < 0.72) { gL = V(-0.22, 0.36, 0.4); gR = V(0.22, 0.36, 0.4); }
    // (a signalling arm raised: that hand lets go)
    if ((P.armR || 0) < -0.3) gR = null;
    if ((P.armL || 0) < -0.3) gL = null;
    // (a hand takes hold and lets go on a spring; and where a hold jumps from one frame to the next, as
    // when the gun comes off the nut or a wheel changes hands, the jump is not followed at once: it
    // fades out over a few tenths of a second while the hold's own movement is followed exactly)
    const wsp = (kw, kv, on) => { let x = P[kw] || 0, v = P[kv] || 0; const nn = DT > 0 ? Math.max(1, Math.ceil(DT / 0.02)) : 0, hh = nn ? DT / nn : 0; if (!nn) { P[kw] = on; P[kv] = 0; return; } for (let i = 0; i < nn; i++) { v += (196 * (on - x) - 28 * v) * hh; x += v * hh; } P[kw] = U.clamp(x, 0, 1); P[kv] = v; };
    wsp('gwL', 'gvL', gL ? 1 : 0); wsp('gwR', 'gvR', gR ? 1 : 0);
    const fadeK = DT > 0 ? Math.exp(-DT / 0.13) : 0;
    const hold = (g, kp, kr, ko, kw) => {
      if (!g) return;
      const raw = P[kr] || (P[kr] = g.clone()), off = P[ko] || (P[ko] = new THREE.Vector3());
      if ((P[kw] || 0) > 0.05 && raw.distanceTo(g) > 0.06) off.add(raw).sub(g); // (a jump: carried as an offset)
      off.multiplyScalar(fadeK); raw.copy(g);
      (P[kp] || (P[kp] = new THREE.Vector3())).copy(g).add(off);
    };
    hold(gL, 'gpL', 'grL', 'goL', 'gwL'); hold(gR, 'gpR', 'grR', 'goR', 'gwR');
    // hips, then the torso leaning forward from them, the helmet on top with its visor ahead; bent
    // further, as far as it must be, for the hands to reach their holds
    const lean0 = 0.3 * c + (P.lean || 0) * (1 - amp) + amp * (0.05 + 0.12 * U.smooth((spd - 1.5) / 3));
    const shAt = (ln, sd) => V(sd * 0.235, -0.07 * Math.cos(ln) + 0.6 * Math.cos(ln) + hip + 0.06, -0.07 * Math.sin(ln) + 0.6 * Math.sin(ln));
    let leanN = lean0;
    if (P.gpL || P.gpR) {
      // (the least bend that reaches, found to a hundredth of a radian, so it moves smoothly as the
      // holds do; where nothing reaches, the bend that comes nearest)
      const err = ln => { let e = 0; if (P.gpL && P.gwL > 0.01) e = Math.max(e, shAt(ln, -1).distanceTo(P.gpL) - 0.56); if (P.gpR && P.gwR > 0.01) e = Math.max(e, shAt(ln, 1).distanceTo(P.gpR) - 0.56); return e; };
      if (err(lean0) <= 0) leanN = lean0;
      else {
        let best = lean0, bestE = 1e9;
        for (let ln = lean0; ln <= lean0 + 1.1; ln += 0.1) { const e = err(ln); if (e < bestE) { bestE = e; best = ln; } if (e <= 0) break; }
        if (bestE <= 0) { let lo = Math.max(lean0, best - 0.1), hi = best; for (let it = 0; it < 7; it++) { const m = (lo + hi) / 2; if (err(m) <= 0) hi = m; else lo = m; } leanN = hi; }
        else { let lo = Math.max(lean0, best - 0.1), hi = Math.min(lean0 + 1.1, best + 0.1); for (let it = 0; it < 8; it++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (err(m1) < err(m2)) hi = m2; else lo = m1; } leanN = (lo + hi) / 2; }
      }
    }
    let lean = lean0 + (leanN - lean0) * Math.max(P.gwL || 0, P.gwR || 0);
    // (the bend, likewise: a jump in it fades out rather than snapping the back)
    if (P.lnRaw != null && Math.abs(lean - P.lnRaw) > 0.06) P.lnOff = (P.lnOff || 0) + P.lnRaw - lean;
    P.lnOff = (P.lnOff || 0) * fadeK; P.lnRaw = lean; lean += P.lnOff;
    put('pelvis', 0, hip + 0.12, 0, 0, 0, 0.2);
    E.set(lean, 0, 0); Q.setFromEuler(E);
    const top = V(0, 0.6, 0).applyQuaternion(Q).add(V(0, hip + 0.06, 0));
    put('torso', top.x, top.y, top.z, lean, 0, 0.58);
    const hl = lean * 0.55, hc = V(0, 0.19, 0.01).applyEuler(new THREE.Euler(hl, 0, 0)).add(top);
    _E2.set(hl, 0, 0); _Q2.setFromEuler(_E2);
    ms.head.setMatrixAt(i, M4.multiplyMatrices(_R, M5.compose(hc, _Q2, SC.set(1, 1, 1))));
    const vc = V(0, -0.005, 0.135).applyEuler(new THREE.Euler(hl, 0, 0)).add(hc);
    ms.visor.setMatrixAt(i, M4.multiplyMatrices(_R, M5.compose(vc, _Q2, SC.set(1, 1, 1))));
    // Arms: hanging and swinging as they walk, or reaching their holds (shoulder to elbow to wrist, the
    // elbows down and out); the change between eased, so a hand comes to its hold and leaves it.
    const UA = 0.3, FA = 0.28;
    const dirOf = (rx, rz) => V(Math.sin(rz), -Math.cos(rz) * Math.cos(rx), -Math.cos(rz) * Math.sin(rx));
    const put2 = (name, o, d, len) => put(name, o.x, o.y, o.z, Math.atan2(-d.z, -d.y), Math.asin(U.clamp(d.x, -1, 1)), len);
    const arm = (side, name1, name2, nameH, raise, gw, gp) => {
      const sh = V(side * 0.235, -0.07, 0).applyQuaternion(Q).add(top);
      const up = raise < -0.3;
      const sA = up ? raise : -(0.15 + lean * 0.6) + side * sw * 0.55 + (raise || 0);
      const eA = up ? -0.15 : -0.3;
      let dU = dirOf(sA, side * -0.1), dF = dirOf(sA + eA, side * -0.05);
      if (gw > 0.001 && gp) {
        const D = gp.clone().sub(sh), dl = D.length(), d = U.clamp(dl, 0.05, UA + FA - 0.002); D.normalize();
        const a = Math.acos(U.clamp((UA * UA + d * d - FA * FA) / (2 * UA * d), -1, 1));
        const pole = V(side * 0.8, -0.6, -0.2); pole.addScaledVector(D, -pole.dot(D)).normalize();
        const iU = D.clone().multiplyScalar(Math.cos(a)).addScaledVector(pole, Math.sin(a));
        const W = sh.clone().addScaledVector(D, Math.min(dl, UA + FA)), iF = W.sub(sh.clone().addScaledVector(iU, UA)).normalize();
        dU.lerp(iU, gw).normalize(); dF.lerp(iF, gw).normalize();
      }
      put2(name1, sh, dU, UA);
      const el = sh.clone().addScaledVector(dU, UA);
      put2(name2, el, dF, FA);
      const hd = el.clone().addScaledVector(dF, FA);
      put2(nameH, hd, dF, 1);
      return hd;
    };
    arm(-1, 'uarmL', 'farmL', 'handL', P.armL || 0, P.gwL, P.gpL);
    arm(1, 'uarmR', 'farmR', 'handR', P.armR || 0, P.gwR, P.gpR);
    // The wheel in their hands; where it is is noted (TYW) for wheels() below, which carries the car's
    // own wheel there while it is off the car (P.carried: this person's spare not drawn meanwhile).
    if (P.tyre && P.tyreW) {
      // (between the car's hub and the hands: placed in the world, turned as the person is)
      E.set(0, P.yaw, 0); Q.setFromEuler(E);
      M4.compose(P.tyreW, Q, SC.set(1, 1, 1));
    } else if (P.tyre) {
      const tp = P.tyreAt || V(0, 1.0, 0.38);
      M4.multiplyMatrices(_R, M5.makeTranslation(tp.x, tp.y, tp.z));
    }
    if (P.tyre) (TYW[i] || (TYW[i] = new THREE.Vector3())).setFromMatrixPosition(M4); else TYW[i] = null;
    const tyM = P.tyre && !P.carried && !(cr.cl && (ROLES[q].r === 'o' || ROLES[q].r === 'n')) ? M4 : HIDE;
    ms.tyre.setMatrixAt(i, tyM); ms.rim.setMatrixAt(i, tyM);
    if (gunC) ms.gun.setMatrixAt(i, M4.multiplyMatrices(_R, M5.compose(gunC, _Q2.identity(), SC.set(0.1, 0.15, 0.36))));
    else ms.gun.setMatrixAt(i, HIDE);
    if (jC) {
      _Q2.setFromUnitVectors(_gt.set(0, 0, 1), jD);
      ms.jack.setMatrixAt(i, M4.multiplyMatrices(_R, M5.compose(jC, _Q2, SC.set(0.08, 0.08, jC.len))));
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

  // Footfalls, in the world. A foot in its stance stays where it was put down while the body walks
  // over it; in its swing it travels from where it lifted to where it will land, the place under the
  // hip half a stance ahead at the pace they are going, rising and falling as it goes. Its timing is
  // the stride's phase (C.walk, run by the ground covered): stance the first sf of each foot's cycle.
  let DT = 0;
  function feet(C, step) {
    const sf = 0.62 - 0.22 * U.smooth((C.spd - 2) / 2), cyc = 2 * step / Math.max(C.spd, 0.4);
    const cy = Math.cos(C.yaw), sy = Math.sin(C.yaw), fw = C.fw || (C.fw = [null, null]);
    let far = false;
    for (let k = 0; k < 2; k++) {
      const hx = k ? 0.1 : -0.1, rx = C.x + hx * cy, rz = C.z - hx * sy;
      const u = (((C.walk + k * Math.PI) / (2 * Math.PI)) % 1 + 1) % 1;
      let f = fw[k];
      if (!f) f = fw[k] = { x: rx, z: rz, lift: 0, st: true, ax: rx, az: rz };
      if (u < sf) {
        // (down: stays put; just landed, wherever the swing brought it)
        if (!f.st) { f.st = true; f.lift = 0; }
        // (left behind by more than a leg can reach, as by a shove: stepped back under)
        // (dragged after the body, never jumped, at up to 2.5 m/s)
        const ex = f.x - rx, ez = f.z - rz, el = Math.hypot(ex, ez);
        if (el > 1.5) { f.x = rx; f.z = rz; }
        else if (el > 0.8) { const m = Math.min(el - 0.8, 2.5 * DT); f.x -= ex / el * m; f.z -= ez / el * m; }
      } else {
        if (f.st) { f.st = false; f.ax = f.x; f.az = f.z; f.tx = null; }
        const t = (u - sf) / (1 - sf), ahead = (1 - t) * (1 - sf) * cyc + sf * cyc / 2;
        // (the landing place at most a long stride from under the hip, however the pace reads)
        let ox2 = (C.vx || 0) * ahead, oz2 = (C.vz || 0) * ahead; const ol = Math.hypot(ox2, oz2);
        // (and closer in the slower they go: a shuffle lands under the hip, wherever its drift points)
        const om = 0.6 * U.smooth(C.spd / 0.9);
        if (ol > om) { ox2 *= om / ol; oz2 *= om / ol; }
        // (the landing place itself moves no faster than 3 m/s, so a change of mind mid-step bends it)
        let tx = rx + ox2, tz = rz + oz2;
        if (f.tx != null) { const mx = tx - f.tx, mz = tz - f.tz, ml = Math.hypot(mx, mz), cap = 3 * DT + Math.hypot(C.vx || 0, C.vz || 0) * DT; if (ml > cap) { tx = f.tx + mx * cap / ml; tz = f.tz + mz * cap / ml; } }
        f.tx = tx; f.tz = tz;
        const e = U.smooth(t);
        f.x = f.ax + (tx - f.ax) * e; f.z = f.az + (tz - f.az) * e;
        f.lift = Math.sin(Math.PI * t) * (0.09 + 0.05 * U.smooth((C.spd - 1.5) / 2));
      }
      // (standing still: the feet back under the hips)
      if (C.walkAmp < 0.02) { f.x = rx; f.z = rz; f.lift = 0; }
      if (!f.st || Math.hypot(f.x - rx, f.z - rz) > 0.04) far = true;
    }
    return far;
  }

  function pose(cr, dt) {
    const F = frame(cr), BF = { x: cr.box.x, y: cr.box.y, h: cr.box.h }, st = cr.state, u = cr.u || 0;
    for (let q = 0; q < NPER; q++) {
      const R = ROLES[q];
      // where this person is: their place at the car (lx, ly, in the car's frame F) and their place in
      // the garage's mouth (the box's frame), in between by cr.w (0 waiting .. 1 at the car)
      const wa = waitAt(cr, q), w = U.smooth(U.clamp(cr.w, 0, 1));
      let lx = R.x, ly = R.gs ? R.y * cr.side : R.y;
      const P = { crouch: 0, arms: 0, yaw: 0, gun: R.r === 'g', jack: R.r === 'j' ? 0 : null, tyre: R.r === 'n' && st === 'ready' };
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
          if (st === 'stop' && s > 0.17 && s < 0.55) P.carried = true;
          if (s > 0.17) { P.tyre = true; P.tyreAt = V(0, 1.0, 0.38); ly += R.corner[1] * 0.75 * off; lx += 0.25 * off; if (st === 'stop') P.lerpT = { from: 'hub', f: U.smooth((s - 0.17) / 0.13) }; }
        } else if (R.r === 'n') {
          // the new wheel held upright at hub height, slid onto the hub (0.4..0.55)
          P.crouch = 0.65; P.arms = 0.95; P.tyre = st === 'ready' || s < 0.55;
          const on = U.smooth((s - 0.4) / 0.15);
          if (st === 'stop') { ly -= R.corner[1] * 0.38 * on; lx += 0.3 * on; }
          if (P.tyre) P.tyreAt = V(0, 1.0, 0.38);
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
        else if (R.r === 'w') { P.crouch = 1; P.arms = st === 'stop' && s > 0.08 && s < 0.72 ? 0.9 : 0.4; }
        else if (R.r === 'c') { P.arms = 0.15; if (st === 'stop' && s > 0.93) P.armR = -2.4 * U.smooth((s - 0.93) / 0.05); }
      } else if (st === 'release') {
        // stepping back from the car as it goes
        const back = U.smooth(cr.t / 0.6);
        // (everyone at least 1.8 m out from the car's axis, the old wheels carried back with them)
        const sg = Math.sign(R.y || cr.side);
        ly += sg * Math.max(0, (sg === -cr.side ? 2.5 : 1.9) - Math.abs(R.y)) * back; if (R.r === 'j') lx += (R.front ? 0 : -1) * back, ly += R.front ? cr.side * 1.5 : 0;
        if (R.r === 'o') { P.tyre = true; P.tyreAt = V(0, 1.0, 0.38); ly += Math.sign(R.y) * 0.75; }
      } else if (st === 'back' && R.r === 'o') {
        // (the old wheels carried back to the garage)
        P.tyre = true; P.tyreAt = V(0, 1.0, 0.38);
        P.crouch = R.r === 'g' ? 1 - back : 0; P.gun = R.r === 'g'; P.arms = 0.3;
      }
      // Waiting in the garage the wheel-on men stand with their new wheels, upright on the floor in
      // front of them, hands on top (and the wheel-off men with the old ones they brought back); they lift
      // them to walk out.
      if (st === 'idle' && (R.r === 'n' || R.r === 'o' && cr.oldHeld)) {
        P.tyre = true; P.tyreAt = V(0, TYRE_R, 0.5); P.crouch = 0.25; P.arms = 0.55; P.lean = 0.15;
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
          P.x += -sh * sd * pen; P.z += ch * sd * pen; P.away = true;
        }
      }
      // (walking: facing the way they go)
      if (cr.moving && Math.hypot(ax - bx, az - bz) > 0.3) yaw = Math.atan2((az - bz) * cr.dir, (ax - bx) * cr.dir) - F.h;
      // (a wheel carried at the waist, lower and further out as they crouch over their work)
      // (the crouch as it is: walking stands a person up)
      const cE = (P.crouch || 0) * (1 - ((cr.cur[q] && cr.cur[q].up) || 0));
      if (P.tyre && P.tyreAt && P.tyreAt.y > 0.9) P.tyreAt.set(0, 1.0 - 0.5 * cE, 0.38 + 0.15 * cE);
      // three's y rotation: local +z to (sin, cos); a person faces local +z
      const hW = F.h + yaw;
      P.yaw = Math.PI / 2 - hW;
      // a wheel on its way between the car's hub and the hands (the car's own wheel is hidden
      // meanwhile, wheels() below): the hub of this corner as the car is drawn
      if (P.lerpT && R.corner) {
        const hubs = cr.car && HUBS.get(cr.car), hub = hubs && hubs[(R.corner[0] > 0 ? 0 : 2) + (R.corner[1] > 0 ? 1 : 0)];
        if (hub) {
          const cz = 0.38 + 0.15 * cE, cyy = 1.0 - 0.5 * cE;
          const hw = V(P.x + Math.sin(P.yaw) * cz, P.y + cyy, P.z + Math.cos(P.yaw) * cz), f = P.lerpT.f;
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
      // Every change eased as a body moves: by critically damped springs, so a move gathers speed and
      // slows to a stop instead of starting at full speed the moment the plan changes (a first-order
      // ease did that, and read as a snap from one pose to the next). A person moves no faster than a
      // sprint, 4.5 m/s, nor speeds up or slows faster than 7 m/s^2; turns no faster than 7 rad/s.
      const k = dt > 0 ? 1 - Math.exp(-dt / 0.11) : 1;
      C.sv = C.sv || {};
      const n = dt > 0 ? Math.max(1, Math.ceil(dt / 0.02)) : 0, h = n ? dt / n : 0;
      const spring = (key, w, tgt) => {
        if (!n) { C[key] = tgt; C.sv[key] = 0; return; }
        let x = C[key] == null ? tgt : C[key], v = C.sv[key] || 0;
        for (let i = 0; i < n; i++) { v += (w * w * (tgt - x) - 2 * w * v) * h; x += v * h; }
        C[key] = x; C.sv[key] = v;
      };
      for (const key of ['y', 'crouch', 'arms', 'lean', 'armR', 'armL']) spring(key, 10, P[key] || 0);
      const ox = C.x, oz = C.z;
      if (!n) { C.x = P.x; C.z = P.z; C.mvx = C.mvz = 0; }
      else for (let i = 0; i < n; i++) {
        const w = P.away ? 12 : 7; // (quicker out of a car's way)
        let ax = w * w * (P.x - C.x) - 2 * w * (C.mvx || 0), az = w * w * (P.z - C.z) - 2 * w * (C.mvz || 0);
        const al = Math.hypot(ax, az); if (al > 7) { ax *= 7 / al; az *= 7 / al; }
        let vx = (C.mvx || 0) + ax * h, vz = (C.mvz || 0) + az * h;
        const vl = Math.hypot(vx, vz); if (vl > 4.5) { vx *= 4.5 / vl; vz *= 4.5 / vl; }
        C.mvx = vx; C.mvz = vz; C.x += vx * h; C.z += vz * h;
      }
      {
        let dyaw = Math.atan2(Math.sin(P.yaw - C.yaw), Math.cos(P.yaw - C.yaw)), yv = C.sv.yaw || 0;
        for (let i = 0; i < n; i++) { yv += (81 * dyaw - 18 * yv) * h; yv = U.clamp(yv, -7, 7); C.yaw += yv * h; dyaw -= yv * h; }
        if (!n) C.yaw = P.yaw;
        C.sv.yaw = yv;
      }
      if (P.jack == null) C.jack = null; else { if (C.jack == null) C.jack = P.jack; spring('jack', 12, P.jack); }
      // The walk: how fast they really go (eased a little), the way they go in their own frame, and the
      // stride's phase run on by the ground covered, so the feet keep pace with the body.
      if (dt > 0) {
        const vx = (C.x - ox) / dt, vz = (C.z - oz) / dt, kv = 1 - Math.exp(-dt / 0.07);
        C.vx = (C.vx || 0) + (vx - (C.vx || 0)) * kv; C.vz = (C.vz || 0) + (vz - (C.vz || 0)) * kv;
      }
      C.spd = Math.hypot(C.vx || 0, C.vz || 0);
      const stepL = U.clamp(0.3 + 0.18 * C.spd, 0.3, 0.75);
      // (come to a stop with a foot still out: one more step or two, in place, to bring it under)
      const dW = Math.hypot(C.x - ox, C.z - oz) / (2 * stepL) * 2 * Math.PI;
      C.walk = (C.walk == null ? q * 0.9 : C.walk) + (C.far && (P.crouch || 0) < 0.3 ? Math.max(dW, dt * 2 * Math.PI * 0.9) : dW);
      DT = dt; C.far = feet(C, stepL);
      // (getting up off a knee to walk, or down onto it, takes a person a good part of a second)
      C.up = C.up == null ? C.walkAmp || 0 : C.up + ((C.walkAmp || 0) - C.up) * (dt > 0 ? 1 - Math.exp(-dt / 0.22) : 1);
      C.walkAmp += (Math.max(U.smooth((C.spd - 0.12) / 0.45), C.far && (P.crouch || 0) < 0.3 ? 0.6 : 0) - C.walkAmp) * (dt > 0 ? 1 - Math.exp(-dt / 0.12) : 1);
      C.tyre = P.tyre; C.tyreW = P.tyreW;
      // (a wheel lifted or set down, not jumped)
      if (P.tyreAt) {
        if (!C.tyreAt || !C.tyre0) { C.tyreAt = P.tyreAt.clone(); C.tav = new THREE.Vector3(); }
        else for (let i = 0; i < n; i++) { const w = 8; C.tav.x += (w * w * (P.tyreAt.x - C.tyreAt.x) - 2 * w * C.tav.x) * h; C.tav.y += (w * w * (P.tyreAt.y - C.tyreAt.y) - 2 * w * C.tav.y) * h; C.tav.z += (w * w * (P.tyreAt.z - C.tyreAt.z) - 2 * w * C.tav.z) * h; C.tyreAt.addScaledVector(C.tav, h); }
      } else C.tyreAt = null;
      C.tyre0 = P.tyre; C.carried = P.carried; C.gun = P.gun;
      // (still settling: keep posing this crew)
      // (walking while their place moves under them by more than a stroll)
      const mv = Math.hypot(P.x - C.x, P.z - C.z);
      if (mv + Math.abs(Math.atan2(Math.sin(P.yaw - C.yaw), Math.cos(P.yaw - C.yaw))) + Math.abs((P.crouch || 0) - C.crouch) > 0.002 || Math.hypot(C.mvx || 0, C.mvz || 0) > 0.005 || Object.values(C.sv).some(v => Math.abs(v) > 0.005) || C.walkAmp > 0.01 || Math.abs(C.up - C.walkAmp) > 0.01) cr.settling = true;
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
      else if (p && !p.served && (p.phase === 'in' || p.phase === 'approach' && car.loc && (was === 'ready' || Tracks.fwd(S.tr, car.loc.s, S.tr.pit.sIn) < 900))) next = 'ready';
      else if (p && p.served && (p.phase === 'in' || p.phase === 'out') && was !== 'idle') next = was === 'release' && cr.t > 1.2 ? 'back' : (was === 'back' ? 'back' : 'release');
      else if (was === 'release' || was === 'back') next = 'back';
      if (next !== was) {
        // (out to the car: the old wheels they were standing with left where they were, on the floor)
        if (was === 'idle' && cr.oldHeld) {
          cr.oldSpot = OQ.map(q => TYW[cr.k * NPER + q] && TYW[cr.k * NPER + q].clone()); cr.oldHeld = false;
          if (cr.cl) { cr.cl.U.f.comp.value.copy(cr.cl.U.o.comp.value); cr.cl.U.f.wear.value.copy(cr.cl.U.o.wear.value); cr.fAng = cr.cl.o.map(it => it.w.userData.crewAng || 0); }
        }
        // (a new stop: its spares are the ones in hand)
        if (next === 'ready') cr.nCycle = false;
        cr.state = next; cr.t = 0;
      }
      cr.t += dt;
      // walking out to the box while a car is on its way, back to the garage afterwards (about 2 s)
      const target = cr.state === 'idle' || cr.state === 'back' ? 0 : 1, w0 = cr.w;
      cr.w += U.clamp(target - cr.w, -dt / 2.2, dt / 2.2);
      cr.moving = Math.abs(cr.w - w0) > 1e-5; cr.dir = target > w0 ? 1 : -1;
      if (cr.state === 'back' && cr.w <= 0) { cr.state = 'idle'; cr.t = 0; cr.oldHeld = true; }
      if (cr.state === 'idle' || cr.state === 'ready') cr.stopF = null;
      cr.u = cr.state === 'stop' && p && p.service ? U.clamp(1 - (p.serviceT || 0) / p.service, 0, 1) : 0;
      // (re-posed only while something changes: a crew standing still costs nothing)
      let near = false;
      for (const c of cars) if (c && c.x != null && (c.speed || 0) > 0.3 && (c.x - cr.box.x) ** 2 + (c.y - cr.box.y) ** 2 < 900) { near = true; break; }
      if (near || cr.moving || cr.settling || cr.state === 'stop' || cr.state === 'release' || was !== cr.state || cr.dirty) { cr.settling = false; pose(cr, dt); cr.dirty = false; any = true; }
    }
    for (const cr of S.crews) clones(cr, cars);
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
    d.lastDt = dt;
    // (its speed as drawn, from where it was drawn last: the spring's own velocity lagged the lead)
    if (d.px != null) { const kv = 1 - Math.exp(-dt / 0.06); d.mvx = (d.mvx == null ? (d.x - d.px) / d.pdt : d.mvx + ((d.x - d.px) / d.pdt - d.mvx) * kv); d.mvy = (d.mvy == null ? (d.y - d.py) / d.pdt : d.mvy + ((d.y - d.py) / d.pdt - d.mvy) * kv); }
    d.px = d.x; d.py = d.y; d.pdt = dt;
    // (a reset or a teleport: start again where the car is)
    if (Math.hypot(c.x - d.x, c.y - d.y) > 8) { d.x = c.x; d.y = c.y; d.vx = c.vx || 0; d.vy = c.vy || 0; d.h = 0; d.vh = 0; d.rel = null; d.stood = false; }
    const stop = p && p.phase === 'stop';
    const cr = S && c.team ? S.crews.find(q => q.team === c.team || q.team.id === c.team.id) : null;
    if (stop) d.stood = true;
    if (d.stood && !stop) {
      // released: the offset at that moment fades out as the car pulls away
      // (over the ground it covers, 14 m, not a time: a car slow off the line would otherwise slide
      // sideways back onto the race's line while hardly moving)
      if (!d.rel) d.rel = { ox: d.x - c.x, oy: d.y - c.y, oh: d.h, t: 0, s: 0 };
      d.plan = null;
      d.rel.t += dt; d.rel.s += Math.max(0, c.speed || 0) * dt;
      const k = Math.min(1 - U.smooth(d.rel.s / 14), 1 - U.smooth((d.rel.t - 2) / 3));
      d.x = c.x + d.rel.ox * k; d.y = c.y + d.rel.oy * k; d.h = d.rel.oh * k; d.vx = c.vx || 0; d.vy = c.vy || 0; d.vh = 0;
      if (k <= 0) { d.done = true; return null; }
      return [d.x - c.x, d.y - c.y, d.h];
    }
    // The arrival, planned: some 25 m out the car as drawn is given one run into its box, along it as
    // a quintic in time from where it is, at the speed it is going (braking as it is, at about 3 m/s^2),
    // to rest at the box's centre with no speed and no braking left, so the braking builds and eases
    // off as a driver's does; across from the lane to the box in the first four fifths of that time,
    // the car pointing along its own path (no sideways slide) and straight by the end, its front wheels
    // steered to the path. The run lasts as long as the race takes to stop the car from there (its
    // 4.5 m/s^2 braking law), within what keeps the run from overshooting or braking too hard.
    if (cr && p && !p.served && S.tr && c.team) {
      const box = S.tr.pit.boxS[c.team.idx], L = S.tr.L, r = box == null || !c.loc ? 1e9 : ((box - c.loc.s) % L + L * 1.5) % L - L / 2;
      const bh = cr.box.h, ch = Math.cos(bh), sh = Math.sin(bh);
      if (!d.plan && !stop && r < 26 && r > 2) {
        const ex = d.x - cr.box.x, ey = d.y - cr.box.y, s0 = ex * ch + ey * sh, l0 = -ex * sh + ey * ch;
        const mvx = d.mvx == null ? d.vx : d.mvx, mvy = d.mvy == null ? d.vy : d.mvy;
        const vs = Math.max(0.5, mvx * ch + mvy * sh), vl = -mvx * sh + mvy * ch, dist = -s0;
        if (dist > 1) {
          let T = (2 / 3) * (Math.sqrt(Math.max(r - 0.5, 1.1)) - Math.sqrt(1.1)) + 0.15;
          T = U.clamp(T, 1.25 * dist / vs, 1.8 * dist / vs);
          d.plan = { t: 0, T, S: quint(s0, vs, -3, T), Lt: T * 0.8, Lq: quint(l0, vl, 0, T * 0.8), psi: null, sv: null, acc: 0, steer: 0 };
        }
      }
      const P = d.plan;
      if (P && P.t < P.T) {
        P.t = Math.min(P.T, P.t + dt);
        const t = P.t, sp = qv(P.S, t), sv = qd(P.S, t), tl = Math.min(t, P.Lt), l = qv(P.Lq, tl), lv = t < P.Lt ? qd(P.Lq, tl) : 0;
        const nx = cr.box.x + ch * sp - sh * l, ny = cr.box.y + sh * sp + ch * l;
        d.vx = (nx - d.x) / dt; d.vy = (ny - d.y) / dt; d.x = nx; d.y = ny;
        const psi = Math.atan2(lv, Math.max(sv, 0.3));
        if (P.psi != null) P.steer += (U.clamp(Math.atan(3.6 * wrapA(psi - P.psi) / Math.max(sv * dt, 1e-3)), -0.35, 0.35) - P.steer) * (1 - Math.exp(-dt / 0.08));
        P.acc = P.sv == null ? 0 : (sv - P.sv) / dt;
        P.psi = psi; P.sv = sv;
        d.h = wrapA(bh + psi - c.h); d.vh = 0;
        return [d.x - c.x, d.y - c.y, d.h];
      }
    }
    // the target: the race's place, or through the stop (and once the planned run is done) the box's
    // centre and heading
    let tx = c.x, ty = c.y, th = 0, w = 40;
    if ((stop || d.plan) && cr) { tx = cr.box.x; ty = cr.box.y; th = wrapA(cr.box.h - c.h); w = 6; if (d.plan) { d.plan.acc = 0; d.plan.steer *= Math.exp(-dt / 0.1); } }
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
  // quintic in time: from x0 at speed v0 and acceleration a0 to 0 at rest with none, by time T
  function quint(x0, v0, a0, T) {
    const T2 = T * T, T3 = T2 * T, T4 = T3 * T, T5 = T4 * T;
    const c3 = (-20 * x0 - 12 * v0 * T - 3 * a0 * T2) / (2 * T3), c4 = (30 * x0 + 16 * v0 * T + 3 * a0 * T2) / (2 * T4), c5 = (-12 * x0 - 6 * v0 * T - a0 * T2) / (2 * T5);
    return [x0, v0, a0 / 2, c3, c4, c5];
  }
  const qv = (c, t) => c[0] + t * (c[1] + t * (c[2] + t * (c[3] + t * (c[4] + t * c[5]))));
  const qd = (c, t) => c[1] + t * (2 * c[2] + t * (3 * c[3] + t * (4 * c[4] + t * 5 * c[5])));
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
        const h = w.userData.crewHome;
        const hx = h ? h.x : w.position.x, hz = h ? h.y : w.position.z;
        _v.set(hx, w.position.y + body.position.y, hz).applyAxisAngle(YAX, o.rotation.y).add(o.position);
        // (by where it sits: front or rear, and the car's right, +z, or left)
        const ci = (hx > 0 ? 0 : 2) + (hz > 0 ? 1 : 0);
        (hubs[ci] || (hubs[ci] = new THREE.Vector3())).copy(_v);
      });
    }
    // The planned run in: the front wheels steered to its path, and the car's nose dipping under its
    // braking and rising back, a little past level, as it comes to rest (a spring, lightly damped),
    // in place of what the race's own braking would make of it
    const sd = SET.get(c), pl = sd && sd.plan; const dtW = (sd && sd.lastDt) || 1 / 60;
    if (pl || sd && sd.pitch) {
      const tgt = pl && p && !p.served && pl.t < pl.T ? U.clamp(pl.acc * 0.0017, -0.024, 0.008) : 0;
      sd.pitch = sd.pitch || 0; sd.pv = sd.pv || 0;
      const nn = Math.max(1, Math.ceil(dtW / 0.01)), hh = dtW / nn;
      for (let i = 0; i < nn; i++) { sd.pv += (196 * (tgt - sd.pitch) - 2 * 0.35 * 14 * sd.pv) * hh; sd.pitch += sd.pv * hh; }
      if (pl && p && !p.served) body.rotation.z += sd.pitch - (c.pitch || 0) * 1;
      else { body.rotation.z += sd.pitch; if (Math.abs(sd.pitch) < 1e-4 && Math.abs(sd.pv) < 1e-3) sd.pitch = 0; }
      if (pl && pl.steer) for (const w of wl) if (w.userData && w.userData.front) w.rotation.y = -pl.steer;
    }
    // The car's own wheels come off: from the moment its wheel-off man pulls it (u 0.17) until the new
    // one is on (u 0.55) each wheel goes where his hands have it, out from the hub and away (the wheel
    // and its rim; the upright and brake duct stay on the car). From u 0.55 it is back on its hub as the
    // new wheel, the very copy the wheel-on man carried in (clones() below), and he that took it off
    // holds a copy of it, so no wheel ever changes its look.
    const cr = stop && S ? S.crews.find(q => q.team === c.team || q.team.id === c.team.id) : null;
    const off = cr && u > 0.17 && u < 0.55;
    // (the wheels drawn one by one, not merged, from a little before they come off: the metal wheel is
    // partly among the parts that do not spin, and goes off with the rest of it)
    if (body.userData) body.userData.pitWheels = !!(cr && u > 0.1 && u < 0.62);
    if (off) { o.updateMatrix(); body.updateMatrix(); }
    if (!off && !c.__crewOff && !(stop && u >= 0.55)) return;
    for (const w of wl) {
      const d = w.userData, tilt = d && d.spin && d.spin.parent;
      if (!tilt) continue;
      const ci = (w.position.x > 0 ? 0 : 2) + (w.position.z > 0 ? 1 : 0);
      const at = off ? TYW[cr.k * NPER + OQ[ci]] : null;
      if (at) {
        w.updateMatrix();
        _M.multiplyMatrices(o.matrix, body.matrix).multiply(w.matrix).invert();
        tilt.position.copy(at).applyMatrix4(_M);
        d.crewAng = d.ang || 0;
      } else tilt.position.set(0, 0, 0);
      // (and the spoked metal wheel, which the model keeps among the parts that do not spin: it goes
      // with the tyre, leaving the brake drum and the upright on the car)
      for (const m of rimsOf(d)) m.position.copy(tilt.position);
      // (the new wheel goes on as the copy was carried: unturned; the car turns it on from there)
      if (stop && u >= 0.55) { d.ang = 0; d.spin.rotation.z = 0; }
    }
    // From u 0.55 the wheels on the car are the new ones: unworn, in the compound chosen for the stop
    // (the race itself fits them at the stop's end; its compound then is the same)
    const bu = body.userData;
    if (stop && u >= 0.55 && F1.R3Tyre) {
      if (bu.tyWear) bu.tyWear.set(0, 0, 0, 0);
      if (bu.tyComp) bu.tyComp.value.copy(F1.R3Tyre.compColor(newComp(c)));
    } else if (bu.tyComp && c.compound && F1.R3Tyre && c.__crewComp) bu.tyComp.value.copy(F1.R3Tyre.compColor(c.compound.id));
    c.__crewComp = !!(stop && u >= 0.55);
    c.__crewOff = off;
  }
  const _M = new THREE.Matrix4();
  // a wheel's spoked metal rim where the model keeps it with the upright (by its material's name: the
  // carbon brake drum and duct stay on the car)
  function rimsOf(d) {
    if (d.crewRims) return d.crewRims;
    const r = [];
    for (const hg of d.hubs || []) for (const m of hg.children) if (m.isMesh && /wheel/i.test((m.material && m.material.name) || '')) r.push(m);
    d.crewRims = r;
    return r;
  }

  // Copies of the team's own wheels for the crew's hands: the wheel-on men's new wheels (n) and, once
  // theirs is off, the wheel-off men's old ones (o); the car's own wheel parts (their geometry and
  // materials shared, so its tyre's compound, wear and lettering), one copy of each corner's wheel for
  // each. Made from the car the crew is serving, or from either of the team's cars while they wait;
  // placed where the hands are (TYW), turned as the wheel sits on a car in the box.
  const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), ZAX = new THREE.Vector3(0, 0, 1), _s = new THREE.Vector3(1, 1, 1);
  function wheelSrc(cr, cars) {
    const models = F1.R3 && F1.R3.carModels;
    if (!models) return null;
    const pick = cr.car || cars.find(c => c.team === cr.team || c.team && c.team.id === cr.team.id);
    const m = pick && models.get(pick), body = m && m.userData && m.userData.body, wl = body && body.userData && body.userData.wheels;
    return wl && wl.length === 4 && wl.every(w => w.userData && w.userData.lods && w.userData.lods[0]) ? { car: pick, body, wl } : null;
  }
  // where a wheel-on man's wheel stands while he waits: half a metre ahead of his place in the garage
  const TYRE_R = 0.362, _spot = new THREE.Vector3();
  function spareSpot(cr, q) {
    const wa = waitAt(cr, q), BF = { x: cr.box.x, y: cr.box.y, h: cr.box.h }, [x, z] = toWorld(BF, wa[0], wa[1]);
    const yaw = Math.PI / 2 - (cr.box.h + (cr.side > 0 ? -Math.PI / 2 : Math.PI / 2));
    return _spot.set(x + Math.sin(yaw) * 0.5, cr.gy + TYRE_R, z + Math.cos(yaw) * 0.5);
  }
  const newComp = car => (car.pitPlan && car.pitPlan.compound) || (car.compound && car.compound.id);
  function dropClones(cr) {
    if (!cr.cl) return;
    for (const g of cr.cl.all) if (g.parent) g.parent.remove(g);
    cr.cl = null;
  }
  function clones(cr, cars) {
    const src = wheelSrc(cr, cars);
    if (!src) { dropClones(cr); return; }
    // (rebuilt only for another model: the team's two cars share theirs)
    const mid = src.body.userData.carId || src.car;
    if (cr.cl && cr.cl.mid === mid) cr.cl.car = src.car;
    if (!cr.cl || cr.cl.mid !== mid) {
      dropClones(cr);
      const n = [], o = [], f = [], all = [];
      // (each set its own copies of the tyre materials: the new wheels in the compound chosen for this
      // stop and unworn, the old ones in the compound and wear they came off with)
      const T0 = () => new THREE.Color(0xffd400);
      const U2 = { n: { comp: { value: T0() }, wear: { value: new THREE.Vector4() } }, o: { comp: { value: T0() }, wear: { value: new THREE.Vector4() } }, f: { comp: { value: T0() }, wear: { value: new THREE.Vector4() } } };
      const mats = { n: new Map(), o: new Map(), f: new Map() };
      const matFor = (m, set) => {
        if (mats[set].has(m)) return mats[set].get(m);
        const ud = m.userData; m.userData = {};
        const t = m.clone(); m.userData = ud;
        const ex = ud.patchExtra, u2 = U2[set];
        t.userData = Object.assign({}, ud, { patchExtra: sh => { if (ex) ex(sh); if (sh.uniforms.uTyComp) { sh.uniforms.uTyComp = u2.comp; sh.uniforms.uTyWear = u2.wear; } } });
        delete t.userData.r3s;
        if (F1.R3S) F1.R3S.patch(t);
        mats[set].set(m, t);
        return t;
      };
      for (const w of src.wl) {
        const ci = (w.position.x > 0 ? 0 : 2) + (w.position.z > 0 ? 1 : 0);
        for (const [arr, set] of [[n, 'n'], [o, 'o'], [f, 'f']]) {
          const g = w.userData.lods[0].clone(true);
          // (whole: its spoked metal rim as well)
          for (const m of rimsOf(w.userData)) if (m.parent === w.userData.hubs[0]) { const q = m.clone(); q.position.set(0, 0, 0); g.add(q); }
          g.visible = false; g.matrixAutoUpdate = false;
          g.traverse(q => { if (q.isMesh) { q.castShadow = true; q.receiveShadow = true; if (!Array.isArray(q.material)) q.material = matFor(q.material, set); } });
          S.root.add(g); arr[ci] = { g, w }; all.push(g);
        }
      }
      cr.cl = { car: src.car, mid, n, o, f, all, U: U2, oldId: null };
    }
    // the compounds: new, the one chosen for this stop (the player's choice, or the strategist's);
    // old, the one the car came in on (noted while it is still on the car)
    const car = cr.car, p = car && car.brain && car.brain.pit, R3T = F1.R3Tyre;
    if (car && car.compound && R3T) {
      const stopping = p && p.phase === 'stop', u = stopping && p.service ? 1 - (p.serviceT || 0) / p.service : -1;
      if (stopping || cr.state === 'ready') cr.cl.oldId = car.compound.id;
      const newId = newComp(car);
      cr.cl.U.n.comp.value.copy(R3T.compColor(newId));
      cr.cl.U.o.comp.value.copy(R3T.compColor(cr.cl.oldId || car.compound.id));
      const m = F1.R3.carModels.get(car), tw = m && m.userData.body && m.userData.body.userData.tyWear;
      if (tw && (cr.state === 'ready' || stopping && u < 0.55)) cr.cl.U.o.wear.value.copy(tw);
    }
    // Nothing a viewer is watching appears or vanishes. The next stop's new wheels are stood at the
    // wheel-on men's places in the garage once these are on the car, at the first moment those places
    // are out of the camera's view (or, at the latest, when the crew is home); a man picks his up as his
    // hands come to it. The old wheels set down when the crew went out stay on the floor until the
    // camera looks away (or the crew is home with the next ones).
    const cam = F1.R3 && F1.R3.camera;
    if (cam) _fr.setFromProjectionMatrix(_m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    // (in view: inside the camera's frustum, within 160 m, and not behind one of the crew standing close
    // in front of it, as when they walk back past it)
    const hidBy = pt => {
      const cx = cam.position.x, cz = cam.position.z, dx = pt.x - cx, dz = pt.z - cz, L2 = dx * dx + dz * dz;
      for (const C of cr.cur) {
        if (!C) continue;
        const ex = C.x - cx, ez = C.z - cz, t = (ex * dx + ez * dz) / L2;
        if (t < 0.6 || t > 0.98) continue;
        const px = cx + dx * t, pz = cz + dz * t, y = cam.position.y + (pt.y - cam.position.y) * t;
        if (Math.hypot(C.x - px, C.z - pz) < 0.14 && y > cr.gy && y < cr.gy + 1.7 && Math.hypot(C.x - pt.x, C.z - pt.z) < 2.2) return true;
      }
      return false;
    };
    const seen = pt => !!cam && pt.distanceToSquared(cam.position) < 160 * 160 && _fr.intersectsSphere(_sph.set(pt, 0.6)) && !hidBy(pt);
    const u = cr.u || 0;
    if (cr.state === 'stop' && u >= 0.55 && !cr.nCycle) { cr.nCycle = true; cr.nPend = true; cr.nSpare = [false, false, false, false]; }
    if (cr.nPend) {
      // (each wheel on its own: stood there the first moment its place is out of sight)
      cr.nSpare = cr.nSpare || [false, false, false, false];
      for (let ci = 0; ci < 4; ci++) if (!cr.nSpare[ci] && (cr.state === 'idle' || !seen(spareSpot(cr, NQ[ci])))) cr.nSpare[ci] = true;
      if (cr.nSpare.every(Boolean)) cr.nPend = false;
    }
    if (cr.oldSpot) {
      for (let ci = 0; ci < 4; ci++) if (cr.oldSpot[ci] && (!seen(cr.oldSpot[ci]) || cr.state === 'idle' && cr.oldHeld)) cr.oldSpot[ci] = null;
      if (!cr.oldSpot.some(Boolean)) cr.oldSpot = null;
    }
    for (let ci = 0; ci < 4; ci++) {
      for (const [arr, role] of [[cr.cl.n, NQ], [cr.cl.o, OQ], [cr.cl.f, OQ]]) {
        const it = arr[ci], q = role[ci], C = cr.cur[q], hold = C && C.tyre && !C.carried ? TYW[cr.k * NPER + q] : null;
        let at = null, ang = 0;
        if (arr === cr.cl.n) {
          if (cr.nSpare && cr.nSpare[ci]) {
            const sp = spareSpot(cr, q);
            // (picked up: his hands at it, or a moment after he is home whatever they are doing)
            if (hold && cr.state === 'idle' && (hold.distanceTo(sp) < 0.15 || cr.t > 1.6)) { cr.nSpare[ci] = false; at = hold; }
            else at = sp;
          } else if (hold && !(cr.nPend && cr.state !== 'idle')) at = hold;
        } else if (arr === cr.cl.o) { at = hold; ang = it.w.userData.crewAng || 0; }
        else if (cr.oldSpot && cr.oldSpot[ci]) { at = cr.oldSpot[ci]; ang = cr.fAng ? cr.fAng[ci] : 0; }
        it.g.visible = !!at;
        if (!at) continue;
        const d = it.w.userData, tilt = d.spin.parent;
        _q.setFromAxisAngle(YAX, -cr.box.h).multiply(tilt.quaternion).multiply(_q2.setFromAxisAngle(ZAX, -ang));
        it.g.matrix.compose(at, _q, _s);
        // (its world matrices made here: the venue's tree is not walked every frame, being still)
        it.g.updateMatrixWorld(true);
      }
    }
  }
  const _fr = new THREE.Frustum(), _m4 = new THREE.Matrix4(), _sph = new THREE.Sphere();

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
