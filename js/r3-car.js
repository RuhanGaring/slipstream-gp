// 3D F1 car built from code. Local frame: x forward (nose at +x), y up, z to the
// driver's right; origin at the centre of gravity, ground at y = 0. Dimensions follow
// a current F1 car: 5.6 m long, 2.0 m wide, 3.6 m wheelbase, 18 inch wheels.
(function (G) {
  'use strict';
  const F1 = G.F1;

  // Loft: superelliptic cross-sections along x. stations: {x, w, h, y, z}
  // Catmull-Rom resampling of the stations so the surface curves smoothly between them
  // (a gloss clear coat shows every facet as a band in the reflection otherwise).
  function smoothStations(st, sub) {
    const out = [], keys = ['x', 'w', 'h', 'y', 'z'];
    const at = (i, k) => (st[Math.max(0, Math.min(st.length - 1, i))][k] || 0);
    for (let i = 0; i < st.length - 1; i++) for (let q = 0; q < sub; q++) {
      const t = q / sub, o = {};
      for (const k of keys) {
        const p0 = at(i - 1, k), p1 = at(i, k), p2 = at(i + 1, k), p3 = at(i + 2, k);
        o[k] = 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
      }
      o.w = Math.max(0.01, o.w); o.h = Math.max(0.01, o.h);
      out.push(o);
    }
    out.push(Object.assign({ z: 0 }, st[st.length - 1]));
    return out;
  }

  function loft(stations, segs, colorAt, n = 2.6) {
    stations = smoothStations(stations, 4);
    segs = Math.max(segs, 36);
    const pos = [], col = [], idx = [];
    const c = new THREE.Color();
    stations.forEach((st, si) => {
      for (let k = 0; k < segs; k++) {
        const a = k / segs * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const px = Math.sign(ca) * Math.pow(Math.abs(ca), 2 / n) * st.w / 2;
        const py = Math.sign(sa) * Math.pow(Math.abs(sa), 2 / n) * st.h / 2;
        pos.push(st.x, st.y + py, (st.z || 0) + px);
        c.set(colorAt(si / (stations.length - 1), sa, ca));
        col.push(c.r, c.g, c.b);
      }
    });
    const S = stations.length;
    // Winding must face outward. That depends on which way the stations run along x:
    // listed nose-to-tail (x falling), the natural order would point every face inward.
    const rev = stations[0].x > stations[S - 1].x;
    for (let si = 0; si < S - 1; si++) for (let k = 0; k < segs; k++) {
      const a = si * segs + k, b = si * segs + (k + 1) % segs, d = (si + 1) * segs + k, e = (si + 1) * segs + (k + 1) % segs;
      if (rev) idx.push(a, b, d, b, e, d); else idx.push(a, d, b, b, d, e);
    }
    // end caps
    for (const [si, first] of [[0, true], [S - 1, false]]) {
      const ci = pos.length / 3, st = stations[si];
      pos.push(st.x, st.y, st.z || 0);
      c.set(colorAt(si / (S - 1), 0, 1)); col.push(c.r, c.g, c.b);
      for (let k = 0; k < segs; k++) {
        const a = si * segs + k, b = si * segs + (k + 1) % segs;
        if (first !== rev) idx.push(ci, b, a); else idx.push(ci, a, b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  function box(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx) g.rotateX(rx); if (ry) g.rotateY(ry); if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    return g;
  }

  function beam(p1, p2, r) {
    const a = new THREE.Vector3(...p1), b = new THREE.Vector3(...p2);
    const len = a.distanceTo(b);
    const g = new THREE.CylinderGeometry(r, r, len, 6);
    const m = new THREE.Matrix4();
    const dir = b.clone().sub(a).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    m.compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(m);
    return g;
  }

  function merge(geos) {
    // merge non-indexed copies (enough for static car parts)
    const parts = geos.map(g => (g.index ? g.toNonIndexed() : g));
    let n = 0; for (const g of parts) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    let o = 0;
    for (const g of parts) {
      if (!g.attributes.normal) g.computeVertexNormals();
      pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3);
      if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
      o += g.attributes.position.count;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return out;
  }

  const shared = {};
  function mats() {
    if (shared.carbon) return shared;
    const T = F1.R3T, cf = T.carbon();
    const weave = (rep, o) => {
      const m = cf.map.clone(), nm = cf.normal.clone();
      m.repeat.set(rep, rep); nm.repeat.set(rep, rep); m.needsUpdate = nm.needsUpdate = true;
      return Object.assign({ map: m, normalMap: nm, normalScale: new THREE.Vector2(0.35, 0.35) }, o);
    };
    // carbon fibre: the weave is resin-filled, so a dielectric base under a clear resin coat
    shared.carbon = new THREE.MeshPhysicalMaterial(weave(14, { roughness: 0.5, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.25 }));
    shared.floor = new THREE.MeshPhysicalMaterial(weave(14, { roughness: 0.62, metalness: 0, color: 0x9a9a9a }));
    shared.carbonGloss = new THREE.MeshPhysicalMaterial(weave(6, { roughness: 0.4, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04 }));
    // slick tyre: dark rubber, fairly rough, a faint sheen once warm
    shared.tyre = new THREE.MeshPhysicalMaterial({ color: 0x1c1c1e, roughness: 0.78, metalness: 0, sheen: 0.4, sheenRoughness: 0.6, sheenColor: new THREE.Color(0x303034) });
    if (T.has('rubber')) {
      shared.tyre.normalMap = T.photo('rubber_n', [10, 1], false); shared.tyre.normalScale.set(0.35, 0.35);
      shared.tyre.roughnessMap = T.photo('rubber_arm', [10, 1], false);
    }
    shared.sidewall = new THREE.MeshStandardMaterial({ map: T.sidewall(), roughness: 0.85, metalness: 0 });
    // forged magnesium rims, painted satin anthracite
    shared.rim = new THREE.MeshPhysicalMaterial({ color: 0x24272b, roughness: 0.38, metalness: 0.85, clearcoat: 0.3, clearcoatRoughness: 0.3 });
    // titanium halo, painted gloss black
    shared.halo = new THREE.MeshPhysicalMaterial({ color: 0x0a0b0c, roughness: 0.4, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.12 });
    // iridium visor: thin-film interference gives the blue-gold shift
    shared.visor = new THREE.MeshPhysicalMaterial({ color: 0x0b0d10, roughness: 0.06, metalness: 0.7, iridescence: 1, iridescenceIOR: 1.6, iridescenceThicknessRange: [250, 550] });
    shared.mirror = new THREE.MeshStandardMaterial({ color: 0x9aa4ae, roughness: 0.05, metalness: 1 });
    shared.cockpit = new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.9 });
    return shared;
  }

  const teamCache = new Map();
  const FINISH = { vanta: 'satin', ferro: 'gloss', meridian: 'satin', halcyon: 'gloss', norrland: 'satin', solenne: 'gloss', kodiak: 'satin', tessera: 'gloss', brightwater: 'gloss', aurex: 'satin' };

  function teamParts(team) {
    if (teamCache.has(team.id)) return teamCache.get(team.id);
    const M = mats();
    const base = team.base, acc = team.accent, third = team.third;
    const dark = '#16181c';
    // Livery finish: modern cars run either a satin (matte) wrap to save weight or a gloss
    // clear-coated paint. Both are dielectric base coats; the difference is the clear coat.
    const finish = FINISH[team.id] === 'satin'
      ? { roughness: 0.5, metalness: 0, clearcoat: 0.2, clearcoatRoughness: 0.5 }
      : { roughness: 0.3, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03 };
    const paint = new THREE.MeshPhysicalMaterial(Object.assign({ vertexColors: true }, finish));
    const accMat = new THREE.MeshPhysicalMaterial(Object.assign({ color: new THREE.Color(acc) }, finish));
    const baseMat = new THREE.MeshPhysicalMaterial(Object.assign({ color: new THREE.Color(base) }, finish));
    const helmetMat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(third), roughness: 0.25, metalness: 0.1, clearcoat: 1 });

    // monocoque, nose and engine cover: accent stripe along the spine
    const chassis = loft([
      { x: 2.95, w: 0.16, h: 0.11, y: 0.31 },
      { x: 2.55, w: 0.26, h: 0.18, y: 0.34 },
      { x: 1.95, w: 0.38, h: 0.28, y: 0.4 },
      { x: 1.3, w: 0.5, h: 0.4, y: 0.46 },
      { x: 0.85, w: 0.62, h: 0.48, y: 0.5 },
      { x: 0.2, w: 0.7, h: 0.5, y: 0.52 },
      { x: -0.35, w: 0.66, h: 0.66, y: 0.6 },
      { x: -0.75, w: 0.56, h: 0.64, y: 0.6 },
      { x: -1.35, w: 0.44, h: 0.5, y: 0.54 },
      { x: -1.95, w: 0.26, h: 0.34, y: 0.46 },
      { x: -2.35, w: 0.14, h: 0.2, y: 0.42 },
    ], 22, (t, sa) => (sa > 0.82 && t > 0.05 && t < 0.92 ? acc : sa < -0.55 ? dark : base));

    // sidepods with an undercut: carbon below, base above, accent sweep through the middle
    const pod = side => loft([
      { x: 0.42, w: 0.4, h: 0.3, y: 0.4, z: 0.6 * side },
      { x: 0.22, w: 0.52, h: 0.4, y: 0.42, z: 0.66 * side },
      { x: -0.3, w: 0.54, h: 0.42, y: 0.42, z: 0.64 * side },
      { x: -0.95, w: 0.42, h: 0.36, y: 0.4, z: 0.54 * side },
      { x: -1.5, w: 0.26, h: 0.28, y: 0.36, z: 0.4 * side },
      { x: -1.95, w: 0.12, h: 0.18, y: 0.33, z: 0.28 * side },
    ], 18, (t, sa) => (sa < -0.25 ? dark : sa > 0.05 && sa < 0.45 && t < 0.8 ? acc : base), 2.3);

    // airbox and roll hoop rising behind the helmet, blending into the engine cover
    const airbox = loft([
      { x: 0.06, w: 0.2, h: 0.16, y: 0.93 },
      { x: -0.12, w: 0.3, h: 0.26, y: 0.95 },
      { x: -0.5, w: 0.3, h: 0.26, y: 0.9 },
      { x: -0.95, w: 0.22, h: 0.2, y: 0.82 },
      { x: -1.45, w: 0.1, h: 0.1, y: 0.72 },
    ], 16, (t, sa) => (sa > 0.7 ? acc : base));
    const intake = new THREE.CircleGeometry(0.075, 14); intake.scale(1, 1.25, 1); intake.rotateY(Math.PI / 2); intake.translate(0.065, 0.94, 0);
    // floor and plank
    const floorShape = new THREE.Shape();
    [[1.2, -0.42], [0.8, -0.98], [-1.2, -0.98], [-1.75, -0.62], [-1.75, 0.62], [-1.2, 0.98], [0.8, 0.98], [1.2, 0.42]].forEach(([x, z], k) => (k ? floorShape.lineTo(x, z) : floorShape.moveTo(x, z)));
    const floor = new THREE.ExtrudeGeometry(floorShape, { depth: 0.035, bevelEnabled: false });
    floor.rotateX(Math.PI / 2); floor.translate(0, 0.085, 0);

    // front wing: main plane, two flaps, endplates
    const fw = merge([
      box(0.3, 0.025, 1.9, 2.74, 0.1, 0),
      box(0.18, 0.02, 1.62, 2.66, 0.15, 0, 0, 0, 0.32),
      box(0.15, 0.02, 1.5, 2.58, 0.2, 0, 0, 0, 0.5),
    ]);
    const fwEnd = merge([box(0.42, 0.24, 0.025, 2.7, 0.17, -0.96), box(0.42, 0.24, 0.025, 2.7, 0.17, 0.96)]);
    const nosePylon = merge([box(0.3, 0.16, 0.05, 2.65, 0.2, -0.12), box(0.3, 0.16, 0.05, 2.65, 0.2, 0.12)]);

    // rear wing: endplates, main plane, beam wing, pylon; the DRS flap is separate
    const rwEnd = merge([box(0.62, 0.62, 0.025, -2.42, 0.78, -0.52), box(0.62, 0.62, 0.025, -2.42, 0.78, 0.52)]);
    const rwMain = merge([box(0.32, 0.03, 1.02, -2.42, 0.86, 0, 0, 0, -0.12), box(0.22, 0.025, 0.8, -2.3, 0.42, 0, 0, 0, -0.2), box(0.12, 0.42, 0.06, -2.36, 0.62, 0)]);
    const flapGeo = box(0.24, 0.022, 1.02, 0, 0, 0, 0, 0, -0.55); // pivots about its leading edge

    // engine-cover fin (number goes on it), cockpit, mirrors
    const fin = box(1.2, 0.2, 0.02, -1.25, 0.86, 0);
    const cockpit = loft([{ x: 0.75, w: 0.36, h: 0.06, y: 0.77 }, { x: 0.15, w: 0.5, h: 0.08, y: 0.78 }, { x: -0.18, w: 0.42, h: 0.06, y: 0.79 }], 14, () => '#050506');
    const mirrors = merge([box(0.07, 0.05, 0.12, 0.82, 0.66, -0.47), box(0.07, 0.05, 0.12, 0.82, 0.66, 0.47), beam([0.82, 0.6, -0.3], [0.82, 0.66, -0.42], 0.012), beam([0.82, 0.6, 0.3], [0.82, 0.66, 0.42], 0.012)]);

    // halo
    const pillar = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(0.98, 0.56, 0), new THREE.Vector3(0.86, 0.78, 0), new THREE.Vector3(0.7, 0.89, 0)]), 8, 0.03, 6);
    const hoop = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.08, 0.66, -0.31), new THREE.Vector3(0.18, 0.86, -0.3), new THREE.Vector3(0.52, 0.91, -0.19), new THREE.Vector3(0.7, 0.89, 0),
      new THREE.Vector3(0.52, 0.91, 0.19), new THREE.Vector3(0.18, 0.86, 0.3), new THREE.Vector3(-0.08, 0.66, 0.31)]), 24, 0.032, 6);

    // suspension: upper and lower wishbones plus a push/pull rod per corner
    const sus = [];
    for (const [wx, wz, inner] of [[1.96, 0.8, 0.28], [-1.62, 0.78, 0.3]]) for (const sd of [-1, 1]) {
      sus.push(beam([wx + 0.25, 0.48, inner * sd], [wx, 0.46, (wz - 0.12) * sd], 0.016));
      sus.push(beam([wx - 0.3, 0.46, inner * sd], [wx, 0.46, (wz - 0.12) * sd], 0.016));
      sus.push(beam([wx + 0.25, 0.26, inner * sd], [wx, 0.26, (wz - 0.12) * sd], 0.016));
      sus.push(beam([wx - 0.3, 0.26, inner * sd], [wx, 0.26, (wz - 0.12) * sd], 0.016));
      sus.push(beam([wx - 0.1, 0.5, inner * sd], [wx, 0.28, (wz - 0.14) * sd], 0.014));
    }
    const suspension = merge(sus);
    const helmet = new THREE.SphereGeometry(0.135, 18, 12); helmet.translate(0.27, 0.76, 0);
    const visor = new THREE.SphereGeometry(0.138, 18, 8, -0.9, 1.8, 1.2, 0.45); visor.translate(0.27, 0.76, 0);
    const rainLight = box(0.04, 0.07, 0.11, -2.66, 0.36, 0);

    const parts = {
      paint, accMat, baseMat, helmetMat,
      list: [
        [chassis, paint, true], [pod(1), paint, true], [pod(-1), paint, true], [airbox, paint, true], [intake, M.cockpit, false],
        [floor, M.floor, true], [fw, baseMat, true], [fwEnd, accMat, false], [nosePylon, M.carbon, false],
        [rwEnd, baseMat, true], [rwMain, M.carbonGloss, true], [fin, baseMat, false], [cockpit, M.cockpit, false],
        [mirrors, M.carbonGloss, false], [pillar, M.halo, true], [hoop, M.halo, true], [suspension, M.carbon, false],
        [helmet, helmetMat, false], [visor, M.visor, false],
      ],
      flapGeo, rainLight,
    };
    teamCache.set(team.id, parts);
    return parts;
  }

  // wheel geometry (shared): tyre, rim, compound stripe on the outer sidewall
  const wheelGeo = {};
  function wheelParts(width) {
    if (wheelGeo[width]) return wheelGeo[width];
    const R = 0.36;
    const tyre = new THREE.CylinderGeometry(R, R, width, 30, 1, false); tyre.rotateX(Math.PI / 2);
    // rounded shoulders: torus at each sidewall edge
    const sh1 = new THREE.TorusGeometry(R - 0.035, 0.035, 8, 30); sh1.translate(0, 0, width / 2 - 0.035);
    const sh2 = new THREE.TorusGeometry(R - 0.035, 0.035, 8, 30); sh2.translate(0, 0, -width / 2 + 0.035);
    const rim = new THREE.CylinderGeometry(0.25, 0.25, width + 0.012, 24); rim.rotateX(Math.PI / 2);
    const stripe = new THREE.TorusGeometry(0.29, 0.011, 6, 36); stripe.translate(0, 0, width / 2 + 0.004);
    const stripe2 = new THREE.TorusGeometry(0.29, 0.011, 6, 36); stripe2.translate(0, 0, -width / 2 - 0.004);
    const spokes = merge([0, 1, 2, 3, 4].map(k => box(0.03, 0.4, 0.015, 0, 0, width / 2 + 0.008, 0, 0, k * Math.PI / 5)));
    const sw1 = new THREE.RingGeometry(0.252, 0.358, 48, 1); sw1.translate(0, 0, width / 2 + 0.002);
    const sw2 = new THREE.RingGeometry(0.252, 0.358, 48, 1); sw2.rotateY(Math.PI); sw2.translate(0, 0, -width / 2 - 0.002);
    return (wheelGeo[width] = { tyre: merge([tyre, sh1, sh2]), rim, stripe: merge([stripe, stripe2]), spokes, side: merge([sw1, sw2]) });
  }

  const compoundMats = {};
  function compoundMat(id) {
    const col = { S: 0xff2d2d, M: 0xffd400, H: 0xf2f2f2 }[id] || 0xffd400;
    // the compound band is paint on the rubber: satin, a little dulled by dust, never glowing
    return compoundMats[id] || (compoundMats[id] = new THREE.MeshStandardMaterial({ color: new THREE.Color(col).multiplyScalar(0.82), roughness: 0.68, metalness: 0 }));
  }

  function makeWheel(width, comp) {
    const M = mats(), W = wheelParts(width);
    const g = new THREE.Group();
    const spin = new THREE.Group();
    const tyre = new THREE.Mesh(W.tyre, M.tyre); tyre.castShadow = true;
    const rim = new THREE.Mesh(W.rim, M.rim);
    const spokes = new THREE.Mesh(W.spokes, M.rim);
    const stripe = new THREE.Mesh(W.stripe, compoundMat(comp));
    const side = new THREE.Mesh(W.side, M.sidewall);
    spin.add(tyre, side, rim, spokes, stripe);
    g.add(spin);
    g.userData = { spin, stripe };
    return g;
  }

  // A complete car: body group + four wheels + DRS flap + rain light
  function makeCar(team, num, comp) {
    const P = teamParts(team);
    const root = new THREE.Group();
    for (const [geo, mat, shadow] of P.list) {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = shadow; m.receiveShadow = true;
      root.add(m);
    }
    // number on the fin
    const numTex = F1.R3T.number(num, team.accent === '#121212' ? '#121212' : '#ffffff');
    const numMat = new THREE.MeshStandardMaterial({ map: numTex, transparent: true, depthWrite: false, roughness: 0.4 });
    for (const sd of [-1, 1]) {
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.21), numMat);
      pl.position.set(-1.2, 0.87, 0.012 * sd);
      if (sd < 0) pl.rotation.y = Math.PI;
      root.add(pl);
    }
    const flapPivot = new THREE.Group();
    flapPivot.position.set(-2.32, 0.99, 0);
    const flap = new THREE.Mesh(P.flapGeo, P.baseMat); flap.position.set(-0.1, 0, 0); flap.castShadow = true;
    flapPivot.add(flap);
    root.add(flapPivot);
    const rainMat = new THREE.MeshStandardMaterial({ color: 0x400808, emissive: 0xff2010, emissiveIntensity: 0 });
    const rain = new THREE.Mesh(P.rainLight, rainMat);
    root.add(rain);
    const wheels = [];
    for (const [x, z, w, front] of [[1.96, -0.8, 0.305, 1], [1.96, 0.8, 0.305, 1], [-1.62, -0.78, 0.405, 0], [-1.62, 0.78, 0.405, 0]]) {
      const wh = makeWheel(w, comp);
      wh.position.set(x, 0.36, z);
      wh.userData.front = !!front;
      root.add(wh);
      wheels.push(wh);
    }
    root.userData = { wheels, flapPivot, rainMat, spin: 0, comp };
    return root;
  }

  function setCompound(root, comp) {
    if (root.userData.comp === comp) return;
    root.userData.comp = comp;
    for (const w of root.userData.wheels) for (const s of w.userData.stripes || [w.userData.stripe]) s.material = compoundMat(comp);
  }

  // ---------- scanned-accurate model (tools/car_prep.mjs) ----------
  // A modern ground-effect car from a CC BY 4.0 model (see CREDITS.md), embedded as two
  // levels of detail. Body parts carry a material id; painted parts carry a livery zone per
  // vertex (0 base, 1 accent, 2 bare carbon) so every team is painted from its colours.
  const ID = { paint: 0, carbon: 1, carbonGloss: 2, tyre: 3, rim: 4, halo: 5, helmet: 6, visor: 7, mirror: 8, interior: 9, nut: 10 };
  let MODEL = null;
  function model() {
    if (MODEL !== null) return MODEL;
    const A = F1.Assets && F1.Assets.carModel;
    if (!A) return (MODEL = false);
    const raw = atob(A.bin), bin = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bin[i] = raw.charCodeAt(i);
    const buf = bin.buffer;
    const geo = g => {
      const G = new THREE.BufferGeometry();
      G.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, g.pos[0], g.pos[1]), 3));
      G.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(buf, g.nor[0], g.nor[1]), 3, true));
      G.setIndex(new THREE.BufferAttribute(g.idx[0] === 'u32' ? new Uint32Array(buf, g.idx[1], g.idx[2]) : new Uint16Array(buf, g.idx[1], g.idx[2]), 1));
      if (g.uv) G.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(buf, g.uv[0], g.uv[1]), 2));
      G.computeBoundingSphere();
      return { G, zone: g.zone ? new Uint8Array(buf, g.zone[0], g.zone[1]) : null };
    };
    MODEL = { lods: A.lods.map(L => ({
      body: Object.fromEntries(Object.entries(L.body).map(([k, g]) => [k, geo(g)])),
      wheels: Object.fromEntries(Object.entries(L.wheels).map(([k, w]) => [k, { c: w.c, r: w.r, w: w.w, parts: Object.fromEntries(Object.entries(w.parts).map(([m, g]) => [m, geo(g).G])) }])),
    })) };
    for (const L of MODEL.lods) splitHalo(L.body);
    cutCockpit(MODEL.lods[0].body);
    // carbon and paint parts get box-projected UVs so the weave has somewhere to live
    for (const L of MODEL.lods) for (const id of [ID.carbon, ID.carbonGloss, ID.paint]) if (L.body[id]) boxUV(L.body[id].G, 1);
    return MODEL;
  }
  // The source model files the halo hoop and its front pillar with the painted bodywork, so
  // the livery shader painted them in team colours. They are one separate shell of the paint
  // mesh (above the cockpit rim, x 0.19..1.24, y 0.77..0.99): move that shell to the halo.
  function splitHalo(body) {
    const P = body[ID.paint]; if (!P) return;
    const p = P.G.attributes.position, idx = P.G.index.array, n = p.count;
    const par = new Int32Array(n); for (let i = 0; i < n; i++) par[i] = i;
    const find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    const join = (a, b) => { a = find(a); b = find(b); if (a !== b) par[a] = b; };
    const seen = new Map();
    for (let i = 0; i < n; i++) {
      const k = p.getX(i).toFixed(4) + ',' + p.getY(i).toFixed(4) + ',' + p.getZ(i).toFixed(4);
      if (seen.has(k)) join(i, seen.get(k)); else seen.set(k, i);
    }
    for (let t = 0; t < idx.length; t += 3) { join(idx[t], idx[t + 1]); join(idx[t], idx[t + 2]); }
    const box = new Map();
    for (let i = 0; i < n; i++) {
      const r = find(i); let b = box.get(r);
      if (!b) box.set(r, b = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9]);
      const x = p.getX(i), y = p.getY(i), z = Math.abs(p.getZ(i));
      b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.min(b[2], z);
      b[3] = Math.max(b[3], x); b[4] = Math.max(b[4], y); b[5] = Math.max(b[5], z);
    }
    const halo = new Set();
    for (const [r, b] of box) if (b[0] > 0.1 && b[3] < 1.35 && b[1] > 0.7 && b[4] < 1.03 && b[5] < 0.34 && b[5] > 0.2) halo.add(r);
    if (!halo.size) return;
    const keep = [], move = [];
    for (let t = 0; t < idx.length; t += 3) (halo.has(find(idx[t])) ? move : keep).push(idx[t], idx[t + 1], idx[t + 2]);
    P.G.setIndex(keep);
    // the halo part: its own compact geometry (the existing halo mounts plus the hoop)
    const pos = [], nor = [], ind = [];
    const add = (G, tris) => {
      const a = G.attributes.position, nn = G.attributes.normal, map = new Map();
      for (const v of tris) {
        if (!map.has(v)) { map.set(v, pos.length / 3); pos.push(a.getX(v), a.getY(v), a.getZ(v)); nor.push(nn.getX(v), nn.getY(v), nn.getZ(v)); }
        ind.push(map.get(v));
      }
    };
    if (body[ID.halo]) add(body[ID.halo].G, body[ID.halo].G.index.array);
    add(P.G, move);
    const H = new THREE.BufferGeometry();
    H.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    H.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    H.setIndex(ind); H.computeBoundingSphere();
    body[ID.halo] = { G: H, zone: null };
  }
  function boxUV(G, size) {
    const p = G.attributes.position, n = G.attributes.normal, uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
      const [u, v] = ay >= ax && ay >= az ? [p.getX(i), p.getZ(i)] : ax >= az ? [p.getZ(i), p.getY(i)] : [p.getX(i), p.getY(i)];
      uv[i * 2] = u / size; uv[i * 2 + 1] = v / size;
    }
    G.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }

  // per-team painted body geometry: shares positions, normals and indices, adds colours
  const liveryCache = new Map();
  function liveryGeo(team, lod) {
    const key = team.id + '|' + lod;
    if (liveryCache.has(key)) return liveryCache.get(key);
    const src = model().lods[lod].body[ID.paint];
    const G = new THREE.BufferGeometry();
    for (const a of ['position', 'normal', 'uv']) if (src.G.attributes[a]) G.setAttribute(a, src.G.attributes[a]);
    G.setIndex(src.G.index);
    const cols = [new THREE.Color(team.base), new THREE.Color(team.accent), new THREE.Color(0x111214)];
    const c = new Float32Array(src.zone.length * 3);
    for (let i = 0; i < src.zone.length; i++) { const k = cols[src.zone[i]] || cols[0]; c[i * 3] = k.r; c[i * 3 + 1] = k.g; c[i * 3 + 2] = k.b; }
    G.setAttribute('color', new THREE.BufferAttribute(c, 3));
    G.boundingSphere = src.G.boundingSphere;
    liveryCache.set(key, G);
    return G;
  }

  // painted bodywork: same finish as the team's paint, livery zones drawn in the shader
  const liveryMats = new Map();
  function liveryMat(team) {
    if (liveryMats.has(team.id)) return liveryMats.get(team.id);
    const P = teamParts(team), m = P.baseMat.clone();
    m.color.set(0xffffff);
    m.userData.livery = { uLivBase: { value: new THREE.Color(team.base) }, uLivAccent: { value: new THREE.Color(team.accent) }, uLivCarbon: { value: new THREE.Color(0x0e0f11) } };
    // The inner walls of the cockpit opening are bare matte carbon on a real car, not
    // lacquered paint: seen almost edge-on from the driver's eye a clear coat there mirrors
    // the bright sky as a pale streak down the side of the cockpit. Inboard-facing surfaces
    // inside the opening lose the clear coat and gloss.
    m.userData.patchKey = 'liv_ck';
    m.userData.patchExtra = sh => {
      sh.vertexShader = 'varying vec3 cRP; varying vec3 cRN;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  cRP = position; cRN = normal;');
      sh.fragmentShader = 'varying vec3 cRP; varying vec3 cRN;\n' + sh.fragmentShader
        .replace('#include <roughnessmap_fragment>', [
          '#include <roughnessmap_fragment>',
          '  float cIn = smoothstep(-0.1, -0.02, cRP.x) * (1.0 - smoothstep(1.02, 1.1, cRP.x)) * (1.0 - smoothstep(0.24, 0.28, abs(cRP.z)))',
          '            * smoothstep(0.42, 0.48, cRP.y) * (1.0 - smoothstep(0.84, 0.9, cRP.y));',
          '  float cCk = cIn * smoothstep(0.35, 0.65, dot(normalize(cRN), vec3(0.0, 0.0, -sign(cRP.z))));',
          '  roughnessFactor = mix(roughnessFactor, 0.72, cCk);',
        ].join('\n'))
        .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\n  material.clearcoat *= 1.0 - cCk;\n#endif');
    };
    liveryMats.set(team.id, m);
    return m;
  }
  const modelMats = {};
  // Racing slick rubber as it looks on a car that has run: not black but a deep charcoal (carbon
  // black rubber reflects about 4 to 5 per cent), dead matte. The sidewall is a smooth moulded
  // finish with a faint satin; the tread is scrubbed: rougher and a shade lighter, dusted with
  // a fine grain of torn rubber and darker streaks running round the tyre. Which is which comes
  // from the surface's facing in the wheel's own frame (the axle is z), so no UV layout is needed.
  function tyreMat() {
    const m = new THREE.MeshPhysicalMaterial({ map: F1.R3T.sidewall(), color: 0xffffff, roughness: 0.78, metalness: 0, sheen: 0.35, sheenRoughness: 0.7, sheenColor: new THREE.Color(0x3a3b3f) });
    m.userData.patchKey = 'tyre';
    m.userData.patchExtra = sh => {
      sh.vertexShader = 'varying vec3 tRP; varying vec3 tRN;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  tRP = position; tRN = normal;');
      sh.fragmentShader = [
        'varying vec3 tRP; varying vec3 tRN;',
        'float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
        'float tNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
        '  return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), f.x), mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), f.x), f.y); }',
      ].join('\n') + '\n' + sh.fragmentShader
        .replace('#include <map_fragment>', [
          '#include <map_fragment>',
          '  float tTr = 1.0 - smoothstep(0.35, 0.75, abs(normalize(tRN).z));', // 1 on the tread, 0 on the sidewalls
          '  vec2 tUV = vec2(atan(tRP.y, tRP.x) * length(tRP.xy), tRP.z);', // metres round the tyre, across it
          '  float tG = tNoise(tUV * vec2(260.0, 420.0)) * 0.6 + tNoise(tUV * vec2(90.0, 140.0)) * 0.4;', // fine grain
          '  float tS = tNoise(vec2(tUV.x * 3.0, tUV.y * 60.0));', // streaks running round the tyre
          '  vec3 tSide = vec3(0.034, 0.034, 0.036) * (0.92 + 0.08 * tG);',
          '  vec3 tTread = vec3(0.052, 0.050, 0.049) * (0.8 + 0.35 * tG) * (0.85 + 0.2 * tS);',
          // the sidewall keeps its moulded lettering and rings from the map
          '  diffuseColor.rgb = mix(tSide + max(diffuseColor.rgb - vec3(0.008), 0.0) * 0.9, tTread, tTr);',
        ].join('\n'))
        .replace('#include <roughnessmap_fragment>', [
          '#include <roughnessmap_fragment>',
          '  roughnessFactor = mix(0.72, 0.93 - 0.06 * tG, tTr);',
        ].join('\n'));
    };
    return m;
  }
  function modelMat(id, team) {
    const M = mats(), P = teamParts(team);
    switch (+id) {
      case ID.paint: return P.paint;
      case ID.carbon: return M.carbon;
      case ID.carbonGloss: return M.carbonGloss;
      case ID.halo: return M.halo;
      case ID.helmet: return P.helmetMat;
      case ID.visor: return M.visor;
      case ID.mirror: return M.mirror;
      case ID.interior: return M.cockpit;
      case ID.tyre: return modelMats.tyre || (modelMats.tyre = tyreMat());
      // forged magnesium wheel, satin anthracite
      case ID.rim: return modelMats.rim || (modelMats.rim = new THREE.MeshPhysicalMaterial({ color: 0x202226, roughness: 0.36, metalness: 0.85, clearcoat: 0.3, clearcoatRoughness: 0.3 }));
      // anodised wheel nut
      case ID.nut: return modelMats.nut || (modelMats.nut = new THREE.MeshStandardMaterial({ color: 0xc9a24a, roughness: 0.3, metalness: 1 }));
      default: return M.carbon;
    }
  }

  // Where the tyre meets the road: a dense core over the footprint and a wide soft halo of
  // the tyre's own shade round it, so the car sits on the asphalt under any light.
  // The scanned bodywork is built from open, single-sided shells (engine-cover outlet,
  // crash structure, sidepod inlets). Drawn one-sided, every place you can see the inside
  // of a panel turns into a see-through hole, so all model materials render both sides.
  const twoSided = m => { if (m.side !== THREE.DoubleSide) { m.side = THREE.DoubleSide; m.needsUpdate = true; } return m; };

  // Far detail level: the whole car (the low-detail body with its livery zones as vertex
  // colours, and the four wheels) merged into one mesh under one shared material, so a
  // distant car costs one draw call instead of about twenty-five. The wheels neither turn
  // nor steer at this level; from as far away as it is used, nobody can tell.
  const FAR_COL = { [ID.carbon]: '#1c1d20', [ID.carbonGloss]: '#17181b', [ID.halo]: '#22242a', [ID.mirror]: '#1c1d20', [ID.interior]: '#121315', [ID.tyre]: '#1a1a1b', [ID.rim]: '#2a2c30', [ID.nut]: '#c9a24a' };
  const farCache = new Map();
  let farMatS = null;
  function farMat() {
    return farMatS || (farMatS = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.05, side: THREE.DoubleSide }));
  }
  function farGeo(team) {
    if (farCache.has(team.id)) return farCache.get(team.id);
    const MD = model(), lod = MD.lods.length - 1, L = MD.lods[lod];
    const pos = [], nor = [], col = [], idx = [];
    const add = (G, colorAt, off) => {
      const p = G.attributes.position, n = G.attributes.normal, base = pos.length / 3;
      for (let i = 0; i < p.count; i++) {
        pos.push(p.getX(i) + off[0], p.getY(i) + off[1], p.getZ(i) + off[2]);
        if (n) nor.push(n.getX(i), n.getY(i), n.getZ(i)); else nor.push(0, 1, 0);
        const c = colorAt(i); col.push(c[0], c[1], c[2]);
      }
      if (G.index) for (let i = 0; i < G.index.count; i++) idx.push(base + G.index.getX(i));
      else for (let i = 0; i < p.count; i++) idx.push(base + i);
    };
    const flat = id => { const c = new THREE.Color(FAR_COL[id] || FAR_COL[ID.carbon]); return () => [c.r, c.g, c.b]; };
    for (const [id, part] of Object.entries(L.body)) {
      if (+id === ID.helmet || +id === ID.visor) continue;
      if (+id === ID.paint) { const ca = liveryGeo(team, lod).attributes.color; add(part.G, i => [ca.getX(i), ca.getY(i), ca.getZ(i)], [0, 0, 0]); }
      else add(part.G, flat(id), [0, 0, 0]);
    }
    for (const key of ['FL', 'FR', 'RL', 'RR']) {
      const W = L.wheels[key], c = MD.lods[0].wheels[key].c;
      for (const [id, G] of Object.entries(W.parts)) add(G, flat(id), c);
    }
    const G = new THREE.BufferGeometry();
    G.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    G.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    G.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    G.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    G.computeBoundingSphere();
    farCache.set(team.id, G);
    return G;
  }

  // The low-detail wheels of all four corners merged into one mesh per material (tyre, rim),
  // shared by every car. Used at the low detail level, where a wheel's turn and steer cannot
  // be seen: two draw calls instead of eight.
  let wheelsLow = null;
  function wheelsLowGeo() {
    if (wheelsLow) return wheelsLow;
    const MD = model(), L = MD.lods[MD.lods.length - 1], by = {};
    for (const key of ['FL', 'FR', 'RL', 'RR']) {
      const c = MD.lods[0].wheels[key].c;
      for (const [id, G] of Object.entries(L.wheels[key].parts)) {
        const b = by[id] || (by[id] = { pos: [], nor: [], uv: [], idx: [] }), p = G.attributes.position, n = G.attributes.normal, t = G.attributes.uv, base = b.pos.length / 3;
        // read through the attributes: the model's normals are packed (normalised bytes)
        for (let i = 0; i < p.count; i++) {
          b.pos.push(p.getX(i) + c[0], p.getY(i) + c[1], p.getZ(i) + c[2]);
          if (n) b.nor.push(n.getX(i), n.getY(i), n.getZ(i)); else b.nor.push(0, 1, 0);
          if (t) b.uv.push(t.getX(i), t.getY(i)); else b.uv.push(0, 0);
        }
        if (G.index) for (let i = 0; i < G.index.count; i++) b.idx.push(base + G.index.getX(i)); else for (let i = 0; i < p.count; i++) b.idx.push(base + i);
      }
    }
    wheelsLow = Object.entries(by).map(([id, b]) => {
      const G = new THREE.BufferGeometry();
      G.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      G.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
      G.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      G.setIndex(b.idx); G.computeBoundingSphere();
      return [id, G];
    });
    return wheelsLow;
  }

  function makeModelCar(team, num, comp) {
    const MD = model();
    const root = new THREE.Group();
    const lodGroups = [], wheels = [], helmet = [];
    MD.lods.forEach((L, lod) => {
      const g = new THREE.Group();
      for (const [id, part] of Object.entries(L.body)) {
        const mesh = new THREE.Mesh(part.G, twoSided(+id === ID.paint ? liveryMat(team) : modelMat(id, team)));
        mesh.castShadow = true;
        // the scanned helmet lost its round shell in simplification; the cockpit builds its own
        if (+id === ID.helmet || +id === ID.visor) continue;
        g.add(mesh);
      }
      g.visible = lod === 0;
      root.add(g);
      lodGroups.push(g);
    });
    // wheels: one pivot per corner (steers), spinning group inside, both LODs
    for (const key of ['FL', 'FR', 'RL', 'RR']) {
      const W0 = MD.lods[0].wheels[key];
      const pivot = new THREE.Group();
      pivot.position.set(W0.c[0], W0.c[1], W0.c[2]);
      const spin = new THREE.Group();
      pivot.add(spin);
      const lodMeshes = [];
      MD.lods.forEach((L, lod) => {
        const W = L.wheels[key], grp = new THREE.Group();
        for (const [id, G] of Object.entries(W.parts)) { const m = new THREE.Mesh(G, twoSided(modelMat(id, team))); m.castShadow = true; grp.add(m); }
        grp.visible = lod === 0;
        spin.add(grp); lodMeshes.push(grp);
      });
      // compound marking on both sidewalls
      const stripes = [];
      for (const sd of [-1, 1]) {
        const t = new THREE.Mesh(new THREE.TorusGeometry(W0.r * 0.79, 0.011, 6, 40), compoundMat(comp));
        t.position.z = sd * (W0.w * 0.5 - 0.012);
        spin.add(t); stripes.push(t);
      }
      root.add(pivot);
      pivot.userData = { spin, front: key[0] === 'F', stripes, lods: lodMeshes };
      wheels.push(pivot);
    }
    // fin numbers are replaced by a nose number, visible from the TV angles
    const numMat = new THREE.MeshStandardMaterial({ map: F1.R3T.number(num, team.accent === '#121212' ? '#121212' : '#ffffff'), transparent: true, depthWrite: false, roughness: 0.4 });
    // lying on the nose, reading from the front, following its downward slope
    const ng = new THREE.PlaneGeometry(0.3, 0.15); ng.rotateX(-Math.PI / 2); ng.rotateY(-Math.PI / 2); ng.rotateZ(-0.12);
    const nose = new THREE.Mesh(ng, numMat);
    nose.position.set(1.95, 0.71, 0);
    root.add(nose);
    const wl = new THREE.Group();
    for (const [id, G] of wheelsLowGeo()) { const m = new THREE.Mesh(G, twoSided(modelMat(id, team))); m.castShadow = m.receiveShadow = true; wl.add(m); }
    wl.visible = false;
    const far = new THREE.Mesh(farGeo(team), farMat());
    far.castShadow = true; far.visible = false;
    root.add(far);
    const rainMat = new THREE.MeshStandardMaterial({ color: 0x400808, emissive: 0xff2010, emissiveIntensity: 0 });
    const rain = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.06, 0.1), rainMat);
    rain.position.set(-2.2, 0.47, 0);
    root.add(rain);
    const driverIdx = Math.max(0, team.drivers.findIndex(d => d[3] === num));
    const cockpit = buildCockpit(team, driverIdx);
    root.add(cockpit.group);
    // T-cam mount points: the camera is bolted to the pod, so it moves only with the chassis
    const tcamEye = new THREE.Object3D(), tcamLook = new THREE.Object3D();
    tcamEye.position.set(-0.44, 1.255, 0); tcamLook.position.set(30, -0.6, 0);
    const eyeA = new THREE.Object3D(), lookA = new THREE.Object3D();
    // The onboard eye rides a pivot at the neck that follows the driver's head at a fraction of
    // its turn (eyeP), so the view leans into corners without swinging wildly.
    const eyeP = new THREE.Group(); eyeP.position.copy(cockpit.neck); eyeP.rotation.order = 'YZX'; root.add(eyeP);
    eyeA.position.copy(EYE).sub(cockpit.neck); lookA.position.set(30 - cockpit.neck.x, -2.4 - cockpit.neck.y, 0); // about 6 degrees down: the road, the halo and the wheel share the frame
    eyeP.add(eyeA, lookA);
    // Helmet cam: fixed to the car, above and behind the helmet, looking forward over the visor at the
    // halo, the wheel and the front tyres (centred; the helmet stays in the bottom of the frame)
    const hEye = new THREE.Object3D(), hLook = new THREE.Object3D();
    { const e = G.__helmetEye || [-0.12, 1.46, -6.2]; hEye.position.set(e[0], e[1], 0); hLook.position.set(30, e[2], 0); }
    root.add(hEye, hLook); // bolted to the chassis, not the head
    root.add(tcamEye, tcamLook);
    root.userData = { wheels, wheelsLow: wl, flapPivot: new THREE.Group(), rainMat, spin: 0, comp, lodGroups, far, nose, helmet: cockpit.helmet, model: true, cockpit, tcamEye, tcamLook, eyeA, lookA, eyeP, hEye, hLook };
    updateCockpit(root, 0);
    return root;
  }
  // inner: whether the cockpit interior is drawn at full detail. From outside a car only its
  // helmet shows in the opening, so beyond a few metres the rest of the cockpit (some eighty
  // meshes: the wheel and its buttons, the arms, harness and pads) is taken out, and its
  // animation (updateCockpit) stops with it.
  function setLod(root, lod, inner = true) {
    const u = root.userData;
    if (!u.lodGroups || (u.lod === lod && u.inner === inner)) return;
    u.lod = lod; u.inner = inner;
    // level 2 is the merged far mesh: every separate part is hidden. Hidden groups are also
    // taken out of the scene graph, or three would still update every matrix inside them each
    // frame (the full-detail body, wheels and cockpit of twenty cars is thousands of nodes)
    const far = lod === 2 && !!u.far, L = far ? -1 : Math.min(lod, u.lodGroups.length - 1);
    const put = (g, on, par) => { g.visible = on; if (on && !g.parent) par.add(g); else if (!on && g.parent) g.parent.remove(g); };
    u.lodGroups.forEach((g, k) => put(g, k === L, root));
    // the compound rings on the sidewalls are a centimetre wide: full detail only. At low
    // detail the four wheels are the merged pair of meshes (unless one has come off in a crash)
    const merged = L === 1 && !!u.wheelsLow && u.wheels.every(w => w.userData.lods.length);
    for (const w of u.wheels) { w.userData.lods.forEach((g, k) => put(g, k === L && !merged, w.userData.spin)); w.userData.stripes.forEach(m => { m.visible = lod === 0; }); }
    if (u.wheelsLow) put(u.wheelsLow, merged, root);
    if (u.far) u.far.visible = far;
    if (u.nose) u.nose.visible = !far;
    const ck = u.cockpit;
    if (ck) {
      put(ck.group, lod === 0, root);
      // the cockpit's parts as built, and which of them hold the helmet (kept from outside)
      if (!ck.kids) {
        const hel = new Set(ck.helmet || []);
        ck.kids = ck.group.children.slice().map(ch => { let h = false; ch.traverse(m => { if (hel.has(m)) h = true; }); return { ch, h }; });
      }
      ck.inner = inner;
      for (const { ch, h } of ck.kids) { const on = inner || h; if (on && ch.parent !== ck.group) ck.group.add(ch); else if (!on && ch.parent === ck.group) ck.group.remove(ch); }
    }
  }

  // ---------- cockpit: steering wheel, driver, T-cam pod ----------
  // Positions are in the car frame (metres, +X forward, +Z right) measured against the
  // model: the visor sits at X 0.17-0.21, Y 1.09-1.11, the airbox top at about Y 1.09.
  // The onboard eye sits under the halo's top bar, far enough forward that the bar frames
  // the top of the view and the centre pillar runs down to the nose (as on a real onboard);
  // the wheel is about 40 cm ahead and 15 cm below it, with the hands at quarter to three.
  const EYE = new THREE.Vector3(0.52, 0.81, 0), WHEEL_C = new THREE.Vector3(0.85, 0.68, 0);
  const STEER_RATIO = 4.2; // steering wheel turn per unit of road-wheel angle (about +-100 degrees at full lock)
  const GRIP_X = 0.131; // grip centres from the wheel's centre line (the U grips' outer bars)

  // ---------- the wheel's screen: live data for the car being driven ----------
  // drawn in the reference drawing's pixels (DISP_PX: width, height, left, top), twice over
  const DISP_PX = [605, 420, 715, 85], DISP_K = 2;
  // lamp colours in linear HDR: lit ones go well past 1 so they glow (and bloom) in a dark cockpit
  const LED_ON = [new THREE.Color(1, 0.9, 0).multiplyScalar(5), new THREE.Color(0.1, 1, 0.12).multiplyScalar(5), new THREE.Color(1, 0.06, 0.04).multiplyScalar(5)];
  const LED_OFF = [new THREE.Color(0.1, 0.09, 0), new THREE.Color(0.01, 0.07, 0.015), new THREE.Color(0.1, 0.01, 0.01)];
  function makeDisplay() {
    const c = document.createElement('canvas'); c.width = DISP_PX[0] * DISP_K; c.height = DISP_PX[1] * DISP_K;
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    const d = { c, g: c.getContext('2d'), t, last: 0, key: '' };
    drawDisplay(d, null);
    return d;
  }
  function drawDisplay(d, car) {
    const g = d.g;
    const kmh = car ? Math.round(car.speed * 3.6) : 0, gear = car ? car.gear : 0;
    const rpmF = car && car.spec ? Math.max(0, Math.min(1, (car.rpm - 9000) / (car.spec.rpmLimit - 9000))) : 0;
    const soc = car && car.soc != null ? car.soc : 0.8;
    const T = car ? car.wheels.map(w => Math.round(w.temp)) : [90, 90, 95, 95];
    const Wr = car ? car.wheels.map(w => Math.round((w.wear || 0) * 100)) : [0, 0, 0, 0];
    const mode = car ? (car.overtake ? 'OVERTAKE' : car.aeroX ? 'X-MODE' : car.deploy > 1000 ? 'DEPLOY' : car.harvest > 1000 ? 'HARVEST' : 'MIX 3') : 'MIX 3';
    const comp = car && car.compound ? car.compound.color : '#ffd400';
    const flash = rpmF > 0.985 && Math.floor(performance.now() / 70) % 2;
    const key = [kmh, gear, Math.round(rpmF * 15), flash, Math.round(soc * 100), mode, T.join(','), Wr.join(','), car ? car.lap + '/' + car.pos + (car.rpm | 0) : ''].join('|');
    if (key === d.key) return;
    d.key = key;
    g.setTransform(DISP_K, 0, 0, DISP_K, -DISP_PX[2] * DISP_K, -DISP_PX[3] * DISP_K);
    g.fillStyle = '#040405'; g.fillRect(DISP_PX[2], DISP_PX[3], DISP_PX[0], DISP_PX[1]);
    // shift lights: five yellow, five green, five red; all flash at the limiter
    const lit = Math.round(rpmF * 15);
    // (the shift lights are real emissive lamps on the wheel, set here from the same data)
    if (d.leds) d.leds.forEach((m, k) => { m.color.copy(!flash && k < lit ? LED_ON[k < 5 ? 0 : k < 10 ? 1 : 2] : LED_OFF[k < 5 ? 0 : k < 10 ? 1 : 2]); });
    // the screen and its grid
    const x0 = 735, x1 = 1300, y0 = 170, y1 = 495;
    g.fillStyle = '#000000'; g.fillRect(x0, y0, x1 - x0, y1 - y0);
    const font = (w, s) => `${w} ${s}px Titillium Web, Segoe UI, sans-serif`;
    g.textBaseline = 'middle';
    const txt = (s, x, y, size, col, al = 'center', w = 700) => { g.font = font(w, size); g.fillStyle = col; g.textAlign = al; g.fillText(s, x, y); };
    // row 1: lap, battery, position
    txt('LAP', 785, 193, 28, '#f2f3f5', 'left'); txt(String(car ? Math.max(1, car.lap) : 1), 912, 193, 34, '#f2f3f5', 'right');
    txt('SOC', 962, 193, 20, '#f2f3f5', 'left'); txt(Math.round(soc * 100) + '%', 1075, 193, 22, '#ffd400', 'right');
    txt('POS', 1123, 193, 28, '#f2f3f5', 'left'); txt(String(car ? car.pos : 1), 1262, 193, 34, '#f2f3f5', 'right');
    // gear in the middle column, speed and engine speed on the right, tyre on the left
    const cx0 = 962, cx1 = 1075;
    txt(gear < 0 ? 'R' : gear === 0 ? 'N' : String(gear), (cx0 + cx1) / 2, 290, 150, '#ffffff', 'center', 800);
    txt(String(kmh), 1290, 240, 50, '#ffffff', 'right');
    txt('KPH', 1110, 240, 20, '#9aa6b2', 'left');
    txt(String(car ? Math.round(car.rpm || 0) : 0), 1245, 290, 38, '#3fe04a', 'right');
    txt('RPM', 1110, 290, 18, '#3fe04a', 'left');
    txt(mode === 'MIX 3' ? '' : mode, 1190, 332, 22, '#3fe04a', 'center');
    txt('P' + (car ? car.pos : 1), 845, 238, 44, '#c46cf2', 'center');
    g.strokeStyle = comp; g.lineWidth = 9; g.beginPath(); g.arc(848, 306, 34, 0, 6.283); g.stroke();
    g.strokeStyle = '#9aa0a8'; g.lineWidth = 3; g.beginPath(); g.arc(848, 306, 18, 0, 6.283); g.stroke();
    // headers and the tyre grid: wear (green, then yellow, then red) and temperature per corner
    txt('Wear', 790, 378, 22, '#f2f3f5'); txt('Temp', 900, 378, 22, '#f2f3f5'); txt('Temp', 1132, 378, 22, '#f2f3f5'); txt('Wear', 1245, 378, 22, '#f2f3f5');
    g.fillStyle = '#f0e400'; g.fillRect(cx0 + 2, 360, cx1 - cx0 - 4, 38);
    txt(mode.length > 7 ? mode.slice(0, 7) : mode, (cx0 + cx1) / 2, 380, 26, '#111111', 'center', 800);
    const wcol = w => (w < 40 ? '#18d81f' : w < 70 ? '#f0e400' : '#ff3322');
    const cell = (x, y, w, h, bg, s, col) => { if (bg) { g.fillStyle = bg; g.fillRect(x, y, w, h); } txt(s, x + w / 2, y + h / 2 + 2, 40, col, 'center', 600); };
    cell(737, 402, 108, 44, wcol(Wr[0]), String(Wr[0]), '#062306'); cell(847, 402, 112, 44, null, String(T[0]), '#ffffff');
    cell(737, 448, 108, 44, wcol(Wr[2]), String(Wr[2]), '#062306'); cell(847, 448, 112, 44, null, String(T[2]), '#ffffff');
    cell(1077, 402, 110, 44, null, String(T[1]), '#ffffff'); cell(1189, 402, 109, 44, wcol(Wr[1]), String(Wr[1]), '#062306');
    cell(1077, 448, 110, 44, null, String(T[3]), '#ffffff'); cell(1189, 448, 109, 44, wcol(Wr[3]), String(Wr[3]), '#062306');
    cell(cx0 + 2, 402, cx1 - cx0 - 4, 44, '#18d81f', 'ERS', '#062306');
    txt(String(Math.round(soc * 100)), (cx0 + cx1) / 2, 472, 40, '#ffffff', 'center', 600);
    g.strokeStyle = '#e8e8e8'; g.lineWidth = 2;
    g.beginPath();
    for (const [a, b, c2, e] of [[x0, 215, x1, 215], [x0, 358, x1, 358], [x0, 260, cx0, 260], [cx1, 260, x1, 260], [cx0, 215, cx0, y1], [cx1, 215, cx1, y1], [x0, 400, x1, 400]]) { g.moveTo(a, b); g.lineTo(c2, e); }
    g.stroke();
    d.t.needsUpdate = true;
  }

  let _carbonDark = null;
  let _tubMat = null, _padMat = null, _beltMat = null, _ghostMat = null;
  // draws nothing in the view; the shadow pass still renders the mesh's depth
  function shadowOnly() { return _ghostMat || (_ghostMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false })); }
  function cockpitMats(team, driverIdx) {
    const M = mats();
    // race suit: woven Nomex, matte with a soft sheen at grazing angles
    const suit = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(team.base).multiplyScalar(0.6), roughness: 0.85, metalness: 0, sheen: 1, sheenRoughness: 0.5, sheenColor: new THREE.Color(team.accent).multiplyScalar(0.5) });
    const panel = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(team.accent), roughness: 0.85, metalness: 0, sheen: 1, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xffffff).multiplyScalar(0.4) });
    // gloves: suede palms and knit backs, light grey so they read against the dark tub
    const glove = new THREE.MeshPhysicalMaterial({ color: 0x8f959e, roughness: 0.88, sheen: 0.8, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xc8ccd2), side: THREE.DoubleSide });
    // grips: moulded rubber and alcantara
    const grip = new THREE.MeshPhysicalMaterial({ color: 0x121315, roughness: 0.9, sheen: 0.5, sheenRoughness: 0.7, sheenColor: new THREE.Color(0x3a3d44) });
    // the wheel itself: dark lacquered carbon
    const body = _carbonDark || (_carbonDark = new THREE.MeshPhysicalMaterial({ color: 0x15171a, roughness: 0.42, metalness: 0.1, clearcoat: 0.9, clearcoatRoughness: 0.12 }));
    const trim = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.35, metalness: 0.8 });
    // the T-cam pod colour tells the team's two cars apart: black for the first driver, fluorescent yellow for the second
    const pod = new THREE.MeshPhysicalMaterial({ color: driverIdx === 1 ? 0xd9ef00 : 0x111215, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.05 });
    // the tub: bare satin carbon, dark
    // the inside of the survival cell: bare twill weave under a thin satin resin coat
    if (!_tubMat) {
      const cf = F1.R3T.carbon(), wm = cf.map.clone(), wn = cf.normal.clone();
      wm.repeat.set(9, 9); wn.repeat.set(9, 9); wm.needsUpdate = wn.needsUpdate = true;
      _tubMat = new THREE.MeshPhysicalMaterial({ map: wm, normalMap: wn, normalScale: new THREE.Vector2(0.3, 0.3), color: 0xb4b7bc, roughness: 0.5, metalness: 0, clearcoat: 0.45, clearcoatRoughness: 0.25, envMapIntensity: 3, side: THREE.DoubleSide });
      // energy-absorbing padding covered in black suede (the open cockpit is lit mostly by sky
      // bounce, so these take a little more of the environment than the bodywork)
      _padMat = new THREE.MeshPhysicalMaterial({ color: 0x2b2d31, roughness: 0.9, metalness: 0, sheen: 1, sheenRoughness: 0.5, sheenColor: new THREE.Color(0x7a7e88), envMapIntensity: 3 });
      // harness webbing
      _beltMat = new THREE.MeshPhysicalMaterial({ color: 0x24262b, roughness: 0.8, sheen: 0.6, sheenRoughness: 0.5, sheenColor: new THREE.Color(0x5a5e66), side: THREE.DoubleSide });
    }
    return { M, suit, panel, glove, grip, body, trim, pod, tub: _tubMat, pad: _padMat, belt: _beltMat };
  }

  // ---------- driver's gloves, sleeves and the tub they sit in ----------
  // The right hand's grip frame in the wheel's frame (x right, y up, z toward the driver):
  // origin on the grip's axis, x the palm's normal (see below), y up the
  // forearm toward the wrist (down and back toward the elbow in the tub), z = x * y. The
  // left is the mirror image.
  function handMatrix(sd) {
    // x is the palm's normal: inboard onto the grip, turned a little toward the nose so the
    // back of the glove faces out and back toward the driver
    const X = new THREE.Vector3(...(G.__handX || [-0.9, 0, -0.45])).normalize();
    // y runs back along the hand toward the wrist; the fingers curl about z = x * y, which has
    // to follow the grip's bar (the wheel's y) for the fist to close round it. So the wrist
    // sits behind the grip, toward the driver, dropped about 24 degrees for a forearm that
    // comes up from below.
    const Y = new THREE.Vector3(...(G.__handY || [0, -0.45, 1])); Y.addScaledVector(X, -Y.dot(X)).normalize();
    const Z = new THREE.Vector3().crossVectors(X, Y);
    const M = new THREE.Matrix4().makeTranslation(GRIP_X, -0.019, 0)
      .multiply(new THREE.Matrix4().makeRotationZ(0.06))
      .multiply(new THREE.Matrix4().makeBasis(X, Y, Z));
    return sd > 0 ? M : new THREE.Matrix4().makeScale(-1, 1, 1).multiply(M);
  }
  // The driver's tub: the scanned body only has a shallow cockpit floor (y 0.5); it is cut
  // away (cutCockpit) and this deep carbon well takes its place, wide enough for the elbows.
  function tubGeo() {
    const parts = [];
    const plane = (w, h, x, y, z, rx, ry) => { const g = new THREE.PlaneGeometry(w, h); g.rotateX(rx || 0); g.rotateY(ry || 0); g.translate(x, y, z); parts.push(g); };
    plane(0.9, 0.4, 0.57, 0.24, 0, -Math.PI / 2); // floor
    for (const sd of [-1, 1]) plane(0.9, 0.42, 0.57, 0.45, sd * 0.198, 0, sd > 0 ? Math.PI : 0); // side walls
    plane(0.4, 0.62, 0.1, 0.53, 0, 0, Math.PI / 2); // seat back
    plane(0.4, 0.42, 1.0, 0.45, 0, 0, -Math.PI / 2); // front bulkhead
    return merge(parts);
  }
  // The cockpit as the driver sees it: the painted bodywork of the car itself forms the sides
  // of the opening, the inside of the cell is bare weave, and below the wheel the front
  // bulkhead has the dark mouth of the leg tunnel. From the eye the driver also sees their
  // own chest and the six-point harness under the wheel (povOnly: shown only from inside,
  // where the outside-view torso is hidden).
  const LIP_Y = x => 0.782 - Math.max(0, x - 0.55) * 0.06; // top of the front bulkhead, under the line of sight
  function cockpitInterior(K, mesh) {
    const grp = new THREE.Group(), povOnly = [];
    // front bulkhead with the leg tunnel's dark mouth
    const bs = new THREE.Shape(), bt = LIP_Y(1.02) - 0.015;
    bs.moveTo(-0.16, 0.42); bs.lineTo(0.16, 0.42); bs.lineTo(0.16, bt); bs.lineTo(-0.16, bt); bs.lineTo(-0.16, 0.42);
    const hole = new THREE.Path(); hole.absellipse(0, 0.52, 0.12, 0.075, 0, Math.PI * 2, true); bs.holes.push(hole);
    const bulk = mesh(new THREE.ShapeGeometry(bs, 16), K.tub, false);
    bulk.rotation.y = -Math.PI / 2; bulk.position.x = 1.02; grp.add(bulk);
    const tunnel = mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.5, 20, 1, true), K.M.cockpit, false);
    tunnel.rotation.z = Math.PI / 2; tunnel.scale.z = 0.625; tunnel.position.set(1.27, 0.52, 0); grp.add(tunnel);
    // the driver as seen from their own eyes: chest and stomach lying back under the wheel,
    // thighs running into the tunnel, and the harness over them
    const A = new THREE.Vector3(0.4, 0.575, 0), B = new THREE.Vector3(0.82, 0.465, 0);
    const torso = mesh(new THREE.CapsuleGeometry(0.12, A.distanceTo(B), 6, 16).scale(1, 1, 1.25), K.suit);
    placeBone(torso, A, B, true);
    grp.add(torso); povOnly.push(torso);
    for (const sd of [-1, 1]) {
      const th = mesh(new THREE.CapsuleGeometry(0.068, 0.36, 4, 12), K.suit);
      placeBone(th, new THREE.Vector3(0.84, 0.47, sd * 0.085), new THREE.Vector3(1.18, 0.58, sd * 0.09), true);
      grp.add(th); povOnly.push(th);
    }
    // harness: webbing laid over the chest, shoulder straps and lap straps into a central buckle
    const strap = (a, b, w) => {
      const m = mesh(new THREE.BoxGeometry(w, 1, 0.005), K.belt, false);
      placeBone(m, a, b);
      grp.add(m); povOnly.push(m); return m;
    };
    const buckle = new THREE.Vector3(0.705, 0.598, 0);
    for (const sd of [-1, 1]) {
      strap(new THREE.Vector3(0.43, 0.703, sd * 0.085), buckle.clone().add(new THREE.Vector3(-0.01, 0.002, sd * 0.03)), 0.05);
      strap(new THREE.Vector3(0.79, 0.545, sd * 0.13), buckle.clone().add(new THREE.Vector3(0.015, -0.006, sd * 0.03)), 0.05);
    }
    const disc = mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.012, 20), K.trim, false);
    disc.position.copy(buckle); disc.quaternion.setFromUnitVectors(_up, new THREE.Vector3(0.26, 0.97, 0).normalize()); disc.position.y += 0.006;
    grp.add(disc); povOnly.push(disc);
    povOnly.forEach(m => { m.visible = false; });
    return { grp, povOnly };
  }
  function cutCockpit(body) {
    for (const part of Object.values(body)) {
      const G = part.G, p = G.attributes.position, ix = G.index.array, keep = [];
      for (let t = 0; t < ix.length; t += 3) {
        const a = ix[t], b = ix[t + 1], c = ix[t + 2];
        const cx = (p.getX(a) + p.getX(b) + p.getX(c)) / 3, cy = (p.getY(a) + p.getY(b) + p.getY(c)) / 3, cz = (p.getZ(a) + p.getZ(b) + p.getZ(c)) / 3;
        const ux = p.getX(b) - p.getX(a), uy = p.getY(b) - p.getY(a), uz = p.getZ(b) - p.getZ(a);
        const vx = p.getX(c) - p.getX(a), vy = p.getY(c) - p.getY(a), vz = p.getZ(c) - p.getZ(a);
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const flat = Math.abs(ny) > 0.7 * Math.hypot(nx, ny, nz);
        if (flat && cy < 0.6 && cx > 0.15 && cx < 0.98 && Math.abs(cz) < 0.19) continue;
        keep.push(a, b, c);
      }
      if (keep.length !== ix.length) G.setIndex(keep);
    }
  }

  // ---------- the steering wheel ----------
  // Modelled on a modern F1 wheel: a carbon body 28 cm across with a screen and shift lights
  // on top, two button spines, five rotaries round a colour-coded multi-function dial, four
  // thumbwheels, and big moulded U grips round two finger holes. Laid out in the pixel space
  // of the reference drawing (1720 px across), converted to metres by WS; wheel frame: x right,
  // y up, z toward the driver, face at z = WF.
  const WS = 0.28 / 1720, WF = 0.013;
  const WX = px => (px - 1010) * WS, WY = py => (665 - py) * WS;
  const OUTLINE_R = [[1010, 75], [1200, 78], [1380, 95], [1520, 140], [1650, 190], [1740, 290], [1810, 450], [1858, 650], [1866, 860],
    [1840, 1060], [1780, 1190], [1690, 1240], [1580, 1225], [1500, 1150], [1420, 1090], [1250, 1075]];
  const GRIP_PATH = [[1640, 240], [1735, 330], [1790, 480], [1815, 680], [1815, 880], [1790, 1050], [1730, 1170], [1630, 1205], [1530, 1150]];
  // x, y, radius (px), cap colour, label, ink
  const BUTTONS = [
    [515, 200, 42, '#2fb2e6', 'N', '#ffffff'], [557, 336, 40, '#2a43c8', 'OV', '#ffffff'], [605, 468, 38, '#f5a524', '+10\n-1', '#1a1a1a'],
    [632, 604, 38, '#f2f2f2', 'BB-', '#1a1a1a'], [634, 742, 38, '#f2f2f2', 'A', '#1a1a1a'], [648, 880, 40, '#f07a1a', 'RCH', '#1a1a1a'],
    [1516, 207, 42, '#f0e400', 'PIT', '#1a1a1a'], [1476, 336, 40, '#e0362b', 'R', '#ffffff'], [1428, 468, 38, '#f5a524', '+1', '#1a1a1a'],
    [1406, 604, 38, '#f2f2f2', 'BB\n+', '#1a1a1a'], [1400, 742, 38, '#f2f2f2', 'OK', '#1a1a1a'], [1388, 877, 40, '#f5a524', 'BO', '#1a1a1a'],
  ];
  // rotaries: x, y, knob radius, pointer angle (radians clockwise from up), scale
  const ROTARIES = [
    { x: 790, y: 680, r: 66, a: -1.2, n: [7, 8, 9, 0, 1, 2, null, null, null, 4, 3, null], label: 'SOC', tag: '#101114' },
    { x: 815, y: 905, r: 68, a: 0.35, n: [1, 2, null, 5, 6, 7, 8, 9, 10, 11, 12, null], label: 'SCENARIO', tag: '#b23ac0' },
    { x: 1235, y: 680, r: 66, a: 0.5, n: [1, 2, 3, 4, 5, 6, null, null, null, 12, 13, 14], label: 'PU', tag: '#101114' },
    { x: 1222, y: 905, r: 68, a: -0.25, n: [6, null, null, 9, 10, 11, 12, 13, 14, 1, 2, null], label: 'HS', tag: '#2fa85a' },
  ];
  const MULTI = { x: 1017, y: 770, r: 85, ring: [95, 148], a: 0.45 };
  const MULTI_SEGS = [['TYRE', '#121214', '#fff'], ['FAIL\nB', '#e2272e', '#fff'], ['EXIT', '#2bb34a', '#fff'], ['BBAL', '#ffffff', '#111'], ['DRY', '#f4e300', '#111'],
    ['DISP', '#cfe9ab', '#111'], ['MODE', '#ffffff', '#111'], ['VOL', '#f4e300', '#111'], ['GAIN', '#ffffff', '#111'], ['DAMP', '#ffffff', '#111'],
    ['AERO', '#ffffff', '#111'], ['SLIP', '#1f3fdc', '#fff'], ['SHIFT', '#ffffff', '#111'], ['FAIL\nA', '#f5a623', '#111']];
  // thumbwheels: x, y, axis angle, label
  const DRUMS = [[330, 330, 0.95, 'ENTRY'], [1690, 330, -0.95, 'MID'], [515, 655, Math.PI / 2, 'BSHAPE'], [1505, 655, Math.PI / 2, 'TORQUE']];

  function wheelOutline() {
    const pts = OUTLINE_R.concat([[1010, 1085]], OUTLINE_R.slice(1).reverse().map(([x, y]) => [2020 - x, y]));
    const s = new THREE.Shape();
    s.moveTo(WX(pts[0][0]), WY(pts[0][1]));
    s.splineThru(pts.slice(1).concat([pts[0]]).map(([x, y]) => new THREE.Vector2(WX(x), WY(y))));
    for (const sd of [1, -1]) {
      // finger holes inside the grips: rounded slots
      const x0 = WX(sd > 0 ? 1530 : 2020 - 1650), x1 = WX(sd > 0 ? 1650 : 2020 - 1530), y0 = WY(1060), y1 = WY(392), r = 55 * WS;
      const h = new THREE.Path();
      h.moveTo(x0 + r, y0); h.lineTo(x1 - r, y0); h.quadraticCurveTo(x1, y0, x1, y0 + r); h.lineTo(x1, y1 - r); h.quadraticCurveTo(x1, y1, x1 - r, y1);
      h.lineTo(x0 + r, y1); h.quadraticCurveTo(x0, y1, x0, y1 - r); h.lineTo(x0, y0 + r); h.quadraticCurveTo(x0, y0, x0 + r, y0);
      s.holes.push(h);
    }
    return s;
  }

  // the printed carbon faceplate: weave, button spines, scales, the multi-function ring, labels
  let _face = null;
  const FACE = { x0: 140, y0: 60, w: 1740, h: 1190 };
  function wheelFace() {
    if (_face) return _face;
    const k = 2048 / FACE.w, c = document.createElement('canvas');
    c.width = 2048; c.height = Math.round(FACE.h * k);
    const g = c.getContext('2d');
    g.setTransform(k, 0, 0, k, -FACE.x0 * k, -FACE.y0 * k);
    // twill weave from the shared carbon tile, one tile per 2.5 cm
    const wv = F1.R3T.carbon().map.image, pat = g.createPattern(wv, 'repeat'), sc = 0.025 / WS / wv.width;
    g.save(); g.scale(sc, sc); g.fillStyle = pat; g.fillRect(FACE.x0 / sc, FACE.y0 / sc, FACE.w / sc, FACE.h / sc); g.restore();
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(FACE.x0, FACE.y0, FACE.w, FACE.h);
    // grips' upper housings and the button spines: smooth black mouldings
    const blob = (pts, fill) => {
      g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; g.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2); }
      g.closePath(); g.fillStyle = fill; g.fill();
    };
    for (const m of [1, -1]) {
      const X = x => (m > 0 ? x : 2020 - x);
      blob([[450, 180], [520, 120], [610, 118], [650, 170], [700, 560], [708, 960], [650, 1010], [560, 995], [520, 700], [470, 400]].map(([x, y]) => [X(x), y]), '#0c0d0f');
      blob([[150, 560], [210, 300], [300, 200], [430, 150], [470, 260], [440, 380], [360, 400], [330, 600], [300, 1150], [160, 1000]].map(([x, y]) => [X(x), y]), '#0b0c0e');
      // highlight along the spine's inner edge
      g.strokeStyle = 'rgba(255,255,255,0.06)'; g.lineWidth = 6; g.beginPath(); g.moveTo(X(650), 170); g.quadraticCurveTo(X(700), 560, X(705), 960); g.stroke();
    }
    // screen bezel
    g.fillStyle = '#050506'; g.beginPath(); g.roundRect(712, 82, 612, 426, 26); g.fill();
    // button bezels and the LED dots beside the screen
    for (const [x, y, r] of BUTTONS) { g.fillStyle = '#050506'; g.beginPath(); g.arc(x, y, r + 12, 0, 6.283); g.fill(); }
    for (const x of [668, 1366]) for (const y of [172, 211, 249]) { g.fillStyle = '#f4f6f8'; g.beginPath(); g.arc(x, y, 12, 0, 6.283); g.fill(); }
    // rotary scales and their tags
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const R of ROTARIES) {
      g.fillStyle = '#060607'; g.beginPath(); g.arc(R.x, R.y, R.r + 14, 0, 6.283); g.fill();
      g.font = '700 26px Titillium Web, Segoe UI, sans-serif'; g.fillStyle = '#f2f3f5';
      R.n.forEach((v, i) => { if (v == null) return; const a = (i / R.n.length) * Math.PI * 2 - Math.PI / 2 - 0.5; g.fillText(String(v), R.x + Math.cos(a) * (R.r + 34), R.y + Math.sin(a) * (R.r + 34)); });
      const tx = R.x, ty = R.y - R.r - 78 + (R.label === 'SCENARIO' || R.label === 'HS' ? 0 : 0);
      const ly = R.label === 'SCENARIO' || R.label === 'HS' ? R.y - R.r - 50 : R.y - R.r - 52;
      g.font = '800 26px Titillium Web, Segoe UI, sans-serif';
      const w = g.measureText(R.label).width + 26;
      g.fillStyle = R.tag; g.beginPath(); g.roundRect(tx - w / 2, ly - 18, w, 36, 8); g.fill();
      g.fillStyle = '#ffffff'; g.fillText(R.label, tx, ly + 1);
      void ty;
    }
    // the multi-function ring
    const M = MULTI, n = MULTI_SEGS.length;
    MULTI_SEGS.forEach(([lab, col, ink], i) => {
      const a0 = (i - 0.5) / n * Math.PI * 2 - Math.PI / 2, a1 = (i + 0.5) / n * Math.PI * 2 - Math.PI / 2;
      g.fillStyle = col; g.beginPath(); g.arc(M.x, M.y, M.ring[1], a0, a1); g.arc(M.x, M.y, M.ring[0], a1, a0, true); g.closePath(); g.fill();
      const am = (a0 + a1) / 2, rm = (M.ring[0] + M.ring[1]) / 2;
      g.save(); g.translate(M.x + Math.cos(am) * rm, M.y + Math.sin(am) * rm);
      g.fillStyle = ink; g.font = '800 19px Titillium Web, Segoe UI, sans-serif';
      lab.split('\n').forEach((t, j, all) => g.fillText(t, 0, (j - (all.length - 1) / 2) * 18));
      g.restore();
    });
    g.fillStyle = '#060607'; g.beginPath(); g.arc(M.x, M.y, M.ring[0], 0, 6.283); g.fill();
    // thumbwheel labels
    g.font = '800 30px Titillium Web, Segoe UI, sans-serif'; g.fillStyle = '#f2f3f5';
    for (const [word, x] of [['BSHAPE', 438], ['TORQUE', 1585]]) word.split('').forEach((ch, i) => g.fillText(ch, x, 612 + i * 23));
    for (const [word, x, y, a] of [['ENTRY', 285, 372, 0.62], ['MID', 1740, 372, -0.62]]) {
      g.save(); g.translate(x, y); g.rotate(a);
      g.fillStyle = '#3cc35a'; g.beginPath(); g.roundRect(-55, -15, 110, 30, 6); g.fill();
      g.fillStyle = '#ffffff'; g.font = '800 22px Titillium Web, Segoe UI, sans-serif'; g.fillText(word, 0, 1);
      g.restore();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    // the body's cap UVs are in metres (ExtrudeGeometry): map the drawing's box onto them
    const Wm = FACE.w * WS, Hm = FACE.h * WS;
    t.repeat.set(1 / Wm, 1 / Hm); t.offset.set(-WX(FACE.x0) / Wm, -WY(FACE.y0 + FACE.h) / Hm);
    return (_face = t);
  }
  const _caps = new Map();
  function capTexture(col, label, ink) {
    const key = col + label + ink;
    if (_caps.has(key)) return _caps.get(key);
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(54, 50, 6, 64, 64, 66); grd.addColorStop(0, col); grd.addColorStop(1, col);
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.beginPath(); g.arc(64, 64, 64, 0, 6.283); g.arc(64, 64, 56, 0, 6.283, true); g.fill();
    g.fillStyle = ink; g.textAlign = 'center'; g.textBaseline = 'middle';
    const lines = label.split('\n');
    g.font = `800 ${lines.length > 1 ? 34 : label.length > 2 ? 40 : 52}px Titillium Web, Segoe UI, sans-serif`;
    lines.forEach((t, j) => g.fillText(t, 64, 66 + (j - (lines.length - 1) / 2) * 34));
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    t.center.set(0.5, 0.5); t.rotation = Math.PI / 2; // the cylinder's cap is turned a quarter by rotateX
    _caps.set(key, t);
    return t;
  }
  let _drum = null;
  function drumTexture() {
    if (_drum) return _drum;
    const c = document.createElement('canvas'); c.width = 512; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#0e0f11'; g.fillRect(0, 0, 512, 64);
    for (let i = 0; i < 48; i++) { g.fillStyle = i % 2 ? '#1c1e22' : '#08090a'; g.fillRect(i * 512 / 48, 0, 512 / 96, 64); }
    g.fillStyle = '#f2f3f5'; g.font = '800 30px Titillium Web, Segoe UI, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let i = 0; i < 12; i++) g.fillText(String(i + 1), (i + 0.5) * 512 / 12, 33);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return (_drum = t);
  }

  function buildWheel(spin, K, disp, mesh) {
    // body: carbon, the printed face on the front cap
    const bodyG = new THREE.ExtrudeGeometry(wheelOutline(), { depth: 0.02, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.003, bevelSegments: 3, curveSegments: 12 });
    bodyG.translate(0, 0, -0.01);
    const faceMat = new THREE.MeshPhysicalMaterial({ map: wheelFace(), roughness: 0.38, metalness: 0.05, clearcoat: 0.8, clearcoatRoughness: 0.15 });
    spin.add(mesh(bodyG, [faceMat, K.body]));
    // the moulded rubber grips round the finger holes
    for (const sd of [1, -1]) {
      const pts = GRIP_PATH.map(([x, y]) => new THREE.Vector3(WX(sd > 0 ? x : 2020 - x), WY(y), 0));
      const tg = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'centripetal'), 48, 0.0175, 18, false);
      tg.scale(1, 1, 1.35);
      spin.add(mesh(tg, K.grip));
    }
    // the screen with its shift lights, set into the bezel
    // a lit screen: unlit material, brighter than white so it glows against the dark tub
    const screen = new THREE.MeshBasicMaterial({ map: disp.t, color: new THREE.Color(1.8, 1.8, 1.8), toneMapped: true });
    const scr = mesh(new THREE.PlaneGeometry(DISP_PX[0] * WS, DISP_PX[1] * WS), screen, false);
    scr.position.set(WX(DISP_PX[2] + DISP_PX[0] / 2), WY(DISP_PX[3] + DISP_PX[1] / 2), WF + 0.0006);
    spin.add(scr);
    // shift lights: 15 lamps over the screen (set from the revs), and the six white status lamps
    disp.leds = [];
    const lampG = new THREE.CircleGeometry(13 * WS, 20);
    for (let k = 0; k < 15; k++) {
      const m = new THREE.MeshBasicMaterial({ color: LED_OFF[k < 5 ? 0 : k < 10 ? 1 : 2].clone() });
      const l = new THREE.Mesh(lampG, m); l.position.set(WX(762 + k * 36.6), WY(108), WF + 0.0012); spin.add(l); disp.leds.push(m);
    }
    const white = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 4, 4.2) });
    for (const x of [668, 1366]) for (const y of [172, 211, 249]) { const l = new THREE.Mesh(lampG, white); l.position.set(WX(x), WY(y), WF + 0.0012); spin.add(l); }
    drawDisplay(disp, null);
    // buttons: short caps with their legends
    for (const [x, y, r, col, lab, ink] of BUTTONS) {
      const cg = new THREE.CylinderGeometry(r * WS, r * WS * 1.04, 0.0045, 28); cg.rotateX(Math.PI / 2);
      const top = new THREE.MeshStandardMaterial({ map: capTexture(col, lab, ink), roughness: 0.4 });
      const side = new THREE.MeshStandardMaterial({ color: new THREE.Color(col).multiplyScalar(0.6), roughness: 0.5 });
      const b = mesh(cg, [side, top, side], false);
      b.position.set(WX(x), WY(y), WF + 0.0022);
      spin.add(b);
    }
    // rotaries: knurled knobs with a pointer
    const knobMat = new THREE.MeshPhysicalMaterial({ color: 0x111215, roughness: 0.45, clearcoat: 0.5, clearcoatRoughness: 0.3 });
    const knob = (x, y, r, a, big) => {
      const g = new THREE.Group(); g.position.set(WX(x), WY(y), WF);
      const kg = new THREE.CylinderGeometry(r * WS * 0.8, r * WS, big ? 0.011 : 0.009, 32); kg.rotateX(Math.PI / 2); kg.translate(0, 0, big ? 0.0055 : 0.0045);
      g.add(mesh(kg, knobMat, false));
      const pg = new THREE.BoxGeometry(r * WS * 0.5, r * WS * 1.9, 0.004); pg.translate(0, r * WS * 0.15, big ? 0.012 : 0.0105);
      const p = mesh(pg, knobMat, false); g.add(p);
      g.rotation.z = -a;
      spin.add(g);
    };
    for (const R of ROTARIES) knob(R.x, R.y, R.r, R.a, false);
    knob(MULTI.x, MULTI.y, MULTI.r, MULTI.a, true);
    // thumbwheels
    const drumMat = new THREE.MeshStandardMaterial({ map: drumTexture(), roughness: 0.6 });
    for (const [x, y, ang] of DRUMS) {
      const dg = new THREE.CylinderGeometry(0.0095, 0.0095, 0.02, 28);
      const d = mesh(dg, drumMat, false);
      d.position.set(WX(x), WY(y), WF - 0.002); d.rotation.z = ang;
      spin.add(d);
    }
    // shift paddles and clutch paddles behind the grips (seen through the finger holes)
    for (const sd of [-1, 1]) {
      const pd = mesh(new THREE.BoxGeometry(0.07, 0.11, 0.004), K.M.carbon);
      pd.position.set(sd * 0.095, 0.005, -0.03); pd.rotation.y = sd * 0.12; spin.add(pd);
      const cl = mesh(new THREE.BoxGeometry(0.05, 0.05, 0.004), K.M.carbon);
      cl.position.set(sd * 0.085, -0.07, -0.026); spin.add(cl);
    }
  }

  // ---------- the driver's arms ----------
  // A scanned human arm (MakeHuman, js/assets/arm.js) from the shoulder to the fingertips,
  // fingers posed round a grip and dressed in a suit sleeve and glove, skinned onto five
  // bones: shoulder, upper arm, forearm, forearm twist, hand. Each frame the hand is placed on
  // its grip, the elbow is solved, and every bone gets a rigid transform from the rest arm to
  // the car frame. The left arm is the right one mirrored.
  const ARM_SCALE = 1.12; // the base mesh is a small adult; a driver's reach to the wheel
  let _arm;
  function armData() {
    if (_arm !== undefined) return _arm;
    const A = F1.Assets && F1.Assets.arm;
    if (!A) return (_arm = null);
    const bytes = s => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; };
    // MakeHuman faces +z with y up and the right arm toward -x; the car faces +X with +Z right
    const toCar = (v, out = new THREE.Vector3()) => out.set(v[2] * ARM_SCALE, v[1] * ARM_SCALE, -v[0] * ARM_SCALE);
    const dirCar = v => new THREE.Vector3(v[2], v[1], -v[0]).normalize();
    const pos = new Float32Array(bytes(A.p)), ix = new Uint16Array(bytes(A.ix)), w = new Uint8Array(bytes(A.w)), zone = new Uint8Array(bytes(A.zone));
    const n = pos.length / 3, car = new Float32Array(n * 3), v = new THREE.Vector3();
    for (let i = 0; i < n; i++) { toCar([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], v); car.set([v.x, v.y, v.z], i * 3); }
    const J = A.joints, H = A.hand;
    const X0 = dirCar(H.x), Y0 = dirCar(H.y); Y0.addScaledVector(X0, -Y0.dot(X0)).normalize();
    const Z0 = new THREE.Vector3().crossVectors(X0, Y0);
    const RF0 = new THREE.Matrix4().makeBasis(X0, Y0, Z0).setPosition(toCar(H.c));
    const S0 = toCar(J.shoulder), E0 = toCar(J.elbow), F0 = toCar(J.fore2), W0 = toCar(J.wrist);
    return (_arm = { car, ix, w, zone, n, S0, E0, F0, W0, RF0inv: RF0.clone().invert(), L1: S0.distanceTo(E0), L2: E0.distanceTo(W0),
      h0: new THREE.Vector3().crossVectors(E0.clone().sub(S0), W0.clone().sub(E0)).normalize() });
  }
  // geometry for one side: the left is the right mirrored across the car's centre line
  const _armGeo = {};
  // The posed thumb stands up over the wheel's face; a driver tucks it into the grip's finger
  // hole. Bend it there: points along the thumb (from its root low on the fist to
  // its tip above the fist, in the grip frame: x into the palm, y toward the wrist, z along
  // the bar) turn about an axis through the root, the turn growing from nothing at the root
  // to the full angle past the middle joint, and fading out sideways so the palm stays put.
  // THUMB: [axis x, y, z, angle (radians)]; G.__thumb overrides it (then rebuild the arms).
  const THUMB = [1, 0, 0, 1.0], TH_ROOT = [0.012, 0.008, 0.008], TH_TIP = [0.02, 0, 0.072];
  function thumbBend(p, sd) {
    const A = armData(), T = G.__thumb || THUMB, inv = A.RF0inv, fwd = inv.clone().invert();
    const root = new THREE.Vector3(...TH_ROOT), tip = new THREE.Vector3(...TH_TIP), ax = tip.clone().sub(root), L = ax.length();
    ax.divideScalar(L);
    const q = new THREE.Quaternion(), axis = new THREE.Vector3(T[0], T[1], T[2]).normalize(), v = new THREE.Vector3(), d = new THREE.Vector3();
    for (let i = 0; i < A.n; i++) {
      if (A.w[i * 5 + 4] < 100) continue;
      v.set(A.car[i * 3], A.car[i * 3 + 1], A.car[i * 3 + 2]).applyMatrix4(inv);
      d.subVectors(v, root);
      const t = d.dot(ax) / L, r = d.clone().addScaledVector(ax, -d.dot(ax)).length();
      const k = THREE.MathUtils.smoothstep(t, 0.12, 0.6) * (1 - THREE.MathUtils.smoothstep(r, G.__thR0 || 0.011, G.__thR1 || 0.017));
      if (k <= 0) continue;
      q.setFromAxisAngle(axis, T[3] * k);
      v.sub(root).applyQuaternion(q).add(root).applyMatrix4(fwd);
      p[i * 3] = v.x; p[i * 3 + 1] = v.y; p[i * 3 + 2] = sd < 0 ? -v.z : v.z;
    }
  }
  // debug: rebuild both arms' geometry after changing G.__thumb
  function rebuildArms() {
    for (const k of [1, -1]) {
      const G0 = _armGeo[k]; if (!G0) continue;
      delete _armGeo[k];
      const G1 = armGeo(k);
      G0.attributes.position.array.set(G1.attributes.position.array); G0.attributes.position.needsUpdate = true; G0.computeVertexNormals();
      _armGeo[k] = G0;
    }
  }
  function armGeo(sd) {
    if (_armGeo[sd]) return _armGeo[sd];
    const A = armData(), G = new THREE.BufferGeometry(), n = A.n;
    const p = new Float32Array(A.car);
    if (sd < 0) for (let i = 0; i < n; i++) p[i * 3 + 2] = -p[i * 3 + 2];
    const ix = new Uint16Array(A.ix);
    if (sd < 0) for (let t = 0; t < ix.length; t += 3) { const k = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = k; }
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const ws = [0, 1, 2, 3, 4].map(b => [b, A.w[i * 5 + b] / 255]).sort((a, b) => b[1] - a[1]).slice(0, 4);
      const t = ws.reduce((s, x) => s + x[1], 0) || 1;
      ws.forEach(([b, x], k) => { si[i * 4 + k] = b; sw[i * 4 + k] = x / t; });
      const z = A.zone[i]; // 0 sleeve, 1 glove, 2 gauntlet, 3 knuckle panel
      col.set(z === 0 ? [1, 0, 0] : z === 3 ? [0, 0, 1] : [0, 1, 0], i * 3);
    }
    thumbBend(p, sd);
    G.setAttribute('position', new THREE.BufferAttribute(p, 3));
    G.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    G.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    G.setAttribute('color', new THREE.BufferAttribute(col, 3));
    G.setIndex(new THREE.BufferAttribute(ix, 1));
    G.computeVertexNormals();
    return (_armGeo[sd] = G);
  }
  // Cloth relief, 1024 px for a 5 cm tile (about 50 px per millimetre), as heights:
  // R the suit's Nomex twill, G the glove backs' fine knit, B the palms' suede nap.
  let _fab = null;
  function fabricTexture() {
    if (_fab) return _fab;
    // scanned cloth (js/assets/fabric.js, CC0) when it is there; the drawn relief below otherwise
    if (F1.Assets && F1.Assets.fabric) {
      const img = new Image(), t = new THREE.Texture(img);
      img.onload = () => { t.needsUpdate = true; };
      img.src = F1.Assets.fabric;
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.NoColorSpace; t.anisotropy = 8;
      return (_fab = t);
    }
    const N = 1024, c = document.createElement('canvas'); c.width = c.height = N;
    const g = c.getContext('2d'), img = g.createImageData(N, N), d = img.data;
    const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
    const vnoise = (x, y, p) => { // tileable value noise with period p cells
      const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const h = (a, b) => hash(((a % p) + p) % p, ((b % p) + p) % p);
      return (h(xi, yi) * (1 - sx) + h(xi + 1, yi) * sx) * (1 - sy) + (h(xi, yi + 1) * (1 - sx) + h(xi + 1, yi + 1) * sx) * sy;
    };
    const TW = 32, KC = 16, KR = 22;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      // 2/2 twill: diagonal ribs, threads alternating every half period
      const rib = 0.5 + 0.5 * Math.cos(2 * Math.PI * (x + y) / TW);
      const thr = 0.5 + 0.5 * Math.cos(2 * Math.PI * (((Math.floor((x - y) / (TW / 2)) & 1) ? x : y) / (TW / 4)));
      const tw = 0.62 * rib + 0.28 * thr + 0.1 * vnoise(x / 8, y / 8, N / 8);
      // jersey knit: columns of V-shaped loops
      const u = x / KC, v = y / KR, fu = u - Math.floor(u), fv = v - Math.floor(v);
      const lobe = Math.sin(Math.PI * fu) ** 0.7, vee = 0.5 + 0.5 * Math.cos(2 * Math.PI * (fv + Math.abs(fu - 0.5) * 0.9));
      const kn = 0.55 * lobe * (0.4 + 0.6 * vee) + 0.15 * vnoise(x / 6, y / 6, N / 6);
      // suede: soft multi-octave nap
      const su = 0.5 * vnoise(x / 64, y / 64, N / 64) + 0.3 * vnoise(x / 16, y / 16, N / 16) + 0.2 * vnoise(x / 4, y / 4, N / 4);
      const i = (y * N + x) * 4;
      d[i] = tw * 255; d[i + 1] = Math.min(1, kn + 0.15) * 255; d[i + 2] = su * 255; d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.NoColorSpace; t.anisotropy = 8;
    return (_fab = t);
  }
  // Suit and glove in one material. The vertex colour picks sleeve (r), glove (g) or knuckle
  // panel (b); in the glove, faces turned toward the palm are suede. Cloth relief comes from
  // fabricTexture, projected three ways onto the arm's rest pose (the geometry before
  // skinning), so the weave stays put on the cloth as the arm bends, and is applied as bump
  // relief from its screen-space slope. The gloves are black whatever the team: black knit
  // backs, a slightly deeper black knuckle panel, dark stitching. The sleeve and the band
  // round the gauntlet cuff take the team's colours.
  function armMaterial(team, sd) {
    const A = armData(), m3 = v => (sd < 0 ? new THREE.Vector3(v.x, v.y, -v.z) : v.clone());
    const suit = new THREE.Color(team.base), acc = new THREE.Color(team.accent);
    const glove = new THREE.Color(0x26272b), panel = new THREE.Color(0x1a1b1e);
    const X0 = new THREE.Vector3().setFromMatrixColumn(A.RF0inv.clone().invert(), 0);
    // Cloth sheen is light scattered by the fibres, so it takes the fabric's own colour; an
    // untinted sheen on a dark glove turns every edge pale where the sun grazes it
    const m = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.84, metalness: 0, sheen: 1, sheenRoughness: 0.65, sheenColor: new THREE.Color(0xffffff) });
    const u = {
      uSuit: { value: suit.multiplyScalar(0.8) }, uGlove: { value: glove }, uPanel: { value: panel }, uBand: { value: acc }, uSuede: { value: new THREE.Color(0x2b2c30) },
      uFab: { value: fabricTexture() }, uPalm: { value: m3(X0) }, uWrist: { value: m3(A.W0) }, uUpArm: { value: m3(A.F0.clone().sub(A.W0).normalize()) },
    };
    m.userData.patchKey = 'arm';
    m.userData.patchExtra = sh => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = 'varying vec3 vRP; varying vec3 vRN;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vRP = position; vRN = normal;');
      sh.fragmentShader = [
        'varying vec3 vRP; varying vec3 vRN;',
        'uniform vec3 uSuit; uniform vec3 uGlove; uniform vec3 uPanel; uniform vec3 uBand; uniform vec3 uSuede; uniform sampler2D uFab;',
        'uniform vec3 uPalm; uniform vec3 uWrist; uniform vec3 uUpArm;',
        'vec4 fabTri(vec3 p, vec3 n) { vec3 w = pow(abs(n), vec3(4.0)); w /= w.x + w.y + w.z;',
        '  return texture2D(uFab, p.zy) * w.x + texture2D(uFab, p.xz) * w.y + texture2D(uFab, p.xy) * w.z; }',
      ].join('\n') + '\n' + sh.fragmentShader
        .replace('#include <color_fragment>', [
          '  vec3 aN = normalize(vRN);',
          '  vec4 aF = fabTri(vRP / 0.05, aN);', // 5 cm tile
          '  float aGl = vColor.g + vColor.b, aSu = aGl * smoothstep(0.25, 0.55, dot(aN, uPalm));',
          '  float aAl = dot(vRP - uWrist, uUpArm);', // metres up the forearm from the wrist
          '  vec3 aCol = uSuit * vColor.r + uGlove * vColor.g + uPanel * vColor.b;',
          '  aCol = mix(aCol, uSuede, aSu);',
          // gauntlet: a band in the team's accent colour and a dark stitched edge
          '  float aCuff = vColor.g * step(0.0, aAl);',
          '  aCol = mix(aCol, uBand, aCuff * step(0.045, aAl) * step(aAl, 0.054));',
          '  aCol = mix(aCol, vec3(0.045), aCuff * step(0.064, aAl) * step(aAl, 0.068));',
          '  float aH = mix(aF.r, mix(aF.g, aF.b, aSu), aGl);',
          // the cloth reads at a glance: weave and knit light and dark, as on a real suit
          '  aCol *= mix(0.74, 1.12, aH);',
          // palm grip: a field of small dark silicone dots printed on the suede
          '  vec2 aDp = fract(vec2(vRP.x + vRP.z, vRP.y) * 190.0) - 0.5;',
          '  aCol = mix(aCol, vec3(0.03), aSu * (1.0 - smoothstep(0.17, 0.24, length(aDp))));',
          // gauntlet: a dark hook-and-loop strap round the wrist with a stitched edge
          '  float aStrap = aCuff * smoothstep(0.004, 0.008, aAl) * (1.0 - smoothstep(0.036, 0.04, aAl));',
          '  aCol = mix(aCol, vec3(0.05) * (0.8 + 0.4 * aF.b), aStrap);',
          '  aCol = mix(aCol, vec3(0.045), aCuff * (step(0.008, aAl) * step(aAl, 0.0095) + step(0.0345, aAl) * step(aAl, 0.036)));',
          // suit sleeve: stitched panel seams round the forearm, a darker double line
          '  float aSm = fract(aAl / 0.085);',
          '  aCol *= 1.0 - 0.45 * vColor.r * step(0.07, aAl) * (step(aSm, 0.012) + step(0.03, aSm) * step(aSm, 0.04));',
          '  diffuseColor.rgb = aCol;',
        ].join('\n'))
        .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n  material.sheenColor *= clamp(diffuseColor.rgb * 2.6, 0.0, 1.0);')
        .replace('#include <normal_fragment_maps>', [
          '#include <normal_fragment_maps>',
          // bump relief from the cloth height (Mikkelsen's screen-space method)
          '  {',
          '    float aHs = aH * mix(0.00055, 0.0005, aSu);',
          '    vec3 sX = dFdx(-vViewPosition), sY = dFdy(-vViewPosition);',
          '    float dHx = dFdx(aHs), dHy = dFdy(aHs);',
          '    vec3 R1 = cross(sY, normal), R2 = cross(normal, sX);',
          '    float det = dot(sX, R1) * faceDirection;',
          '    vec3 grad = sign(det) * (dHx * R1 + dHy * R2);',
          '    normal = normalize(abs(det) * normal - grad);',
          '  }',
        ].join('\n'))
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.95, aSu);');
    };
    return m;
  }
  function makeArm(sd, team) {
    if (!armData()) return null;
    const bones = [0, 1, 2, 3, 4].map(() => { const b = new THREE.Bone(); b.matrixAutoUpdate = false; b.matrixWorldAutoUpdate = false; return b; });
    const skel = new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4()));
    const mesh = new THREE.SkinnedMesh(armGeo(sd), armMaterial(team, sd));
    mesh.bindMode = THREE.DetachedBindMode;
    mesh.bind(skel, new THREE.Matrix4());
    mesh.frustumCulled = false; mesh.castShadow = true;
    return { sd, mesh, bones };
  }
  // Solve a right arm: hand frame Hc (hand frame to car frame), shoulder S. Fills out[0..4]
  // with rest-to-car bone transforms.
  const _a = { W: new THREE.Vector3(), E: new THREE.Vector3(), d: new THREE.Vector3(), p: new THREE.Vector3(), u: new THREE.Vector3(), f: new THREE.Vector3(), h: new THREE.Vector3(),
    m1: new THREE.Matrix4(), m2: new THREE.Matrix4(), q: new THREE.Quaternion(), qt: new THREE.Quaternion(), F: new THREE.Vector3(), S: new THREE.Vector3() };
  function frameMap(out, a0, h0, a1, h1, from, to) {
    // rotation taking (a0, h0) to (a1, h1), pivoting point `from` onto `to`
    const b0 = _a.p.crossVectors(a0, h0), M0 = _a.m1.makeBasis(a0, h0, b0);
    const b1 = new THREE.Vector3().crossVectors(a1, h1), M1 = _a.m2.makeBasis(a1, h1, b1);
    out.multiplyMatrices(M1, M0.transpose());
    const t = from.clone().applyMatrix4(out);
    out.setPosition(to.x - t.x, to.y - t.y, to.z - t.z);
    return out;
  }
  function solveArm(Hc, S, out) {
    const A = armData(), a = _a;
    out[4].multiplyMatrices(Hc, A.RF0inv);
    const W = a.W.copy(A.W0).applyMatrix4(out[4]);
    // Reaching for a grip the wheel has turned high, a driver does not straighten the arm and
    // lift the elbow: the shoulder rolls forward toward the wheel and the elbow stays down in
    // the tub, so the forearm still comes up to the grip from below. Shift the shoulder toward
    // the wrist (up to 10 cm) so the arm keeps a bend.
    a.d.subVectors(W, S);
    const reach0 = a.d.length(), bend = 0.78 * (A.L1 + A.L2);
    S = a.S.copy(S);
    if (reach0 > bend) S.addScaledVector(a.d, Math.min(0.1, reach0 - bend) / reach0);
    a.d.subVectors(W, S);
    let d = a.d.length();
    const maxD = A.L1 + A.L2 - 0.002;
    if (d > maxD) { W.copy(S).addScaledVector(a.d, maxD / d); d = maxD; }
    a.d.normalize();
    const along = (A.L1 * A.L1 - A.L2 * A.L2 + d * d) / (2 * d), up = Math.sqrt(Math.max(0, A.L1 * A.L1 - along * along));
    // elbows low and out in the tub; lifting past the rim they may swing out over the side
    a.p.set(-0.2, -1, 0.12); a.p.addScaledVector(a.d, -a.p.dot(a.d)).normalize();
    const E = a.E.copy(S).addScaledVector(a.d, along).addScaledVector(a.p, up);
    E.y = Math.max(0.36, Math.min(0.7, E.y)); // never up near the eyes
    E.z = Math.max(0.07, Math.min(E.z, 0.125 + Math.max(0, E.y - 0.64) * 0.35)); // elbows tucked in, forearms close together
    // As the grip rises toward the top of the wheel, the elbow drops under it, as onboard footage
    // shows at full lock: the forearm comes up from an elbow low by the driver's ribs. The wrist
    // limits how far: the forearm turns from where a straight wrist would put it (fN) toward
    // upright, but by no more than the wrist can bend (55 degrees), so the hand stays in line
    // with the forearm instead of kinking off the cuff. The shoulder follows to keep the upper
    // arm its length.
    const t = THREE.MathUtils.smoothstep(W.y, 0.71, 0.8);
    if (t > 0) {
      const fN = a.F.copy(A.W0).sub(A.E0).transformDirection(out[4]); // elbow to wrist, wrist straight
      // elbow to wrist at full lock: up from below and behind, leaning in from the elbow's own side
      // (about 25 degrees off upright), as onboard footage shows
      const fT = a.p.set(0.3, 1, G.__ftZ != null ? G.__ftZ : -0.5).normalize();
      const ang = fN.angleTo(fT);
      if (ang > 1e-4) {
        a.q.setFromUnitVectors(fN, fT);
        a.qt.identity().slerp(a.q, Math.min(1, 0.96 / ang));
        fN.applyQuaternion(a.qt);
      }
      E.lerp(a.p.copy(W).addScaledVector(fN, -A.L2), t);
      S.sub(E).setLength(A.L1).add(E);
    }
    // upper arm and forearm share the elbow's hinge axis
    a.u.subVectors(E, S).normalize(); a.f.subVectors(W, E).normalize();
    a.h.crossVectors(a.u, a.f);
    if (a.h.lengthSq() < 1e-6) a.h.set(0, 0, 1).cross(a.u);
    a.h.normalize();
    const u0 = A.E0.clone().sub(A.S0).normalize(), f0 = A.W0.clone().sub(A.E0).normalize();
    frameMap(out[1], u0, A.h0, a.u, a.h, A.S0, S);
    frameMap(out[2], f0, A.h0, a.f, a.h, A.E0, E);
    out[0].copy(out[1]);
    // the forearm's twist bone takes half the hand's roll about the forearm
    const r2 = a.q.setFromRotationMatrix(out[2]), rh = a.qt.setFromRotationMatrix(out[4]);
    const rel = r2.clone().invert().multiply(rh); // in the rest frame
    const proj = f0.dot(new THREE.Vector3(rel.x, rel.y, rel.z));
    const tw = new THREE.Quaternion(f0.x * proj, f0.y * proj, f0.z * proj, rel.w).normalize();
    const half = new THREE.Quaternion().slerp(tw, 0.5);
    const q3 = r2.clone().multiply(half);
    const Fp = a.F.copy(A.F0).applyMatrix4(out[2]);
    out[3].makeRotationFromQuaternion(q3);
    const t3 = A.F0.clone().applyMatrix4(out[3]);
    out[3].setPosition(Fp.x - t3.x, Fp.y - t3.y, Fp.z - t3.z);
  }
  const _mirZ = new THREE.Matrix4().makeScale(1, 1, -1);
  const _roll = new THREE.Matrix4(), _gp = new THREE.Vector3();
  const _sol = [0, 1, 2, 3, 4].map(() => new THREE.Matrix4()), _Hc = new THREE.Matrix4(), _spinR = new THREE.Matrix4();
  // place one arm for the wheel's current turn
  function poseArm(arm, ck) {
    // the right arm's case: for the left, mirror the wheel's turn and the result
    const sp = arm.sd > 0 ? ck.spin.rotation.z : -ck.spin.rotation.z;
    _spinR.makeRotationZ(sp);
    // Past about 30 degrees of lock the hand turns round the grip handle itself (the way a
    // hand twists on a throttle), so as the grip is carried toward the top the wrist swings
    // back toward the driver and the forearm can come up from below with the wrist nearly
    // straight, as in onboard footage. Turning about the handle keeps the palm wrapped on it:
    // a roll in the wheel's plane instead swings the heel of the hand into the wheel body.
    // A small part of the turn is still taken up in the wheel's plane.
    const H = handMatrix(1), kn = THREE.MathUtils.smoothstep(Math.abs(sp), 0.5, 1.6);
    if (kn > 0) {
      _gp.setFromMatrixPosition(H);
      const twist = (G.__handTip != null ? G.__handTip : -0.9) * kn * Math.sign(sp), roll = (G.__handRoll != null ? G.__handRoll : 0.2) * kn;
      H.premultiply(_roll.makeTranslation(-_gp.x, -_gp.y, -_gp.z)).premultiply(_roll.makeRotationY(twist))
        .premultiply(_roll.makeRotationZ(-sp * roll))
        // and tips forward, away from the driver (about the wheel's level axis, as seen from the seat),
        // so the palm stands off the rim instead of pressing flat into it
        .premultiply(_roll.makeRotationZ(sp)).premultiply(_roll.makeRotationX((G.__handPitch != null ? G.__handPitch : -0.35) * kn)).premultiply(_roll.makeRotationZ(-sp))
        .premultiply(_roll.makeTranslation(_gp.x, _gp.y, _gp.z));
    }
    _Hc.multiplyMatrices(ck.pivot.matrix, _spinR).multiply(H);
    solveArm(_Hc, arm.shoulder, _sol);
    arm.bones.forEach((b, k) => {
      if (arm.sd > 0) b.matrixWorld.copy(_sol[k]);
      else b.matrixWorld.multiplyMatrices(_mirZ, _sol[k]).multiply(_mirZ);
    });
  }

  function buildCockpit(team, driverIdx) {
    const K = cockpitMats(team, driverIdx);
    const group = new THREE.Group();
    const mesh = (geo, mat, shadow = true) => { const m = new THREE.Mesh(geo, mat); m.castShadow = shadow; return m; };
    // --- steering wheel, facing the driver; spins about its own axis ---
    const pivot = new THREE.Group();
    pivot.position.copy(WHEEL_C);
    // the face stands vertical, square to the car's axis, as an F1 wheel is mounted (no rake back toward the driver)
    const zA = new THREE.Vector3(-1, 0, 0), xA = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), zA).normalize(), yA = new THREE.Vector3().crossVectors(zA, xA);
    pivot.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xA, yA, zA));
    const spin = new THREE.Group();
    pivot.add(spin);
    const disp = makeDisplay();
    buildWheel(spin, K, disp, mesh);
    // quick-release hub and column into the dash
    const hub = mesh(new THREE.CylinderGeometry(0.026, 0.03, 0.04, 16), K.trim); hub.rotation.x = Math.PI / 2; hub.position.z = -0.045; spin.add(hub);
    const col = mesh(new THREE.CylinderGeometry(0.015, 0.019, 0.3, 10), K.M.carbon);
    col.rotation.x = Math.PI / 2; col.position.z = -0.2;
    pivot.add(col);
    group.add(pivot);
    group.add(mesh(tubGeo(), K.tub, false));
    const inner = cockpitInterior(K, mesh);
    group.add(inner.grp);
    // --- driver: reclined torso (outside views only), helmet, arms reaching the grips ---
    const hips = new THREE.Vector3(0.48, 0.52, 0), chest = new THREE.Vector3(0.13, 0.79, 0);
    const torso = mesh(new THREE.CapsuleGeometry(0.15, 0.3, 6, 14), K.suit);
    placeBone(torso, hips, chest, 1); torso.scale.z = 1.25; torso.scale.x = 0.85;
    group.add(torso);
    // helmet: rounded shell in the driver's colour, iridium visor band, rear spoiler
    const P = teamParts(team), helmet = [torso];
    const shell = mesh(new THREE.SphereGeometry(0.13, 32, 24), P.helmetMat);
    shell.scale.set(1.12, 1, 0.95); shell.position.set(0.25, 0.93, 0);
    const visor = mesh(new THREE.SphereGeometry(0.1335, 32, 10, Math.PI - 0.95, 1.9, 1.22, 0.42), K.M.visor, false);
    visor.scale.copy(shell.scale); visor.position.copy(shell.position);
    const spoiler = mesh(new THREE.BoxGeometry(0.03, 0.01, 0.11), P.helmetMat);
    spoiler.position.set(0.12, 1.02, 0); spoiler.rotation.z = 0.35;
    const stripe = mesh(new THREE.SphereGeometry(0.1315, 32, 6, 0, Math.PI * 2, 0.45, 0.12), P.accMat, false);
    stripe.scale.copy(shell.scale); stripe.position.copy(shell.position);
    // the head turns about the base of the neck: helmet parts live in a pivot there
    const NECK = new THREE.Vector3(0.17, 0.84, 0), head = new THREE.Group();
    head.position.copy(NECK); head.rotation.order = 'YZX'; group.add(head);
    for (const m of [shell, visor, spoiler, stripe]) { m.position.sub(NECK); head.add(m); }
    helmet.push(shell, visor, spoiler, stripe);
    const collar = mesh(new THREE.TorusGeometry(0.075, 0.03, 8, 18), K.M.cockpit);
    collar.position.set(0.16, 0.82, 0); collar.rotation.x = Math.PI / 2; collar.rotation.y = -0.35;
    collar.position.sub(NECK); head.add(collar); helmet.push(collar); // hidden with the helmet in the cockpit view
    // In the cockpit view the helmet and the outside-view torso are hidden, but the driver's
    // head and shoulders still shade the wheel, the hands and the lap when the sun is behind.
    // Stand-ins that draw nothing (no colour, no depth) and only cast shadow keep that.
    const ghost = shadowOnly();
    const hs = mesh(new THREE.SphereGeometry(0.13, 16, 12), ghost); hs.scale.copy(shell.scale); hs.position.copy(shell.position); head.add(hs);
    const ts = mesh(torso.geometry, ghost); ts.position.copy(torso.position); ts.quaternion.copy(torso.quaternion); ts.scale.copy(torso.scale); group.add(ts);
    // arms: the scanned, dressed arms (makeArm), shoulders low in the tub
    const arms = [];
    for (const sd of [-1, 1]) {
      const arm = makeArm(sd, team);
      if (!arm) continue;
      arm.shoulder = new THREE.Vector3(0.34, 0.66, 0.115); // the right one; the left is solved mirrored
      group.add(arm.mesh);
      arms.push(arm);
    }
    // --- T-cam pod on a short mast over the roll hoop ---
    // the camera looks out of the pod's front face, so the pod sits just behind and below the lens point
    const mast = mesh(new THREE.BoxGeometry(0.05, 0.08, 0.03), K.M.carbon); mast.position.set(-0.5, 1.13, 0);
    const bar = mesh(new THREE.BoxGeometry(0.075, 0.05, 0.2), K.pod); bar.position.set(-0.5, 1.2, 0);
    const lens = mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.012, 14), K.M.visor, false); lens.rotation.z = Math.PI / 2; lens.position.set(-0.462, 1.205, 0);
    group.add(mast, bar, lens);
    return { group, pivot, spin, arms, steer: null, helmet, povOnly: inner.povOnly, disp, head, neck: NECK, hs: { y: 0, p: 0, r: 0, vy: 0, vp: 0, vr: 0, t: 0, ph: Math.random() * 6.28 } };
  }

  // orient a unit-height mesh (Y axis) from a to b
  const _d = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
  function placeBone(m, a, b, keepScale) {
    _d.subVectors(b, a);
    const len = _d.length();
    m.position.addVectors(a, b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(_up, _d.multiplyScalar(1 / len));
    if (!keepScale) m.scale.set(1, len, 1);
  }

  // Turn the wheel and solve both arms (two-bone IK, elbows out and down) so the
  // gloves stay on the grips. With the car being driven, the wheel's screen shows its data.
  function updateCockpit(root, steer, car) {
    const ck = root.userData.cockpit;
    if (!ck || !ck.group.visible || ck.inner === false) return;
    if (car && ck.disp) {
      const now = performance.now();
      // refresh rate from advanced graphics (each redraw re-uploads the display texture); 0 freezes it
      const hz = F1.R3 && F1.R3.GFX.dispHz != null ? F1.R3.GFX.dispHz : 12;
      if ((hz > 0 && now - ck.disp.last > 1000 / hz) || !ck.disp.drawn) { ck.disp.last = now; ck.disp.drawn = true; drawDisplay(ck.disp, car); }
    }
    let a = Math.max(-1.75, Math.min(1.75, -(steer || 0) * STEER_RATIO));
    // From the driver's seat the wheel never sits dead still: the engine and the road come up
    // the column as a small, quick rotational buzz that grows with speed and turns into
    // sharp kicks over a kerb, and the hands, gripping it, shake with it. About a tenth of a
    // degree at rest to a degree at speed, two over kerbs; frequencies kept well under half the
    // frame rate.
    if (car) {
      const t = performance.now() / 1000, sp = Math.min(1, (car.speed || 0) / 85);
      const rev = car.rpm ? Math.min(1, Math.max(0, (car.rpm - 4000) / 8000)) : 0;
      const kerb = car.onKerb ? Math.min(1, car.onKerb / 2) : 0;
      const amp = 0.0028 + 0.008 * sp + 0.0035 * rev + 0.022 * kerb;
      a += amp * (Math.sin(t * 2 * Math.PI * 13.1) * 0.55 + Math.sin(t * 2 * Math.PI * 21.7 + 1.3) * 0.3 + Math.sin(t * 2 * Math.PI * 7.3 + 0.4) * 0.35);
    } else if (ck.steer !== null && Math.abs(a - ck.steer) < 1e-4) return;
    ck.steer = a;
    ck.spin.rotation.z = a;
    ck.pivot.updateMatrix(); ck.spin.updateMatrix();
    for (const arm of ck.arms) poseArm(arm, ck);
  }

  // The driver's head, as a real driver's moves: it turns into the corner ahead of the car's
  // own turn, tips with lateral g (the neck fights it, so it lags), drops under braking, and
  // buzzes a little with speed. A damped spring per axis gives the lag and the settle.
  function updateHead(root, c, dt) {
    const ck = root.userData.cockpit;
    if (!ck || !ck.head || !ck.group.visible) return;
    const h = ck.hs, ay = c.ay || 0, ax = c.ax || 0, sp = c.speed || 0, R = Math.random, D = Math.PI / 180;
    h.t += dt;
    // Gaze shifts, after the eye-head literature (Glasauer; Saeb et al.; Peters and Qureshi;
    // Badler's idle-gaze models): the head does not drift, it holds still through a fixation
    // (a second or two, never the same) and then moves in a quick discrete shift whose speed
    // follows a bell-shaped minimum-jerk profile. Duration grows with amplitude, about 0.25 s
    // plus 9 ms per degree. Large shifts are made in two steps (a primary movement a little
    // short of the target, then a small corrective one). Most targets are near straight ahead;
    // now and then there is a glance to a mirror or the pit wall, and the head comes back.
    const g = h.g || (h.g = { y0: 0, p0: 0, r0: 0, y1: 0, p1: 0, r1: 0, t0: 0, dur: 0.01, next: 1 + R() * 2, away: false, fix: null });
    const mj = u => { u = Math.max(0, Math.min(1, u)); return u * u * u * (10 - 15 * u + 6 * u * u); };
    const gy = g.y0 + (g.y1 - g.y0) * mj((h.t - g.t0) / g.dur), gp = g.p0 + (g.p1 - g.p0) * mj((h.t - g.t0) / g.dur), gr = g.r0 + (g.r1 - g.r0) * mj((h.t - g.t0) / g.dur);
    if (h.t >= g.t0 + g.dur) {
      g.y0 = g.y1; g.p0 = g.p1; g.r0 = g.r1;
      if (g.fix) { // the corrective half of a big shift
        g.y1 = g.fix[0]; g.p1 = g.fix[1]; g.r1 = g.fix[2]; g.fix = null; g.t0 = h.t + 0.08; g.dur = 0.14;
      } else if (h.t >= g.next) {
        let ty, tp;
        if (!g.away && R() < 0.22) { ty = (R() < 0.5 ? -1 : 1) * (16 + R() * 14) * D; tp = (R() * 8 - 6) * D; g.away = true; g.next = h.t + 0.5 + R() * 1.2; }
        else if (g.away) { ty = (R() * 6 - 3) * D; tp = (R() * 3 - 1) * D; g.away = false; g.next = h.t + 0.9 + R() * 2.6; }
        else { ty = (R() * 2 - 1) * 7 * D; tp = (R() * 5 - 3.5) * D; g.next = h.t + 0.7 + Math.pow(R(), 1.5) * 3.5; }
        const tr = -ty * 0.12 + (R() - 0.5) * 2 * D; // a turned head tips a little
        const amp = Math.hypot(ty - g.y0, tp - g.p0) / D;
        g.t0 = h.t; g.dur = 0.25 + 0.009 * amp;
        if (amp > 14) { g.fix = [ty, tp, tr]; const k = 0.88; g.y1 = g.y0 + (ty - g.y0) * k; g.p1 = g.p0 + (tp - g.p0) * k; g.r1 = g.r0 + (tr - g.r0) * k; }
        else { g.y1 = ty; g.p1 = tp; g.r1 = tr; }
      }
    }
    // the neck's response to the car: tips out with lateral g, drops under braking, buzzes
    const buzz = Math.min(1, sp / 80) * 0.004;
    const rT = -Math.max(-0.03, Math.min(0.03, ay * 0.0007)) + Math.sin(h.t * 5.1 + 1) * buzz,
      pT = Math.max(-0.1, Math.min(0.05, ax * 0.0022)) + Math.sin(h.t * 9.1 + 2) * buzz * 0.7,
      yT = Math.sin(h.t * 7.3) * buzz;
    const K = 70, Dm = 13, s = Math.min(dt, 0.033);
    h.vy += ((yT - h.y) * K - h.vy * Dm) * s; h.y += h.vy * s;
    h.vr += ((rT - h.r) * K - h.vr * Dm) * s; h.r += h.vr * s;
    h.vp += ((pT - h.p) * K - h.vp * Dm) * s; h.p += h.vp * s;
    ck.head.rotation.set(h.r + gr, h.y + gy, h.p + gp);
    // The head as a mass on the neck: a spring-damper per axis (about 4 Hz, well damped: a
    // braced neck under a helmet settles in about one swing), pushed by the car's own
    // accelerations. Under braking it lurches forward, in a corner it
    // lags to the outside, over a crest or a jump it floats up as the car drops away, and a
    // landing or a kerb drives it back down into the shoulders and the head bounces on it.
    const zT = (c.zRoad || 0) + (c.zh || 0), P = h.pos || (h.pos = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, zPrev: zT, vzPrev: 0, azF: 0 });
    let az = 0;
    if (dt > 0) {
      const vz = (zT - P.zPrev) / dt; // the car's vertical speed (road height plus heave)
      az = Math.max(-35, Math.min(35, (vz - P.vzPrev) / dt)); // road height differenced twice is spiky: no more than 3.5 g gets through
      P.vzPrev = vz; P.zPrev = zT;
    }
    P.azF += (az - P.azF) * Math.min(1, dt * 14); // about 70 ms of smoothing
    const KN = 650, CN = 31, sdt = Math.min(dt, 0.02); // damping ratio about 0.6
    // the neck stiffens as it reaches its limits, so the head cannot wander off the shoulders
    const lim = (v, m) => (Math.abs(v) > m ? -(Math.abs(v) - m) * 3500 * Math.sign(v) : 0);
    P.vx += (-ax * 0.45 - KN * P.x - CN * P.vx + lim(P.x, 0.03)) * sdt; P.x += P.vx * sdt;
    P.vz += (-ay * 0.12 - KN * P.z - CN * P.vz + lim(P.z, 0.012)) * sdt; P.z += P.vz * sdt;
    P.vy += (-P.azF * 0.35 - KN * P.y - CN * P.vy + lim(P.y, 0.02)) * sdt; P.y += P.vy * sdt; // the spine and seat soak up most of it
    for (const k of ['x', 'y', 'z']) if (!isFinite(P[k])) { P[k] = 0; P['v' + k] = 0; }
    ck.head.position.set(ck.neck.x + P.x, ck.neck.y + P.y, ck.neck.z + P.z);
    // (the onboard cameras stay locked to the chassis; only the visible helmet moves)
  }

  const makeCodeCar = makeCar;
  // One merged, low-detail shell of the whole car (LOD1 body plus a cylinder per wheel), for
  // the motion blur's velocity pass: one draw per car instead of every part.
  let HULL = null;
  function velHull() {
    if (HULL) return HULL;
    const MD = model(), pos = [], idx = [];
    const add = (G, mtx) => {
      const p = G.attributes.position, base = pos.length / 3, v = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); if (mtx) v.applyMatrix4(mtx); pos.push(v.x, v.y, v.z); }
      const ix = G.index ? G.index.array : null;
      if (ix) for (let i = 0; i < ix.length; i++) idx.push(base + ix[i]); else for (let i = 0; i < p.count; i++) idx.push(base + i);
    };
    if (MD) {
      const L = MD.lods[MD.lods.length - 1];
      for (const part of Object.values(L.body)) add(part.G, null);
      for (const W of Object.values(MD.lods[0].wheels)) {
        const c = new THREE.CylinderGeometry(W.r, W.r, W.w, 12); c.rotateX(Math.PI / 2);
        add(c, new THREE.Matrix4().makeTranslation(W.c[0], W.c[1], W.c[2]));
      }
    } else add(new THREE.BoxGeometry(5.4, 0.9, 1.9), new THREE.Matrix4().makeTranslation(0, 0.45, 0));
    HULL = new THREE.BufferGeometry();
    HULL.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    HULL.setIndex(idx); HULL.computeBoundingSphere();
    return HULL;
  }

  function makeAnyCar(team, num, comp) { return model() ? makeModelCar(team, num, comp) : makeCodeCar(team, num, comp); }

  // debug: re-place every live cockpit's gloves after changing G.__handX / G.__handY
  function debugHands(scene) {
    scene.traverse(o => { const ck = o.userData && o.userData.cockpit; if (ck && ck.arms) { ck.steer = null; updateCockpit(o, 0); } });
  }

  F1.R3Car = { armData: () => armData(), rebuildArms, updateHead, debugHands, makeCar: makeAnyCar, setCompound, setLod, updateCockpit, velHull, hasModel: () => !!model(), loft, box, beam, merge };
})(typeof window !== 'undefined' ? window : globalThis);
