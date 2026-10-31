// The broadcast viewer, shared by replays and spectating: which car is followed, which camera
// shows it, a free camera to fly anywhere, an automatic director, and the overlay (timing
// tower, the followed car's card, the camera in use and, in a replay, the timeline).
//   cameras   C / V next / previous, 1 to 9 and 0 direct, F free camera, T top down, G map
//   cars      Left / Right (or , .) previous / next by position, Up / Down the leader / last
//   director  D cuts between cars and cameras by itself
//   free cam  W A S D move, Q / E down / up, mouse drag or arrow keys look, Shift fast, wheel zoom
//   replay    Space play / pause, J / L 5 s back / on, U / I one frame back / on, [ ] slower /
//             faster (down to rewind), Home / End, click or drag the timeline; N / B next /
//             previous event (overtakes, contacts, pit stops, fastest laps, safety car), E the
//             event list, Y the highlights (plays every event in turn), P saves a photo
//   H hides the overlay, Tab the timing tower, Esc leaves
(function (G) {
  'use strict';
  const F1 = G.F1;
  const U = F1.U;

  const MODES = ['chase', 'far', 'tcam', 'cockpit', 'helmet', 'nose', 'side', 'tv', 'heli', 'blimp', 'top', 'map', 'orbit', 'free'];
  const NAMES = { chase: 'CHASE', far: 'FAR CHASE', tcam: 'T-CAM', cockpit: 'COCKPIT', helmet: 'HELMET', nose: 'NOSE', side: 'SIDEPOD', tv: 'TV', heli: 'HELICOPTER', blimp: 'BLIMP', top: 'TOP DOWN', map: 'MAP', orbit: 'ORBIT', free: 'FREE CAMERA' };
  const RATES = [-2, -1, 0.1, 0.25, 0.5, 1, 2, 4, 8];

  const V = {
    on: false, kind: null, mode: 'tv', focusId: null, director: false, dirT: 0, overlay: true, tower: true,
    free: { x: 0, y: 30, z: 0, yaw: 0, pitch: -0.3, fov: 60 }, keys: new Set(), drag: null, player: null, snap: false,
  };

  // ---------- following ----------
  function order(race) { return race.order && race.order.length ? race.order : race.cars; }
  function focus(race) {
    const cars = race.cars;
    let c = cars.find(x => x.id === V.focusId);
    if (!c || (c.retired && c.hidden)) { c = order(race).find(x => !(x.retired && x.hidden)) || cars[0]; V.focusId = c.id; }
    return c;
  }
  function stepCar(race, d) {
    const list = order(race).filter(x => !(x.retired && x.hidden));
    const k = list.findIndex(x => x.id === V.focusId);
    const n = list[((k < 0 ? 0 : k) + d + list.length) % list.length];
    if (n) { V.focusId = n.id; V.snap = true; flash(); }
  }
  function setMode(m, race) {
    if (m === 'free' && V.mode !== 'free') {
      // start the free camera where the current one is, looking the same way
      const cam = F1.R3 && F1.R3.camera;
      if (cam) {
        const d = new (G.THREE.Vector3)(); cam.getWorldDirection(d);
        Object.assign(V.free, { x: cam.position.x, y: cam.position.y, z: cam.position.z, yaw: Math.atan2(d.z, d.x), pitch: Math.asin(U.clamp(d.y, -1, 1)), fov: cam.fov });
      } else { const c = focus(race); Object.assign(V.free, { x: c.x - 30, y: 20, z: c.y, yaw: 0, pitch: -0.4 }); }
    }
    V.mode = m; V.snap = true; flash();
  }

  // ---------- director: cut to a battle, or the leader, with a fitting camera ----------
  function direct(race, dt) {
    V.dirT -= dt;
    if (V.dirT > 0) return;
    V.dirT = 6 + Math.random() * 6;
    const list = order(race).filter(c => !c.retired && !c.finished);
    let pick = list[0];
    // the closest fight on track
    let best = 1e9;
    for (let k = 1; k < list.length; k++) { const gap = Math.abs((list[k - 1].dist || 0) - (list[k].dist || 0)); if (gap < best && gap < 60) { best = gap; pick = list[k]; } }
    if (Math.random() < 0.25 && list.length) pick = list[Math.floor(Math.random() * Math.min(list.length, 10))];
    if (pick) V.focusId = pick.id;
    const cams = ['tv', 'tv', 'tv', 'heli', 'chase', 'tcam', 'orbit', 'blimp', 'nose', 'side'];
    V.mode = cams[Math.floor(Math.random() * cams.length)];
    V.snap = true; flash();
  }

  // ---------- free camera ----------
  function flyFree(dt) {
    const f = V.free, k = V.keys, sp = (k.has('ShiftLeft') || k.has('ShiftRight') ? 90 : 25) * dt;
    const cx = Math.cos(f.yaw), cz = Math.sin(f.yaw);
    if (k.has('KeyW')) { f.x += cx * sp; f.z += cz * sp; }
    if (k.has('KeyS')) { f.x -= cx * sp; f.z -= cz * sp; }
    if (k.has('KeyA')) { f.x += cz * sp; f.z -= cx * sp; }
    if (k.has('KeyD')) { f.x -= cz * sp; f.z += cx * sp; }
    if (k.has('KeyE')) f.y += sp;
    if (k.has('KeyQ')) f.y = Math.max(0.5, f.y - sp);
    const turn = 1.4 * dt;
    if (k.has('ArrowLeft')) f.yaw -= turn;
    if (k.has('ArrowRight')) f.yaw += turn;
    if (k.has('ArrowUp')) f.pitch = Math.min(1.5, f.pitch + turn);
    if (k.has('ArrowDown')) f.pitch = Math.max(-1.5, f.pitch - turn);
  }

  // ---------- overlay ----------
  let el = null, refs = null;
  function build() {
    if (el) return;
    el = document.createElement('div');
    el.id = 'viewer';
    el.innerHTML = `
      <div class="vw-top"><div class="vw-badge"><i></i><b class="vw-kind">REPLAY</b><span class="vw-trk"></span></div><div class="vw-lap"></div></div>
      <div class="vw-tower"></div>
      <div class="vw-card"><div class="vw-pos"></div><div class="vw-who"><div class="vw-name"></div><div class="vw-team"></div></div>
        <div class="vw-tel"><div class="vw-spd"><b></b><small>KM/H</small></div><div class="vw-gear"></div><div class="vw-ped"><i class="vw-thr"></i><i class="vw-brk"></i></div><div class="vw-drs">DRS</div></div><div class="vw-gaps"></div></div>
      <div class="vw-cam"><span class="vw-dir" title="Director (D)">DIRECTOR</span><span class="vw-camn" title="Next camera (C)"></span><button class="vw-x" title="Esc"></button></div>
      <div class="vw-bar">
        <div class="vw-ctl"><button class="vw-b vw-pev" title="Previous event (B)">&#8676;</button><button class="vw-b vw-back" title="5 s back (J)">&#9664;&#9664;</button><button class="vw-b vw-play" title="Play / pause (Space)"></button><button class="vw-b vw-fwd" title="5 s on (L)">&#9654;&#9654;</button><button class="vw-b vw-nev" title="Next event (N)">&#8677;</button><button class="vw-b vw-rate" title="Speed ([ and ])"></button></div>
        <div class="vw-tl"><div class="vw-laps"></div><div class="vw-evs"></div><div class="vw-fill"></div><div class="vw-head"></div></div>
        <div class="vw-time"></div>
      </div>
      <div class="vw-help"></div>
      <div class="vw-list"><div class="vw-lt">EVENTS</div><div class="vw-li"></div></div>
      <div class="vw-note"></div>`;
    document.body.appendChild(el);
    const q = s => el.querySelector(s);
    refs = { kind: q('.vw-kind'), trk: q('.vw-trk'), lap: q('.vw-lap'), tower: q('.vw-tower'), card: q('.vw-card'), pos: q('.vw-pos'), name: q('.vw-name'), team: q('.vw-team'),
      spd: q('.vw-spd b'), gear: q('.vw-gear'), thr: q('.vw-thr'), brk: q('.vw-brk'), drs: q('.vw-drs'), camn: q('.vw-camn'), dir: q('.vw-dir'), bar: q('.vw-bar'), play: q('.vw-play'),
      rate: q('.vw-rate'), tl: q('.vw-tl'), evs: q('.vw-evs'), list: q('.vw-list'), li: q('.vw-li'), note: q('.vw-note'), gaps: q('.vw-gaps'), fill: q('.vw-fill'), head: q('.vw-head'), laps: q('.vw-laps'), time: q('.vw-time'), help: q('.vw-help') };
    // the timeline: click or drag to any moment
    const seekTo = e => { const P = V.player; if (!P) return; const r = refs.tl.getBoundingClientRect(); P.seekTime(U.clamp((e.clientX - r.left) / r.width, 0, 1) * P.length()); };
    refs.tl.addEventListener('pointerdown', e => { refs.tl.setPointerCapture(e.pointerId); V.scrub = true; seekTo(e); });
    refs.tl.addEventListener('pointermove', e => { if (V.scrub) seekTo(e); });
    refs.tl.addEventListener('pointerup', () => { V.scrub = false; });
    refs.play.addEventListener('click', () => key('Space'));
    // buttons for a touch screen (no keyboard): events, speed, the director, leaving
    q('.vw-pev').addEventListener('click', () => key('KeyB'));
    q('.vw-nev').addEventListener('click', () => key('KeyN'));
    refs.rate.addEventListener('click', () => { const P = V.player; if (!P) return; const k = RATES.indexOf(P.rate); P.rate = RATES[k >= RATES.length - 1 || k < 0 ? 2 : k + 1]; P.playing = true; });
    refs.dir.addEventListener('click', () => key('KeyD'));
    q('.vw-x').addEventListener('click', () => { if (V.onExit) V.onExit(); });
    // on a touch screen: tap the camera name for the next camera, the car card for the next car
    refs.camn.addEventListener('click', () => key('KeyC'));
    refs.card.addEventListener('click', () => key('ArrowRight'));
    const jumpTo = id => { const P = V.player, e = P && P.events[+id]; if (e) goEvent(e); };
    refs.evs.addEventListener('pointerdown', e => { const m = e.target.closest('i'); if (m) { e.stopPropagation(); jumpTo(m.dataset.k); } });
    refs.li.addEventListener('click', e => { const r = e.target.closest('[data-k]'); if (r) jumpTo(r.dataset.k); });
    q('.vw-back').addEventListener('click', () => key('KeyJ'));
    q('.vw-fwd').addEventListener('click', () => key('KeyL'));
    // the free camera looks round with the mouse held down on the picture
    window.addEventListener('pointerdown', e => { if (V.on && V.mode === 'free' && e.target.tagName === 'CANVAS') V.drag = { x: e.clientX, y: e.clientY }; });
    window.addEventListener('pointermove', e => { if (!V.drag) return; V.free.yaw += (e.clientX - V.drag.x) * 0.004; V.free.pitch = U.clamp(V.free.pitch - (e.clientY - V.drag.y) * 0.004, -1.5, 1.5); V.drag = { x: e.clientX, y: e.clientY }; });
    window.addEventListener('pointerup', () => { V.drag = null; });
    window.addEventListener('wheel', e => { if (V.on && V.mode === 'free') V.free.fov = U.clamp(V.free.fov + Math.sign(e.deltaY) * 4, 15, 100); }, { passive: true });
  }
  let flashT = 0;
  function flash() { flashT = 2.2; }
  const fmt = s => { s = Math.max(0, s); const m = Math.floor(s / 60); return m + ':' + (s - m * 60).toFixed(1).padStart(4, '0'); };
  const tcol = t => (t.base === '#121417' ? t.accent : t.base);
  let towerT = 0;
  function draw(race, dt) {
    if (!el) return;
    el.classList.toggle('off', !V.overlay);
    el.classList.toggle('replay', V.kind === 'replay');
    if (!V.overlay) return;
    const c = focus(race), P = V.player;
    refs.kind.textContent = V.kind === 'replay' ? 'REPLAY' : 'LIVE';
    refs.trk.textContent = race.track.name.toUpperCase();
    const lap = Math.max(1, Math.min(race.laps || 1, P && P.leaderLap ? P.leaderLap : (order(race)[0] && order(race)[0].lap) || 1));
    refs.lap.innerHTML = race.mode === 'tt' ? `<b>${fmt(race.time)}</b>` : `LAP <b>${lap}</b> / ${race.laps}`;
    // the car card
    refs.card.style.setProperty('--tc', tcol(c.team));
    refs.pos.textContent = race.mode === 'tt' ? '' : 'P' + (c.pos || '-');
    refs.name.textContent = `${c.driver.first} ${c.driver.last.toUpperCase()}`;
    refs.team.textContent = c.team.name.toUpperCase() + (c.inPit ? '  /  IN THE PITS' : c.retired ? '  /  OUT' : '');
    refs.spd.textContent = Math.round((c.speed || 0) * 3.6);
    refs.gear.textContent = c.gear > 0 ? c.gear : 'N';
    refs.thr.style.height = Math.round(U.clamp(c.throttleOut != null ? c.throttleOut : c.ctl.throttle, 0, 1) * 100) + '%';
    refs.brk.style.height = Math.round(U.clamp(c.ctl ? c.ctl.brake : 0, 0, 1) * 100) + '%';
    refs.drs.classList.toggle('on', !!c.drsOpen);
    // camera name, briefly brighter after a change
    flashT = Math.max(0, flashT - dt);
    refs.camn.textContent = NAMES[V.mode] || V.mode.toUpperCase();
    refs.camn.parentNode.classList.toggle('lit', flashT > 0);
    refs.dir.classList.toggle('on', V.director);
    el.querySelector('.vw-x').innerHTML = V.kind === 'replay' ? 'EXIT' : '&#10073;&#10073;';
    // the timing tower, a few times a second
    towerT -= dt;
    refs.tower.classList.toggle('off', !V.tower);
    if (V.tower && towerT <= 0) {
      towerT = 0.25;
      const list = order(race).slice().sort((a, b) => (a.pos || 99) - (b.pos || 99));
      const lead = list[0];
      refs.tower.innerHTML = list.map((x, k) => {
        let gap = '';
        if (race.mode !== 'tt') gap = k === 0 ? 'LEADER' : x.retired ? 'OUT' : x.inPit ? 'PIT' : (lead.dist - x.dist > race.track.L ? '+' + Math.floor((lead.dist - x.dist) / race.track.L) + ' LAP' : '+' + ((lead.dist - x.dist) / Math.max(30, lead.speed || 60)).toFixed(1));
        return `<div class="vw-row${x.id === V.focusId ? ' me' : ''}" data-id="${x.id}"><span class="p">${race.mode === 'tt' ? '' : k + 1}</span><span class="sw" style="background:${tcol(x.team)}"></span><span class="c">${x.driver.code}</span><span class="g">${gap}</span></div>`;
      }).join('');
    }
    // the timeline
    if (P) {
      const len = Math.max(0.01, P.length()), at = P.pos();
      refs.fill.style.width = (at / len * 100) + '%';
      refs.head.style.left = (at / len * 100) + '%';
      refs.play.innerHTML = P.playing ? '&#10073;&#10073;' : '&#9654;';
      refs.rate.textContent = (P.rate < 0 ? 'REWIND ' + -P.rate : P.rate) + 'x';
      refs.time.textContent = fmt(at) + ' / ' + fmt(len);
      if (!refs.evs.dataset.done) {
        refs.evs.dataset.done = '1';
        refs.evs.innerHTML = P.events.map((e, k) => `<i class="ev-${e.type}" data-k="${k}" title="${fmt(e.at)}  ${e.label}" style="left:${(e.at / len * 100).toFixed(2)}%"></i>`).join('');
        refs.li.innerHTML = P.events.length ? P.events.map((e, k) => `<div class="ev-${e.type}" data-k="${k}"><span>${fmt(e.at)}</span>${e.label}</div>`).join('') : '<div class="none">NOTHING YET</div>';
      }
      if (!refs.laps.dataset.done) {
        // a tick at every lap the leader starts
        refs.laps.dataset.done = '1';
        refs.laps.innerHTML = (P.lapMarks || []).map(m => `<i style="left:${(m.t / len * 100).toFixed(2)}%"><em>${race.laps && m.lap > race.laps ? 'FINISH' : 'L' + m.lap}</em></i>`).join('');
      }
    }
    // gaps to the cars either side on the road
    {
      const L = order(race).slice().sort((a, b) => (a.pos || 99) - (b.pos || 99)), k = L.indexOf(c);
      const g = o => (Math.abs((o.dist || 0) - (c.dist || 0)) / Math.max(30, c.speed || 60)).toFixed(1);
      refs.gaps.innerHTML = race.mode === 'tt' ? '' : `${k > 0 ? `<span>AHEAD ${L[k - 1].driver.code} <b>${g(L[k - 1])}</b></span>` : '<span>LEADING</span>'}${k >= 0 && k < L.length - 1 ? `<span>BEHIND ${L[k + 1].driver.code} <b>${g(L[k + 1])}</b></span>` : ''}`;
    }
    refs.list.classList.toggle('on', !!V.list && !!P);
    // the highlights: each event from a little before, then on to the next
    if (V.hl && P) {
      V.hlT -= dt * Math.abs(P.rate || 1);
      if (V.hlT <= 0 || !P.playing) { const e = P.nextEvent(1); if (e) goEvent(e, 9); else { V.hl = false; note('END OF HIGHLIGHTS'); } }
    }
    noteT = Math.max(0, noteT - dt);
    refs.note.classList.toggle('on', noteT > 0);
    refs.help.textContent = V.mode === 'free'
      ? 'WASD MOVE   Q E DOWN UP   DRAG OR ARROWS LOOK   SHIFT FAST   WHEEL ZOOM   C NEXT CAMERA   ESC EXIT'
      : (V.kind === 'replay' ? 'SPACE PLAY   J L SKIP   U I FRAME   [ ] SPEED   N B EVENTS   E LIST   Y HIGHLIGHTS   P PHOTO   ' : '') + 'LEFT RIGHT CAR   C V CAMERA   1-0 DIRECT   F FREE   T TOP   G MAP   D DIRECTOR   TAB TOWER   H HIDE   ESC ' + (V.kind === 'replay' ? 'EXIT' : 'PAUSE');
  }
  // jump to an event: a few seconds before it, following the car it is about
  function goEvent(e, hold) {
    const P = V.player;
    if (!P || !e) return;
    P.seekTime(Math.max(0, e.at - 3)); P.playing = true; if (P.rate < 0) P.rate = 1;
    if (e.car != null) V.focusId = e.car;
    if (!V.director && ['top', 'map', 'blimp', 'free'].includes(V.mode)) V.mode = 'tv';
    V.snap = true; V.hlT = hold || 0; flash(); note(e.label);
  }
  let noteT = 0;
  function note(t) { if (refs) { refs.note.textContent = t; noteT = 3; } }
  // a photo of the picture (the overlay is not part of it), saved as a PNG. The WebGL canvas
  // is only readable straight after it is drawn, so the game calls afterRender() then
  function photo() { V.photoReq = true; }
  function afterRender() {
    if (!V.photoReq) return;
    V.photoReq = false;
    const R = F1.R3 && F1.R3.renderer;
    if (!R) return;
    try {
      const a = document.createElement('a');
      a.download = 'slipstream-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.png';
      a.href = R.domElement.toDataURL('image/png');
      a.click();
      note('PHOTO SAVED');
    } catch (err) { note('PHOTO FAILED'); }
  }

  // clicking a driver in the tower follows them
  document.addEventListener('click', e => {
    const row = V.on && e.target.closest && e.target.closest('.vw-row');
    if (row) { V.focusId = +row.dataset.id; V.snap = true; flash(); }
  });

  // ---------- keys ----------
  let raceRef = null;
  // returns true when the key was used here
  function key(code) {
    if (!V.on) return false;
    const race = raceRef, P = V.player;
    if (V.mode === 'free' && ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'ShiftLeft', 'ShiftRight'].includes(code)) return true;
    const k = MODES.indexOf(V.mode);
    if (code === 'KeyC') { V.director = false; setMode(MODES[(k + 1) % MODES.length], race); return true; }
    if (code === 'KeyV') { V.director = false; setMode(MODES[(k - 1 + MODES.length) % MODES.length], race); return true; }
    if (/^Digit[0-9]$/.test(code)) { const n = +code.slice(5); V.director = false; setMode(MODES[n === 0 ? 9 : n - 1], race); return true; }
    if (code === 'KeyF') { V.director = false; setMode(V.mode === 'free' ? 'chase' : 'free', race); return true; }
    if (code === 'KeyT') { V.director = false; setMode('top', race); return true; }
    if (code === 'KeyG') { V.director = false; setMode('map', race); return true; }
    if (code === 'ArrowRight' || code === 'Period') { V.director = false; stepCar(race, 1); return true; }
    if (code === 'ArrowLeft' || code === 'Comma') { V.director = false; stepCar(race, -1); return true; }
    if (code === 'ArrowUp') { const l = order(race)[0]; if (l) { V.focusId = l.id; V.snap = true; } return true; }
    if (code === 'ArrowDown') { const o = order(race); const l = o[o.length - 1]; if (l) { V.focusId = l.id; V.snap = true; } return true; }
    if (code === 'KeyD') { V.director = !V.director; V.dirT = 0; return true; }
    if (code === 'KeyH') { V.overlay = !V.overlay; return true; }
    if (code === 'Tab') { V.tower = !V.tower; return true; }
    if (P) {
      if (code === 'Space' || code === 'KeyK') { if (!P.playing && P.t >= P.f1) P.seek(P.f0); P.playing = !P.playing; if (P.rate < 0 && P.playing && P.t <= P.f0) P.rate = 1; return true; }
      if (code === 'KeyJ') { P.seekTime(P.pos() - 5); V.snap = true; return true; }
      if (code === 'KeyL') { P.seekTime(P.pos() + 5); V.snap = true; return true; }
      if (code === 'BracketLeft' || code === 'Minus') { P.rate = RATES[Math.max(0, RATES.indexOf(P.rate) - 1)]; P.playing = true; return true; }
      if (code === 'BracketRight' || code === 'Equal') { P.rate = RATES[Math.min(RATES.length - 1, RATES.indexOf(P.rate) + 1)]; P.playing = true; return true; }
      if (code === 'KeyU') { P.playing = false; P.seek(Math.round(P.t) - 1); return true; }
      if (code === 'KeyI') { P.playing = false; P.seek(Math.round(P.t) + 1); return true; }
      if (code === 'KeyN') { const e = P.nextEvent(1); if (e) goEvent(e); else note('NO MORE EVENTS'); return true; }
      if (code === 'KeyB') { const e = P.nextEvent(-1); if (e) goEvent(e); else note('NO EARLIER EVENTS'); return true; }
      if (code === 'KeyE') { V.list = !V.list; return true; }
      if (code === 'KeyY') { V.hl = !V.hl; if (V.hl) { P.seek(P.f0); V.hlT = 0; P.rate = 1; P.playing = true; note('HIGHLIGHTS'); } return true; }
      if (code === 'KeyP') { photo(); return true; }
      if (code === 'Home') { P.seek(P.f0); V.snap = true; return true; }
      if (code === 'End') { P.seek(P.f1); V.snap = true; return true; }
    }
    return false;
  }

  // ---------- life cycle ----------
  function start(kind, race, o = {}) {
    build();
    V.on = true; V.kind = kind; raceRef = race; V.player = o.player || null;
    V.director = !!o.director;
    V.onExit = o.onExit || null;
    if (o.focusId != null) V.focusId = o.focusId;
    if (o.mode) V.mode = o.mode;
    V.snap = true; V.keys.clear();
    if (refs) { delete refs.laps.dataset.done; delete refs.evs.dataset.done; }
    V.hl = false; V.list = false;
    el.classList.add('show');
    flash();
  }
  function stop() {
    V.on = false; V.player = null; raceRef = null; V.keys.clear(); V.drag = null;
    if (el) el.classList.remove('show');
  }
  // per frame: the director, the free camera, the overlay
  function update(race, dt) {
    if (!V.on) return;
    raceRef = race;
    if (V.director) direct(race, dt);
    if (V.mode === 'free') flyFree(dt);
    draw(race, dt);
  }
  // what the renderer needs this frame
  function view(race) {
    const o = { mode: V.mode, focus: focus(race), free: V.mode === 'free' ? V.free : null, snap: V.snap };
    V.snap = false;
    return o;
  }

  // tucked away while a menu (pause) is over the picture
  function hide(on) { if (el) el.classList.toggle('show', V.on && !on); }

  F1.Viewer = { V, MODES, NAMES, start, stop, update, view, key, focus, afterRender, hide, keyDown: c => V.keys.add(c), keyUp: c => V.keys.delete(c) };
})(typeof window !== 'undefined' ? window : globalThis);
