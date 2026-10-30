// Worker thread for tools/learnpar.js: runs js/learncore.js jobs.
const { parentPort } = require('worker_threads');
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'data.js', 'ai.js', 'race.js', 'learncore.js']);
if (process.env.NO_STORED) { F1.Lines = { stride: 2 }; }
parentPort.on('message', ({ k, msg }) => {
  try {
    const g = F1.LearnCore.handle(msg);
    let r = g.next();
    while (!r.done) r = g.next();
    parentPort.postMessage({ k, res: r.value });
  } catch (e) { parentPort.postMessage({ k, err: String(e && e.stack || e) }); }
});
