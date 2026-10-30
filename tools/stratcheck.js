const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'limits.js', 'data.js', 'ai.js', 'race.js']);
const S = F1.Race.Strategy;
for (const id of ['kestrel', 'lucerne']) {
  const tr = F1.Race.getTrack(id);
  for (const laps of [3, 5, 8, 12, 20]) {
    const wr = Math.max(1, 22 / Math.max(3, laps));
    const wpl = { S: S.wearEstimate(tr, 'S', wr), M: S.wearEstimate(tr, 'M', wr), H: S.wearEstimate(tr, 'H', wr) };
    const p = S.plan({ base: tr.refLap, laps, comp: null, wear: 0, wpl, loss: S.pitLoss(tr), need2: laps >= 5 });
    console.log(id, laps, 'laps:', p.seq.join('>'), 'stops', p.stops.join(','), 'loss', S.pitLoss(tr).toFixed(1), 'wear/lap M', wpl.M.toFixed(3));
  }
}
