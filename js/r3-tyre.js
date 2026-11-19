// The 2026 slick, built here rather than taken from the car models (whose tyres are the old, wider
// size and carry the old markings). Sizes from the 2026 rules: front 280 mm wide and 705 mm across,
// rear 375 mm wide and 710 mm across, on the same 18 inch rim.
//
// The shape is a lathe: the cross-section turned about the axle. The section's outer half is a
// superellipse, so the tread is flat across its middle and rolls over a big round shoulder into the
// sidewall, which bulges a little past the rim and curls in to the bead behind the rim's flange.
// Normals come from the section's own tangent, so the tyre shades as one smooth surface at every
// detail level. Three levels: 64, 28 and 20 facets round, 2 x 11, 2 x 5 and 2 x 4 bands across
// (about 2800, 560 and 320 triangles: the full level as many as the model's own tyre had, in one
// draw instead of two).
//
// The sidewall's markings are one shared texture used as masks (red: the compound's colour, painted;
// green: the white barcode label; blue: moulded lettering and the shoulder's ticks, lighter rubber),
// so a compound change only changes a colour. The texture is laid flat over the side of the wheel,
// read from the wheel's own coordinates (u turned over on the inner side, so the lettering reads
// the right way round from either side). Layout after the 2026 tyre: a thin line hugging the rim, a
// thick arc down the leading side, the brand across the top and the tyre's name across the bottom,
// letter tops outward, a barcode label and the forest mark low on the leading side.
// Dimensions in metres; the wheel spins about its z axis.
(function (G) {
  'use strict';
  const F1 = G.F1, THREE = G.THREE, TAU = Math.PI * 2;
  const SIZE = { F: { R: 0.3525, hw: 0.14 }, R: { R: 0.355, hw: 0.1875 } };
  const ART_R = 0.36, TYK = 1 / (2 * ART_R); // the texture spans the wheel out to ART_R
  const LEVEL = [{ n: 64, up: 8, lo: 3 }, { n: 28, up: 4, lo: 1 }, { n: 20, up: 3, lo: 1 }];
  const SE = 3.4; // the shoulder's squareness (2 an ellipse, higher squarer)

  // the half section from the middle of the tread out to the bead: [rho, z, nRho, nZ]
  function section(R, hw, rb, zr, up, lo) {
    const rm = (R + rb) / 2, A = R - rm, e = 2 / SE;
    // the upper part, densely, then picked out evenly by length plus turning (the shoulder gets most)
    const D = 240, pts = [];
    for (let i = 0; i <= D; i++) {
      const t = (i / D) * Math.PI / 2, c = Math.cos(t), s = Math.sin(t);
      pts.push([rm + A * Math.pow(c, e), hw * Math.pow(s, e)]);
    }
    const w = [0];
    for (let i = 1; i <= D; i++) {
      const ds = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      const a0 = i > 1 ? Math.atan2(pts[i - 1][1] - pts[i - 2][1], pts[i - 1][0] - pts[i - 2][0]) : Math.PI / 2;
      const a1 = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
      let da = Math.abs(a1 - a0); if (da > Math.PI) da = TAU - da;
      w.push(w[i - 1] + ds + 0.05 * da);
    }
    const out = [];
    for (let k = 0, i = 0; k <= up; k++) {
      const goal = (k / up) * w[D];
      while (i < D && w[i + 1] < goal) i++;
      const f = i < D ? (goal - w[i]) / Math.max(1e-9, w[i + 1] - w[i]) : 0, j = Math.min(D, i + 1);
      out.push([pts[i][0] + (pts[j][0] - pts[i][0]) * f, pts[i][1] + (pts[j][1] - pts[i][1]) * f]);
    }
    out[0] = [R, 0]; out[up] = [rm, hw];
    // the lower sidewall: down to the bead, curling in behind the rim flange at the end
    for (let k = 1; k <= lo; k++) {
      const t = k / lo;
      out.push([rm - (rm - rb) * t, zr + (hw - zr) * (1 - Math.pow(t, 4))]);
    }
    // normals from the tangent (central differences), pointing out of the tyre
    return out.map((p, i) => {
      const a = out[Math.max(0, i - 1)], b = out[Math.min(out.length - 1, i + 1)];
      let tr = b[0] - a[0], tz = b[1] - a[1];
      if (i === 0) { tr = 0; tz = 1; }
      const l = Math.hypot(tr, tz) || 1;
      return [p[0], p[1], tz / l, -tr / l];
    });
  }

  const geoCache = new Map();
  // one tyre: outer radius R, half width hw, bead radius rb, bead half width zr; level 0..2
  function geometry(R, hw, rb, zr, level) {
    const key = [R, hw, rb, zr, level].map(x => x.toFixed(4)).join();
    if (geoCache.has(key)) return geoCache.get(key);
    const L = LEVEL[level], sec = section(R, hw, rb, zr, L.up, L.lo), rows = sec.length, n = L.n;
    const nv = 2 * rows * n, pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = [];
    let v = 0;
    for (const s of [1, -1]) {
      const base = v;
      for (let r = 0; r < rows; r++) {
        const [rho, z, nr, nz] = sec[r];
        for (let j = 0; j < n; j++, v++) {
          const a = (j / n) * TAU, c = Math.cos(a), sn = Math.sin(a), x = rho * c, y = rho * sn;
          pos.set([x, y, s * z], v * 3);
          nor.set([nr * c, nr * sn, s * nz], v * 3);
          uv.set([0.5 + s * x * TYK, 0.5 + y * TYK], v * 2);
        }
      }
      for (let r = 0; r < rows - 1; r++) for (let j = 0; j < n; j++) {
        const a = base + r * n + j, b = base + r * n + (j + 1) % n, c = a + n, d = b + n;
        // (front faces outward on both halves: three turns a double-sided material's normals round
        // on back faces, so a mesh wound inside out is lit and self-shadowed from the inside)
        if (s > 0) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    geoCache.set(key, g);
    return g;
  }

  // ---- the sidewall markings ----
  let art = null;
  function texture() {
    if (art) return art;
    const N = 1024, S = N / (2 * ART_R), cv = document.createElement('canvas');
    cv.width = cv.height = N;
    const x = cv.getContext('2d'), C = N / 2;
    x.fillStyle = '#000'; x.fillRect(0, 0, N, N);
    const P = (r, a) => [C + r * Math.cos(a) * S, C - r * Math.sin(a) * S];
    const deg = d => (d * Math.PI) / 180;
    const RED = 'rgb(255,0,0)', BLUE = 'rgb(0,0,255)';
    x.globalCompositeOperation = 'lighter';
    // a ring segment from angle a0 to a1 (degrees, counter-clockwise, 0 to the right)
    const band = (r0, r1, a0, a1, col) => {
      x.fillStyle = col; x.beginPath();
      x.arc(C, C, r1 * S, -deg(a0), -deg(a1), true);
      x.arc(C, C, r0 * S, -deg(a1), -deg(a0), false);
      x.closePath(); x.fill();
    };
    // text along the circle, letter tops outward, reading clockwise, centred on angle ac (degrees)
    const arcText = (str, r, cap, ac, col, font, track = 0) => {
      const px = cap * S / 0.72;
      x.font = font.replace('#', px.toFixed(1) + 'px'); x.fillStyle = col; x.textAlign = 'left'; x.textBaseline = 'alphabetic';
      const ws = [...str].map(ch => x.measureText(ch).width + track * px), total = ws.reduce((s, w) => s + w, 0);
      let a = deg(ac) + total / 2 / (r * S);
      [...str].forEach((ch, i) => {
        const am = a - ws[i] / 2 / (r * S), [px0, py0] = P(r, am);
        x.save(); x.translate(px0, py0); x.rotate(Math.PI / 2 - am);
        x.fillText(ch, -x.measureText(ch).width / 2, 0);
        x.restore();
        a -= ws[i] / (r * S);
      });
    };
    const BOLD = 'italic 900 # "Arial Black", "Arial", sans-serif', PLAIN = '700 # "Arial", sans-serif';
    // the thin line round the rim, all the way
    band(0.2508, 0.2568, 0, 359.99, RED);
    // the thick arc down the leading side
    band(0.2705, 0.2855, 118, 212, RED);
    // brand across the top, the tyre's name across the bottom (letter tops outward)
    arcText('PIRELLI', 0.2665, 0.03, 72, RED, BOLD, 0.02);
    arcText('P ZERO', 0.2625, 0.038, 292, RED, BOLD, 0.08);
    arcText('TM', 0.2945, 0.006, 254, RED, PLAIN);
    // the forest mark: a small tree and its letters
    { const [tx, ty] = P(0.2835, deg(226)); x.fillStyle = RED; x.beginPath(); x.arc(tx, ty, 0.005 * S, 0, TAU); x.fill(); }
    arcText('FSC', 0.2715, 0.005, 226, RED, PLAIN);
    // moulded lettering, small, in rubber
    arcText('MADE IN ITALY   280/705 R18   TUBELESS', 0.2625, 0.0042, 160, BLUE, PLAIN, 0.05);
    arcText('PIRELLI  F1  2026   DOT 2026', 0.2885, 0.0048, 345, BLUE, PLAIN, 0.08);
    arcText('P ZERO   SLICK', 0.2625, 0.0042, 20, BLUE, PLAIN, 0.06);
    // the shoulder: a fine mould line and short ticks all round
    x.strokeStyle = BLUE; x.lineWidth = 0.0014 * S;
    x.beginPath(); x.arc(C, C, 0.2985 * S, 0, TAU); x.stroke();
    x.lineWidth = 0.0018 * S;
    for (let k = 0; k < 120; k++) {
      const a = (k / 120) * TAU, [x0, y0] = P(0.3015, a), [x1, y1] = P(0.313, a);
      x.beginPath(); x.moveTo(x0, y0); x.lineTo(x1, y1); x.stroke();
    }
    // the barcode label: white paper, black bars (drawn over the masks)
    x.globalCompositeOperation = 'source-over';
    {
      const a = deg(238), [lx, ly] = P(0.2735, a);
      x.save(); x.translate(lx, ly); x.rotate(Math.PI / 2 - a);
      const w = 0.012 * S, h = 0.03 * S;
      x.fillStyle = 'rgb(0,255,0)'; x.fillRect(-w / 2, -h / 2, w, h);
      x.fillStyle = '#000';
      let yy = -h / 2 + 0.0015 * S;
      for (let k = 0; yy < h / 2 - 0.0015 * S; k++) { const t = (0.0003 + ((k * 7919) % 5) * 0.00022) * S; x.fillRect(-w / 2 + 0.0012 * S, yy, w - 0.0024 * S, t); yy += t + 0.00045 * S; }
      x.restore();
    }
    art = new THREE.CanvasTexture(cv);
    art.colorSpace = THREE.NoColorSpace; // masks, read as numbers
    art.anisotropy = 8;
    art.userData = { tyMask: true };
    return art;
  }

  // ---- the material ----
  // Every number the tyre's shader uses, by group, with its range for the tuning panel (js/r3-tyretune.js,
  // F7 on a local build). Colours are sRGB hex; the shader gets them in linear. A value changes live:
  // each is one shared uniform, so every car's tyres take it at once.
  const lin = (r, g, b) => '#' + new THREE.Color().setRGB(r, g, b).getHexString();
  const SCHEMA = [
    ['Surface', 'rough', 'Roughness, new tread', 0.2, 1, 0.01, 0.48],
    ['Surface', 'roughSide', 'Sidewall: rougher by', -0.2, 0.4, 0.01, 0.1],
    ['Surface', 'roughDust', 'Sidewall dust: rougher by', 0, 0.4, 0.01, 0.1],
    ['Surface', 'spec', 'Specular strength (F0 x)', 0, 2, 0.01, 0.87],
    ['Surface', 'envSpec', 'Sky reflection', 0, 3, 0.01, 0.4],
    ['Surface', 'envDiff', 'Sky light (diffuse)', 0, 3, 0.01, 0.15],
    ['Surface', 'sheen', 'Grazing sheen', 0, 2, 0.01, 0],
    ['Surface', 'sheenPow', 'Grazing sheen tightness', 0.5, 12, 0.1, 0.5],
    // the tyre in shade (under a building, the car's own shadow): its own copies of the car's shade values
    ['Shade', 'ao', 'Ground occlusion on the tyre', 0, 1.5, 0.01, 0.58],
    ['Shade', 'self', 'Tyre self-shade (the car covering its sky)', 0, 1, 0.01, 1],
    ['Shade', 'fill', 'Light floor in shade (added)', 0, 0.3, 0.002, 0.01],
    ['Surface', 'sideLo', 'Tread/sidewall split from', 0, 1, 0.01, 0.5],
    ['Surface', 'sideHi', 'Tread/sidewall split to', 0, 1, 0.01, 0.85],
    ['Rubber colour', 'treadNew', 'Tread, new', 'c', 0, 0, '#0f0f0f'],
    ['Rubber colour', 'treadWorn', 'Tread, worn', 'c', 0, 0, '#121212'],
    ['Rubber colour', 'side', 'Sidewall', 'c', 0, 0, '#3c3c3d'],
    ['Rubber colour', 'dust', 'Sidewall dust (added)', 'c', 0, 0, '#181715'],
    ['Rubber colour', 'dustNew', 'Dust on a new tyre (share)', 0, 1, 0.01, 0.26],
    ['Wear', 'band', 'Scuffed bands', 0, 1.5, 0.01, 0.23],
    ['Wear', 'grain', 'Graining', 0, 1, 0.01, 0.18],
    ['Wear', 'pick', 'Picked-up rubber', 0, 1, 0.01, 1],
    ['Wear', 'pickFrom', 'Picked-up rubber: coverage (lower more)', 0.4, 0.95, 0.01, 0.74],
    ['Wear', 'wRoughOfs', 'Worn tread: roughness offset', -0.4, 0.4, 0.01, 0.09],
    ['Wear', 'wRoughBand', 'Worn tread: roughness by band', 0, 0.6, 0.01, 0.09],
    ['Wear', 'wRoughPick', 'Worn tread: roughness by pick-up', 0, 1, 0.01, 0.6],
    ['Pattern sizes', 'kDust', 'Dust speckle (per turn)', 40, 2000, 1, 383],
    ['Pattern sizes', 'kBand', 'Scuff bands (per turn)', 1, 80, 0.5, 30],
    ['Pattern sizes', 'kGrain', 'Grain lines (per turn)', 200, 4000, 10, 820],
    ['Pattern sizes', 'kPick', 'Pick-up spots (per turn)', 50, 4000, 5, 1500],
    ['Markings', 'paint', 'Compound paint brightness', 0, 1.5, 0.01, 0.78],
    ['Markings', 'paintRough', 'Paint roughness', 0, 1, 0.01, 0.62],
    ['Markings', 'paintDust', 'Paint dulled by wear', 0, 1, 0.01, 0.2],
    ['Markings', 'label', 'Barcode label brightness', 0, 1, 0.01, 0.7],
    ['Markings', 'emboss', 'Moulded lettering: lighter by', 0, 2, 0.01, 0.4],
    ['Markings', 'embossRough', 'Moulded lettering: smoother by', -0.3, 0.3, 0.01, 0.05],
    ['Markings', 'artLo', 'Markings fade on the shoulder: from', 0, 1, 0.01, 0.25],
    ['Markings', 'artHi', 'Markings fade on the shoulder: to', 0, 1, 0.01, 0.6],
    ['Pinholes', 'holeShare', 'Share of cells with a hole', 0, 1, 0.01, 0.3],
    ['Pinholes', 'holeSize', 'Hole radius (m)', 0, 0.004, 0.0001, 0.0015],
    ['Pinholes', 'holeDark', 'Hole darkness', 0, 1, 0.01, 0.55],
  ].map(([group, key, label, a, b, c, def]) => (a === 'c' ? { group, key, label, type: 'c', def } : { group, key, label, type: 'f', min: a, max: b, step: c, def }));
  const DEFAULTS = Object.fromEntries(SCHEMA.map(d => [d.key, d.def]));
  const U = Object.fromEntries(SCHEMA.map(d => ['uT_' + d.key, { value: d.type === 'c' ? new THREE.Color(d.def) : d.def }]));
  const values = Object.assign({}, DEFAULTS);
  // set some or all values (unknown keys ignored); the tyres change at once
  function set(o) {
    for (const d of SCHEMA) {
      if (!o || o[d.key] == null) continue;
      values[d.key] = d.type === 'c' ? String(o[d.key]) : +o[d.key];
      if (d.type === 'c') U['uT_' + d.key].value.set(values[d.key]); else U['uT_' + d.key].value = values[d.key];
    }
  }
  // (the exposure the tunnel adds, undone for the fill: in there the lamps' light is opened up about
  // fourfold past the open air's, and the fill rode up with it; render3d sets it each frame)
  U.uT_fillIris = { value: 1 };
  const DECL = SCHEMA.map(d => `uniform ${d.type === 'c' ? 'vec3' : 'float'} uT_${d.key};`).join(' ') + ' uniform float uT_fillIris;';

  const COMP = { S: 0xff2d2d, M: 0xffd400, H: 0xf2f2f2 };
  const compColor = id => new THREE.Color(COMP[id] || COMP.M);
  const TY_NEW = { value: new THREE.Vector4() }, TY_COMP = { value: compColor('M') };
  // wear: per wheel FL FR RL RR, 0 new to 1 spent (js/render3d.js updateCars); comp: the compound's colour
  function patch(sh, wear, comp) {
    sh.uniforms.uTyWear = wear || TY_NEW;
    sh.uniforms.uTyComp = comp || TY_COMP;
    Object.assign(sh.uniforms, U);
    // (the car's shade values, for this material alone: its shader reads them by these names)
    sh.uniforms.uCarAOK = U.uT_ao; sh.uniforms.uCarSelfK = U.uT_self;
    sh.vertexShader = 'attribute vec3 aWc; attribute float aWi; attribute vec2 aTyS; varying vec3 vTyP; varying vec3 vTyN; varying float vTyWi; varying vec2 vTyS;\n'
      + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vTyP = position - aWc; vTyN = normal; vTyWi = aWi; vTyS = aTyS;');
    sh.fragmentShader = [
      'varying vec3 vTyP; varying vec3 vTyN; varying float vTyWi; varying vec2 vTyS; uniform vec4 uTyWear; uniform vec3 uTyComp;',
      DECL,
      'float tyH(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }',
      'float tyN(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
      '  return mix(mix(mix(tyH(i), tyH(i + vec3(1, 0, 0)), f.x), mix(tyH(i + vec3(0, 1, 0)), tyH(i + vec3(1, 1, 0)), f.x), f.y),',
      '             mix(mix(tyH(i + vec3(0, 0, 1)), tyH(i + vec3(1, 0, 1)), f.x), mix(tyH(i + vec3(0, 1, 1)), tyH(i + vec3(1, 1, 1)), f.x), f.y), f.z); }',
      // noise k times round the tyre (a circle in noise space, so it closes with no seam), w along a third axis
      'float tyC(vec2 cs, float k, float w) { return tyN(vec3(cs * (k * 0.159155), w)); }',
    ].join('\n') + '\n' + sh.fragmentShader
      .replace('#include <map_fragment>', [
        '  float tyRho = length(vTyP.xy); vec3 tyNl = normalize(vTyN);',
        '  float tySide = smoothstep(uT_sideLo, max(uT_sideHi, uT_sideLo + 0.001), abs(tyNl.z)), tyTread = 1.0 - tySide;',
        '  vec2 tyCs = vTyP.xy / max(tyRho, 1e-4); float tyZn = vTyP.z / max(vTyS.y, 0.05);',
        // the markings, laid flat over the side (u turned over on the inner side)
        `  float tySg = vTyP.z < 0.0 ? -1.0 : 1.0; const float TYK = ${TYK.toFixed(5)};`,
        '  vec2 tyUv = vec2(0.5 + tySg * vTyP.x * TYK, 0.5 + vTyP.y * TYK), tyDx = dFdx(vTyP.xy) * TYK, tyDy = dFdy(vTyP.xy) * TYK;',
        '  vec4 tyA = textureGrad(map, tyUv, vec2(tySg * tyDx.x, tyDx.y), vec2(tySg * tyDy.x, tyDy.y)) * smoothstep(uT_artLo, max(uT_artHi, uT_artLo + 0.001), abs(tyNl.z));',
        '  float tyDust = tyC(tyCs, uT_kDust, tyRho * 140.0) * 0.6 + tyC(tyCs, uT_kDust * 3.46, tyRho * 500.0) * 0.4;',
        '  float tyBand = tyC(tyCs, uT_kBand, vTyP.z * 55.0) * 0.6 + tyC(tyCs, uT_kBand * 3.0, vTyP.z * 140.0 + 7.0) * 0.4;',
        '  float tyGrain = tyC(tyCs, uT_kGrain, vTyP.z * 22.0);',
        '  float tyPick = smoothstep(uT_pickFrom, min(uT_pickFrom + 0.18, 1.0), tyC(tyCs, uT_kPick, vTyP.z * 180.0 + 3.0));',
        '  float tyW = clamp(dot(uTyWear, vec4(equal(vec4(floor(vTyWi + 0.5)), vec4(0.0, 1.0, 2.0, 3.0)))), 0.0, 1.0);',
        // the tread's pinholes (vents from the mould): a few in every cell of a grid round the tyre
        '  vec2 tyQ = vec2(atan(vTyP.y, vTyP.x) * 19.0986, tyZn * 5.0), tyI = floor(tyQ), tyF = fract(tyQ) - 0.5;',
        '  vec2 tyO = vec2(tyH(vec3(tyI, 7.7)), tyH(vec3(tyI, 9.3))) - 0.5;',
        '  vec2 tyDd = (tyF - tyO * 0.6) * vec2(6.2831853 * tyRho / 120.0, 0.4 * vTyS.y);',
        '  float tyHole = step(1.0 - uT_holeShare, tyH(vec3(tyI, 3.1))) * (1.0 - smoothstep(uT_holeSize * 0.53, uT_holeSize, length(tyDd))) * tyTread;',
        // the rubber: new, one even charcoal; worn, the scuffed bands, grain and picked-up rubber
        '  vec3 tySw = uT_side + uT_dust * smoothstep(0.55, 0.95, tyDust) * mix(uT_dustNew, 1.0, tyW);',
        '  vec3 tyTr = mix(uT_treadNew, uT_treadWorn * (1.0 - uT_band + 2.0 * uT_band * tyBand) * (1.0 - uT_grain + 2.0 * uT_grain * tyGrain) * (1.0 - uT_pick * tyPick), tyW);',
        '  vec3 tyCol = mix(tySw, tyTr, tyTread) * (1.0 + uT_emboss * tyA.b) * (1.0 - uT_holeDark * tyHole);',
        // the compound's paint (dulled by dust as the tyre wears) and the label
        '  tyCol = mix(tyCol, uTyComp * uT_paint * (1.0 - uT_paintDust * tyW * tyDust), clamp(tyA.r, 0.0, 1.0));',
        '  tyCol = mix(tyCol, vec3(uT_label), clamp(tyA.g, 0.0, 1.0));',
        '  diffuseColor.rgb = tyCol;',
      ].join('\n'))
      .replace('#include <roughnessmap_fragment>', [
        '#include <roughnessmap_fragment>',
        // (a new tread's roughness; the sidewall a little rougher, a worn tread patchy)
        '  roughnessFactor = mix(uT_rough + uT_roughSide + uT_roughDust * tyDust, mix(uT_rough, uT_rough + uT_wRoughOfs + uT_wRoughBand * tyBand + uT_wRoughPick * tyPick, tyW), tyTread);',
        '  roughnessFactor = clamp(mix(roughnessFactor, uT_paintRough, clamp(tyA.r + tyA.g, 0.0, 1.0)) - uT_embossRough * tyA.b, 0.04, 1.0);',
      ].join('\n'))
      // (a floor of light, added last, after the car's shade and occlusion: the rubber is near black,
      // and under a building the wheel went pitch black while the paint round it did not. It is a
      // share of the light the place has (the hemisphere: sky and ground, or a tunnel's lamps), set
      // so that in daylight it is what the slider says; as a fixed amount it glowed white in a
      // tunnel, where the exposure opens about sevenfold)
      .replace('#include <opaque_fragment>', [
        '  { vec3 tyFi = vec3(0.9, 0.93, 1.0);',
        '#if NUM_HEMI_LIGHTS > 0',
        '    tyFi = getHemisphereLightIrradiance(hemisphereLights[0], normalize(normal)) * 3.4;',
        '#endif',
        '    outgoingLight += uT_fill * uT_fillIris * tyFi; }',
        '#include <opaque_fragment>'].join('\n'))
      // (rubber is a plain dielectric: F0 about 0.04, scaled here)
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n  material.specularColor *= uT_spec; material.specularF90 *= uT_spec;')
      .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\n#ifdef RE_IndirectSpecular\n  radiance *= uT_envSpec;\n#endif\n  iblIrradiance *= uT_envDiff;')
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n  reflectedLight.indirectSpecular += uT_sheen * pow(1.0 - saturate(dot(geometryNormal, geometryViewDir)), uT_sheenPow) * iblIrradiance * 0.3;');
  }
  // the material every car model's tyres share (each car takes its own copy, for its wear and compound)
  function material() {
    const m = new THREE.MeshPhysicalMaterial({ map: texture(), roughness: 0.6, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 1, specularIntensity: 1 });
    m.name = 'tyre26';
    // (the shadow map takes the far side of the tyre, so its lit side cannot shade itself in streaks
    // where the sun grazes the shoulder)
    m.shadowSide = THREE.BackSide;
    m.userData.tyMask = true;
    m.userData.patchKey = 'wtyre26';
    m.userData.patchExtra = sh => patch(sh, null, null);
    return m;
  }

  F1.R3Tyre = { SIZE, geometry, texture, material, patch, compColor, SCHEMA, DEFAULTS, values, set, setIris: k => { U.uT_fillIris.value = k; } };
})(window);
