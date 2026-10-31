// Trees as impostors of scanned models. tools/assets_trees.py embeds, per species, an atlas
// of eight side views (colour, and the surface normal in each view's camera space) baked
// from a CC0 Poly Haven model. In game every tree is one camera-facing quad: the vertex
// shader picks the two baked views nearest the direction the tree is seen from and the
// fragment shader blends them, so a tree turns as the camera passes it. The baked normals,
// bent toward a crown-shaped sphere, light the foliage like a volume under the venue's sun,
// and a shadow pass draws the same quad facing the sun, so each tree casts its own shape.
(function (G) {
  'use strict';
  const F1 = G.F1, THREE = G.THREE;
  const U = F1.U, Tracks = F1.Tracks;

  // species per look and how tall each grows for a decor radius r (metres)
  const SETS = {
    fir: { names: ['fir_0', 'fir_1', 'fir_2'], h: r => 6 + r * 2.1 },
    quiver: { names: ['quiver'], h: r => 3.2 + r * 0.6 },
    broad: { names: ['broad1', 'broad2', 'broad4'], h: r => 5 + r * 1.55 },
  };
  // where the baked crown sits in a view (fraction of the height): centre and half-height
  const CROWN = [0.66, 0.36];

  const A = () => F1.Assets && F1.Assets.trees;
  const available = () => !!A();

  const VERT_PARS = [
    'attribute vec4 tPos; attribute vec2 tVar;',
    'uniform float uTAspect;',
    'varying vec2 vTUv0; varying vec2 vTUv1; varying float vTBl; varying vec2 vTAng; varying vec2 vTLoc;',
    'varying vec3 vTRight; varying vec3 vTFwd; varying vec3 vTTint;',
  ].join('\n');
  const VERT = [
    '  vec2 tD = cameraPosition.xz - tPos.xz;',
    '  float tBeta = atan(tD.y, tD.x);',
    '  vec2 tF = normalize(tD + vec2(1e-5));',
    '  vec3 tRight = vec3(tF.y, 0.0, -tF.x); // right as the bake camera saw it from tF',
    // the view in the atlas: views are 45 degrees apart, measured in the tree's own frame
    '  float tA = (tBeta - tVar.x) / 6.28318 * 8.0;',
    '  tA = mod(tA, 8.0);',
    '  float tK0 = floor(tA), tK1 = mod(tK0 + 1.0, 8.0);',
    '  vTBl = tA - tK0;',
    '  vTAng = vec2(tK0, tK1) * 0.785398 + tVar.x;',
    '  vec2 tS = vec2(position.x + 0.5, position.y);',
    '  vTLoc = tS;',
    '  vTUv0 = vec2((mod(tK0, 4.0) + tS.x) / 4.0, (1.0 - floor(tK0 / 4.0) + tS.y) * 0.5);',
    '  vTUv1 = vec2((mod(tK1, 4.0) + tS.x) / 4.0, (1.0 - floor(tK1 / 4.0) + tS.y) * 0.5);',
    '  float tH = tPos.w, tW = tH * uTAspect;',
    '  transformed = vec3(tPos.x, tPos.y - 0.15, tPos.z) + tRight * position.x * tW + vec3(0.0, position.y * tH, 0.0);',
    '  vTRight = tRight; vTFwd = vec3(tF.x, 0.0, tF.y);',
    '  vTTint = vec3(1.0 + tVar.y * 0.13, 1.0 + tVar.y * 0.05, 1.0 - tVar.y * 0.16) * (1.0 + tVar.y * 0.1);',
  ].join('\n');
  const FRAG_PARS = [
    'uniform sampler2D uTNrm; uniform vec2 uTCrown;',
    'varying vec2 vTUv0; varying vec2 vTUv1; varying float vTBl; varying vec2 vTAng; varying vec2 vTLoc;',
    'varying vec3 vTRight; varying vec3 vTFwd; varying vec3 vTTint;',
  ].join('\n');
  const FRAG_COLOR = '  diffuseColor *= mix(texture2D(map, vTUv0), texture2D(map, vTUv1), vTBl);';
  const FRAG_NORMAL = [
    '  vec3 tN0 = texture2D(uTNrm, vTUv0).xyz * 2.0 - 1.0, tN1 = texture2D(uTNrm, vTUv1).xyz * 2.0 - 1.0;',
    // a baked view-space normal back to world space: x along that view's right, z toward it
    '  vec3 tW0 = tN0.x * vec3(sin(vTAng.x), 0.0, -cos(vTAng.x)) + vec3(0.0, tN0.y, 0.0) + tN0.z * vec3(cos(vTAng.x), 0.0, sin(vTAng.x));',
    '  vec3 tW1 = tN1.x * vec3(sin(vTAng.y), 0.0, -cos(vTAng.y)) + vec3(0.0, tN1.y, 0.0) + tN1.z * vec3(cos(vTAng.y), 0.0, sin(vTAng.y));',
    '  vec3 tNw = normalize(mix(tW0, tW1, vTBl) + vec3(0.0, 1e-4, 0.0));',
    // leaf cards point every which way; bend them toward the crown's rounded volume
    '  vec2 tQ = vec2((vTLoc.x - 0.5) * 2.0, (vTLoc.y - uTCrown.x) / uTCrown.y);',
    '  vec3 tSn = normalize(vTRight * tQ.x + vec3(0.0, tQ.y, 0.0) + vTFwd * sqrt(max(0.05, 1.0 - dot(tQ, tQ))));',
    '  float tCw = smoothstep(uTCrown.x - uTCrown.y, uTCrown.x - uTCrown.y + 0.15, vTLoc.y);',
    '  tNw = normalize(mix(tNw, tSn, 0.55 * tCw));',
    '  normal = normalize((viewMatrix * vec4(tNw, 0.0)).xyz);',
  ].join('\n');
  // sunlight through the leaves toward the eye
  const FRAG_TRANS = [
    '  float tTr = pow(max(dot(normalize(vFogWorld - cameraPosition), uSunDir), 0.0), 4.0);',
    '  totalEmissiveRadiance += diffuseColor.rgb * uSunCol * tTr * 0.22 * smoothstep(uTCrown.x - uTCrown.y, uTCrown.x, vTLoc.y);',
  ].join('\n');

  function patchLit(sh, u) {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = VERT_PARS + '\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT);
    sh.fragmentShader = FRAG_PARS + '\n' + sh.fragmentShader
      .replace('#include <map_fragment>', FRAG_COLOR + '\n  diffuseColor.rgb *= vTTint;')
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n' + FRAG_NORMAL)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + FRAG_TRANS);
  }
  function patchDepth(sh, u) {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = VERT_PARS + '\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT);
    sh.fragmentShader = FRAG_PARS + '\n' + sh.fragmentShader.replace('#include <map_fragment>', FRAG_COLOR);
  }

  const species = {};
  function getSpecies(name) {
    if (species[name]) return species[name];
    const s = A()[name];
    if (!s) return (species[name] = null);
    const load = (uri, srgb) => {
      const t = new THREE.Texture(), im = new Image();
      im.onload = () => { t.image = im; t.needsUpdate = true; };
      im.src = uri;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = 4;
      return t;
    };
    const color = load(s.color, true), nrm = load(s.normal, false);
    const u = { uTAspect: { value: s.W / s.H }, uTNrm: { value: nrm }, uTCrown: { value: new THREE.Vector2(CROWN[0], CROWN[1]) } };
    const lit = new THREE.MeshStandardMaterial({ map: color, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.75, metalness: 0 });
    lit.userData.patchExtra = sh => patchLit(sh, u);
    lit.userData.patchKey = 'tree';
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: color, alphaTest: 0.5, side: THREE.DoubleSide });
    depth.onBeforeCompile = sh => patchDepth(sh, u);
    depth.customProgramCacheKey = () => 'treeDepth';
    return (species[name] = { s, lit, depth });
  }

  function quad() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    return g;
  }

  // The deep forest as a wall. Seen from the track, rows of impostors behind the first few
  // only add layers of alpha-tested quads over the same pixels (each shaded, then hidden),
  // which is what made dense forest expensive. Instead, everything beyond the front rows is
  // two long curtains that follow the track, cut out by a texture of the same baked fir views
  // stamped edge to edge in three rows (back rows darker, crowns peeking between). A pixel of
  // forest is then shaded about once. The stamped normals are view space, which for a curtain
  // facing the viewer is tangent space, so the wall takes the sun like the impostors do.
  const SH_PER = 120, SH_H = 30, SH_W = 2048, SH_TH = 512; // texture: metres along, metres high, pixels
  let shellMats = null;
  function shellMaterials(names, set) {
    if (shellMats) return shellMats;
    const mapC = document.createElement('canvas'), nrmC = document.createElement('canvas');
    mapC.width = nrmC.width = SH_W; mapC.height = nrmC.height = SH_TH;
    const map = new THREE.CanvasTexture(mapC), nrm = new THREE.CanvasTexture(nrmC);
    map.colorSpace = THREE.SRGBColorSpace; nrm.colorSpace = THREE.NoColorSpace;
    for (const t of [map, nrm]) { t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = 8; }
    const img = uri => new Promise(ok => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ok(null); im.src = uri; });
    Promise.all(names.map(n => Promise.all([img(A()[n].color), img(A()[n].normal)]))).then(ims => {
      const g = mapC.getContext('2d'), gn = nrmC.getContext('2d'), rnd = U.rng(57), pxm = SH_TH / SH_H;
      const tmp = document.createElement('canvas'), gt = tmp.getContext('2d');
      // under the crowns: dark trunks and undergrowth, so the wall has no daylight at its foot
      const foot = (ctx, col) => {
        ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, SH_TH);
        for (let x = 0; x <= SH_W; x += 16) ctx.lineTo(x, SH_TH - pxm * (6 + 2.5 * Math.sin(x * 0.013) + rnd() * 2));
        ctx.lineTo(SH_W, SH_TH); ctx.closePath(); ctx.fill();
      };
      foot(g, '#1c2418'); foot(gn, 'rgb(128,128,255)');
      const stamp = (k, x, hPx, bright) => {
        const [ci, ni] = ims[k], s = A()[names[k]];
        if (!ci || !ni) return;
        const v = Math.floor(rnd() * 8), cw = ci.width / 4, ch = ci.height / 2, nw = ni.width / 4, nh = ni.height / 2;
        const w = hPx * s.W / s.H;
        for (const dx of [0, -SH_W, SH_W]) {
          const x0 = x - w / 2 + dx;
          if (x0 > SH_W || x0 + w < 0) continue;
          g.filter = 'brightness(' + bright.toFixed(3) + ') saturate(' + (0.85 + rnd() * 0.3).toFixed(3) + ')';
          g.drawImage(ci, (v % 4) * cw, Math.floor(v / 4) * ch, cw, ch, x0, SH_TH - hPx, w, hPx);
          g.filter = 'none';
          // the normal view, masked by the colour view's alpha
          tmp.width = Math.ceil(w); tmp.height = Math.ceil(hPx);
          gt.globalCompositeOperation = 'source-over';
          gt.drawImage(ni, (v % 4) * nw, Math.floor(v / 4) * nh, nw, nh, 0, 0, w, hPx);
          gt.globalCompositeOperation = 'destination-in';
          gt.drawImage(ci, (v % 4) * cw, Math.floor(v / 4) * ch, cw, ch, 0, 0, w, hPx);
          gn.drawImage(tmp, x0, SH_TH - hPx);
        }
      };
      // back row first: darker (deeper in the wood), then the middle row, then the front
      for (const [bright, gap] of [[0.55, 0.36], [0.72, 0.4], [0.9, 0.46]]) {
        for (let x = rnd() * 40; x < SH_W;) {
          const r = 2.4 + Math.pow(rnd(), 0.8) * 6, hm = Math.min(SH_H - 1, set.h(r) * (0.72 + rnd() * 0.56));
          const k = Math.floor(rnd() * names.length), s = A()[names[k]], hPx = hm * pxm;
          stamp(k, x, hPx, bright * (0.88 + rnd() * 0.24));
          x += hPx * s.W / s.H * gap * (0.7 + rnd() * 0.6);
        }
      }
      map.needsUpdate = nrm.needsUpdate = true;
    });
    const lit = new THREE.MeshStandardMaterial({ map, normalMap: nrm, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.8, metalness: 0 });
    return (shellMats = { lit });
  }

  // curtains along both sides at fixed depths into the forest; a vertex stands at full height
  // only where the deep trees it replaces stood (so clearings and gaps stay open), and sinks
  // underground where the offset line folds over itself on the inside of a bend
  const CURTAINS = [{ o: 18, k: 1, du: 0 }, { o: 44, k: 1.12, du: 0.37 }];
  function buildShell(root, tr, deep, names, set) {
    const cell = 10, grid = new Map();
    for (const it of deep) { const key = Math.floor(it.x / cell) + ',' + Math.floor(it.y / cell); grid.set(key, (grid.get(key) || 0) + 1); }
    const occAt = (x, y) => {
      let n = 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) n += grid.get((Math.floor(x / cell) + a) + ',' + (Math.floor(y / cell) + b)) || 0;
      return U.smooth((n - 1) / 4);
    };
    const nearest = (x, y) => { let bd = 1e9; tr.hash.near(x, y, 160, i => { bd = Math.min(bd, (x - tr.x[i]) ** 2 + (y - tr.y[i]) ** 2); }); return Math.sqrt(bd); };
    const st = Math.max(1, Math.round(4 / tr.ds)), win = Math.max(1, Math.round(20 / tr.ds));
    const pos = [], nor = [], uv = [], idx = [];
    for (const c of CURTAINS) for (let side = 0; side < 2; side++) {
      const sg = side ? 1 : -1, b = tr.barr[side];
      // which way along the track is "right" for someone on it looking out at this side
      const dir = Math.sign(sg * (-tr.ny[0] * tr.tx[0] + tr.nx[0] * tr.ty[0])) || 1;
      let cum = 0, px = null, pz = null, first = pos.length / 3;
      const nv = Math.ceil(tr.N / st) + 1;
      for (let q = 0; q < nv; q++) {
        const i = (q * st) % tr.N;
        let bs = 0; for (let k = -win; k <= win; k++) bs += b[(i + k + tr.N) % tr.N];
        const off = bs / (2 * win + 1) + 12 + c.o;
        const x = tr.x[i] + tr.nx[i] * sg * off, z = tr.y[i] + tr.ny[i] * sg * off;
        if (px !== null) cum += Math.hypot(x - px, z - pz);
        px = x; pz = z;
        let occ = occAt(x, z);
        if (occ > 0 && nearest(x, z) < off * 0.85) occ = 0;
        const f = c.k * (0.92 + 0.16 * (0.5 + 0.5 * Math.sin(cum * 0.021 + c.du * 9))), gy = Tracks.groundAt(tr, x, z) - 2;
        const u = dir * cum / SH_PER + c.du, top = gy + (SH_H * f + 2) * occ;
        pos.push(x, gy, z, x, top, z);
        const nx = -sg * tr.nx[i], nz = -sg * tr.ny[i], l = Math.hypot(nx, 0.2, nz);
        nor.push(nx / l, 0.2 / l, nz / l, nx / l, 0.2 / l, nz / l);
        uv.push(u, -2 / (SH_H * f), u, 1);
        if (q > 0) {
          const a0 = first + (q - 1) * 2, a1 = a0 + 2; // bottom, top of the previous and this column
          // wound counter-clockwise as seen from the track, the side the normals face
          if (dir > 0) idx.push(a0, a1, a0 + 1, a0 + 1, a1, a1 + 1); else idx.push(a1, a0, a1 + 1, a1 + 1, a0, a0 + 1);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const M = shellMaterials(names, set), mesh = new THREE.Mesh(g, M.lit);
    mesh.customDepthMaterial = M.depth;
    // no shadow pass: the curtains span the whole lap, so they would fill every cascade, and the
    // front rows of real trees already throw the forest's shade onto the verge
    mesh.castShadow = false; mesh.receiveShadow = true;
    root.add(mesh);
  }

  // add the circuit's trees to root; items are decor entries of type 'tree'
  function build(root, tr, items) {
    const set = SETS[Tracks.treesOf(tr)] || SETS.broad;
    const names = set.names.filter(n => getSpecies(n));
    if (!names.length) return false;
    // the deep rows of a conifer forest become the wall above; only the front rows stay trees
    const deep = items.filter(it => it.forest && it.deep);
    if (deep.length && set === SETS.fir) { buildShell(root, tr, deep, names, set); items = items.filter(it => !(it.forest && it.deep)); }
    const rnd = U.rng(91), tiles = new Map();
    for (const it of items) {
      const sp = names[Math.floor(rnd() * names.length)];
      const key = sp + '|' + Math.floor(it.x / 450) + ',' + Math.floor(it.y / 450) + (it.deep ? 'd' : '');
      let t = tiles.get(key); if (!t) tiles.set(key, t = { sp, list: [], deep: !!it.deep });
      t.list.push(it);
    }
    for (const { sp, list, deep } of tiles.values()) {
      // shuffled, so a thinned tile (scenery setting) keeps a random share spread over it
      for (let k = list.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [list[k], list[j]] = [list[j], list[k]]; }
      const S = getSpecies(sp), n = list.length;
      const pos = new Float32Array(n * 4), vr = new Float32Array(n * 2);
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, hMax = 0;
      list.forEach((it, k) => {
        const h = set.h(it.r) * (0.72 + rnd() * 0.56);
        pos[k * 4] = it.x; pos[k * 4 + 1] = Tracks.groundAt(tr, it.x, it.y); pos[k * 4 + 2] = it.y; pos[k * 4 + 3] = h;
        vr[k * 2] = rnd() * Math.PI * 2; vr[k * 2 + 1] = rnd() * 2 - 1;
        x0 = Math.min(x0, it.x); x1 = Math.max(x1, it.x); z0 = Math.min(z0, it.y); z1 = Math.max(z1, it.y); hMax = Math.max(hMax, h);
      });
      const g = quad();
      g.setAttribute('tPos', new THREE.InstancedBufferAttribute(pos, 4));
      g.setAttribute('tVar', new THREE.InstancedBufferAttribute(vr, 2));
      g.instanceCount = n;
      const cy = pos[1];
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3((x0 + x1) / 2, cy + hMax / 2, (z0 + z1) / 2), Math.hypot(x1 - x0, z1 - z0) / 2 + hMax * 1.5 + 60);
      const mesh = new THREE.Mesh(g, S.lit);
      mesh.customDepthMaterial = S.depth;
      // inside a forest the trees behind the first rows shade only each other, out of sight
      mesh.castShadow = !deep; mesh.receiveShadow = false;
      mesh.userData.dens = n;
      root.add(mesh);
    }
    return true;
  }

  F1.R3Trees = { available, build };
})(typeof window !== 'undefined' ? window : globalThis);
