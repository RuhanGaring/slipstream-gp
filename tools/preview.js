// Writes an SVG sheet of every circuit (centreline, edges, barriers, pit, line).
// usage: node tools/preview.js OUT.html
const load = require('./load');
const fs = require('fs');
const F1 = load();
const out = process.argv[2] || 'preview.html';
let html = '<html><body style="margin:0;background:#222;display:flex;flex-wrap:wrap">';
for (const def of F1.Tracks.DEFS) {
  const t = F1.Tracks.build(def);
  let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
  for (let i = 0; i < t.N; i++) { mnx = Math.min(mnx, t.x[i]); mny = Math.min(mny, t.y[i]); mxx = Math.max(mxx, t.x[i]); mxy = Math.max(mxy, t.y[i]); }
  const pad = 80;
  const vb = `${mnx - pad} ${mny - pad} ${mxx - mnx + 2 * pad} ${mxy - mny + 2 * pad}`;
  const poly = (d, arr) => {
    let s = '';
    for (let i = 0; i < t.N; i++) {
      const o = typeof d === 'function' ? d(i) : d;
      if (isNaN(o)) { s += ' '; continue; }
      s += `${(t.x[i] + t.nx[i] * o).toFixed(1)},${(t.y[i] + t.ny[i] * o).toFixed(1)} `;
    }
    return s;
  };
  let svg = `<svg viewBox="${vb}" width="760" height="560" style="background:#3a5a2a;margin:4px">`;
  svg += `<polygon points="${poly(i => -t.barr[0][i])}" fill="none" stroke="#ddd" stroke-width="2"/>`;
  svg += `<polygon points="${poly(i => t.barr[1][i])}" fill="none" stroke="#ddd" stroke-width="2"/>`;
  svg += `<polygon points="${poly(0)}" fill="none" stroke="#555" stroke-width="${t.w}"/>`;
  // pit lane
  let pp = '';
  const i0 = Math.round(t.pit.sIn / t.ds);
  for (let k = 0; k < t.N; k++) { const i = (i0 + k) % t.N; if (!isNaN(t.pit.off[i])) pp += `${(t.x[i] + t.nx[i] * t.pit.off[i]).toFixed(1)},${(t.y[i] + t.ny[i] * t.pit.off[i]).toFixed(1)} `; }
  svg += `<polyline points="${pp}" fill="none" stroke="#888" stroke-width="${t.pit.lane}"/>`;
  if (t.line) svg += `<polygon points="${poly(i => t.line.off[i])}" fill="none" stroke="#f0f" stroke-width="1.2"/>`;
  // kerbs
  for (let i = 0; i < t.N; i++) {
    if (t.kerbL[i]) svg += `<circle cx="${t.x[i] - t.nx[i] * (t.hw + 1)}" cy="${t.y[i] - t.ny[i] * (t.hw + 1)}" r="1.2" fill="red"/>`;
    if (t.kerbR[i]) svg += `<circle cx="${t.x[i] + t.nx[i] * (t.hw + 1)}" cy="${t.y[i] + t.ny[i] * (t.hw + 1)}" r="1.2" fill="red"/>`;
  }
  svg += `<circle cx="${t.x[0]}" cy="${t.y[0]}" r="12" fill="#fff"/>`;
  for (const z of t.drs) { const p = F1.Tracks.pointAt(t, z.act, 0); svg += `<circle cx="${p[0]}" cy="${p[1]}" r="9" fill="#0f0"/>`; }
  svg += `<text x="${mnx}" y="${mny - 20}" fill="#fff" font-size="40">${t.name} L=${t.L.toFixed(0)} warn=${t.filletWarn} dir=${t.dir} c=${t.corners}</text>`;
  def.v.forEach((v, k) => { svg += `<text x="${v[0]}" y="${v[1]}" fill="#ff0" font-size="34">${k}</text>`; });
  svg += '</svg>';
  html += svg;
  console.log(t.name, 'L', t.L.toFixed(0), 'warn', t.filletWarn, 'dir', t.dir, 'drs', t.drs.length, 'corners', t.corners);
}
fs.writeFileSync(out, html + '</body></html>');
