// Tunes the AI's driving technique (F1.AI.P in js/ai.js) over many circuits until it stops
// getting faster. A candidate technique is scored the way the game would use it: on every
// training circuit the grip limits are learned again with that technique driving (on the
// circuit's fixed racing line), then a lone car drives flying laps on them. Score: mean lap
// time relative to the starting technique, plus penalties for recoveries, wall hits and
// track-limit breaches. A (1+1) evolution strategy perturbs a few constants at a time and
// keeps a change only if the score improves; it stops after STALL tries in a row without
// one. Progress is kept in STATE so a run can be resumed.
// usage: node tools/drivetune.js STATE.json LINEDIR [STALL]   (LINEDIR: learned gen-*.json)
const fs = require('fs'), path = require('path'), os = require('os');
const { execFile } = require('child_process');
const F1 = require('./load')(['util.js', 'tracks.js', 'car.js', 'raceline.js', 'lines.js', 'data.js', 'ai.js']);
const [STATE, LINEDIR, STALL = 40] = process.argv.slice(2);
const TRAIN = (process.env.TRAIN || 'kestrel,lucerne,rimal,nordwald,gen-1,gen-2,gen-3,gen-4').split(',');
const HELD = (process.env.HELD || 'hakone,bahia,sierra,gen-5,gen-10,gen-15').split(',');
const THREADS = 2, TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dtune-'));
const P0 = Object.assign({}, F1.AI.P), KEYS = Object.keys(P0);

// a racing line file per circuit: the hand-made ones from js/lines.js, generated ones learned
const lineFile = id => {
  const f = path.join(TMP, 'line-' + id + '.json');
  if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ line: id.startsWith('gen-') ? JSON.parse(fs.readFileSync(path.join(LINEDIR, id + '.json'), 'utf8')).line : F1.Lines[id] }));
  return f;
};
const run = (args, env) => new Promise(res => execFile('node', args, { env: Object.assign({}, process.env, env), maxBuffer: 1e8, cwd: path.join(__dirname, '..') }, (e, out) => res(out || '')));

let seq = 0;
async function evalMap(P, id) {
  const out = path.join(TMP, `lim-${id}-${++seq}.json`), env = { AIP: JSON.stringify(P) };
  await run([path.join(__dirname, 'learnpar.js'), id, String(THREADS)], Object.assign({ LINEFROM: lineFile(id), SIMONLY: '1', OUT: out }, env));
  if (!fs.existsSync(out)) return { id, best: null };
  const r = await run([path.join(__dirname, 'gripdrive.js'), id, 'learned', out, 'sim'], env);
  fs.unlinkSync(out);
  try { return JSON.parse(r.trim().split('\n').pop()); } catch (e) { return { id, best: null }; }
}
async function evalSet(P, ids) {
  const res = [], q = ids.slice();
  const lanes = Math.max(1, Math.floor((os.cpus().length - 1) / THREADS));
  await Promise.all(Array.from({ length: lanes }, async () => { while (q.length) { const id = q.shift(); res.push(await evalMap(P, id)); } }));
  return res;
}
// score: lap relative to the reference, plus a price for every kind of trouble
function score(res, ref) {
  let s = 0;
  for (const r of res) {
    const base = ref[r.id];
    if (!r.best || !base) { s += 1.5; continue; }
    s += r.best / base + 0.25 * (r.rec || 0) + 0.06 * (r.walls || 0) + 0.02 * (r.lim || 0);
  }
  return s / res.length;
}

(async () => {
  let st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null;
  if (!st) {
    console.log('reference run of the starting technique...');
    const tr = await evalSet(P0, TRAIN), th = await evalSet(P0, HELD);
    const ref = {}; for (const r of tr.concat(th)) ref[r.id] = r.best;
    st = { ref, best: Object.assign({}, P0), bestScore: score(tr, ref), held0: score(th, ref), sigma: 0.15, tries: 0, stall: 0, log: [], start: tr.concat(th) };
    console.log('start', JSON.stringify(st.start));
    fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
  }
  const rnd = Math.random;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  while (st.stall < +STALL) {
    // perturb two to four constants by a log-normal factor
    const cand = Object.assign({}, st.best), n = 2 + Math.floor(rnd() * 3), picked = [];
    for (let k = 0; k < n; k++) { const key = KEYS[Math.floor(rnd() * KEYS.length)]; cand[key] = +(cand[key] * Math.exp(st.sigma * gauss())).toPrecision(4); picked.push(key); }
    const t0 = Date.now(), res = await evalSet(cand, TRAIN), sc = score(res, st.ref);
    st.tries++;
    const ok = sc < st.bestScore - 1e-4;
    if (ok) { st.best = cand; st.bestScore = sc; st.stall = 0; st.sigma = Math.min(0.4, st.sigma * 1.3); }
    else { st.stall++; st.sigma = Math.max(0.03, st.sigma * 0.93); }
    st.log.push({ t: st.tries, sc: +sc.toFixed(5), ok, keys: picked });
    console.log(`try ${st.tries} ${ok ? 'BETTER' : 'no'} score ${sc.toFixed(5)} best ${st.bestScore.toFixed(5)} (${((1 - st.bestScore) * 100).toFixed(2)}% faster) sigma ${st.sigma.toFixed(3)} stall ${st.stall} [${picked.join(',')}] ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
  }
  console.log('no improvement in', STALL, 'tries: checking the held-out circuits');
  const th = await evalSet(st.best, HELD);
  st.held = score(th, st.ref); st.heldRes = th;
  console.log(`held-out score ${st.held.toFixed(5)} vs start ${st.held0.toFixed(5)}`, JSON.stringify(th));
  console.log('best', JSON.stringify(st.best));
  fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
})();
