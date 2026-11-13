// A worker thread that solves crash structures (js/softbody.js) for the main thread (js/softworker.js).
// It keeps each structure it is given and steps it on request, applying first whatever the main
// thread did to its own copy (new contacts, torn corners, repairs), and answers with the new shape.
'use strict';
self.F1 = { Race: { CC: null } };
const states = new Map();
const OUT = ['p', 'q', 'L0', 'broken', 'off', 'gp', 'toe', 'camber', 'hubOff', 'noSteer', 'cc', 'ver', 'offVer', 'awake', 'idle', 'age', 'energy', 'acc'];
self.onmessage = e => {
  const m = e.data;
  if (m.type === 'init') {
    self.F1.Race.CC = m.cc;
    importScripts(m.src);
    return;
  }
  if (m.type !== 'step') return;
  const Soft = self.F1.Soft;
  let s = states.get(m.id);
  if (m.state) {
    s = Soft.init({}, m.state.kind);
    for (const k of Object.keys(m.state)) { const v = m.state[k]; if (s[k] && s[k].set && v && v.length === s[k].length) s[k].set(v); else s[k] = v; }
    states.set(m.id, s);
  }
  if (!s) return;
  for (const [op, a] of m.ops) {
    if (op === 'plane') { s.planes.push(a); s.awake = 1; s.idle = 0; s.age = 0; }
    else if (op === 'tear') Soft.tear(s, a);
    else if (op === 'repair') Soft.repair(s, a);
  }
  // (in pieces of the race's own step, as the main thread would have: 1/240 s, or the dense
  // structure's 1/120 s, so the solve is the same however long the main thread waited)
  const rate = s.kind === 'beam' ? 1 / 120 : 1 / 240;
  for (let t = m.dt; t > 1e-9 && s.awake; t -= rate) Soft.step(s, Math.min(rate, t));
  const r = { id: m.id, mseq: m.mseq, epoch: m.epoch };
  for (const k of OUT) { const v = s[k]; r[k] = v && v.slice ? v.slice() : v; }
  self.postMessage(r);
};
