// World renderer. The circuit is pre-built into 100 m chunks of Path2D geometry
// (asphalt, kerbs, run-off, lines, barriers, pit lane) so each frame only fills the
// chunks on screen. Scenery is bucketed on a grid and culled the same way.
(function (G) {
  'use strict';
  const F1 = G.F1;
  const U = F1.U, Tracks = F1.Tracks, SURF = F1.SURF, Sprites = F1.Sprites;

  const THEMES = {
    park: {
      grassA: '#4f7d36', grassB: '#568640', grassN: ['#47722f', '#5c8c45', '#4a7832'],
      gravel: '#cdb88e', gravelN: ['#bba578', '#dccaa2', '#c4ad82', '#a99470'],
      asphalt: '#3a3d42', asphaltN: ['#33363a', '#41444a', '#2f3236', '#46494e'],
      runoff: '#474a4f', runoffN: ['#404347', '#4e5156'],
      ground: '#4f7d36', groundN: ['#47722f', '#5c8c45'], bg: 'grass',
      tree: ['#2f5a24', '#36652a', '#2a5120'], treeHi: '#4b7d39',
    },
    modern: {
      grassA: '#6c8f3e', grassB: '#73974a', grassN: ['#62853a', '#7aa04e'],
      gravel: '#d9c08f', gravelN: ['#cfb27d', '#e2cc9f', '#c9ab76'],
      asphalt: '#36393e', asphaltN: ['#2f3236', '#3d4045', '#2b2e32'],
      runoff: '#4b5260', runoffN: ['#454c59', '#525967'],
      ground: '#dcc496', groundN: ['#d2b886', '#e6d1a8', '#cdb27f', '#e9d7b4'], bg: 'ground',
      tree: ['#4d6b2c', '#56763a'], treeHi: '#7c9a50', palms: true,
    },
    street: {
      grassA: '#5b7e3c', grassB: '#628544', grassN: ['#557739'],
      gravel: '#cdb88e', gravelN: ['#bba578'],
      asphalt: '#3c3f44', asphaltN: ['#35383c', '#43464b', '#303337'],
      runoff: '#55585d', runoffN: ['#4e5156', '#5c5f64'],
      ground: '#9b978e', groundN: ['#928e85', '#a4a097', '#8b877e', '#aaa69d'], bg: 'ground',
      water: '#1f5873',
      tree: ['#3c6a2c', '#447432'], treeHi: '#5e8f45', city: true,
    },
  };

  const CHUNK = 50;

  function build(tr, ctx) {
    const style = tr.def.style;
    const theme = THEMES[style];
    const W = { tr, theme, chunks: [], decor: [], buckets: new Map(), pats: Sprites.makePatterns(ctx, theme) };
    const N = tr.N;
    const P = (i, d) => { i = (i + N) % N; return [tr.x[i] + tr.nx[i] * d, tr.y[i] + tr.ny[i] * d]; };

    for (let a = 0; a < N; a += CHUNK) {
      const b = Math.min(N, a + CHUNK); // inclusive end index b (wraps)
      const ch = { a, b, minx: 1e9, miny: 1e9, maxx: -1e9, maxy: -1e9 };
      const strip = (fo, fi, i0 = a, i1 = b + 1) => { // polygon between two offset functions (1 sample overlap hides seams)
        const p = new Path2D();
        let first = true;
        for (let i = i0; i <= i1; i++) { const q = P(i, fo(i % N)); if (first) { p.moveTo(q[0], q[1]); first = false; } else p.lineTo(q[0], q[1]); }
        for (let i = i1; i >= i0; i--) { const q = P(i, fi(i % N)); p.lineTo(q[0], q[1]); }
        p.closePath();
        return p;
      };
      for (let i = a; i <= b; i++) {
        for (const sd of [-1, 1]) {
          const q = P(i, sd * (tr.barr[sd > 0 ? 1 : 0][i % N] + 6));
          ch.minx = Math.min(ch.minx, q[0]); ch.maxx = Math.max(ch.maxx, q[0]);
          ch.miny = Math.min(ch.miny, q[1]); ch.maxy = Math.max(ch.maxy, q[1]);
        }
        const po = tr.pit.off[i % N];
        if (!isNaN(po)) {
          const q = P(i, po + Math.sign(po) * 40);
          ch.minx = Math.min(ch.minx, q[0]); ch.maxx = Math.max(ch.maxx, q[0]);
          ch.miny = Math.min(ch.miny, q[1]); ch.maxy = Math.max(ch.maxy, q[1]);
        }
      }
      const hw = tr.hw;
      ch.asphalt = strip(() => -hw, () => hw);
      // run-off bands by surface, per side, as runs
      ch.gravel = new Path2D(); ch.tarmac = new Path2D(); ch.verge = new Path2D();
      for (const side of [0, 1]) {
        const sg = side ? 1 : -1;
        let i = a;
        while (i < b) {
          const t = tr.runT[side][i % N];
          let j = i;
          while (j < b && tr.runT[side][j % N] === t) j++;
          const path = t === SURF.GRAVEL ? ch.gravel : t === SURF.TARMAC ? ch.tarmac : ch.verge;
          if (path !== ch.verge || style !== 'park') {
            path.addPath(strip(k => sg * (hw + 0.2), k => sg * (hw + tr.runW[side][k]), i, Math.min(b, j)));
          }
          i = j;
        }
      }
      // kerbs (alternating 2 m blocks)
      ch.kerbR = new Path2D(); ch.kerbW = new Path2D();
      for (const side of [0, 1]) {
        const sg = side ? 1 : -1, kb = side ? tr.kerbR : tr.kerbL;
        for (let i = a; i < b; i++) {
          if (!kb[i % N]) continue;
          const p1 = P(i, sg * (hw - 0.05)), p2 = P(i + 1, sg * (hw - 0.05)), p3 = P(i + 1, sg * (hw + tr.kerbW)), p4 = P(i, sg * (hw + tr.kerbW));
          const path = (i % 2) ? ch.kerbR : ch.kerbW;
          path.moveTo(p1[0], p1[1]); path.lineTo(p2[0], p2[1]); path.lineTo(p3[0], p3[1]); path.lineTo(p4[0], p4[1]); path.closePath();
        }
      }
      // white edge lines
      ch.lines = new Path2D();
      ch.lines.addPath(strip(() => -hw + 0.05, () => -hw + 0.32));
      ch.lines.addPath(strip(() => hw - 0.32, () => hw - 0.05));
      // rubbered-in racing line
      if (tr.line) ch.rubber = strip(k => tr.line.off[k] - 1.15, k => tr.line.off[k] + 1.15);
      // barriers
      ch.wall = new Path2D(); ch.tyres = new Path2D();
      for (const side of [0, 1]) {
        const sg = side ? 1 : -1;
        let first = true;
        for (let i = a; i <= b; i++) {
          const q = P(i, sg * (tr.barr[side][i % N] + 0.45));
          if (first) { ch.wall.moveTo(q[0], q[1]); first = false; } else ch.wall.lineTo(q[0], q[1]);
        }
        // tyre walls where there is a gravel trap
        let on = false;
        for (let i = a; i <= b; i++) {
          const g = tr.runT[side][i % N] === SURF.GRAVEL;
          const q = P(i, sg * (tr.barr[side][i % N] - 0.6));
          if (g && !on) { ch.tyres.moveTo(q[0], q[1]); on = true; } else if (g) ch.tyres.lineTo(q[0], q[1]); else on = false;
        }
      }
      // pit lane
      ch.pit = new Path2D(); ch.pitLines = new Path2D(); ch.pitWall = new Path2D();
      let pitAny = false;
      {
        let i = a;
        while (i < b) {
          if (isNaN(tr.pit.off[i % N])) { i++; continue; }
          let j = i;
          while (j < b && !isNaN(tr.pit.off[(j + 1) % N])) j++;
          if (j > i) {
            const L2 = tr.pit.lane / 2;
            ch.pit.addPath(strip(k => tr.pit.off[k] - L2, k => tr.pit.off[k] + L2, i, j));
            ch.pitLines.addPath(strip(k => tr.pit.off[k] - L2 + 0.05, k => tr.pit.off[k] - L2 + 0.3, i, j));
            ch.pitLines.addPath(strip(k => tr.pit.off[k] + L2 - 0.3, k => tr.pit.off[k] + L2 - 0.05, i, j));
            pitAny = true;
          }
          i = j + 1;
        }
        let first = true;
        for (let k = a; k <= b; k++) {
          const pw = tr.pit.wall[k % N];
          if (isNaN(pw)) { first = true; continue; }
          const q = P(k, tr.pit.side * (pw + 0.3));
          if (first) { ch.pitWall.moveTo(q[0], q[1]); first = false; } else ch.pitWall.lineTo(q[0], q[1]);
        }
      }
      ch.hasPit = pitAny;
      W.chunks.push(ch);
    }

    // start line, grid boxes, DRS lines, braking boards
    W.marks = new Path2D(); W.checker = [];
    {
      const hw = tr.hw;
      // start / finish: chequered band
      for (let r = 0; r < 2; r++) for (let k = 0; k < Math.ceil(tr.w / 0.8); k++) {
        if ((k + r) % 2) continue;
        const d0 = -hw + k * 0.8, d1 = Math.min(hw, d0 + 0.8);
        const s0 = r * 0.8 - 0.8;
        const q1 = Tracks.pointAt(tr, s0, d0), q2 = Tracks.pointAt(tr, s0 + 0.8, d0), q3 = Tracks.pointAt(tr, s0 + 0.8, d1), q4 = Tracks.pointAt(tr, s0, d1);
        W.checker.push([q1, q2, q3, q4]);
      }
      // grid boxes: an open-backed bracket per slot
      for (let k = 0; k < 20; k++) {
        const g = tr.grid[k];
        const a1 = Tracks.pointAt(tr, g.s + 2.9, g.d - 1.15), a2 = Tracks.pointAt(tr, g.s + 2.9, g.d + 1.15);
        const b1 = Tracks.pointAt(tr, g.s + 1.9, g.d - 1.15), b2 = Tracks.pointAt(tr, g.s + 1.9, g.d + 1.15);
        W.marks.moveTo(b1[0], b1[1]); W.marks.lineTo(a1[0], a1[1]); W.marks.lineTo(a2[0], a2[1]); W.marks.lineTo(b2[0], b2[1]);
      }
      W.drsLines = new Path2D();
      for (const z of tr.drs) {
        for (const s of [z.act, z.det]) {
          for (let k = 0; k < 8; k++) {
            const d0 = -hw + (k + 0.25) * tr.w / 8, d1 = d0 + tr.w / 16;
            const q1 = Tracks.pointAt(tr, s, d0), q2 = Tracks.pointAt(tr, s, d1);
            W.drsLines.moveTo(q1[0], q1[1]); W.drsLines.lineTo(q2[0], q2[1]);
          }
        }
      }
      // braking boards (3 / 2 / 1 stripes at 150 / 100 / 50 m before the braking point)
      W.boards = [];
      for (const z of tr.brakeZones) {
        if (z.vIn - z.vOut < 18) continue;
        const i0 = Math.floor(z.s0 / tr.ds) % tr.N;
        let k = 0;
        for (let q = 0; q < 60; q++) k += tr.kap[(i0 + q) % tr.N];
        const side = k > 0 ? -1 : 1; // outside of the corner
        [150, 100, 50].forEach((m, n) => {
          const s = (z.s0 - m + 40 + tr.L) % tr.L;
          const i = Math.floor(s / tr.ds) % tr.N;
          const d = side * (tr.hw + tr.kerbW + 2.2);
          const [x, y, h] = Tracks.pointAt(tr, s, d);
          W.boards.push({ x, y, h, n: 3 - n });
          void i;
        });
      }
    }

    buildScenery(W);
    // minimap
    W.mini = buildMini(tr);
    return W;
  }

  // ---------- scenery ----------
  function clearance(tr, x, y, extra, W) {
    // true if the point is clear of the circuit (beyond barriers + extra) and of buildings
    let ok = true;
    if (W && W.solid) for (const b of W.solid) if ((x - b.x) ** 2 + (y - b.y) ** 2 < b.r * b.r) return false;
    tr.hash.near(x, y, 80, i => {
      if (!ok) return;
      const dx = x - tr.x[i], dy = y - tr.y[i];
      const along = dx * tr.tx[i] + dy * tr.ty[i];
      if (Math.abs(along) > tr.ds * 2.5) return;
      const d = dx * tr.nx[i] + dy * tr.ny[i];
      const side = d > 0 ? 1 : 0;
      let lim = tr.barr[side][i] + extra;
      const po = tr.pit.off[i];
      if (!isNaN(po) && Math.sign(po) === Math.sign(d)) lim = Math.max(lim, Math.abs(po) + tr.pit.lane / 2 + 26 + extra);
      if (Math.abs(d) < lim) ok = false;
    });
    return ok;
  }

  function addDecor(W, item) {
    W.decor.push(item);
    const r = item.r || Math.hypot(item.w || 0, item.h || 0);
    const c0 = Math.floor((item.x - r) / 200), c1 = Math.floor((item.x + r) / 200);
    const r0 = Math.floor((item.y - r) / 200), r1 = Math.floor((item.y + r) / 200);
    for (let cx = c0; cx <= c1; cx++) for (let cy = r0; cy <= r1; cy++) {
      const k = cx + ',' + cy;
      let a = W.buckets.get(k); if (!a) W.buckets.set(k, a = []);
      a.push(item);
    }
  }

  function buildScenery(W) {
    const tr = W.tr, th = W.theme, rnd = U.rng(tr.def.seed || 1);
    let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
    for (let i = 0; i < tr.N; i++) { mnx = Math.min(mnx, tr.x[i]); mny = Math.min(mny, tr.y[i]); mxx = Math.max(mxx, tr.x[i]); mxy = Math.max(mxy, tr.y[i]); }
    const pad = 260;
    W.bounds = { x0: mnx - pad, y0: mny - pad, x1: mxx + pad, y1: mxy + pad };

    W.solid = [];
    // harbour for the street circuit: water north of the main straight
    if (th.city) {
      W.water = { y: Math.min(...Array.from(tr.y)) - 34 };
    }
    // garages and pit building behind the pit lane
    {
      const pit = tr.pit;
      for (let b = 0; b < 10; b++) {
        const s = pit.boxS[b];
        const i = Math.floor(s / tr.ds) % tr.N;
        if (isNaN(pit.off[i])) continue;
        const off = pit.off[i] + pit.side * (pit.lane / 2 + 5.5);
        const [x, y, h] = Tracks.pointAt(tr, s, off);
        const team = F1.Data.TEAMS[b];
        addDecor(W, { type: 'garage', x, y, h, w: 14, d: 9, team, r: 10 });
        const [bx, by] = Tracks.pointAt(tr, s, pit.off[i] + pit.side * 2.6);
        addDecor(W, { type: 'box', x: bx, y: by, h, team, r: 4 });
      }
      // pit building roof spanning the garages
      const s0 = pit.boxS[9] - 12, s1 = pit.boxS[0] + 12;
      const pts = [];
      for (let s = s0; s <= s1; s += 6) {
        const i = Math.floor(((s % tr.L) + tr.L) % tr.L / tr.ds) % tr.N;
        if (isNaN(pit.off[i])) continue;
        const o = pit.off[i] + pit.side * (pit.lane / 2 + 10);
        pts.push(Tracks.pointAt(tr, s, o).slice(0, 2), Tracks.pointAt(tr, s, o + pit.side * 16).slice(0, 2));
      }
      if (pts.length > 4) {
        const left = pts.filter((_, k) => k % 2 === 0), right = pts.filter((_, k) => k % 2 === 1);
        const poly = left.concat(right.reverse());
        let cx = 0, cy = 0; for (const p of poly) { cx += p[0]; cy += p[1]; }
        addDecor(W, { type: 'poly', pts: poly, x: cx / poly.length, y: cy / poly.length, r: 160, fill: '#c9cdd2', edge: '#9aa0a8', roof: true, seed: 5 });
        for (const q of poly) W.solid.push({ x: q[0], y: q[1], r: 20 });
      }
    }
    // grandstands: along the main straight (opposite the pits) and at the slow corners
    const stands = [{ s: tr.L - 120, len: 180, side: -tr.pit.side }];
    for (const z of tr.brakeZones) if (z.vOut < 30) {
      let k = 0;
      const i0 = Math.floor(z.s1 / tr.ds);
      for (let q = -10; q < 20; q++) k += tr.kap[(i0 + q + tr.N) % tr.N];
      stands.push({ s: z.s1 - 30, len: 90, side: k > 0 ? -1 : 1 });
    }
    for (const st of stands.slice(0, 6)) {
      for (let s = st.s - st.len / 2; s < st.s + st.len / 2; s += 30) {
        const i = Math.floor(((s % tr.L) + tr.L) % tr.L / tr.ds) % tr.N;
        const side = st.side > 0 ? 1 : 0;
        const off = st.side * (tr.barr[side][i] + 9);
        const [x, y, h] = Tracks.pointAt(tr, s, off);
        if (!clearance(tr, x, y, 4)) continue;
        addDecor(W, { type: 'stand', x, y, h, w: 28, d: 12, side: st.side, seed: Math.floor(rnd() * 1e6), r: 18 });
        W.solid.push({ x, y, r: 22 });
      }
    }
    // trees / palms / city blocks
    const area = (W.bounds.x1 - W.bounds.x0) * (W.bounds.y1 - W.bounds.y0);
    if (th.city) {
      const cell = 34;
      for (let gx = W.bounds.x0; gx < W.bounds.x1; gx += cell) for (let gy = W.bounds.y0; gy < W.bounds.y1; gy += cell) {
        if (W.water && gy < W.water.y) continue;
        if (rnd() < 0.12) continue;
        const w = cell - 6 - rnd() * 6, h = cell - 6 - rnd() * 6;
        const x = gx + cell / 2, y = gy + cell / 2;
        if (!clearance(tr, x, y, 14, W)) continue;
        const roofs = ['#c9a27a', '#b9805a', '#d8cfc2', '#a7a39b', '#c4b59f', '#9c6b4e', '#e3ddd2'];
        addDecor(W, { type: 'building', x, y, w, h, h0: 0, col: roofs[Math.floor(rnd() * roofs.length)], seed: Math.floor(rnd() * 1e6), r: 30 });
      }
      // marina boats
      if (W.water) for (let k = 0; k < 70; k++) {
        const x = W.bounds.x0 + rnd() * (W.bounds.x1 - W.bounds.x0), y = W.water.y - 25 - rnd() * 180;
        addDecor(W, { type: 'boat', x, y, h: rnd() < 0.5 ? 0 : Math.PI, l: 10 + rnd() * 22, r: 20, col: rnd() < 0.7 ? '#f4f5f2' : '#e8e1cf' });
      }
      for (let k = 0; k < area / 3000; k++) {
        const x = W.bounds.x0 + rnd() * (W.bounds.x1 - W.bounds.x0), y = W.bounds.y0 + rnd() * (W.bounds.y1 - W.bounds.y0);
        if (W.water && y < W.water.y + 4) continue;
        if (!clearance(tr, x, y, 3, W)) continue;
        // only along the street edges: keep trees out of building blocks
        let nearRoad = false;
        tr.hash.near(x, y, 30, () => { nearRoad = true; });
        if (!nearRoad) continue;
        addDecor(W, { type: 'tree', x, y, r: 3 + rnd() * 2.5, c: th.tree[Math.floor(rnd() * th.tree.length)] });
      }
    } else {
      const n = Math.floor(area / (th.palms ? 1800 : 520));
      for (let k = 0; k < n; k++) {
        // clumps
        const cx = W.bounds.x0 + rnd() * (W.bounds.x1 - W.bounds.x0), cy = W.bounds.y0 + rnd() * (W.bounds.y1 - W.bounds.y0);
        const m = th.palms ? 1 : 1 + Math.floor(rnd() * 6);
        for (let q = 0; q < m; q++) {
          const x = cx + (rnd() - 0.5) * 26, y = cy + (rnd() - 0.5) * 26;
          if (!clearance(tr, x, y, 8, W)) continue;
          addDecor(W, th.palms ? { type: 'palm', x, y, r: 4 + rnd() * 2, a: rnd() * 6 } : { type: 'tree', x, y, r: 3.5 + rnd() * 4, c: th.tree[Math.floor(rnd() * th.tree.length)] });
        }
      }
      // a treeline round the edge of the venue, a few rows deep, so the ground plane never
      // runs out flat to the horizon behind the last trackside clumps
      if (!th.palms) {
        const B = W.bounds, per = [[B.x0, B.y0, B.x1, B.y0], [B.x1, B.y0, B.x1, B.y1], [B.x1, B.y1, B.x0, B.y1], [B.x0, B.y1, B.x0, B.y0]];
        for (const [ax, ay, bx, by] of per) {
          const L = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / L, uy = (by - ay) / L, ix = -uy, iy = ux; // inward normal (bounds wind clockwise on screen)
          // (rows 4 to 6 stand well outside, so even an elevated view sees woods at the horizon)
          for (let s = 0; s < L; s += 5 + rnd() * 4) for (let row = 0; row < 7; row++) {
            if (rnd() < (row < 4 ? 0.25 : 0.45)) continue;
            const o = row < 4 ? row * 9 + rnd() * 8 - 20 : -150 - (row - 4) * 14 - rnd() * 10, x = ax + ux * s + ix * o, y = ay + uy * s + iy * o;
            if (W.water && y < W.water.y + 4) continue;
            if (!clearance(tr, x, y, 8, W)) continue;
            addDecor(W, { type: 'tree', x, y, r: 3.5 + rnd() * 4, c: th.tree[Math.floor(rnd() * th.tree.length)], deep: row > 0 });
          }
        }
      }
      // conifer venues sit in forest, like Spa or the Nurburgring: a closed wall of trees a
      // few tens of metres behind the barriers, broken by clearings, instead of scattered clumps
      if (Tracks.treesOf(tr) === 'fir' && Tracks.lookOf(tr) !== 'sierra') {
        const taken = new Set(), cell = 6.5;
        const vn = (x, y) => { // smooth value noise, 0..1
          const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
          const h = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
          const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
          return (h(ix, iy) * (1 - sx) + h(ix + 1, iy) * sx) * (1 - sy) + (h(ix, iy + 1) * (1 - sx) + h(ix + 1, iy + 1) * sx) * sy;
        };
        for (let i = 0; i < tr.N; i += Math.max(1, Math.round(6 / tr.ds))) for (let side = 0; side < 2; side++) {
          const sg = side ? 1 : -1, b0 = tr.barr[side][i];
          for (let o = 0; o < 85; o += 8 + rnd() * 3.5) {
            const x0 = tr.x[i] + tr.nx[i] * sg * (b0 + 12 + o), y0 = tr.y[i] + tr.ny[i] * sg * (b0 + 12 + o);
            const x = x0 + (rnd() - 0.5) * 5, y = y0 + (rnd() - 0.5) * 5;
            // clearings and a ragged forest edge: the wall starts 12 to 40 m back
            const n = vn(x / 140, y / 140) * 0.7 + vn(x / 40, y / 40) * 0.3;
            if (n < 0.33 || o < (1 - n) * 28) continue;
            const k = Math.floor(x / cell) + ',' + Math.floor(y / cell);
            if (taken.has(k)) continue;
            if (!clearance(tr, x, y, 12, W)) continue;
            taken.add(k);
            addDecor(W, { type: 'tree', x, y, r: 2.4 + Math.pow(rnd(), 0.8) * 6, c: th.tree[Math.floor(rnd() * th.tree.length)], deep: o > 30 });
          }
        }
      }
      // car parks / service roads for the modern venue
      if (th.palms) {
        for (let k = 0; k < 14; k++) {
          const x = W.bounds.x0 + rnd() * (W.bounds.x1 - W.bounds.x0), y = W.bounds.y0 + rnd() * (W.bounds.y1 - W.bounds.y0);
          if (!clearance(tr, x, y, 50, W)) continue;
          addDecor(W, { type: 'lot', x, y, w: 60 + rnd() * 50, h: 40 + rnd() * 30, seed: Math.floor(rnd() * 1e6), r: 70 });
        }
      }
    }
  }

  function buildMini(tr) {
    let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
    for (let i = 0; i < tr.N; i++) { mnx = Math.min(mnx, tr.x[i]); mny = Math.min(mny, tr.y[i]); mxx = Math.max(mxx, tr.x[i]); mxy = Math.max(mxy, tr.y[i]); }
    return { mnx, mny, mxx, mxy };
  }

  // ---------- drawing ----------
  function patFill(ctx, P, key, scale) {
    const p = P[key];
    const k = p.m / 256 * (key === 'grass' ? 0.5 : 1);
    if (p.pat.setTransform) p.pat.setTransform(new DOMMatrix([k, 0, 0, k, 0, 0]));
    ctx.fillStyle = p.pat;
  }

  function drawTree(ctx, it) {
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath(); ctx.arc(it.x + it.r * 0.35, it.y + it.r * 0.5, it.r, 0, 6.283); ctx.fill();
    ctx.fillStyle = it.c;
    ctx.beginPath(); ctx.arc(it.x, it.y, it.r, 0, 6.283); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.beginPath(); ctx.arc(it.x - it.r * 0.25, it.y - it.r * 0.25, it.r * 0.55, 0, 6.283); ctx.fill();
  }

  function drawPalm(ctx, it) {
    ctx.save(); ctx.translate(it.x, it.y);
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath(); ctx.arc(it.r * 0.4, it.r * 0.5, it.r * 0.8, 0, 6.283); ctx.fill();
    ctx.strokeStyle = '#4f7a2c'; ctx.lineWidth = 0.9; ctx.lineCap = 'round';
    for (let k = 0; k < 7; k++) {
      const a = it.a + k * 0.9;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(Math.cos(a + 0.3) * it.r * 0.6, Math.sin(a + 0.3) * it.r * 0.6, Math.cos(a) * it.r, Math.sin(a) * it.r); ctx.stroke();
    }
    ctx.fillStyle = '#6b5a3a'; ctx.beginPath(); ctx.arc(0, 0, 0.6, 0, 6.283); ctx.fill();
    ctx.restore();
  }

  function rectAt(ctx, it, w, d) {
    ctx.translate(it.x, it.y); ctx.rotate(it.h || 0);
    ctx.fillRect(-w / 2, -d / 2, w, d);
  }

  function drawStand(ctx, it) {
    ctx.save(); ctx.translate(it.x, it.y); ctx.rotate(it.h);
    const w = it.w, d = it.d;
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(-w / 2 + 1, -d / 2 + 1.5, w, d);
    ctx.fillStyle = '#7d828a'; ctx.fillRect(-w / 2, -d / 2, w, d);
    // seat rows with crowd
    const rnd = U.rng(it.seed);
    const cols = ['#e64545', '#2f6fd6', '#f2c230', '#f4f4f4', '#222', '#2c9c62', '#e07a1f', '#b84ad6'];
    const rows = 7;
    for (let r = 0; r < rows; r++) {
      const y = -d / 2 + 1 + r * (d - 2) / rows;
      ctx.fillStyle = '#5c6169'; ctx.fillRect(-w / 2 + 0.6, y, w - 1.2, 0.4);
      for (let x = -w / 2 + 0.9; x < w / 2 - 0.9; x += 0.75) {
        if (rnd() < 0.18) continue;
        ctx.fillStyle = cols[Math.floor(rnd() * cols.length)];
        ctx.fillRect(x, y + 0.45, 0.5, 0.55);
      }
    }
    // roof edge on the far side
    ctx.fillStyle = '#e8eaed';
    ctx.fillRect(-w / 2, (it.side > 0 ? d / 2 - 1.2 : -d / 2), w, 1.2);
    ctx.restore();
  }

  function drawBuilding(ctx, it) {
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(it.x - it.w / 2 + 2.5, it.y - it.h / 2 + 3.5, it.w, it.h);
    ctx.fillStyle = it.col;
    ctx.fillRect(it.x - it.w / 2, it.y - it.h / 2, it.w, it.h);
    ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 0.5;
    ctx.strokeRect(it.x - it.w / 2 + 0.8, it.y - it.h / 2 + 0.8, it.w - 1.6, it.h - 1.6);
    const rnd = U.rng(it.seed);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (let k = 0; k < 3; k++) ctx.fillRect(it.x - it.w / 2 + 2 + rnd() * (it.w - 6), it.y - it.h / 2 + 2 + rnd() * (it.h - 6), 2 + rnd() * 2, 1.5 + rnd() * 1.5);
  }

  function drawBoat(ctx, it) {
    ctx.save(); ctx.translate(it.x, it.y); ctx.rotate(it.h);
    const l = it.l, w = l * 0.32;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.moveTo(-l / 2 + 1, -w / 2 + 1); ctx.lineTo(l / 2 - l * 0.25 + 1, -w / 2 + 1); ctx.lineTo(l / 2 + 1, 1); ctx.lineTo(l / 2 - l * 0.25 + 1, w / 2 + 1); ctx.lineTo(-l / 2 + 1, w / 2 + 1); ctx.closePath(); ctx.fill();
    ctx.fillStyle = it.col;
    ctx.beginPath(); ctx.moveTo(-l / 2, -w / 2); ctx.lineTo(l / 2 - l * 0.25, -w / 2); ctx.lineTo(l / 2, 0); ctx.lineTo(l / 2 - l * 0.25, w / 2); ctx.lineTo(-l / 2, w / 2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#c9ced4'; ctx.fillRect(-l * 0.2, -w * 0.3, l * 0.35, w * 0.6);
    ctx.fillStyle = '#2b4a5c'; ctx.fillRect(l * 0.05, -w * 0.22, l * 0.08, w * 0.44);
    ctx.restore();
  }

  function drawGarage(ctx, it) {
    ctx.save(); ctx.translate(it.x, it.y); ctx.rotate(it.h);
    ctx.fillStyle = '#c3c7cd'; ctx.fillRect(-it.w / 2, -it.d / 2, it.w, it.d);
    ctx.fillStyle = it.team.base; ctx.fillRect(-it.w / 2 + 0.5, -it.d / 2 + 0.5, it.w - 1, it.d - 1);
    ctx.fillStyle = it.team.accent; ctx.fillRect(-it.w / 2 + 0.5, -0.4, it.w - 1, 0.8);
    ctx.restore();
  }

  function drawBox(ctx, it) {
    ctx.save(); ctx.translate(it.x, it.y); ctx.rotate(it.h);
    ctx.strokeStyle = it.team.base === '#121417' ? '#d8b45a' : it.team.base; ctx.lineWidth = 0.25;
    ctx.strokeRect(-3.2, -1.4, 6.4, 2.8);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(-1.75, -1.0, 0.18, 2.0); ctx.fillRect(1.55, -1.0, 0.18, 2.0);
    ctx.restore();
  }

  function drawLot(ctx, it) {
    ctx.fillStyle = '#6f6f6c'; ctx.fillRect(it.x - it.w / 2, it.y - it.h / 2, it.w, it.h);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 0.15;
    const rnd = U.rng(it.seed);
    const cols = ['#e6e6e6', '#202020', '#9aa3ad', '#b33', '#2a4d8f', '#d9c27a'];
    for (let x = it.x - it.w / 2 + 2; x < it.x + it.w / 2 - 3; x += 2.8) {
      for (const yy of [it.y - it.h / 2 + 2, it.y + it.h / 2 - 7]) {
        ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x, yy + 5); ctx.stroke();
        if (rnd() < 0.65) { ctx.fillStyle = cols[Math.floor(rnd() * cols.length)]; ctx.fillRect(x + 0.45, yy + 0.4, 1.9, 4.2); }
      }
    }
  }

  function drawPoly(ctx, it) {
    ctx.save();
    ctx.translate(2.5, 3.5);
    ctx.beginPath();
    it.pts.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fill();
    ctx.restore();
    ctx.beginPath();
    it.pts.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.fillStyle = it.fill; ctx.fill();
    ctx.strokeStyle = it.edge; ctx.lineWidth = 0.8; ctx.stroke();
    if (it.roof) {
      // roof panel seams and plant units along the building
      const n = it.pts.length / 2;
      ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 0.25;
      for (let k = 0; k < n; k++) {
        const a = it.pts[k], b = it.pts[it.pts.length - 1 - k];
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
      const rnd = U.rng(it.seed);
      for (let k = 1; k < n - 1; k += 2) {
        const a = it.pts[k], b = it.pts[it.pts.length - 1 - k];
        const t = 0.3 + rnd() * 0.4;
        const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
        ctx.fillStyle = '#a9afb7'; ctx.fillRect(x - 1.6, y - 1.6, 3.2, 3.2);
        ctx.fillStyle = '#8c939c'; ctx.fillRect(x - 0.9, y - 0.9, 1.8, 1.8);
      }
      // a band of glazing on the pit-lane side
      ctx.strokeStyle = '#5d7d96'; ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let k = 0; k < n; k++) { const a = it.pts[k]; k ? ctx.lineTo(a[0], a[1]) : ctx.moveTo(a[0], a[1]); }
      ctx.stroke();
    }
  }

  function drawDecor(ctx, it) {
    switch (it.type) {
      case 'tree': drawTree(ctx, it); break;
      case 'palm': drawPalm(ctx, it); break;
      case 'stand': drawStand(ctx, it); break;
      case 'building': drawBuilding(ctx, it); break;
      case 'boat': drawBoat(ctx, it); break;
      case 'garage': drawGarage(ctx, it); break;
      case 'box': drawBox(ctx, it); break;
      case 'lot': drawLot(ctx, it); break;
      case 'poly': drawPoly(ctx, it); break;
    }
  }

  // view: {x0,y0,x1,y1} world AABB
  function drawWorld(ctx, W, view, opts) {
    const tr = W.tr, th = W.theme, P = W.pats;
    // background
    patFill(ctx, P, th.bg === 'grass' ? 'grass' : 'ground');
    ctx.fillRect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0);
    if (W.water && view.y0 < W.water.y) {
      patFill(ctx, P, 'water');
      ctx.fillRect(view.x0, view.y0, view.x1 - view.x0, W.water.y - view.y0);
      ctx.fillStyle = '#c9c3b5';
      ctx.fillRect(view.x0, W.water.y - 2, view.x1 - view.x0, 2);
    }
    // decor that sits on the ground (lots, buildings under trees)
    const items = [];
    const seen = new Set();
    for (let cx = Math.floor(view.x0 / 200); cx <= Math.floor(view.x1 / 200); cx++) {
      for (let cy = Math.floor(view.y0 / 200); cy <= Math.floor(view.y1 / 200); cy++) {
        const a = W.buckets.get(cx + ',' + cy);
        if (a) for (const it of a) if (!seen.has(it)) { seen.add(it); items.push(it); }
      }
    }
    for (const it of items) if (it.type === 'lot' || it.type === 'boat') drawDecor(ctx, it);

    const vis = [];
    for (const ch of W.chunks) {
      if (ch.maxx < view.x0 || ch.minx > view.x1 || ch.maxy < view.y0 || ch.miny > view.y1) continue;
      vis.push(ch);
    }
    // grass verges for non-park venues
    if (th.bg !== 'grass') {
      patFill(ctx, P, 'grass');
      for (const ch of vis) ctx.fill(ch.verge);
    }
    patFill(ctx, P, 'gravel');
    for (const ch of vis) ctx.fill(ch.gravel);
    patFill(ctx, P, 'runoff');
    for (const ch of vis) ctx.fill(ch.tarmac);
    // painted run-off stripes for the modern circuit
    patFill(ctx, P, 'asphalt');
    for (const ch of vis) { ctx.fill(ch.asphalt); if (ch.hasPit) ctx.fill(ch.pit); }
    if (opts.rubber !== false) {
      ctx.fillStyle = 'rgba(15,15,18,0.22)';
      for (const ch of vis) if (ch.rubber) ctx.fill(ch.rubber);
    }
    ctx.fillStyle = '#eceff1';
    for (const ch of vis) { ctx.fill(ch.lines); if (ch.hasPit) ctx.fill(ch.pitLines); }
    ctx.fillStyle = '#d32424';
    for (const ch of vis) ctx.fill(ch.kerbR);
    ctx.fillStyle = '#f1f1f1';
    for (const ch of vis) ctx.fill(ch.kerbW);
    // start line + grid
    ctx.fillStyle = '#f5f5f5';
    for (const q of W.checker) { ctx.beginPath(); ctx.moveTo(q[0][0], q[0][1]); ctx.lineTo(q[1][0], q[1][1]); ctx.lineTo(q[2][0], q[2][1]); ctx.lineTo(q[3][0], q[3][1]); ctx.closePath(); ctx.fill(); }
    ctx.strokeStyle = 'rgba(245,245,245,0.9)'; ctx.lineWidth = 0.22; ctx.lineCap = 'butt';
    ctx.stroke(W.marks);
    ctx.strokeStyle = 'rgba(245,245,245,0.75)'; ctx.lineWidth = 0.3;
    ctx.stroke(W.drsLines);
  }

  function drawBarriers(ctx, W, view) {
    const th = W.theme;
    ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
    for (const ch of W.chunks) {
      if (ch.maxx < view.x0 || ch.minx > view.x1 || ch.maxy < view.y0 || ch.miny > view.y1) continue;
      ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = th.city ? 2.2 : 1.6; ctx.stroke(ch.wall);
      ctx.strokeStyle = th.city ? '#d9dbde' : '#b9bcc0'; ctx.lineWidth = th.city ? 1.3 : 0.9; ctx.stroke(ch.wall);
      if (th.city) {
        // armco rail on top of the concrete, with sponsor-red debris fencing posts
        ctx.strokeStyle = '#8f959c'; ctx.lineWidth = 0.35; ctx.stroke(ch.wall);
        ctx.setLineDash([0.4, 5]); ctx.strokeStyle = '#c8242a'; ctx.lineWidth = 1.3; ctx.stroke(ch.wall); ctx.setLineDash([]);
      }
      ctx.strokeStyle = '#1b1c1f'; ctx.lineWidth = 1.3; ctx.stroke(ch.tyres);
      ctx.setLineDash([1.3, 1.3]);
      ctx.strokeStyle = '#d23a2a'; ctx.lineWidth = 0.5; ctx.stroke(ch.tyres);
      ctx.setLineDash([]);
      if (ch.hasPit) { ctx.strokeStyle = '#d6d8db'; ctx.lineWidth = 0.9; ctx.stroke(ch.pitWall); }
    }
    // braking boards
    for (const b of W.boards) {
      if (b.x < view.x0 || b.x > view.x1 || b.y < view.y0 || b.y > view.y1) continue;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.h);
      ctx.fillStyle = '#f7f7f7'; ctx.fillRect(-0.9, -1.1, 1.8, 2.2);
      ctx.fillStyle = '#111';
      for (let k = 0; k < b.n; k++) ctx.fillRect(-0.7 + k * 0.5, -0.9, 0.24, 1.8);
      ctx.restore();
    }
  }

  function drawUpperDecor(ctx, W, view) {
    const items = [];
    const seen = new Set();
    for (let cx = Math.floor(view.x0 / 200); cx <= Math.floor(view.x1 / 200); cx++) {
      for (let cy = Math.floor(view.y0 / 200); cy <= Math.floor(view.y1 / 200); cy++) {
        const a = W.buckets.get(cx + ',' + cy);
        if (a) for (const it of a) if (!seen.has(it)) { seen.add(it); items.push(it); }
      }
    }
    for (const it of items) if (it.type !== 'lot' && it.type !== 'boat') drawDecor(ctx, it);
  }

  // --- cars ---
  function drawCarShadow(ctx, car) {
    const spr = Sprites.carSprite(car.team);
    ctx.save();
    ctx.translate(car.x + 0.45, car.y + 0.65); ctx.rotate(car.h);
    ctx.globalAlpha = 0.42 * (car.ghostT > 0 && car.ghostT < 1000 ? 0.4 : 1);
    ctx.drawImage(spr.shadow, -spr.ox, -spr.oy, spr.img.width / spr.px, spr.img.height / spr.px);
    ctx.restore();
  }

  function drawCar(ctx, car, alpha) {
    const spr = Sprites.carSprite(car.team);
    ctx.save();
    ctx.translate(car.x, car.y); ctx.rotate(car.h);
    if (alpha < 1) ctx.globalAlpha = alpha;
    // steering front wheels
    for (const sd of [-0.8, 0.8]) {
      ctx.save(); ctx.translate(1.95, sd); ctx.rotate(car.steer);
      Sprites.wheelPath(ctx, 0, 0, 0.68, 0.34);
      ctx.restore();
    }
    ctx.drawImage(spr.img, -spr.ox, -spr.oy, spr.img.width / spr.px, spr.img.height / spr.px);
    // DRS flap open: a gap in the rear wing
    if (car.drsOpen) { ctx.fillStyle = '#0d0e10'; ctx.fillRect(-2.46, -0.48, 0.07, 0.96); }
    // rain light: blinks in the pit lane limiter / when harvesting at low throttle
    const blink = car.limiter ? (Math.floor(performance.now() / 120) % 2) : 0;
    ctx.fillStyle = blink ? '#ff3030' : '#4a1010';
    ctx.fillRect(-2.7, -0.07, 0.1, 0.14);
    // damaged front wing: missing endplate
    if (car.wingDmg > 0.35) { ctx.fillStyle = '#2a2a2a'; ctx.fillRect(2.62, car.id % 2 ? -0.98 : 0.5, 0.36, 0.48); }
    ctx.restore();
  }

  function drawGhost(ctx, ghost, t) {
    if (!ghost) return;
    const k = Math.floor(t * 20);
    const n = ghost.pts.length / 3;
    if (k >= n - 1) return;
    const f = t * 20 - k;
    const a = ghost.pts, i = k * 3, j = (k + 1) * 3;
    const x = a[i] + (a[j] - a[i]) * f, y = a[i + 1] + (a[j + 1] - a[i + 1]) * f;
    const h = a[i + 2] + U.wrapAngle(a[j + 2] - a[i + 2]) * f;
    ctx.save(); ctx.translate(x, y); ctx.rotate(h); ctx.globalAlpha = 0.38;
    ctx.fillStyle = '#9fd3ff';
    ctx.fillRect(-2.6, -0.95, 5.5, 1.9);
    ctx.globalAlpha = 0.7; ctx.strokeStyle = '#d8eeff'; ctx.lineWidth = 0.12; ctx.strokeRect(-2.6, -0.95, 5.5, 1.9);
    ctx.restore();
  }

  // --- racing line assist ---
  function drawAssistLine(ctx, tr, car, mode, prof, marks) {
    prof = prof || tr.prof;
    if (mode === 'off') return;
    const i0 = car.loc.i;
    const v = car.speed;
    const n = Math.round(260 / tr.ds);
    ctx.lineWidth = 0.55; ctx.lineCap = 'round';
    let last = null;
    for (let k = 2; k < n; k++) {
      const i = (i0 + k) % tr.N, j = (i + 1) % tr.N;
      const brk = prof[(i + 1) % tr.N] < prof[i] - 0.05;
      const slower = prof[i] < v - 3; // must be slower than we are now by the time we get here
      let col;
      if (brk || slower) {
        // distance-aware: red if braking is needed right now
        const dist = k * tr.ds;
        const need = (v * v - prof[i] * prof[i]) / (2 * 38);
        col = need > dist - 25 ? 'rgba(255,58,48,0.85)' : 'rgba(255,196,0,0.75)';
      } else col = mode === 'brake' ? null : 'rgba(64,220,120,0.55)';
      if (!col) { last = null; continue; }
      if (col !== last) { if (last) ctx.stroke(); ctx.beginPath(); ctx.strokeStyle = col; ctx.moveTo(tr.x[i] + tr.nx[i] * tr.line.off[i], tr.y[i] + tr.ny[i] * tr.line.off[i]); last = col; }
      ctx.lineTo(tr.x[j] + tr.nx[j] * tr.line.off[j], tr.y[j] + tr.ny[j] * tr.line.off[j]);
    }
    if (last) ctx.stroke();
    // reference points: brake (red bar), turn-in (yellow), apex (blue), track-out (green)
    if (marks) {
      const ahead = i => ((i - i0) % tr.N + tr.N) % tr.N * tr.ds;
      const P = i => [tr.x[i] + tr.nx[i] * tr.line.off[i], tr.y[i] + tr.ny[i] * tr.line.off[i]];
      const dot = (i, col, r) => { const p = P(i); ctx.fillStyle = 'rgba(10,12,16,0.7)'; ctx.beginPath(); ctx.arc(p[0], p[1], r + 0.35, 0, 6.283); ctx.fill(); ctx.fillStyle = col; ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 6.283); ctx.fill(); };
      for (const m of marks) {
        const dA = ahead(m.apex);
        if (dA > 330 && ahead(m.exit) > 330) continue;
        if (m.brake >= 0 && ahead(m.brake) < 330) {
          const i = m.brake, p = P(i);
          ctx.save(); ctx.translate(p[0], p[1]); ctx.rotate(Math.atan2(tr.ty[i], tr.tx[i]));
          ctx.fillStyle = 'rgba(10,12,16,0.7)'; ctx.fillRect(-0.75, -2.75, 1.5, 5.5);
          ctx.fillStyle = '#ff3b30'; ctx.fillRect(-0.5, -2.5, 1.0, 5.0);
          ctx.restore();
        }
        if (mode !== 'full') continue;
        const far = i => Math.abs(i - m.apex) * tr.ds > 14; // a kink: only the apex matters
        if (ahead(m.turnIn) < 330 && far(m.turnIn)) dot(m.turnIn, '#ffcc1f', 1.05);
        if (dA < 330) dot(m.apex, '#3aa0ff', 1.2);
        if (ahead(m.exit) < 330 && far(m.exit)) dot(m.exit, '#2bd66b', 1.05);
      }
    }
  }

  // --- minimap ---
  function drawMini(ctx, W, race, size, dpr) {
    const tr = W.tr, m = W.mini;
    const w = m.mxx - m.mnx, h = m.mxy - m.mny;
    const k = (size - 24) / Math.max(w, h);
    const ox = (size - w * k) / 2 - m.mnx * k, oy = (size - h * k) / 2 - m.mny * k;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    if (!W.miniPath) {
      W.miniPath = new Path2D();
      for (let i = 0; i <= tr.N; i++) { const q = i % tr.N; i ? W.miniPath.lineTo(tr.x[q], tr.y[q]) : W.miniPath.moveTo(tr.x[q], tr.y[q]); }
    }
    ctx.save();
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 9 / k; ctx.stroke(W.miniPath);
    ctx.strokeStyle = 'rgba(235,238,242,0.92)'; ctx.lineWidth = 4 / k; ctx.stroke(W.miniPath);
    // sector tints
    ctx.restore();
    const S = (x, y) => [ox + x * k, oy + y * k];
    // start line
    {
      const [x, y] = S(tr.x[0], tr.y[0]);
      ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(tr.ty[0], tr.tx[0]));
      ctx.fillStyle = '#ff3b30'; ctx.fillRect(-1.5, -6, 3, 12); ctx.restore();
    }
    const cars = race.order.slice().reverse();
    for (const c of cars) {
      const [x, y] = S(c.x, c.y);
      const isP = c.isPlayer;
      ctx.fillStyle = isP ? '#ffffff' : c.team.base;
      ctx.strokeStyle = isP ? '#ff3b30' : (c.team.base === '#121417' || c.team.base === '#eef2f7' ? c.team.accent : 'rgba(0,0,0,0.6)');
      ctx.lineWidth = isP ? 2.5 : 1.4;
      ctx.beginPath(); ctx.arc(x, y, isP ? 5.2 : 3.6, 0, 6.283); ctx.fill(); ctx.stroke();
    }
  }

  F1.Render = { THEMES, build, drawWorld, drawBarriers, drawUpperDecor, drawCar, drawCarShadow, drawGhost, drawAssistLine, drawMini };
})(typeof window !== 'undefined' ? window : globalThis);
