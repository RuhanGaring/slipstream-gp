const F1 = require('./load')();
for (const def of F1.Tracks.DEFS) {
  const t0 = Date.now();
  const tr = F1.Raceline.prepare(F1.Tracks.build(def));
  let vmin = 1e9, vmax = 0;
  for (const v of tr.prof) { vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); }
  console.log(def.id, 'L', tr.L.toFixed(0), 'refLap', F1.U.fmtTime(tr.refLap), 'vmin', (vmin*3.6).toFixed(0), 'vmax', (vmax*3.6).toFixed(0), 'zones', tr.brakeZones.length, 'ms', Date.now()-t0);
}
