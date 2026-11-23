// The loading screen's circuit: an F1 broadcast style 3D map. The track is drawn on as a ribbon over a
// dark ground grid, tilted and slowly turning, with its heights raised, and everything a viewer reads off
// a circuit graphic: corner numbers, the three sectors, overtake zones with their direction, the start
// line, the pit lane with its entry and exit, the highest and lowest points, the fastest and slowest
// places, and a data strip. It is plain 2D canvas with its own small projection, so it runs on any
// machine and costs a few hundred line strokes a frame.
(function (G) {
  'use strict';
  const F1 = G.F1;
  const SEC = ['#ff3b30', '#3aa0ff', '#ffcc1f'], DRS = '#2bd66b', PIT = '#aab3c2';
  const FONT = "'Titillium Web', 'Segoe UI', sans-serif";
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

  function prepare(tr) {
    const N = tr.N, step = Math.max(1, Math.round(N / 520)), M = Math.ceil(N / step);
    let mx = 0, my = 0, z0 = 1e9, z1 = -1e9;
    for (let i = 0; i < N; i++) { mx += tr.x[i]; my += tr.y[i]; z0 = Math.min(z0, tr.z ? tr.z[i] : 0); z1 = Math.max(z1, tr.z ? tr.z[i] : 0); }
    mx /= N; my /= N;
    let R = 1;
    for (let i = 0; i < N; i++) R = Math.max(R, Math.hypot(tr.x[i] - mx, tr.y[i] - my));
    // heights raised for the picture, up to a tenth of the circuit's size
    const dz = z1 - z0, ex = dz > 0.5 ? clamp(0.1 * R / dz, 1, 14) : 1;
    let cxx = 0, cyy = 0, cxy = 0;
    for (let i = 0; i < N; i++) { const a = tr.x[i] - mx, b = tr.y[i] - my; cxx += a * a; cyy += b * b; cxy += a * b; }
    const yaw0 = -0.5 * Math.atan2(2 * cxy, cxx - cyy);
    let aX = 1, bY = 1;
    for (let i = 0; i < N; i++) { const a = tr.x[i] - mx, b = tr.y[i] - my; aX = Math.max(aX, Math.abs(a * Math.cos(yaw0) - b * Math.sin(yaw0))); bY = Math.max(bY, Math.abs(a * Math.sin(yaw0) + b * Math.cos(yaw0))); }
    const P = { tr, N, step, M, mx, my, R, z0, z1, dz, ex, yaw0, aX, bY, idx: [], sec: [], drs: [], pit: [], corners: [], marks: [] };
    const s1 = tr.sectors ? tr.sectors[1] : tr.L / 3, s2 = tr.sectors ? tr.sectors[2] : 2 * tr.L / 3;
    const inDrs = s => (tr.drs || []).some(z => { const a = z.act, b = z.end; return b >= a ? s >= a && s <= b : s >= a || s <= b; });
    for (let k = 0; k <= M; k++) {
      const i = Math.min(N - 1, k * step) % N, s = i * tr.ds;
      P.idx.push(i); P.sec.push(s < s1 ? 0 : s < s2 ? 1 : 2); P.drs.push(inDrs(s));
    }
    // the pit lane: the stretch where it has its own offset
    if (tr.pit && tr.pit.off) {
      let run = [];
      for (let k = 0; k < M; k++) { const i = P.idx[k], o = tr.pit.off[i]; if (o != null && !isNaN(o)) run.push(k); }
      P.pit = run;
    }
    // corner badges, set outside each bend
    (tr.apexes || []).forEach((a, n) => P.corners.push({ n: n + 1, i: a.i, side: a.k > 0 ? -1 : 1 }));
    // the quickest and slowest places the speed plan has
    if (tr.prof) {
      let hi = 0, lo = 0;
      for (let i = 0; i < N; i++) { if (tr.prof[i] > tr.prof[hi]) hi = i; }
      let lowV = 1e9;
      for (const c of P.corners) if (tr.prof[c.i] < lowV) { lowV = tr.prof[c.i]; lo = c; }
      P.top = { i: hi, v: tr.prof[hi] * 3.6 }; P.slow = lo ? { c: lo, v: lowV * 3.6 } : null;
      let mn = 1e9; for (let i = 0; i < N; i++) mn = Math.min(mn, tr.prof[i]);
      P.minV = mn * 3.6;
      // a marker's time round the plan, for the dot that runs the lap
      P.tcum = new Float64Array(N + 1);
      for (let i = 0; i < N; i++) P.tcum[i + 1] = P.tcum[i] + tr.ds / Math.max(8, tr.prof[i]);
    }
    let zi = 0, zj = 0;
    for (let i = 0; i < N; i++) { if (tr.z[i] > tr.z[zi]) zi = i; if (tr.z[i] < tr.z[zj]) zj = i; }
    P.hiPt = zi; P.loPt = zj;
    return P;
  }

  function start(canvas, tr, opts = {}) {
    if (!canvas || !tr) return () => {};
    if (canvas._lm) canvas._lm();
    const P = prepare(tr), N = P.N, M = P.M, ctx = canvas.getContext('2d');
    const t0 = performance.now(), PITCH = 0.92, SINP = Math.sin(PITCH), COSP = Math.cos(PITCH);
    let raf = 0, dead = false, W = 0, H = 0, dpr = 1;
    const sz = () => { dpr = Math.min(2, G.devicePixelRatio || 1); W = canvas.clientWidth || 800; H = canvas.clientHeight || 450; if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); } };
    const px = new Float32Array((M + 1) * 3);
    const compact = () => W < 900 || H < 520;

    const frame = now => {
      if (dead) return;
      if (!canvas.isConnected) { dead = true; return; }
      raf = requestAnimationFrame(frame);
      sz();
      const t = (now - t0) / 1000;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // ground
      const bg = ctx.createRadialGradient(W * 0.64, H * 0.52, 20, W * 0.64, H * 0.52, Math.max(W, H) * 0.75);
      // (a veil over the menus' picture, when that stands behind)
      const over = F1.MenuBg && F1.MenuBg.on;
      if (over) ctx.clearRect(0, 0, W, H);
      bg.addColorStop(0, over ? 'rgba(12,14,19,.46)' : '#171b25'); bg.addColorStop(1, over ? 'rgba(7,8,11,.34)' : '#07090d');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      // the map's room: the right of the screen, the title card holds the left
      const cmp = compact();
      const rx = cmp ? W * 0.04 : W * 0.34, rw = cmp ? W * 0.92 : W * 0.63, ry = cmp ? H * 0.44 : H * 0.13, rh = cmp ? H * 0.36 : H * 0.6;
      const cx = rx + rw / 2, cy = ry + rh / 2;
      const intro = smooth(t / 1.4), yaw = P.yaw0 + 0.3 * Math.sin(t * 0.22) + (1 - intro) * 0.9;
      const cyaw = Math.cos(yaw), syaw = Math.sin(yaw);
      const needX = P.aX * 0.955 + P.bY * 0.3, needY = (P.bY * 0.955 + P.aX * 0.3) * SINP + P.dz * P.ex * COSP * 0.5 + 40;
      const S = Math.min(rw * 0.5 / needX, rh * 0.5 / needY) * 0.93 * (0.9 + 0.1 * intro);
      const pk = 0.24 / P.R;
      // world to screen: [x, y, depth key, scale]
      const proj = (x, y, z, out, o) => {
        const wx = x - P.mx, wy = y - P.my, X = wx * cyaw - wy * syaw, Y = wx * syaw + wy * cyaw, Z = (z - P.z0) * P.ex;
        const w = 1 / (1 + (Y * COSP - Z * SINP) * pk);
        out[o] = cx + X * S * w; out[o + 1] = cy - (Y * SINP + Z * COSP) * S * w + P.dz * P.ex * S * 0.25; out[o + 2] = Y * COSP - Z * SINP;
        return w;
      };
      const tmp = new Float32Array(3), g0 = new Float32Array(3);
      // a faint ground grid, rings and spokes, so the tilt reads
      ctx.lineWidth = 1;
      for (let r = 1; r <= 4; r++) {
        ctx.beginPath();
        for (let a = 0; a <= 64; a++) { const th = a / 64 * 6.2832; proj(P.mx + Math.cos(th) * P.R * r * 0.3, P.my + Math.sin(th) * P.R * r * 0.3, P.z0, tmp, 0); a ? ctx.lineTo(tmp[0], tmp[1]) : ctx.moveTo(tmp[0], tmp[1]); }
        ctx.strokeStyle = `rgba(255,255,255,${0.05 + 0.01 * (5 - r)})`; ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255,255,255,.045)';
      for (let a = 0; a < 12; a++) { const th = a / 12 * 6.2832; ctx.beginPath(); proj(P.mx, P.my, P.z0, tmp, 0); ctx.moveTo(tmp[0], tmp[1]); proj(P.mx + Math.cos(th) * P.R * 1.2, P.my + Math.sin(th) * P.R * 1.2, P.z0, tmp, 0); ctx.lineTo(tmp[0], tmp[1]); ctx.stroke(); }
      // the ribbon's points
      const sc = new Float32Array(M + 1);
      for (let k = 0; k <= M; k++) { const i = P.idx[k] % N; sc[k] = proj(tr.x[i], tr.y[i], tr.z[i], px, k * 3); }
      const roadPx = clamp(S * tr.hw * 2 * 2.5, 5, 15);
      // the track draws itself on, then stays
      const rev = smooth((t - 0.2) / 3.2), upto = Math.floor(rev * M);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      // its shadow on the ground
      ctx.beginPath();
      for (let k = 0; k <= upto; k++) { const i = P.idx[k] % N; proj(tr.x[i], tr.y[i], P.z0, g0, 0); k ? ctx.lineTo(g0[0], g0[1]) : ctx.moveTo(g0[0], g0[1]); }
      ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = roadPx * 1.5; ctx.stroke();
      // pillars from the ground to the raised ribbon, where it stands high
      if (P.dz > 3) {
        ctx.strokeStyle = 'rgba(170,180,200,.16)'; ctx.lineWidth = 1; ctx.beginPath();
        for (let k = 0; k <= upto; k += 8) { const i = P.idx[k] % N; if ((tr.z[i] - P.z0) * P.ex < P.R * 0.012) continue; proj(tr.x[i], tr.y[i], P.z0, g0, 0); ctx.moveTo(g0[0], g0[1]); ctx.lineTo(px[k * 3], px[k * 3 + 1]); }
        ctx.stroke();
      }
      // segments, far to near
      const order = [];
      for (let k = 0; k < upto; k++) order.push(k);
      order.sort((a, b) => (px[(b) * 3 + 2] + px[(b + 1) * 3 + 2]) - (px[(a) * 3 + 2] + px[(a + 1) * 3 + 2]));
      const seg = (k, lw, col) => { ctx.beginPath(); ctx.moveTo(px[k * 3], px[k * 3 + 1]); ctx.lineTo(px[(k + 1) * 3], px[(k + 1) * 3 + 1]); ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke(); };
      // the pit lane under the road
      if (P.pit.length) {
        ctx.beginPath(); let prev = -2;
        for (const k of P.pit) {
          if (k > upto) break;
          const i = P.idx[k] % N, o = tr.pit.off[i];
          proj(tr.x[i] + tr.nx[i] * o, tr.y[i] + tr.ny[i] * o, tr.z[i], g0, 0);
          if (k !== prev + 1) ctx.moveTo(g0[0], g0[1]); else ctx.lineTo(g0[0], g0[1]);
          prev = k;
        }
        ctx.strokeStyle = 'rgba(5,7,10,.9)'; ctx.lineWidth = roadPx * 0.8; ctx.stroke();
        ctx.strokeStyle = PIT; ctx.lineWidth = roadPx * 0.5; ctx.stroke();
      }
      for (const k of order) { const w = (sc[k] + sc[k + 1]) / 2; seg(k, (roadPx + 4) * w, '#04060a'); }
      for (const k of order) { const w = (sc[k] + sc[k + 1]) / 2; seg(k, roadPx * w, '#3a3f4b'); }
      for (const k of order) { const w = (sc[k] + sc[k + 1]) / 2; seg(k, roadPx * 0.34 * w, SEC[P.sec[k]]); if (P.drs[k]) seg(k, roadPx * 0.7 * w, 'rgba(43,214,107,.55)'); }
      // travel direction, little chevrons along the lap
      ctx.fillStyle = 'rgba(255,255,255,.8)';
      for (let k = 6; k < upto - 1; k += 20) {
        const ax = px[k * 3], ay = px[k * 3 + 1], dx = px[(k + 1) * 3] - ax, dy = px[(k + 1) * 3 + 1] - ay, l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l, sz2 = roadPx * 0.42;
        ctx.beginPath(); ctx.moveTo(ax + ux * sz2, ay + uy * sz2); ctx.lineTo(ax - ux * sz2 * 0.6 - uy * sz2 * 0.6, ay - uy * sz2 * 0.6 + ux * sz2 * 0.6); ctx.lineTo(ax - ux * sz2 * 0.6 + uy * sz2 * 0.6, ay - uy * sz2 * 0.6 - ux * sz2 * 0.6); ctx.closePath(); ctx.fill();
      }
      const placed = [];
      const tag = (x, y, text, col, o = {}) => {
        ctx.font = `800 ${o.size || 11}px ${FONT}`; ctx.textAlign = o.align || 'center'; ctx.textBaseline = 'middle';
        const w = ctx.measureText(text).width + 12, h = (o.size || 11) + 8, bx = (o.align === 'left' ? x : o.align === 'right' ? x - w : x - w / 2);
        // (a label that would sit on another moves up or down beside it)
        const hit = yy => placed.some(r => bx < r[0] + r[2] && bx + w > r[0] && yy - h / 2 < r[1] + r[3] && yy + h / 2 > r[1]);
        for (const d of [0, 1, -1, 2, -2, 3, -3, 4, -4]) { if (!hit(y + d * (h + 2))) { y += d * (h + 2); break; } }
        placed.push([bx, y - h / 2, w, h]);
        ctx.fillStyle = o.bg || 'rgba(8,10,14,.86)'; ctx.fillRect(bx, y - h / 2, w, h);
        if (col) { ctx.fillStyle = col; ctx.fillRect(bx, y - h / 2, 3, h); }
        ctx.fillStyle = o.fg || '#fff'; ctx.textAlign = 'left'; ctx.fillText(text, bx + 8, y + 0.5);
      };
      // the start line, a checkered bar across the road, and the sector splits
      const bar = (i, col, lwK) => {
        proj(tr.x[i] + tr.nx[i] * tr.hw * 1.5, tr.y[i] + tr.ny[i] * tr.hw * 1.5, tr.z[i], tmp, 0); proj(tr.x[i] - tr.nx[i] * tr.hw * 1.5, tr.y[i] - tr.ny[i] * tr.hw * 1.5, tr.z[i], g0, 0);
        ctx.beginPath(); ctx.moveTo(tmp[0], tmp[1]); ctx.lineTo(g0[0], g0[1]); ctx.strokeStyle = col; ctx.lineWidth = lwK; ctx.setLineDash(col === '#fff' ? [3, 3] : []); ctx.stroke(); ctx.setLineDash([]);
        return [(tmp[0] + g0[0]) / 2, (tmp[1] + g0[1]) / 2];
      };
      const labels = [];
      if (upto > 2) { const p = bar(0, '#fff', 5); labels.push([p[0], p[1] - 16, 'START / FINISH', '#fff', 0]); }
      if (tr.sectors) for (let q = 1; q < 3; q++) { const k = Math.round(tr.sectors[q] / tr.ds / P.step); if (k < upto) { const i = Math.round(tr.sectors[q] / tr.ds) % N, p = bar(i, SEC[q], 3.5); labels.push([p[0], p[1] - 14, 'S' + q + ' / S' + (q + 1), SEC[q], 0]); } }
      // pit entry and exit
      if (P.pit.length && tr.pit) {
        const k0 = P.pit[0], k1 = P.pit[P.pit.length - 1];
        if (k0 < upto) { const i = P.idx[k0] % N; proj(tr.x[i] + tr.nx[i] * tr.pit.off[i], tr.y[i] + tr.ny[i] * tr.pit.off[i], tr.z[i], tmp, 0); labels.push([tmp[0], tmp[1] + 15, 'PIT IN', PIT, 1]); }
        if (k1 < upto) { const i = P.idx[k1] % N; proj(tr.x[i] + tr.nx[i] * tr.pit.off[i], tr.y[i] + tr.ny[i] * tr.pit.off[i], tr.z[i], tmp, 0); labels.push([tmp[0], tmp[1] + 15, 'PIT OUT', PIT, 1]); }
      }
      // overtake zones, named at their middle
      (tr.drs || []).forEach((z, n) => {
        const a = z.act, b = z.end < z.act ? z.end + tr.L : z.end, mid = ((a + b) / 2) % tr.L, i = Math.round(mid / tr.ds) % N;
        if (i / N <= rev + 0.001 || rev >= 1) { proj(tr.x[i] + tr.nx[i] * tr.hw * 4.5, tr.y[i] + tr.ny[i] * tr.hw * 4.5, tr.z[i], tmp, 0); labels.push([tmp[0], tmp[1], 'OVERTAKE ' + (n + 1), DRS, 0]); }
      });
      // highest and lowest ground
      if (P.dz > 4 && rev > 0.9) {
        for (const [i, text] of [[P.hiPt, 'HIGH +' + Math.round(P.z1 - P.z0) + ' M'], [P.loPt, 'LOW']]) { proj(tr.x[i], tr.y[i], tr.z[i], tmp, 0); labels.push([tmp[0], tmp[1] - (i === P.hiPt ? 18 : -18), text, '#9aa3b2', 0, 10]); }
      }
      // quickest and slowest
      if (P.top && rev > 0.95) {
        proj(tr.x[P.top.i], tr.y[P.top.i], tr.z[P.top.i], tmp, 0); labels.push([tmp[0], tmp[1] - 22, 'TOP SPEED ' + Math.round(P.top.v) + ' KM/H', '#fff', 0, 10]);
        if (P.slow) { const i = P.slow.c.i; proj(tr.x[i], tr.y[i], tr.z[i], tmp, 0); labels.push([tmp[0], tmp[1] + 24, 'SLOWEST T' + P.slow.c.n + '  ' + Math.round(P.slow.v) + ' KM/H', '#ff6a5f', 0, 10]); }
      }
      // corner badges
      for (const c of P.corners) {
        if (c.i / N > rev) continue;
        const i = c.i, off = tr.hw * 3.2 * c.side;
        proj(tr.x[i], tr.y[i], tr.z[i], g0, 0); proj(tr.x[i] + tr.nx[i] * off, tr.y[i] + tr.ny[i] * off, tr.z[i], tmp, 0);
        ctx.beginPath(); ctx.moveTo(g0[0], g0[1]); ctx.lineTo(tmp[0], tmp[1]); ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.beginPath(); ctx.arc(tmp[0], tmp[1], 8.5, 0, 6.2832); ctx.fillStyle = 'rgba(8,10,14,.9)'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.4; ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = `800 10px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(c.n), tmp[0], tmp[1] + 0.5);
      }
      // a marker runs the lap on the speed plan, fast down the straights and slow in the bends
      if (rev >= 1 && P.tcum) {
        const lapT = P.tcum[N], u = ((t - 3.6) * 7) % lapT;
        let a = 0, b = N; while (a < b) { const m = (a + b) >> 1; if (P.tcum[m] < u) a = m + 1; else b = m; }
        const i = clamp(a, 0, N - 1);
        proj(tr.x[i], tr.y[i], tr.z[i], tmp, 0);
        const g = ctx.createRadialGradient(tmp[0], tmp[1], 0, tmp[0], tmp[1], 16); g.addColorStop(0, 'rgba(255,255,255,.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(tmp[0], tmp[1], 16, 0, 6.2832); ctx.fill();
        ctx.beginPath(); ctx.arc(tmp[0], tmp[1], 4, 0, 6.2832); ctx.fillStyle = '#fff'; ctx.fill();
      } else if (upto < M) {
        // the pen's tip while it draws
        const g = ctx.createRadialGradient(px[upto * 3], px[upto * 3 + 1], 0, px[upto * 3], px[upto * 3 + 1], 14); g.addColorStop(0, 'rgba(255,255,255,.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px[upto * 3], px[upto * 3 + 1], 14, 0, 6.2832); ctx.fill();
      }
      // the labels last, so no bend hides one
      ctx.globalAlpha = smooth((t - 0.8) / 0.8);
      for (const [x, y, text, col, , size] of labels) tag(x, y, text, col, { size: size || 11 });
      ctx.globalAlpha = 1;
      // the key and the data strip
      const keyY = cmp ? H * 0.405 : H * 0.095;
      ctx.font = `700 11px ${FONT}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      let kx = rx;
      for (const [txt, col] of [['SECTOR 1', SEC[0]], ['SECTOR 2', SEC[1]], ['SECTOR 3', SEC[2]], ['OVERTAKE ZONE', DRS], ['PIT LANE', PIT]]) {
        ctx.fillStyle = col; ctx.fillRect(kx, keyY - 2, 14, 4); ctx.fillStyle = '#b7bec8'; ctx.fillText(txt, kx + 20, keyY + 0.5); kx += 20 + ctx.measureText(txt).width + 18;
      }
      if (!cmp) {
        const secL = tr.sectors ? [tr.sectors[1], tr.sectors[2] - tr.sectors[1], tr.L - tr.sectors[2]] : null;
        const items = [['LENGTH', (tr.L / 1000).toFixed(3) + ' KM'], ['CORNERS', String(tr.apexes ? tr.apexes.length : '-')], ['OVERTAKE ZONES', String((tr.drs || []).length)],
          ['ELEVATION', P.dz > 0.5 ? Math.round(P.dz) + ' M RANGE' : 'FLAT']];
        if (P.top) items.push(['TOP SPEED', Math.round(P.top.v) + ' KM/H'], ['SLOWEST', Math.round(P.minV) + ' KM/H']);
        if (secL) items.push(['SECTORS', secL.map(v => (v / 1000).toFixed(2)).join(' / ') + ' KM']);
        // (clear of the title card's own stats, which a long name pushes down to here)
        const sx0 = Math.max(rx, W * 0.07 + Math.min(560, W * 0.46) + 14), sy = H * 0.772, bw = (rx + rw - sx0) / items.length;
        ctx.globalAlpha = smooth((t - 1.6) / 0.8);
        items.forEach(([k, v], n) => {
          const x = sx0 + n * bw;
          ctx.fillStyle = 'rgba(10,12,17,.78)'; ctx.fillRect(x, sy - 28, bw - 3, 50);
          ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(x, sy - 28, bw - 3, 2);
          ctx.fillStyle = '#7b8491'; ctx.font = `700 9px ${FONT}`; ctx.textAlign = 'left'; ctx.fillText(k, x + 9, sy - 13);
          ctx.fillStyle = '#fff'; ctx.font = `800 ${n === items.length - 1 ? 13 : 16}px ${FONT}`; ctx.fillText(v, x + 9, sy + 6);
        });
        ctx.globalAlpha = 1;
      }
    };
    raf = requestAnimationFrame(frame);
    const stop = () => { dead = true; cancelAnimationFrame(raf); canvas._lm = null; };
    canvas._lm = stop;
    return stop;
  }

  F1.LoadMap = { start };
})(window);
