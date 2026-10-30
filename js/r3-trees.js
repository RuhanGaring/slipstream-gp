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

  // add the circuit's trees to root; items are decor entries of type 'tree'
  function build(root, tr, items) {
    const set = SETS[Tracks.treesOf(tr)] || SETS.broad;
    const names = set.names.filter(n => getSpecies(n));
    if (!names.length) return false;
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
