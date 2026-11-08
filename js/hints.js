// Race coach: short tips at the moment they are useful, one at a time, for a player who has not
// seen them. Each tip shows a few times over a player's first races and then stops for good,
// so nobody who knows the game ever reads one. Settings > Race coach turns them off. The keys
// named are the player's own (Controls > Keyboard).
(function (G) {
  'use strict';
  const F1 = G.F1;
  const store = {
    get() { try { return JSON.parse(localStorage.getItem('slip_hints')) || {}; } catch (e) { return {}; } },
    set(v) { try { localStorage.setItem('slip_hints', JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  const S = { seen: store.get(), t: 0, wait: 0, cur: null, el: null, offs: 0, wasOff: false, walls: 0, wallAt: -9, wasSpeed: 0, flash: false, askedHelp: false };
  const GAP = 9, SHOW = 6.5; // seconds between tips, seconds on screen

  const key = (a, d) => (F1.Game.hintKey ? F1.Game.hintKey(a) : d);
  const mob = () => F1.Game.mobile && F1.Game.mobile();

  // id, times to show it, test, text
  const TIPS = [
    { id: 'gas', n: 2, on: (r, p) => r.time - r.startTime > 1.2 && !S.moved && p.ctl.throttle < 0.1,
      text: () => (mob() ? 'Hold <b>GAS</b> to go. Lights out means race' : `Hold <b>${key('thr', 'W')}</b> to accelerate`) },
    { id: 'stuck', n: 4, on: (r, p) => S.moved && (p.stuckT || 0) > 2.2 && !p.retired && !(p.dm && p.dm.failed),
      text: () => (mob() ? 'Stuck? Tap <b>&#8634;</b> to rewind' : `Stuck? <b>${key('reset', 'R')}</b> puts the car back on the road`) },
    { id: 'flash', n: 4, on: (r, p) => S.flash && F1.Game.fbCan() && !p.finished,
      text: () => (mob() ? 'Bad moment? Tap <b>&#8634;</b> to go back and try again' : `Bad moment? Hold <b>${key('flash', 'BACKSPACE')}</b> to go back and try again`) },
    { id: 'brake', n: 3, on: (r, p) => {
      if (p.assist.brakeHelp === 2) return false;
      const tr = r.track, j = (p.loc.i + Math.round(60 / tr.ds)) % tr.N;
      return p.speed > 25 && p.speed > p.brain.prof[j] + 22 && p.ctl.brake < 0.1;
    }, text: () => 'Too fast for the next corner. <b>Brake on the red line</b>' },
    { id: 'help', n: 2, on: (r, p) => S.walls >= 4 && !p.assist.brakeHelp, text: () => 'A hard one? <b>Brake help</b> in Race setup does the braking for you' },
    { id: 'grass', n: 2, on: (r, p) => S.offs >= 2 && !r.sim, text: () => 'Grass has little grip: <b>ease off and steer back</b>' },
    { id: 'limits', n: 2, on: (r, p) => r.sim && p.warnings >= 1, text: () => 'Four wheels past the white line is a <b>strike</b>. From the fourth, each one costs 5 seconds' },
    { id: 'overtake', n: 3, on: (r, p) => r.green && p.drsAvail && !p.drsOpen, text: () => (mob() ? 'Tap <b>OVT</b> now for extra power' : `Press <b>${key('drs', 'SPACE')}</b> now for extra power`) },
    { id: 'tyres', n: 2, on: (r, p) => r.sim && p.lap === 1 && r.time - r.startTime > 6, text: () => 'Cold tyres on the first lap: <b>brake early</b> until they warm up' },
    { id: 'pit', n: 2, on: (r, p) => r.sim && r.mandatory && p.lap >= 2 && p.pitStops === 0, text: () => (mob() ? 'This race needs a pit stop: tap <b>PIT</b> to plan it' : `This race needs a pit stop: press <b>${key('pit', 'P')}</b> to plan it`) },
    { id: 'cam', n: 1, on: (r, p) => p.lap === 2, text: () => (mob() ? 'Tap <b>CAM</b> to change the view' : `<b>${key('cam', 'C')}</b> changes the view, <b>Z</b> the distance`) },
  ];

  function note(what) {
    if (what === 'flashback') { S.flash = false; S.walls = 0; }
  }
  function start(race) {
    S.seen = store.get();
    S.t = 0; S.wait = 1; S.moved = false; S.cur = null; S.offs = 0; S.wasOff = false; S.walls = 0; S.wallAt = -9; S.flash = false; S.wasSpeed = 0;
    S.el = document.getElementById('hint');
    if (S.el) { S.el.classList.remove('on'); S.el.innerHTML = ''; }
  }
  function hide() { if (S.el) S.el.classList.remove('on'); S.cur = null; }

  // from the game's effect events: a hard hit
  function wall(race, f) {
    if (race.time - S.wallAt < 1.5) return;
    S.wallAt = race.time; S.walls++;
    if (f.power > 6) S.flash = true;
  }
  function update(race, p, dt) {
    if (!S.el) return;
    if (p.speed > 8) S.moved = true;
    const on = F1.Game.settings.hints !== false;
    // (a tip already up goes as soon as the car is out or home: it sat under the RETIRED banner)
    if (S.cur) { S.t -= dt; if (S.t <= 0 || !on || p.retired || p.finished) { hide(); S.wait = GAP; } return; }
    if (!on || !race.green || p.retired || p.finished) return;
    const tr = race.track, off = Math.abs(p.loc.d) > tr.hw + 1.2;
    if (off && !S.wasOff) S.offs++;
    S.wasOff = off;
    // a spin counts as a bad moment too
    if (p.speed > 8 && Math.abs(p.beta || 0) > 0.9) S.flash = true;
    S.wait -= dt;
    if (S.wait > 0) return;
    S.wait = 0.25; // (tests need not run every frame)
    for (const t of TIPS) {
      if ((S.seen[t.id] || 0) >= t.n || !t.on(race, p)) continue;
      S.seen[t.id] = (S.seen[t.id] || 0) + 1;
      store.set(S.seen);
      S.cur = t; S.t = SHOW;
      S.el.innerHTML = t.text();
      S.el.classList.add('on');
      if (t.id === 'flash') S.flash = false;
      if (t.id === 'grass') S.offs = 0;
      return;
    }
  }
  function resetSeen() { S.seen = {}; store.set({}); }

  F1.Hints = { start, update, wall, note, hide, resetSeen, S };
})(typeof window !== 'undefined' ? window : globalThis);
