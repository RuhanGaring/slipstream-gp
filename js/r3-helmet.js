// The driver's helmet, built to the shape of a current F1 helmet and finished the way one is finished.
// The shell is lofted from a measured side profile: a dome that runs down the forehead into the raked
// line of the visor, a blunt chin that stands proud under it, a round back that tucks in to a flat
// rim, and a lip across the rear of the crown. On it sit the separate parts of the real thing: the
// visor with its sun strip, the hinge plates and their bolts, the chin grilles, the crown vents, the
// head restraint posts, the rubber trim and the neck pad. The shell is a hand-painted design under a
// thick gloss lacquer, so its material is a clear coat over paint with a little metal flake; the
// visor is a dark mirror with a real thin-film colour shift. Every driver has a design of their own
// in their team's colours. Sponsors are invented.
// Dimensions in metres, x forward, y up, z to the driver's right, the origin at eye level in the middle
// of the head. Surface coordinates: t runs from the crown (0) to the rim (1) by distance along the
// surface, ph round the head from the front (0), positive to the right.
(function (G) {
  'use strict';
  const F1 = G.F1, THREE = G.THREE, TAU = Math.PI * 2;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const mix = (a, b, t) => a + (b - a) * t;

  // height, front and back of the outline, and half width, row by row; the first and last rows are
  // only there to give the curve its tangent at each end
  const TY = [0.1091, 0.111, 0.1091, 0.104, 0.088, 0.06, 0.03, 0, -0.034, -0.055, -0.08, -0.1, -0.113, -0.118];
  const TF = [-0.032, -0.006, 0.02, 0.046, 0.07, 0.093, 0.1135, 0.125, 0.139, 0.1465, 0.15, 0.146, 0.129, 0.1];
  const TR = [0.02, -0.006, -0.032, -0.06, -0.1, -0.128, -0.143, -0.149, -0.15, -0.147, -0.142, -0.133, -0.122, -0.11];
  const TW = [-0.03, 0, 0.028, 0.052, 0.084, 0.107, 0.119, 0.125, 0.124, 0.12, 0.113, 0.105, 0.099, 0.095];
  const cr = (a, s) => { const i = clamp(Math.floor(s), 1, a.length - 3), f = s - i, p0 = a[i - 1], p1 = a[i], p2 = a[i + 1], p3 = a[i + 2]; return 0.5 * (2 * p1 + (p2 - p0) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (3 * p1 - p0 - 3 * p2 + p3) * f * f * f); };
  // the rows again, evenly spaced along the surface, so the paint keeps its proportions
  const M = 600, RY = new Float64Array(M + 1), RF = new Float64Array(M + 1), RR = new Float64Array(M + 1), RW = new Float64Array(M + 1);
  let ARC = 0;
  (function table() {
    const N = 2400, L = new Float64Array(N + 1);
    let py = cr(TY, 1), pf = cr(TF, 1), pr = cr(TR, 1);
    for (let k = 1; k <= N; k++) { const s = 1 + 11 * k / N, y = cr(TY, s), f = cr(TF, s), r = cr(TR, s); L[k] = L[k - 1] + Math.hypot(y - py, (Math.abs(f - pf) + Math.abs(r - pr)) / 2); py = y; pf = f; pr = r; }
    ARC = L[N];
    for (let m = 0, k = 0; m <= M; m++) {
      const want = ARC * m / M; while (k < N - 1 && L[k + 1] < want) k++;
      const s = 1 + 11 * (k + clamp((want - L[k]) / Math.max(1e-9, L[k + 1] - L[k]), 0, 1)) / N;
      RY[m] = cr(TY, s); RF[m] = cr(TF, s); RR[m] = cr(TR, s); RW[m] = Math.max(0, cr(TW, s));
    }
  })();
  const look = (A, t) => { const q = clamp(t, 0, 1) * M, i = Math.min(M - 1, Math.floor(q)); return A[i] + (A[i + 1] - A[i]) * (q - i); };
  const pow2 = (v, p) => Math.sign(v) * Math.pow(Math.abs(v), p);
  function base(t, ph, o) {
    const y0 = look(RY, t), xf = look(RF, t), xr = look(RR, t), w = look(RW, t), xc = (xf + xr) / 2, c = Math.cos(ph), s = Math.sin(ph);
    const e = c > 0 ? 2 + 0.8 * ss(-0.03, -0.075, y0) * (1 - 0.6 * ss(-0.1, -0.113, y0)) : 2.1; // the chin is blunter than the head
    const x = xc + (c > 0 ? xf - xc : xc - xr) * pow2(c, 2 / e);
    let z = w * pow2(s, 2 / e);
    const rec = Math.exp(-(((x - 0.012) / 0.05) ** 2) - (((y0 - 0.01) / 0.032) ** 2)); z *= 1 - 0.02 * rec; // the hollow the hinge sits in
    o[0] = x; o[1] = y0 + 0.005 * ss(0.86, 1, t) * s * s; o[2] = z; // the rim arches a little over the shoulders
    return o;
  }
  const A = [0, 0, 0], B = [0, 0, 0];
  function normal(t, ph, o) {
    if (t < 0.004) { o[0] = 0; o[1] = 1; o[2] = 0; return o; }
    const e = 0.0025;
    base(Math.min(1, t + e), ph, A); base(t - e, ph, B); const ax = A[0] - B[0], ay = A[1] - B[1], az = A[2] - B[2];
    base(t, ph + e, A); base(t, ph - e, B); const bx = A[0] - B[0], by = A[1] - B[1], bz = A[2] - B[2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    base(t, ph, A); if (nx * A[0] + ny * (A[1] + 0.002) + nz * A[2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const l = Math.hypot(nx, ny, nz) || 1; o[0] = nx / l; o[1] = ny / l; o[2] = nz / l; return o;
  }
  const N0 = [0, 0, 0];
  function surf(t, ph, h, o) { base(t, ph, o); if (h) { normal(t, ph, N0); base(t, ph, o); o[0] += N0[0] * h; o[1] += N0[1] * h; o[2] += N0[2] * h; } return o; }
  function tOfY(y) { let a = 0, b = 1; for (let i = 0; i < 26; i++) { const m = (a + b) / 2; if (look(RY, m) > y) a = m; else b = m; } return (a + b) / 2; }
  function phOfX(t, x) { let a = 0, b = Math.PI; const o = [0, 0, 0]; for (let i = 0; i < 24; i++) { const m = (a + b) / 2; if (base(t, m, o)[0] > x) a = m; else b = m; } return (a + b) / 2; }
  const onSide = (x, y, sd, h, o) => { const t = tOfY(y); return surf(t, sd * phOfX(t, x), h, o); };

  // the visor, a,b its own coordinates (a across, b from the top edge down): raked top edge, level
  // bottom edge, the back edge sloping forward to the lower hinge, the corners rounded
  const VIS_H = 0.0032;
  function vis(a, b, hmax, o) {
    const aa = Math.abs(a), phE = mix(1.27, 1.03, b), q = clamp((aa - 0.8) / 0.2, 0, 1), r = Math.sqrt(Math.max(0, 1 - Math.pow(q, 2.6)));
    const yT = 0.039 - 0.027 * a * a, yB = -0.034 - 0.003 * a * a, ym = (yT + yB) / 2, y = ym + (mix(yT, yB, b) - ym) * r;
    return surf(tOfY(y), a * phE, hmax * ss(0, 0.1, Math.min(b, 1 - b)) * ss(0, 0.05, 1 - aa) - 0.0005, o);
  }

  function grid(nu, nv, f, opt) {
    const P = new Float32Array((nu + 1) * (nv + 1) * 3), U = opt && opt.uv ? new Float32Array((nu + 1) * (nv + 1) * 2) : null, I = [], p = [0, 0, 0];
    let n = 0;
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      f(i / nu, j / nv, p); P[n * 3] = p[0]; P[n * 3 + 1] = p[1]; P[n * 3 + 2] = p[2];
      if (U) { const w = opt.uv(i / nu, j / nv); U[n * 2] = w[0]; U[n * 2 + 1] = w[1]; }
      n++;
    }
    const id = (i, j) => j * (nu + 1) + i;
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) I.push(id(i, j), id(i + 1, j), id(i, j + 1), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3)); if (U) g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    g.setIndex(I); g.computeVertexNormals();
    // wind it to face out
    const m = id(nu >> 1, nv >> 1), N = g.attributes.normal;
    if (N.getX(m) * P[m * 3] + N.getY(m) * (P[m * 3 + 1] + 0.002) + N.getZ(m) * P[m * 3 + 2] < 0) { for (let i = 0; i < I.length; i += 3) { const k = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = k; } g.setIndex(I); g.computeVertexNormals(); }
    return g;
  }
  function tint(g, hex) {
    const c = new THREE.Color(hex), n = g.attributes.position.count, C = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { C[i * 3] = c.r; C[i * 3 + 1] = c.g; C[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(C, 3)); return g;
  }
  function merge(list) {
    let nv = 0, ni = 0; for (const g of list) { nv += g.attributes.position.count; ni += g.index.count; }
    const first = list[0].attributes, out = new THREE.BufferGeometry(), I = new Uint32Array(ni);
    for (const k of ['position', 'normal', 'uv', 'color']) {
      if (!first[k]) continue;
      const sz = first[k].itemSize, D = new Float32Array(nv * sz); let o = 0;
      for (const g of list) { D.set(g.attributes[k].array, o * sz); o += g.attributes[k].count; }
      out.setAttribute(k, new THREE.BufferAttribute(D, sz));
    }
    let v = 0, n = 0; for (const g of list) { for (let i = 0; i < g.index.count; i++) I[n++] = v + g.index.getX(i); v += g.attributes.position.count; }
    out.setIndex(new THREE.BufferAttribute(I, 1)); return out;
  }
  // the paint is 1024 x 512 for the shell with a 1024 x 128 strip below it for the sun strip
  const VS = 512 / 640;
  function shellGeo(q) {
    const nu = Math.round(112 * q), nv = Math.round(64 * q);
    const sh = grid(nu, nv, (a, b, p) => surf(b, (a - 0.5) * TAU, 0, p), { uv: (a, b) => [1 - a, b * VS] });
    // the back of the mesh is a seam, and the crown a point: both want one normal
    const N = sh.attributes.normal, id = (i, j) => j * (nu + 1) + i;
    for (let j = 0; j <= nv; j++) { const a = id(0, j), b = id(nu, j), x = N.getX(a) + N.getX(b), y = N.getY(a) + N.getY(b), z = N.getZ(a) + N.getZ(b), l = Math.hypot(x, y, z) || 1; N.setXYZ(a, x / l, y / l, z / l); N.setXYZ(b, x / l, y / l, z / l); }
    for (let i = 0; i <= nu; i++) N.setXYZ(id(i, 0), 0, 1, 0);
    // the lip across the back of the crown, in the shell's own paint: rises to a sharp trailing edge
    const lip = (a, b, p) => { const e = Math.abs(a * 2 - 1), B = Math.pow(b, 0.7), t = tOfY(mix(0.09, 0.046, B)), ph = Math.PI + (a * 2 - 1) * 0.95; return surf(t, ph, 0.0105 * Math.pow(B, 1.5) * Math.pow(1 - e * e, 2) * (1 - ss(0.94, 1, b)) - 0.0004, p); };
    const sp = grid(Math.round(40 * q), Math.max(5, Math.round(14 * q)), lip, { uv: (a, b) => { const B = Math.pow(b, 0.7); return [0.5 - (Math.PI + (a * 2 - 1) * 0.95) / TAU, tOfY(mix(0.09, 0.046, B)) * VS]; } });
    // the sun strip, a film on the visor, printed from the strip of the paint
    const st = grid(Math.round(48 * q), Math.max(2, Math.round(6 * q)), (a, b, p) => vis(mix(-0.84, 0.84, a), b * 0.3, VIS_H + 0.0006, p), { uv: (a, b) => [1 - a, (514 + 96 * b) / 640] });
    return merge([sh, sp, st]);
  }
  const visorGeo = q => grid(Math.round(64 * q), Math.max(8, Math.round(20 * q)), (a, b, p) => vis(a * 2 - 1, b, VIS_H, p), { uv: (a, b) => [a, b] });
  function hardwareGeo() {
    const parts = [], DARK = '#0a0b0d', SILVER = '#c6c9cf', PLATE = '#191d27', o = [0, 0, 0], n = [0, 0, 0], a = [0, 0, 0], b = [0, 0, 0];
    const place = (g, t, ph, h, tang, hex) => {
      // tang: lay the part's long axis along the surface, 'ph' round the head or 't' down it
      surf(t, ph, h, o); normal(t, ph, n);
      if (tang === 't') { surf(t + 0.01, ph, h, a); surf(t - 0.01, ph, h, b); } else { surf(t, ph + 0.05, h, a); surf(t, ph - 0.05, h, b); }
      const Z = new THREE.Vector3(n[0], n[1], n[2]), X = new THREE.Vector3(a[0] - b[0], a[1] - b[1], a[2] - b[2]).normalize(), Y = new THREE.Vector3().crossVectors(Z, X).normalize(); X.crossVectors(Y, Z);
      g.applyMatrix4(new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(o[0], o[1], o[2])); parts.push(tint(g, hex));
    };
    const disc = (r0, r1, len) => { const g = new THREE.CylinderGeometry(r0, r1, len, 18); g.rotateX(Math.PI / 2); return g; };
    const stud = (x, y, sd, h0, r, len, hex) => { const t = tOfY(y); place(disc(r * 0.9, r, len), t, sd * phOfX(t, x), h0 + len / 2, 'ph', hex); };
    const bolt = (x, y, sd, h0, r, hex) => { stud(x, y, sd, h0, r, 0.0028, hex); stud(x, y, sd, h0 + 0.0028, r * 0.42, 0.0004, DARK); };
    // a raised band following a line across the side of the shell, with rounded ends; pts [x, y, half width]
    const ribbon = (pts, sd, ht, hex) => {
      const L = pts.length, at = (s, k) => { const g = pts.map(p => p[k]), v = [g[0], ...g, g[L - 1]]; return cr(v, clamp(s, 0, L - 1) + 1); };
      parts.push(tint(grid(48, 6, (u, v, p) => {
        const s = u * (L - 1), cx = at(s, 0), cy = at(s, 1), w = at(s, 2), tx = at(s + 0.02, 0) - at(s - 0.02, 0), ty = at(s + 0.02, 1) - at(s - 0.02, 1), tl = Math.hypot(tx, ty) || 1;
        const r = Math.sqrt(Math.max(0, 1 - Math.pow(Math.abs(u * 2 - 1), 6))), q = v * 2 - 1;
        return onSide(cx - ty / tl * q * w * r, cy + tx / tl * q * w * r, sd, ht * Math.sqrt(Math.max(0, 1 - q * q * q * q)) * Math.min(1, r * 1.4) - 0.0006, p);
      }), hex));
    };
    const eyelet = (t, ph, tang) => {
      const r = new THREE.TorusGeometry(1, 0.26, 6, 18); r.scale(0.0142, 0.0072, 0.009); place(r, t, ph, 0.0005, tang, SILVER);
      const c = disc(1, 1, 0.0016); c.scale(0.0134, 0.0066, 1); place(c, t, ph, 0.0012, tang, DARK);
    };
    for (const sd of [-1, 1]) {
      // the hinge: a dog bone behind the visor, running forward along its back edge to the lower mount
      ribbon([[-0.03, -0.002, 0.006], [-0.012, 0, 0.0115], [0.006, 0.003, 0.0085], [0.024, 0.006, 0.0115], [0.038, -0.008, 0.0115], [0.056, -0.026, 0.01], [0.074, -0.041, 0.008], [0.094, -0.0445, 0.0055]], sd, 0.0042, PLATE);
      bolt(0.0221, 0.006, sd, 0.0036, 0.0065, SILVER); bolt(-0.011, 0, sd, 0.0036, 0.0065, SILVER); bolt(0.0726, -0.0405, sd, 0.0036, 0.0046, '#b89a48');
      { const t = tOfY(-0.046), g = new THREE.SphereGeometry(0.0052, 12, 8); g.scale(1, 1, 0.5); place(g, t, sd * phOfX(t, 0.025), 0, 'ph', SILVER); } // chin strap rivet
      // head restraint post
      stud(-0.07, -0.085, sd, -0.0005, 0.0165, 0.0045, '#22252c'); stud(-0.07, -0.085, sd, 0.004, 0.0085, 0.0115, SILVER); stud(-0.07, -0.085, sd, 0.0155, 0.0036, 0.0006, DARK);
      // the vents on the crown
      { const t = tOfY(0.09); eyelet(t, sd * phOfX(t, 0.03)); const t2 = tOfY(0.096); eyelet(t2, sd * phOfX(t2, -0.043)); const t3 = tOfY(0.06); eyelet(t3, sd * phOfX(t3, -0.112)); }
    }
    eyelet(tOfY(0.106), 0, 't');
    // the tear-off release, on the left, by the hand that pulls it
    bolt(0.088, -0.0442, -1, 0.0036, 0.0052, '#c8181e'); ribbon([[0.098, -0.0475, 0.003], [0.104, -0.0478, 0.003], [0.11, -0.048, 0.0024]], -1, 0.0036, SILVER);
    // rubber trim round the rim and the neck pad under it
    parts.push(tint(grid(96, 3, (u, v, p) => surf(mix(0.955, 1, v), (u - 0.5) * TAU, 0.0026 * Math.sin(v * Math.PI), p)), '#08090a'));
    parts.push(tint(grid(64, 6, (u, v, p) => { surf(1, (u - 0.5) * TAU, 0, p); p[0] = mix(p[0], -0.002, v); p[2] = mix(p[2], 0, v); p[1] = mix(p[1], -0.096, v) - 0.009 * Math.sin(Math.min(1, v * 1.6) * Math.PI); return p; }), '#0c0c0e'));
    // the primitives come without uvs or with them, and only the shared attributes matter here
    for (const g of parts) g.deleteAttribute('uv');
    return merge(parts);
  }
  let GEO = null;
  function geos() { return GEO || (GEO = { hi: { shell: shellGeo(1), visor: visorGeo(1) }, lo: { shell: shellGeo(0.32), visor: visorGeo(0.32) }, hardware: hardwareGeo() }); }

  // ----- paint -----
  const rgb = h => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
  const lum = h => { const c = rgb(h); return (0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]) / 255; };
  const hex = c => '#' + c.map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  const shade = (h, k) => hex(rgb(h).map(v => v * k));
  const blend = (a, b, t) => { const p = rgb(a), q = rgb(b); return hex(p.map((v, i) => mix(v, q[i], t))); };
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const BRANDS = ['HALCYON', 'KODIAK', 'AUREX', 'MERIDIAN', 'NORTHLINE', 'VOLTIC', 'CASTELLO', 'ORBIT', 'SOLANE', 'TRIDENT LABS', 'FENWICK', 'ALTIS'];
  // small repeating motifs printed inside a panel, a shade away from its colour
  function motif(g, kind, ink) {
    const c = document.createElement('canvas'); c.width = c.height = 44; const x = c.getContext('2d');
    x.fillStyle = ink; x.strokeStyle = ink; x.lineWidth = 2.4;
    const star = (px, py, r) => { x.beginPath(); for (let i = 0; i < 10; i++) { const q = i % 2 ? r * 0.42 : r, an = i * Math.PI / 5 + 0.3; x.lineTo(px + Math.cos(an) * q, py + Math.sin(an) * q); } x.closePath(); x.fill(); };
    if (kind === 0) { star(12, 12, 11); star(33, 32, 11); }
    else if (kind === 1) { for (const [a, b] of [[0, 0], [22, 22]]) { x.beginPath(); x.moveTo(a + 2, b + 20); x.lineTo(a + 11, b + 3); x.lineTo(a + 20, b + 20); x.closePath(); x.stroke(); } }
    else if (kind === 2) { for (let i = -44; i < 44; i += 11) { x.beginPath(); x.moveTo(i, 44); x.lineTo(i + 44, 0); x.stroke(); } }
    else { for (const [a, b] of [[11, 11], [33, 33]]) { x.beginPath(); for (let i = 0; i < 6; i++) x.lineTo(a + Math.cos(i * Math.PI / 3) * 9, b + Math.sin(i * Math.PI / 3) * 9); x.closePath(); x.stroke(); } }
    return g.createPattern(c, 'repeat');
  }
  function paint(team, di, dv) {
    const W = 768, H = 480, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'), seed = hash(team.id + ':' + (dv[1] || di));
    let r = seed; const rnd = () => { r = Math.imul(r ^ (r >>> 15), 2654435761) >>> 0; return (r >>> 8) / 16777216; };
    g.scale(W / 1024, H / 640);
    let cols = [...new Set([team.base, team.accent, team.third].filter(x => /^#[0-9a-f]{6}$/i.test(x || '')))].sort((a, b) => lum(b) - lum(a));
    if (!cols.length) cols = ['#f2f2ee', '#2a3550', '#101216'];
    if (lum(cols[0]) < 0.55) cols.unshift('#f2f2ee');
    while (cols.length < 3) cols.push(shade(cols[cols.length - 1], 0.45));
    // team mates share colours and wear them differently
    const a = di % 2 ? cols[1] : cols[0], b = di % 2 ? cols[0] : cols[1], d = cols[2], edge = lum(a) > 0.55 ? shade(d, 0.8) : '#f4f4f0';
    // how much taller a letter must be drawn to come out in its true proportions on the shell
    const yc = y => tOfY(y) * 512, YS = (TAU * 0.128 / 1024) / (ARC / 512);
    const both = fn => { fn(); g.save(); g.translate(1024, 0); g.scale(-1, 1); fn(); g.restore(); };
    const path = (pts, smooth) => {
      g.beginPath(); const P = pts.map(p => [512 - p[0], yc(p[1])]);
      if (!smooth) { P.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); return; }
      const m = (i, k) => (P[i][k] + P[(i + 1) % P.length][k]) / 2; g.moveTo(m(P.length - 1, 0), m(P.length - 1, 1));
      for (let i = 0; i < P.length; i++) g.quadraticCurveTo(P[i][0], P[i][1], m(i, 0), m(i, 1)); g.closePath();
    };
    const candy = (x0, x1, col) => { const l = g.createLinearGradient(512 - x0, 0, 512 - x1, 0); l.addColorStop(0, col); l.addColorStop(0.55, shade(col, 0.82)); l.addColorStop(1, blend(col, '#ffffff', 0.14)); return l; };
    const panel = (pts, col, o) => both(() => {
      o = o || {}; path(pts, o.smooth); g.fillStyle = o.grad ? candy(o.grad[0], o.grad[1], col) : col; g.fill();
      if (o.pat != null) { g.save(); g.clip(); g.globalAlpha = 0.34; g.fillStyle = motif(g, o.pat, lum(col) > 0.5 ? shade(col, 0.55) : blend(col, '#ffffff', 0.4)); g.fillRect(0, 0, 1024, 512); g.restore(); }
      if (o.line) { path(pts, o.smooth); g.lineJoin = 'round'; g.lineWidth = o.lw || 5; g.strokeStyle = o.line; g.stroke(); }
    });
    const pin = (pts, col, w) => both(() => { g.beginPath(); pts.forEach((p, i) => { const x = 512 - p[0], y = yc(p[1]); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.lineJoin = 'round'; g.lineWidth = w; g.strokeStyle = col; g.stroke(); });
    g.fillStyle = a; g.fillRect(0, 0, 1024, 512);
    const P = seed % 4, style = (seed + di) % 4;
    if (style === 0) { // panels, stepped at the corners
      panel([[0, 0.13], [150, 0.13], [176, 0.075], [112, 0.046], [0, 0.046]], b, { grad: [0, 176], line: edge, lw: 7 });
      pin([[176, 0.075], [512, 0.075]], b, 7);
      panel([[236, 0.012], [512, 0.012], [512, -0.058], [296, -0.058]], b, { pat: P, line: edge, lw: 5 });
      for (let i = 0; i < 4; i++) { const x = 340 + i * 30; panel([[x, 0.012], [x + 14, 0.012], [x - 2, -0.058], [x - 16, -0.058]], d); }
      panel([[78, -0.044], [206, -0.042], [250, -0.066], [512, -0.066], [512, -0.125], [78, -0.125]], d, { grad: [78, 512], line: b, lw: 7 });
    } else if (style === 1) { // torn shards, light at the front and dark behind
      const pts = [[512, 0.13], [176, 0.13]]; const n = 11;
      for (let i = 0; i < n; i++) { const y = mix(0.118, -0.118, i / (n - 1)), f = mix(150, 96, ss(-0.02, -0.11, y)); pts.push(i % 2 ? [f + 12 + rnd() * 16, y] : [f + 74 + rnd() * 66, y]); }
      pts.push([512, -0.125]);
      panel(pts, d, { grad: [160, 512] });
      panel([[150, 0.125], [512, 0.125], [512, 0.084], [236, 0.078]], b, { pat: P, line: edge, lw: 4 });
      panel([[120, -0.098], [512, -0.083], [512, -0.125], [90, -0.125]], b, { pat: P, line: edge, lw: 4 });
      both(() => { g.beginPath(); g.ellipse(512 - 262, yc(0.012), 74, 62, 0, 0, TAU); g.fillStyle = b; g.fill(); });
    } else if (style === 2) { // long curves from the chin to the top of the back
      panel([[60, -0.052], [190, -0.042], [330, 0.04], [512, 0.09], [512, 0.0], [350, -0.03], [210, -0.09], [60, -0.082]], b, { smooth: true, grad: [60, 512], line: edge, lw: 6 });
      panel([[150, -0.098], [290, -0.07], [400, -0.03], [512, -0.024], [512, -0.125], [150, -0.125]], d, { smooth: true, pat: P, line: edge, lw: 5 });
      panel([[0, 0.13], [120, 0.13], [188, 0.07], [60, 0.05], [0, 0.05]], d, { smooth: true });
    } else { // bars raked back, a fade running the length of the head
      both(() => { const l = g.createLinearGradient(512, 0, 0, 0); l.addColorStop(0.14, a); l.addColorStop(0.62, b); l.addColorStop(1, d); g.fillStyle = l; g.fillRect(0, 0, 512, 512); });
      for (let i = 0; i < 5; i++) { const x = 210 + i * 58, w = 34 - i * 3; panel([[x + 48, 0.12], [x + 48 + w, 0.12], [x + w - 34, -0.12], [x - 34, -0.12]], i % 2 ? d : a, { line: edge, lw: 3 }); }
      panel([[58, -0.05], [205, -0.044], [240, -0.125], [58, -0.125]], d, { pat: P, line: edge, lw: 5 });
    }
    // the chin panel and the crown vent ring, as on most helmets
    panel([[0, -0.062], [88, -0.062], [106, -0.125], [0, -0.125]], lum(a) > 0.55 ? a : '#f2f2ee');
    // the chin grilles, flush mesh in a dark surround
    const mesh = (x0, x1, y, hw) => both(() => {
      const t0 = yc(y + hw), t1 = yc(y - hw), rr = (t1 - t0) / 2; g.beginPath(); g.moveTo(512 - x0, t0); g.lineTo(512 - x1 + rr, t0); g.arc(512 - x1 + rr, t0 + rr, rr, -Math.PI / 2, Math.PI / 2, true); g.lineTo(512 - x0 - rr, t1); g.arc(512 - x0 - rr, t0 + rr, rr, Math.PI / 2, -Math.PI / 2, true); g.closePath();
      g.fillStyle = '#0c0d10'; g.fill(); g.lineWidth = 2.5; g.strokeStyle = shade(b, 0.7); g.stroke(); g.save(); g.clip(); g.strokeStyle = '#6e727a'; g.lineWidth = 1;
      for (let i = -40; i < 240; i += 5) { g.beginPath(); g.moveTo(512 - x1 + i, t0 - 2); g.lineTo(512 - x1 + i + 14, t1 + 2); g.moveTo(512 - x1 + i + 14, t0 - 2); g.lineTo(512 - x1 + i, t1 + 2); g.stroke(); }
      g.restore();
    });
    mesh(54, 146, -0.055, 0.0058); mesh(0, 26, -0.085, 0.0034);
    g.fillStyle = d; g.fillRect(0, 0, 1024, 48); g.fillStyle = b; g.fillRect(0, 48, 1024, 7); g.fillStyle = edge; g.fillRect(0, 55, 1024, 3);
    // lettering
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const fnt = px => '900 italic ' + px + 'px "Arial Black", Arial, sans-serif';
    function text(s, x, y, px, col, maxW, line, pill) {
      g.save(); g.translate(x, y); g.font = fnt(px); const w = g.measureText(s).width, sx = Math.min(1, maxW / w); g.scale(sx, YS);
      if (pill) { const pw = w + px * 0.9, ph = px * 1.45; g.fillStyle = pill; g.beginPath(); if (g.roundRect) g.roundRect(-pw / 2, -ph / 2, pw, ph, 7); else g.rect(-pw / 2, -ph / 2, pw, ph); g.fill(); }
      if (line) { g.lineWidth = px * 0.16; g.lineJoin = 'round'; g.strokeStyle = line; g.strokeText(s, 0, 0); }
      g.fillStyle = col; g.fillText(s, 0, 0); g.restore();
    }
    const sides = (s, dd, y, px, col, maxW, line, pill) => { text(s, 512 - dd, yc(y), px, col, maxW, line, pill); text(s, 512 + dd, yc(y), px, col, maxW, line, pill); };
    const main = (team.name || 'TEAM').split(' ')[0].toUpperCase(), name = String(dv[1] || dv[2] || '').toUpperCase(), num = String(dv[3] == null ? '' : dv[3]);
    const list = BRANDS.filter(n => n !== main), s1 = list[seed % list.length], s2 = list[((seed >>> 5) % (list.length - 1) + 1 + seed % list.length) % list.length], s3 = list[((seed >>> 9) % (list.length - 1) + 1 + seed % list.length) % list.length];
    const big = lum(b) > 0.5 ? '#111317' : '#f6f6f2', bigL = lum(b) > 0.5 ? '#f6f6f2' : '#111317';
    sides(main, 346, -0.032, 58, big, 236, bigL);
    sides(name, 296, 0.05, 22, '#111317', 122, null, '#f4f4f0');
    sides(s1, 300, -0.1, 20, '#111317', 132, null, '#f4f4f0');
    sides(s2, 150, -0.1, 18, '#111317', 104, null, '#f4f4f0');
    text(s3, 512, yc(-0.098), 19, '#111317', 120, null, lum(a) > 0.55 ? null : '#f2f2ee');
    text(name, 512, yc(0.066), 21, big, 150, bigL);
    for (const x of [0, 1024]) { text(num, x, yc(0.012), 74, '#f6f6f2', 150, '#111317'); text(s1, x, yc(-0.052), 22, '#111317', 170, null, '#f4f4f0'); }
    // the rim, black to the rubber
    g.fillStyle = '#0b0c0e'; g.fillRect(0, 490, 1024, 22);
    // the sun strip: the visor's most valuable space, team name in the middle
    g.fillStyle = '#f4f4f0'; g.fillRect(0, 512, 1024, 128);
    g.fillStyle = b; g.fillRect(0, 602, 1024, 10);
    g.save(); g.translate(0, 558);
    const ink = lum(d) < 0.4 ? d : '#111317';
    g.fillStyle = ink; g.textAlign = 'center'; g.font = fnt(62); g.fillText(main, 512, 0, 460);
    g.font = fnt(34); g.fillText(s1, 170, 0, 210); g.fillText(s2, 854, 0, 210);
    g.restore();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.flipY = false; t.wrapS = THREE.RepeatWrapping; t.anisotropy = 8;
    return t;
  }
  // the mirror coat's tint, deep in the middle and coloured toward the edges, with the faint streaks
  // of a coating laid on in passes; the thin film on the material does the rest
  function visorMap(team) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const g = c.getContext('2d'), s = /^#[0-9a-f]{6}$/i.test(team.accent || '') && lum(team.accent) < 0.85 ? team.accent : /^#[0-9a-f]{6}$/i.test(team.third || '') ? team.third : '#3a68c8';
    const l = g.createLinearGradient(0, 0, 0, 128), hot = blend(s, '#d08a2c', 0.35);
    l.addColorStop(0, blend(s, '#05070c', 0.62)); l.addColorStop(0.55, blend(s, '#04060a', 0.9)); l.addColorStop(1, blend(hot, '#05070c', 0.5));
    g.fillStyle = l; g.fillRect(0, 0, 256, 128);
    let r = hash(team.id); for (let i = 0; i < 46; i++) { r = Math.imul(r ^ (r >>> 13), 1597334677) >>> 0; g.globalAlpha = 0.02 + (r % 5) / 100; g.fillStyle = r & 1 ? '#ffffff' : '#000000'; g.fillRect(0, (r >>> 8) % 128, 256, 1 + (r >>> 20) % 3); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.flipY = false; t.anisotropy = 4;
    return t;
  }
  const shells = new Map(), visors = new Map();
  let hardware = null;
  // the same materials are used by each car of the same driver, for as long as the page is open
  function make(team, di, dv) {
    const key = team.id + ':' + di;
    if (!shells.has(key)) shells.set(key, new THREE.MeshPhysicalMaterial({ map: paint(team, di, dv), roughness: 0.34, metalness: 0.22, clearcoat: 1, clearcoatRoughness: 0.03 }));
    if (!visors.has(team.id)) visors.set(team.id, new THREE.MeshPhysicalMaterial({ map: visorMap(team), roughness: 0.05, metalness: 0.9, iridescence: 0.32, iridescenceIOR: 1.7, iridescenceThicknessRange: [300, 460], clearcoat: 1, clearcoatRoughness: 0.02 }));
    // polished and anodised metal; the bolts and plates differ only in their colour
    hardware = hardware || new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.95, iridescence: 0.4, iridescenceIOR: 1.5, iridescenceThicknessRange: [200, 420] });
    return { geo: geos(), shellMat: shells.get(key), visorMat: visors.get(team.id), hardwareMat: hardware };
  }
  F1.R3Helmet = { make };
})(typeof window !== 'undefined' ? window : globalThis);
