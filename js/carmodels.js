// The 2026 cars: loading and decoding the car files written by tools/car_prep26.mjs. Each file
// holds a JSON header (materials, texture names, the layout of every mesh) and one binary block
// of vertex data: positions and UVs as 16-bit steps over their own range, normals as bytes.
// They ship as script files (tools/car_pack.py: js/assets/cars/ID.js, the textures in tex.js,
// base64), because a script loads everywhere: from the web, from the offline cache (sw.js), and
// from the game opened straight from its folder (file://), where fetch is not allowed.
(function (G) {
  'use strict';
  const F1 = G.F1 = G.F1 || {}, THREE = G.THREE;
  const cars = new Map();   // id -> decoded car
  const texCache = new Map(); // file -> Promise<THREE.Texture> (textures are shared between cars)
  // phones and small GPUs get every texture at half size: a full grid of cars at full size is
  // several hundred megabytes of texture memory
  const small = (navigator.deviceMemory && navigator.deviceMemory <= 4) || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

  // the version index.html stamped on this script, so the car files update with it
  const ver = (() => { const t = document.querySelector('script[src*="carmodels.js"]'); const m = t && t.src.match(/\?v=\w+/); return m ? m[0] : ''; })();
  const scripts = new Map();
  function script(src) {
    if (scripts.has(src)) return scripts.get(src);
    const p = new Promise((res, rej) => {
      const el = document.createElement('script');
      el.src = src + ver; el.onload = () => res(); el.onerror = () => rej(new Error(src));
      document.head.appendChild(el);
    });
    scripts.set(src, p);
    return p;
  }
  function bytes(b64) {
    const raw = atob(b64), u = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i);
    return u;
  }

  function parse(buf) {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x43504753) throw new Error('not a car file'); // 'SGPC'
    const n = dv.getUint32(4, true);
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, n)));
    const off = 8 + n + ((4 - ((8 + n) % 4)) % 4);
    return { meta, bin: buf.slice(off) };
  }

  function texture(file, normal) {
    const key = file + (normal ? '|n' : '');
    if (texCache.has(key)) return texCache.get(key);
    const p = script('js/assets/cars/tex.js').then(async () => {
      const b = new Blob([bytes(F1.CarTex[file])], { type: 'image/webp' });
      const full = +(file.match(/_(\d+)\.webp$/) || [0, 0])[1];
      const opt = { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
      let img;
      try {
        img = await createImageBitmap(b, small && full > 512 ? Object.assign({ resizeWidth: full / 2, resizeHeight: full / 2, resizeQuality: 'high' }, opt) : opt);
      } catch (e) {
        // older browsers: no options, or no WebP in createImageBitmap
        img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(b); });
      }
      const t = new THREE.Texture(img);
      t.flipY = false; // glTF texture space
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = normal ? THREE.NoColorSpace : THREE.SRGBColorSpace;
      t.anisotropy = small ? 4 : 8;
      t.needsUpdate = true;
      return t;
    });
    texCache.set(key, p);
    return p;
  }

  // vertex data views into the binary block
  function decode(bin, g) {
    const geo = new THREE.BufferGeometry();
    const deq = (q, k) => {
      const [o, n, lo, sc] = q, u = new Uint16Array(bin, o, n), f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = lo[i % k] + u[i] * sc[i % k];
      return f;
    };
    geo.setAttribute('position', new THREE.BufferAttribute(deq(g.pos, 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(bin, g.nor[0], g.nor[1]), 3, true));
    if (g.uv) geo.setAttribute('uv', new THREE.BufferAttribute(deq(g.uv, 2), 2));
    if (g.col) {
      // far-level colours, stored in sRGB bytes
      const c = new Uint8Array(bin, g.col[0], g.col[1]), f = new Float32Array(c.length);
      for (let i = 0; i < c.length; i++) { const s = c[i] / 255; f[i] = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }
      geo.setAttribute('color', new THREE.BufferAttribute(f, 3));
    }
    geo.setIndex(new THREE.BufferAttribute(g.idx[0] === 'u32' ? new Uint32Array(bin, g.idx[1], g.idx[2]) : new Uint16Array(bin, g.idx[1], g.idx[2]), 1));
    geo.computeBoundingSphere();
    return geo;
  }

  async function load(id) {
    if (cars.has(id)) return cars.get(id);
    await script('js/assets/cars/' + id + '.js');
    const { meta, bin } = parse(bytes(F1.CarFiles[id]).buffer);
    delete F1.CarFiles[id]; // the decoded bytes are all that is kept
    const normal = new Set(meta.mats.filter(m => m.nmap >= 0).map(m => m.nmap));
    const tex = await Promise.all(meta.tex.map((f, i) => texture(f, normal.has(i))));
    const geos = new WeakMap();
    const car = {
      id, meta, tex,
      geo: g => { let x = geos.get(g); if (!x) geos.set(g, x = decode(bin, g)); return x; },
    };
    cars.set(id, car);
    return car;
  }

  // every car of the grid, one after the other (each decode holds the page for a moment)
  async function loadAll(ids, onProgress) {
    let n = 0;
    for (const id of ids) {
      try { await load(id); } catch (e) { console.warn('car', id, e); }
      if (onProgress) onProgress(++n, ids.length);
    }
    // every texture is decoded now: the base64 copies can go
    await Promise.all(texCache.values()).catch(() => {});
    delete F1.CarTex;
  }

  F1.CarModels = { load, loadAll, has: id => cars.has(id), get: id => cars.get(id), small };
})(typeof window !== 'undefined' ? window : globalThis);
