// Game controller: main loop, input, camera, effects, race lifecycle, attract mode,
// championship and persistence.
(function (G) {
  'use strict';
  const F1 = G.F1;
  const U = F1.U, Race = F1.Race, Render = F1.Render, HUD = F1.HUD, UIm = F1.UI, Audio = F1.Audio, Tracks = F1.Tracks, Car = F1.Car;

  const DT = 1 / 240;
  const cv = document.getElementById('world');
  const ctx = cv.getContext('2d');
  // 3D view underneath; #world stays on top as the overlay for name tags and letterbox.
  // If WebGL is unavailable the game falls back to the original 2D renderer.
  const R3 = F1.R3;
  let R3ok = false;
  try { R3.init(document.getElementById('gl')); R3ok = true; } catch (e) { console.warn('WebGL unavailable, using the 2D renderer', e); }
  document.body.classList.toggle('three', R3ok);
  const miniCv = document.getElementById('minimap');
  const miniCtx = miniCv.getContext('2d');

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };

  const Game = F1.Game = {
    state: 'boot', race: null, world: null, flow: { kind: 'race', mode: 'arcade', track: 'kestrel', team: 0, driver: 0 },
    settings: Object.assign({ master: 0.8, sfx: 0.9, music: 0.5, camera: 'chase', zoom: 1, zoomStep: 1, units: 'kmh', gapMode: 'interval', tags: true, headMotion: true,
      mobile: 'auto', touchSteer: 'pad', tSens: 1, tiltSens: 1, mSens: 1, mDead: 0.04, mCurve: 'progressive', mCentre: 0, mSmooth: 0.04, mInvert: false }, store.get('slip_settings', {})),
    raceDefaults: Object.assign({ laps: 3, difficulty: 2, grid: 10, field: 20, compound: 'M', abs: true, tc: 1, autoGear: true, steerAssist: true, damage: 'full', lineSim: 'brake', lineArcade: 'full' }, store.get('slip_race', {})),
    champ: null, paused: false, hudOn: true,
  };
  // graphics presets for the 3D renderer (see Settings > Graphics)
  const GFX_PRESETS = Game.GFX_PRESETS = {
    // low targets integrated GPUs (Intel UHD 620 class): no post stack, one shadow slice, no
    // grass cards, a 1x pixel ratio cap and earlier car LOD (lite)
    // potato: for when low is still too slow. No shadows, half resolution, and at boot no canvas
    // MSAA and a plain depth buffer (see POT in js/render3d.js), so switching to or from it reloads
    potato: { potato: true, lite: true, post: false, scale: 0.5, msaa: 0, shadows: 'off', ssao: false, bloom: false, shafts: false, motion: false, lens: false },
    low: { potato: false, lite: true, post: false, scale: 0.7, msaa: 0, shadows: 'low', ssao: false, bloom: false, shafts: false, motion: false, lens: false },
    medium: { potato: false, lite: false, post: true, scale: 1, msaa: 2, shadows: 'medium', ssao: false, bloom: true, shafts: false, motion: false, lens: true },
    high: { potato: false, lite: false, post: true, scale: 1, msaa: 4, shadows: 'high', ssao: true, bloom: true, shafts: true, motion: true, lens: true },
    ultra: { potato: false, lite: false, post: true, scale: 1.5, msaa: 4, shadows: 'ultra', ssao: true, bloom: true, shafts: true, motion: true, lens: true },
  };
  // phones and tablets start on the low preset (a desktop starts on high)
  const COARSE = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  if (!Game.settings.gfx && COARSE) Game.settings.gfx = Object.assign({ preset: 'low', tone: 'agx', ev: 0 }, GFX_PRESETS.low);
  Game.settings.gfx = Object.assign({ preset: 'high', tone: 'agx', ev: 0 }, GFX_PRESETS.high, Game.settings.gfx || {});
  // settings saved before the lite flag existed
  Game.settings.gfx.potato = Game.settings.gfx.preset === 'potato';
  if (Game.settings.gfx.lite === undefined) Game.settings.gfx.lite = Game.settings.gfx.preset === 'low';

  // ---------- canvas ----------
  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    if (R3ok) R3.resize(W, H, DPR);
    const md = Math.min(2, window.devicePixelRatio || 1);
    miniCv.width = 220 * md; miniCv.height = 220 * md;
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------- input ----------
  const keys = new Set();
  const inp = { steer: 0, thr: 0, brk: 0 };

  // ---------- touch (mobile mode) ----------
  // Mobile mode (Settings: AUTO follows a touch screen) puts driving controls over the race:
  // the left half of the screen is a steering pad (put a thumb down anywhere and slide it
  // sideways, the further the harder), the right holds brake and throttle pedals, and small
  // buttons along the top pause, change camera and open DRS. Menus already work by tapping.
  // Several fingers at once are tracked by pointer id.
  const touch = { steer: 0, thr: false, brk: false, drs: false, sid: null, x0: 0, pads: new Map() };
  Game.mobile = () => Game.settings.mobile === 'on' || (Game.settings.mobile !== 'off' && COARSE);
  const tl = document.createElement('div');
  tl.id = 'touch';
  tl.innerHTML = '<div class="t-steer"><div class="t-knob"></div></div>' +
    '<div class="t-btn t-pause" data-k="Escape">II</div><div class="t-btn t-cam" data-k="KeyC">CAM</div><div class="t-btn t-drs" data-hold="drs">DRS</div>' +
    '<div class="t-btn t-pit" data-k="KeyP">PIT</div><div class="t-btn t-gup" data-k="KeyE">+</div><div class="t-btn t-gdn" data-k="KeyQ">&minus;</div>' +
    '<div class="t-pedal t-brk" data-hold="brk">BRAKE</div><div class="t-pedal t-thr" data-hold="thr">GAS</div>';
  document.body.appendChild(tl);
  const knob = tl.querySelector('.t-knob'), steerZone = tl.querySelector('.t-steer');
  const setKnob = () => { knob.style.transform = 'translateX(' + (touch.steer * 70) + 'px)'; };
  tl.addEventListener('pointerdown', e => {
    e.preventDefault(); Audio.init(); if (useTilt()) askTilt();
    const el = e.target.closest('[data-k],[data-hold],.t-steer');
    if (!el) return;
    if (el.dataset.k) { onKey(el.dataset.k, false); el.classList.add('on'); setTimeout(() => el.classList.remove('on'), 150); return; }
    if (el.setPointerCapture) el.setPointerCapture(e.pointerId);
    if (el.dataset.hold) { touch[el.dataset.hold] = true; touch.pads.set(e.pointerId, el); el.classList.add('on'); return; }
    if (useTilt()) { askTilt(); Game.tiltZero(); return; }
    touch.sid = e.pointerId; touch.x0 = e.clientX; touch.steer = 0; setKnob();
    knob.style.left = (e.clientX - steerZone.getBoundingClientRect().left - 34) + 'px'; knob.classList.add('on');
  });
  tl.addEventListener('pointermove', e => {
    if (e.pointerId !== touch.sid) return;
    touch.steer = U.clamp((e.clientX - touch.x0) / Math.max(40, innerWidth * 0.11 / (Game.settings.tSens || 1)), -1, 1); setKnob();
  });
  const lift = e => {
    if (e.pointerId === touch.sid) { touch.sid = null; touch.steer = 0; setKnob(); knob.classList.remove('on'); }
    const el = touch.pads.get(e.pointerId);
    if (el) { touch[el.dataset.hold] = false; el.classList.remove('on'); touch.pads.delete(e.pointerId); }
  };
  tl.addEventListener('pointerup', lift); tl.addEventListener('pointercancel', lift);
  function showTouch() {
    const on = Game.mobile() && Game.state === 'race' && !Game.paused;
    tl.classList.toggle('show', on);
    tl.classList.toggle('tilt', useTilt());
    // sim races: the pit-strategy button, and shift buttons when the gears are manual
    const R = Game.race, sim = !!(on && R && R.sim);
    tl.classList.toggle('sim', sim);
    tl.classList.toggle('manual', sim && R.player && R.player.assist && R.player.assist.autoGear === false);
    document.body.classList.toggle('mobile', Game.mobile());
    if (!on) { touch.thr = touch.brk = touch.drs = false; touch.sid = null; touch.steer = 0; touch.pads.clear(); tilt.zero = null; } // tilt re-centres when the race resumes
  }
  Game.showTouch = showTouch;

  // Tilt steering: hold the phone like a wheel and turn it. Gravity is read in the screen's
  // own plane (devicemotion, rotated by the screen orientation), so the steering angle is the
  // phone's roll whatever way up it is held; the centre is wherever the phone was at the
  // start of the race (or when it is recalibrated by tapping the steering half). Full lock at
  // 35 degrees of roll divided by the sensitivity. iOS asks permission on the first tap.
  const tilt = { a: 0, zero: null, ok: false, asked: false };
  function askTilt() {
    if (tilt.asked) return;
    tilt.asked = true;
    const D = window.DeviceMotionEvent;
    if (D && typeof D.requestPermission === 'function') D.requestPermission().then(r => { tilt.ok = r === 'granted'; }).catch(() => {});
    else tilt.ok = true;
  }
  window.addEventListener('devicemotion', e => {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null) return;
    tilt.ok = true;
    const ang = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * Math.PI / 180;
    // device axes to screen axes
    const sx = g.x * Math.cos(ang) + g.y * Math.sin(ang), sy = -g.x * Math.sin(ang) + g.y * Math.cos(ang);
    tilt.a = Math.atan2(sx, -sy) * 180 / Math.PI;
    if (tilt.zero === null) tilt.zero = tilt.a;
  });
  Game.tiltSteer = () => {
    if (!tilt.ok || tilt.zero === null) return null;
    let d = tilt.a - tilt.zero; d = ((d + 540) % 360) - 180;
    return U.clamp(d / (35 / (Game.settings.tiltSens || 1)), -1, 1);
  };
  Game.tiltZero = () => { tilt.zero = null; };
  const useTilt = () => Game.settings.touchSteer === 'tilt';
  window.addEventListener('keydown', e => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab'].includes(e.code)) e.preventDefault();
    if (e.repeat && !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyS', 'KeyA', 'KeyD'].includes(e.code)) return;
    keys.add(e.code);
    Audio.init();
    onKey(e.code, e.repeat);
  });
  window.addEventListener('keyup', e => keys.delete(e.code));
  window.addEventListener('blur', () => { keys.clear(); if (Game.state === 'race' && !Game.paused) pause(); });
  window.addEventListener('pointerdown', e => {
    Audio.init();
    if (e.button === 0 && UIm.UI.cur && UIm.UI.cur.id === 'title') UIm.key('Enter');
    if (e.button === 0 && Game.state === 'loading' && Game.onLoadReady) Game.onLoadReady();
  });

  // ---------- mouse steering ----------
  // Right click in a race toggles it. With pointer lock the mouse turns a virtual
  // wheel (relative movement); without it the cursor's distance from the screen
  // centre is the steering position. Deadzone, curve, smoothing, self-centring and
  // sensitivity come from Settings.
  const mouse = { on: false, v: 0, raw: 0, out: 0, x: null, locked: false, quiet: false };
  const CURVES = { linear: 1, progressive: 1.6, aggressive: 2.3 };
  window.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('mousedown', e => {
    if (e.button !== 2 || Game.state !== 'race' || Game.paused) return;
    setMouseSteer(!mouse.on);
  });
  window.addEventListener('mousemove', e => {
    if (!mouse.on) return;
    const st = Game.settings, inv = st.mInvert ? -1 : 1;
    if (mouse.locked) mouse.v = U.clamp(mouse.v + e.movementX * 0.0025 * st.mSens * inv, -1, 1);
    else mouse.x = e.clientX;
  });
  document.addEventListener('pointerlockchange', () => {
    mouse.locked = document.pointerLockElement === cv;
    if (!mouse.locked && mouse.on && !mouse.quiet && Game.state === 'race' && !Game.paused) pause();
    mouse.quiet = false;
  });
  function lockMouse() {
    try {
      const r = cv.requestPointerLock();
      if (r && r.catch) r.catch(() => { mouse.locked = false; });
    } catch (err) { mouse.locked = false; }
  }
  function unlockMouse() {
    if (document.pointerLockElement) { mouse.quiet = true; document.exitPointerLock(); }
  }
  function setMouseSteer(on, silent) {
    mouse.on = on; mouse.v = 0; mouse.out = 0; mouse.raw = 0; mouse.x = null;
    if (on) lockMouse(); else unlockMouse();
    document.getElementById('msteer').classList.toggle('show', on);
    if (!silent) {
      HUD.message(on ? 'MOUSE STEERING ON' : 'MOUSE STEERING OFF', on ? 'blue' : '', on ? 'RIGHT CLICK TO TURN OFF' : '', 1.6);
      Audio.ui.tick();
    }
  }
  Game.mouse = mouse;
  function mouseSteer(dt) {
    const st = Game.settings;
    let raw;
    if (mouse.locked) {
      // self-centring pulls the virtual wheel back when the mouse is still
      if (st.mCentre > 0) mouse.v *= Math.exp(-st.mCentre * dt);
      raw = mouse.v;
    } else {
      if (mouse.x == null) return 0;
      raw = U.clamp((mouse.x - W / 2) / (W * 0.4) * st.mSens * (st.mInvert ? -1 : 1), -1, 1);
    }
    mouse.raw = raw;
    const a = Math.abs(raw);
    let o = a <= st.mDead ? 0 : (a - st.mDead) / (1 - st.mDead);
    o = Math.pow(o, CURVES[st.mCurve] || 1) * Math.sign(raw);
    mouse.out = st.mSmooth > 0 ? U.expDamp(mouse.out, o, 1 / st.mSmooth, dt) : o;
    return mouse.out;
  }
  function drawMouseGauge() {
    if (!mouse.on) return;
    const g = Game.msGauge || (Game.msGauge = {
      raw: document.querySelector('#msteer .raw'), out: document.querySelector('#msteer .out'), dz: document.querySelector('#msteer .dz'),
      mode: document.querySelector('#msteer .mode'),
    });
    const st = Game.settings;
    g.dz.style.width = (st.mDead * 100) + '%';
    g.raw.style.left = (50 + mouse.raw * 50) + '%';
    g.out.style.left = (mouse.out < 0 ? 50 + mouse.out * 50 : 50) + '%';
    g.out.style.width = (Math.abs(mouse.out) * 50) + '%';
    g.mode.textContent = mouse.locked ? 'MOUSE STEERING' : 'MOUSE STEERING  /  CURSOR MODE';
  }

  // F9: the graphics report (render3d diagnose), on screen and in the console
  function graphicsReport() {
    let el = document.getElementById('gfx-report');
    if (el) { el.remove(); return; }
    const d = R3ok ? R3.diagnose() : { renderer: '2D fallback (WebGL unavailable)' };
    console.log('Slipstream graphics report', d);
    el = document.createElement('div'); el.id = 'gfx-report';
    el.style.cssText = 'position:fixed;left:16px;top:16px;z-index:90;max-width:min(920px,92vw);padding:14px 16px;background:rgba(10,10,14,.94);color:#e8e8ee;font:12px/1.55 Consolas,monospace;white-space:pre-wrap;border-top:3px solid #e10600';
    el.textContent = 'GRAPHICS REPORT (F9 to close)\n' + Object.entries(d).map(([k, v]) => k + ': ' + v).join('\n');
    document.body.appendChild(el);
  }
  function onKey(code, repeat) {
    if (code === 'F9') { graphicsReport(); return; }
    if (code === 'KeyM') { Game.muted = !Game.muted; Audio.setVolumes({ master: Game.muted ? 0 : Game.settings.master }); return; }
    if (Game.state === 'race' && !Game.paused) {
      const race = Game.race, p = race.player;
      if (code === 'Escape' || code === 'KeyP' && !race.sim) { pause(); return; }
      if (code === 'KeyC') {
        const list = R3ok ? CAMS : ['chase', 'fixed'];
        Game.settings.camera = list[(list.indexOf(Game.settings.camera) + 1) % list.length];
        saveSettings();
        if (R3ok) HUD.message('CAMERA  ' + CAM_NAMES[Game.settings.camera], '', '', 1.2);
        return;
      }
      if (code === 'KeyZ') {
        // three zoom steps: near, standard, far
        Game.settings.zoomStep = ((Game.settings.zoomStep == null ? 1 : Game.settings.zoomStep) + 1) % ZOOM_STEPS.length;
        saveSettings();
        HUD.message('CAMERA  ' + ZOOM_STEPS[Game.settings.zoomStep].name, '', '', 1.2);
        return;
      }
      if (code === 'KeyH') { Game.hudOn = !Game.hudOn; document.getElementById('hud').classList.toggle('off', !Game.hudOn); return; }
      if (code === 'KeyR' && race.mode !== 'sim' && race.green && !p.finished && !p.inPit) { race.recover(p); return; }
      if (race.sim && !p.assist.autoGear && race.green) {
        if (code === 'KeyE' || code === 'ShiftLeft') Car.shift(p, 1);
        if (code === 'KeyQ' || code === 'ControlLeft') Car.shift(p, -1);
      }
      if (race.sim && race.mode !== 'tt' && code === 'KeyP') {
        if (Game.pitMenu || p.brain.pit) { Game.pitMenu = false; if (p.brain.pit && p.brain.pit.phase === 'approach') { p.brain.pit = null; HUD.message('PIT STOP CANCELLED', 'yellow'); } }
        else if (!p.inPit && !p.finished) {
          Game.pitMenu = true;
          const adv = race.advice;
          document.getElementById('pp-advice').innerHTML = adv ? 'ENGINEER: <b>' + planText(adv) + '</b>' + (race.mandatory && new Set(p.tyreHist).size < 2 ? '  /  mandatory stop still to serve' : '') : '';
        }
        document.getElementById('pitpanel').classList.toggle('show', !!Game.pitMenu);
        return;
      }
      if (Game.pitMenu && ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5'].includes(code)) {
        const comp = ['S', 'M', 'H', 'I', 'W'][+code.slice(-1) - 1];
        p.pitPlan = { compound: comp };
        p.brain.pit = { phase: 'approach', service: 2.4, served: false };
        Game.pitMenu = false;
        document.getElementById('pitpanel').classList.remove('show');
        HUD.message('BOX, BOX', 'red', `${Car.COMPOUNDS[comp].name} TYRES  /  THIS LAP`);
        Audio.chime(true);
      }
      return;
    }
    if (Game.state === 'loading') {
      if ((code === 'Enter' || code === 'Space' || code === 'NumpadEnter') && Game.onLoadReady) Game.onLoadReady();
      return;
    }
    if (UIm.UI.cur) UIm.key(code);
  }

  // gamepad
  let padPrev = [];
  function pollPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && Array.from(pads).find(x => x);
    if (!gp) return null;
    const b = i => (gp.buttons[i] ? gp.buttons[i].value : 0);
    const pressed = i => b(i) > 0.5 && !(padPrev[i] > 0.5);
    const out = { steer: Math.abs(gp.axes[0]) > 0.08 ? gp.axes[0] : 0, thr: b(7), brk: b(6), active: false };
    out.active = Math.abs(out.steer) > 0 || out.thr > 0.05 || out.brk > 0.05;
    if (Game.state === 'race' && !Game.paused) {
      if (pressed(9)) pause();
      if (pressed(5)) onKey('KeyE');
      if (pressed(4)) onKey('KeyQ');
      if (pressed(3)) onKey('KeyP');
      out.drs = b(0) > 0.5;
      rumble(gp);
    } else {
      if (pressed(12)) onKey('ArrowUp'); if (pressed(13)) onKey('ArrowDown');
      if (pressed(14)) onKey('ArrowLeft'); if (pressed(15)) onKey('ArrowRight');
      if (pressed(0)) onKey('Enter'); if (pressed(1) || pressed(9) && Game.paused) onKey('Escape');
    }
    padPrev = gp.buttons.map(x => x.value);
    return out;
  }

  // Controller feedback from the physics: the low-frequency motor carries kerb strikes,
  // the plank bottoming out and impacts; the high-frequency motor carries tyres locking or
  // spinning past their peak, which is how a pad tells you the grip has gone.
  let rumbleT = 0;
  function rumble(gp) {
    const act = gp.vibrationActuator;
    const p = Game.race && Game.race.player;
    if (!act || !act.playEffect || !p) return;
    const now = performance.now();
    if (now - rumbleT < 60) return;
    rumbleT = now;
    const W = p.wheels, v = Math.min(1, p.speed / 60);
    const kerb = p.onKerb ? 0.25 + 0.35 * v : 0;
    const strong = Math.min(1, Math.max(kerb, (p.bottoming || 0) * 0.8, cam.shake * 0.8, p.surfMask & 0b11000 ? 0.3 * v : 0));
    const slip = Math.max(...W.map(w => Math.max(w.lock, w.spin)), Math.max(...W.map(w => w.slide)) * 0.6);
    const weak = Math.min(1, slip * 0.8 + (p.shiftT > 0 ? 0.25 : 0));
    if (strong < 0.02 && weak < 0.02) return;
    act.playEffect('dual-rumble', { duration: 90, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
  }

  function applyInput(p, dt, pad) {
    const arcade = Game.race.mode === 'arcade';
    let st = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    const thrK = keys.has('KeyW') || keys.has('ArrowUp'), brkK = keys.has('KeyS') || keys.has('ArrowDown');
    const ms = mouse.on ? mouseSteer(dt) : null;
    if (pad && pad.active) {
      inp.steer = pad.steer; inp.thr = pad.thr; inp.brk = pad.brk;
    } else if (Game.mobile() && useTilt() && Game.tiltSteer() !== null) {
      inp.steer = U.approach(inp.steer, Game.tiltSteer(), 12 * dt);
      inp.thr = U.approach(inp.thr, touch.thr ? 1 : 0, (touch.thr ? 6 : 12) * dt);
      inp.brk = U.approach(inp.brk, touch.brk ? 1 : 0, (touch.brk ? 7 : 14) * dt);
    } else if (Game.mobile() && (touch.sid != null || touch.thr || touch.brk || Math.abs(inp.steer) > 0.001 && st === 0 && !mouse.on)) {
      // the steering pad is analogue: follow it quickly, ease back to centre when let go
      inp.steer = U.approach(inp.steer, touch.steer, (touch.sid == null ? 7 : 10) * dt);
      inp.thr = U.approach(inp.thr, touch.thr ? 1 : 0, (touch.thr ? 6 : 12) * dt);
      inp.brk = U.approach(inp.brk, touch.brk ? 1 : 0, (touch.brk ? 7 : 14) * dt);
    } else {
      const toward = st === 0 ? 7 : (Math.sign(st) !== Math.sign(inp.steer) && inp.steer !== 0 ? 9 : (arcade ? 4.2 : 3.8));
      inp.steer = U.approach(inp.steer, st, toward * dt);
      inp.thr = U.approach(inp.thr, thrK ? 1 : 0, (thrK ? 6 : 12) * dt);
      inp.brk = U.approach(inp.brk, brkK ? 1 : 0, (brkK ? 7 : 14) * dt);
      // the mouse steers unless A / D are held
      if (ms != null && st === 0) inp.steer = ms;
    }
    p.ctl.steer = inp.steer; p.ctl.throttle = inp.thr; p.ctl.brake = inp.brk;
    p.ctl.drs = keys.has('Space') || (pad && pad.drs) || touch.drs || false;
  }

  // ---------- camera ----------
  const CAMS = ['chase', 'far', 'tcam', 'cockpit', 'helmet', 'tv'];
  const CAM_NAMES = { chase: 'CHASE', far: 'FAR CHASE', tcam: 'T-CAM', cockpit: 'COCKPIT', helmet: 'HELMET', tv: 'TV', fixed: 'FIXED' };
  Game.CAMS = CAMS; Game.CAM_NAMES = CAM_NAMES;
  if (Game.raceDefaults.damage === true) Game.raceDefaults.damage = 'full'; // the old ON becomes the full model
  if (!CAMS.includes(Game.settings.camera)) Game.settings.camera = 'chase';
  const ZOOM_STEPS = [{ name: 'NEAR', k: 1.35 }, { name: 'STANDARD', k: 1 }, { name: 'FAR', k: 0.66 }];
  const cam = { x: 0, y: 0, angle: -Math.PI / 2, zoom: 8, shake: 0, mode: 'chase', tvTarget: null, tvT: 0 };
  function updateCamera(dt, target, mode) {
    const sp = target.speed;
    const step = ZOOM_STEPS[Game.settings.zoomStep == null ? 1 : Game.settings.zoomStep] || ZOOM_STEPS[1];
    const base = H / 1080 * 10 * Game.settings.zoom * (mode === 'tv' ? 1 : step.k);
    const z = base * U.lerp(1, 0.56, U.smooth(Math.min(1, sp / 85)));
    cam.zoom = U.expDamp(cam.zoom, z, 1.6, dt);
    const look = 6 + sp * 0.26;
    const hx = Math.cos(target.h), hy = Math.sin(target.h);
    const tx = target.x + hx * look, ty = target.y + hy * look;
    const k = mode === 'tv' ? 2.2 : 9;
    cam.x = U.expDamp(cam.x, tx, k, dt); cam.y = U.expDamp(cam.y, ty, k, dt);
    if (mode === 'chase') {
      const want = target.h + Math.PI / 2;
      cam.angle += U.wrapAngle(want - cam.angle) * Math.min(1, dt * 4.5);
    } else cam.angle += U.wrapAngle(0 - cam.angle) * Math.min(1, dt * 3);
    cam.shake = Math.max(0, cam.shake - dt * 3);
  }

  function camMatrix() {
    const ax = W / 2, ay = cam.mode === 'chase' ? H * 0.57 : H / 2;
    const sx = (Math.random() - 0.5) * cam.shake * 10, sy = (Math.random() - 0.5) * cam.shake * 10;
    const c = Math.cos(-cam.angle), s = Math.sin(-cam.angle), z = cam.zoom;
    // screen = A + R * z * (world - cam)
    const a = c * z, b = s * z, cc = -s * z, d = c * z;
    const e = ax + sx - (a * cam.x + cc * cam.y), f = ay + sy - (b * cam.x + d * cam.y);
    return { a, b, c: cc, d, e, f };
  }

  function viewBox(m) {
    const det = m.a * m.d - m.b * m.c;
    const inv = (sx, sy) => { const x = sx - m.e, y = sy - m.f; return [(m.d * x - m.c * y) / det, (-m.b * x + m.a * y) / det]; };
    const pts = [inv(0, 0), inv(W, 0), inv(0, H), inv(W, H)];
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return { x0: Math.min(...xs) - 10, y0: Math.min(...ys) - 10, x1: Math.max(...xs) + 10, y1: Math.max(...ys) + 10 };
  }

  // ---------- effects ----------
  const FX = { parts: [], skid: new Float32Array(9000 * 5), skidN: 0, skidHead: 0, debris: [] };
  function addSkid(x1, y1, x2, y2, kind) {
    const k = FX.skidHead * 5;
    FX.skid[k] = x1; FX.skid[k + 1] = y1; FX.skid[k + 2] = x2; FX.skid[k + 3] = y2; FX.skid[k + 4] = kind;
    FX.skidHead = (FX.skidHead + 1) % 9000; FX.skidN = Math.min(9000, FX.skidN + 1);
  }
  let fxZ = 0; // ground height for the particles being spawned (the 3D view sits them on the road)
  function puff(x, y, vx, vy, r0, r1, life, col, a) {
    if (FX.parts.length > 900) return;
    FX.parts.push({ x, y, z: fxZ, vx, vy, r0, r1, life, t: 0, col, a, kind: 0 });
  }
  function spark(x, y, vx, vy) {
    if (FX.parts.length > 900) return;
    FX.parts.push({ x, y, z: fxZ, vx, vy, life: 0.22 + Math.random() * 0.2, t: 0, kind: 1 });
  }
  function carEffects(c, dt) {
    fxZ = c.zRoad || 0;
    const near = Math.hypot(c.x - cam.x, c.y - cam.y) < 260;
    if (!near) { c.wheels.forEach(w => { w.lmx = null; }); return; }
    const SURF = F1.SURF;
    for (const w of c.wheels) {
      const hard = w.lock > 0.35 || w.spin > 0.35 || w.slide > 0.9;
      const dirt = w.surf === SURF.GRASS || w.surf === SURF.GRAVEL;
      const mark = (hard && !dirt) || (dirt && c.speed > 6);
      if (mark && w.lmx != null) {
        const dx = w.wx - w.lmx, dy = w.wy - w.lmy;
        if (dx * dx + dy * dy > 0.5) { addSkid(w.lmx, w.lmy, w.wx, w.wy, dirt ? (w.surf === SURF.GRAVEL ? 2 : 1) : 0); w.lmx = w.wx; w.lmy = w.wy; }
      } else if (mark) { w.lmx = w.wx; w.lmy = w.wy; } else w.lmx = null;
      if (hard && !dirt && Math.random() < dt * 40) puff(w.wx, w.wy, c.vx * 0.15, c.vy * 0.15, 0.6, 3.6 + Math.random() * 2, 1.1 + Math.random() * 0.6, '200,202,206', 0.28);
      if (dirt && c.speed > 8 && Math.random() < dt * 30) {
        const g = w.surf === SURF.GRAVEL;
        puff(w.wx, w.wy, c.vx * 0.25 + (Math.random() - 0.5) * 3, c.vy * 0.25 + (Math.random() - 0.5) * 3, 0.5, 3 + Math.random() * 2, 0.9, g ? '214,196,150' : '120,140,70', g ? 0.45 : 0.3);
      }
    }
    // damage: a blown or cooking engine smokes, a corner with no wheel drags sparks along the road
    if (c.dm) {
      const dm = c.dm, rx = c.x - Math.cos(c.h) * 2.0, ry = c.y - Math.sin(c.h) * 2.0;
      // a thin grey trail, thicker while the car still moves (no pall hiding the car)
      if (dm.failed === 'ENGINE' && Math.random() < dt * (c.speed > 5 ? 12 : 4)) puff(rx, ry, c.vx * 0.4, c.vy * 0.4, 0.4, 2.2 + Math.random(), 1.6, '120,121,125', 0.16);
      else if (dm.engT > 128 && Math.random() < dt * 5) puff(rx, ry, c.vx * 0.5, c.vy * 0.5, 0.25, 1.4, 0.9, '160,160,165', 0.08);
      for (let k = 0; k < 4; k++) if (dm.wheelOff[k] && c.speed > 4) {
        const w = c.wheels[k];
        for (let q = 0; q < 2; q++) if (Math.random() < dt * 40) spark(w.wx, w.wy, c.vx * 0.7 + (Math.random() - 0.5) * 6, c.vy * 0.7 + (Math.random() - 0.5) * 6);
      }
    }
    // plank sparks over kerbs and bumps at speed
    if (c.speed > 55 && (c.onKerb || Math.random() < dt * 0.6) && Math.random() < dt * (c.onKerb ? 30 : 6)) {
      const bx = c.x - Math.cos(c.h) * 1.2, by = c.y - Math.sin(c.h) * 1.2;
      for (let k = 0; k < 3; k++) spark(bx, by, -c.vx * 0.1 + (Math.random() - 0.5) * 6 + c.vx * 0.85, -c.vy * 0.1 + (Math.random() - 0.5) * 6 + c.vy * 0.85);
    }
  }
  function impactFx(f) {
    fxZ = f.car && f.car.zRoad || 0;
    const n = Math.min(24, 4 + f.power);
    for (let k = 0; k < n; k++) spark(f.x, f.y, (Math.random() - 0.5) * 30 + (f.car ? f.car.vx * 0.6 : 0), (Math.random() - 0.5) * 30 + (f.car ? f.car.vy * 0.6 : 0));
    if (f.power > 9) {
      for (let k = 0; k < 6; k++) FX.debris.push({ x: f.x, y: f.y, z: fxZ, vx: (Math.random() - 0.5) * 16 + (f.car ? f.car.vx * 0.5 : 0), vy: (Math.random() - 0.5) * 16 + (f.car ? f.car.vy * 0.5 : 0), a: Math.random() * 6, s: 0.2 + Math.random() * 0.35, t: 0 });
      if (FX.debris.length > 200) FX.debris.splice(0, FX.debris.length - 200);
      puff(f.x, f.y, 0, 0, 1, 6, 1.4, '170,170,170', 0.3);
    }
  }
  function stepFx(dt) {
    const P = FX.parts;
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.t += dt;
      if (p.t >= p.life) { P[i] = P[P.length - 1]; P.pop(); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      const damp = p.kind ? 2.5 : 1.6;
      p.vx *= 1 - Math.min(1, damp * dt); p.vy *= 1 - Math.min(1, damp * dt);
    }
    for (const d of FX.debris) {
      if (d.t > 4) continue;
      d.t += dt; d.x += d.vx * dt; d.y += d.vy * dt; d.vx *= 1 - Math.min(1, 3 * dt); d.vy *= 1 - Math.min(1, 3 * dt); d.a += dt * Math.hypot(d.vx, d.vy) * 0.3;
    }
  }
  function drawFx(view) {
    // skid marks
    const S = FX.skid;
    const paths = [new Path2D(), new Path2D(), new Path2D()];
    for (let n = 0; n < FX.skidN; n++) {
      const k = n * 5;
      const x = S[k], y = S[k + 1];
      if (x < view.x0 || x > view.x1 || y < view.y0 || y > view.y1) continue;
      const p = paths[S[k + 4]];
      p.moveTo(x, y); p.lineTo(S[k + 2], S[k + 3]);
    }
    ctx.lineCap = 'round';
    ctx.lineWidth = 0.3; ctx.strokeStyle = 'rgba(14,14,16,0.42)'; ctx.stroke(paths[0]);
    ctx.lineWidth = 0.35; ctx.strokeStyle = 'rgba(60,72,30,0.45)'; ctx.stroke(paths[1]);
    ctx.lineWidth = 0.4; ctx.strokeStyle = 'rgba(150,128,88,0.55)'; ctx.stroke(paths[2]);
    ctx.fillStyle = '#1b1c20';
    for (const d of FX.debris) {
      if (d.x < view.x0 || d.x > view.x1 || d.y < view.y0 || d.y > view.y1) continue;
      ctx.save(); ctx.translate(d.x, d.y); ctx.rotate(d.a); ctx.fillRect(-d.s, -d.s * 0.6, d.s * 2, d.s * 1.2); ctx.restore();
    }
  }
  function drawParticles() {
    for (const p of FX.parts) {
      const f = p.t / p.life;
      if (p.kind === 0) {
        ctx.fillStyle = `rgba(${p.col},${(p.a * (1 - f)).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, U.lerp(p.r0, p.r1, Math.sqrt(f)), 0, 6.283); ctx.fill();
      }
    }
    ctx.lineCap = 'round';
    for (const p of FX.parts) {
      if (p.kind !== 1) continue;
      const f = p.t / p.life;
      ctx.strokeStyle = `rgba(255,${Math.round(220 - f * 120)},${Math.round(120 - f * 100)},${(1 - f).toFixed(2)})`;
      ctx.lineWidth = 0.12;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03); ctx.stroke();
    }
  }

  // ---------- rendering ----------
  function drawGantry(tr, race) {
    const [x1, y1] = Tracks.pointAt(tr, 4, -(tr.barr[0][0]));
    const [x2, y2] = Tracks.pointAt(tr, 4, tr.barr[1][0]);
    ctx.save();
    ctx.lineCap = 'butt';
    ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(x1 + 1.2, y1 + 1.8); ctx.lineTo(x2 + 1.2, y2 + 1.8); ctx.stroke();
    ctx.strokeStyle = '#2a2d33'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    // light units over the centre of the track
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const [cx, cy] = Tracks.pointAt(tr, 4, 0);
    ctx.translate(cx, cy); ctx.rotate(ang);
    for (let k = 0; k < 5; k++) {
      const on = race && (race.phase === 'lights' || race.phase === 'grid') && k < race.lightsOn;
      ctx.fillStyle = '#111317'; ctx.fillRect(-3.2 + k * 1.3, -0.75, 1.1, 1.5);
      ctx.fillStyle = on ? '#ff2a1f' : '#3a1210';
      ctx.fillRect(-3.0 + k * 1.3, -0.45, 0.7, 0.9);
    }
    ctx.restore();
  }

  function ghostPose(race) {
    if (!(race.mode === 'tt' && race.ghost && race.green && race.ghostRec)) return null;
    const ghost = race.ghost, t = race.time - race.ghostRec.t0;
    const k = Math.floor(t * 20), n = ghost.pts.length / 3;
    if (k >= n - 1 || k < 0) return null;
    const f = t * 20 - k, a = ghost.pts, i = k * 3, j = (k + 1) * 3;
    return { x: a[i] + (a[j] - a[i]) * f, y: a[i + 1] + (a[j + 1] - a[i + 1]) * f, h: a[i + 2] + U.wrapAngle(a[j + 2] - a[i + 2]) * f };
  }

  function render3d(race, dt, mode) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!Game.world || !race) return;
    const p = race.player;
    let assist = null;
    if (p && mode !== 'tv' && mode !== 'show') {
      const lineMode = race.mode === 'arcade' ? Game.raceDefaults.lineArcade : Game.raceDefaults.lineSim;
      if (!race.assistProf) {
        const handling = race.handling === 'arcade' || race.mode === 'arcade' ? 'arcade' : 'sim';
        race.assistProf = F1.Raceline.speedProfile(race.track, race.track.line, p.spec, { pace: 0.94 * (handling === 'arcade' ? 1.12 : 1), grip: Race.learnedGrip(race.track, handling) });
      }
      if (!race.cornerMarks) race.cornerMarks = F1.Raceline.cornerMarks(race.track, race.track.line, race.assistProf);
      assist = { tr: race.track, car: p, mode: lineMode, prof: race.assistProf, marks: race.cornerMarks };
    }
    const camMode = mode === 'tv' || mode === 'show' ? mode : Game.settings.camera;
    const focus = mode === 'tv' || mode === 'show' ? cam.tvTarget || race.cars[0] : p;
    const step = ZOOM_STEPS[Game.settings.zoomStep == null ? 1 : Game.settings.zoomStep] || ZOOM_STEPS[1];
    R3.render({
      cars: race.cars, focus, mode: camMode, dt: Game.paused ? 0 : dt, zoomK: step.k * Game.settings.zoom, shake: cam.shake, fx: FX,
      assist: camMode === 'tv' || camMode === 'show' ? null : assist, ghost: ghostPose(race),
      lightsOn: race.phase === 'lights' || race.phase === 'grid' ? race.lightsOn : 0,
      weather: race, sc: race.sc,
    });
    // name tags over the other cars
    if (Game.settings.tags && mode !== 'tv' && mode !== 'show' && p) {
      ctx.font = '700 11px Titillium Web, Segoe UI, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const c of race.cars) {
        if (c === p) continue;
        const d = Math.hypot(c.x - p.x, c.y - p.y);
        if (d > 140) continue;
        const q = R3.project(c.x, c.y, 1.7);
        if (!q) continue;
        const a = U.clamp((140 - d) / 40, 0, 1) * 0.9;
        ctx.globalAlpha = a;
        ctx.fillStyle = 'rgba(8,10,13,0.82)'; ctx.fillRect(q.x - 20, q.y - 22, 40, 15);
        ctx.fillStyle = c.team.base === '#121417' ? c.team.accent : c.team.base; ctx.fillRect(q.x - 20, q.y - 22, 3, 15);
        ctx.fillStyle = '#f4f6f8'; ctx.fillText(c.driver.code, q.x + 1.5, q.y - 14.5);
        ctx.globalAlpha = 1;
      }
    }
  }

  function render(race, dt, mode) {
    if (R3ok) { render3d(race, dt, mode); return; }
    const W2 = Game.world;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (!W2 || !race) { ctx.fillStyle = '#07090c'; ctx.fillRect(0, 0, W, H); return; }
    const m = camMatrix();
    ctx.setTransform(m.a * DPR, m.b * DPR, m.c * DPR, m.d * DPR, m.e * DPR, m.f * DPR);
    const view = viewBox(m);
    Render.drawWorld(ctx, W2, view, {});
    Render.drawUpperDecor(ctx, W2, view);
    Render.drawBarriers(ctx, W2, view);
    drawFx(view);
    const p = race.player;
    if (p && mode !== 'tv' && mode !== 'show') {
      const lineMode = race.mode === 'arcade' ? Game.raceDefaults.lineArcade : race.mode === 'tt' ? Game.raceDefaults.lineSim : Game.raceDefaults.lineSim;
      // braking cues follow the limits the AI learned, with a small margin for a human
      if (!race.assistProf) {
        const handling = race.handling === 'arcade' || race.mode === 'arcade' ? 'arcade' : 'sim';
        race.assistProf = F1.Raceline.speedProfile(race.track, race.track.line, p.spec, { pace: 0.94 * (handling === 'arcade' ? 1.12 : 1), grip: Race.learnedGrip(race.track, handling) });
      }
      if (!race.cornerMarks) race.cornerMarks = F1.Raceline.cornerMarks(race.track, race.track.line, race.assistProf);
      Render.drawAssistLine(ctx, race.track, p, lineMode, race.assistProf, race.cornerMarks);
    }
    const vis = race.cars.filter(c => c.x > view.x0 - 5 && c.x < view.x1 + 5 && c.y > view.y0 - 5 && c.y < view.y1 + 5);
    for (const c of vis) Render.drawCarShadow(ctx, c);
    if (race.mode === 'tt' && race.ghost && race.green && race.ghostRec) Render.drawGhost(ctx, race.ghost, race.time - race.ghostRec.t0);
    for (const c of vis) if (c !== p) Render.drawCar(ctx, c, c.ghostT > 0 && c.ghostT < 1000 ? 0.45 : 1);
    if (p && vis.includes(p)) Render.drawCar(ctx, p, p.ghostT > 0 && p.ghostT < 1000 ? 0.5 : 1);
    drawParticles();
    drawGantry(race.track, race);
    // name tags in screen space
    if (Game.settings.tags && mode !== 'tv' && mode !== 'show') {
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.font = '700 11px Titillium Web, Segoe UI, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const c of vis) {
        if (c === p) continue;
        const d = Math.hypot(c.x - p.x, c.y - p.y);
        if (d > 140) continue;
        const sx = m.a * c.x + m.c * c.y + m.e, sy = m.b * c.x + m.d * c.y + m.f;
        const a = U.clamp((140 - d) / 40, 0, 1) * 0.9;
        ctx.globalAlpha = a;
        ctx.fillStyle = 'rgba(8,10,13,0.82)'; ctx.fillRect(sx - 20, sy - 34, 40, 15);
        ctx.fillStyle = c.team.base === '#121417' ? c.team.accent : c.team.base; ctx.fillRect(sx - 20, sy - 34, 3, 15);
        ctx.fillStyle = '#f4f6f8'; ctx.fillText(c.driver.code, sx + 1.5, sy - 26.5);
        ctx.globalAlpha = 1;
      }
    }
  }

  // ---------- loading scene ----------
  // Each circuit gets a cinematic shot of its signature corner (the slowest one):
  // a pack of cars, one of them yours, rolling through it in slow motion under a
  // drifting camera, graded to the venue's light, with letterbox bars.
  const GRADES = {
    kestrel: { tint: 'rgba(70,95,130,0.32)', op: 'multiply', lift: 'rgba(210,225,240,0.06)' },   // overcast English summer
    varenna: { tint: 'rgba(255,170,80,0.30)', op: 'soft-light', lift: 'rgba(255,200,120,0.08)' }, // golden Lombardy afternoon
    lucerne: { tint: 'rgba(40,150,190,0.22)', op: 'soft-light', lift: 'rgba(255,255,255,0.06)' }, // bright Riviera morning
    hakone: { tint: 'rgba(150,170,200,0.30)', op: 'multiply', lift: 'rgba(225,232,245,0.16)' },  // mist off the mountains
    rimal: { tint: 'rgba(255,95,40,0.36)', op: 'multiply', lift: 'rgba(255,150,60,0.08)' },      // desert dusk
  };
  const load = { on: false };

  function startLoadScene(trackId, teamIdx) {
    const tr = Race.getTrack(trackId);
    buildWorld(tr);
    // the circuit's signature corner: its tightest real bend (from the track
    // geometry, so a quirk in the speed plan can never point the camera at a straight)
    const cs = F1.Raceline.cornersOf(tr).filter(c => Math.abs(c.angle) > 0.6);
    const c0 = cs.reduce((a, c) => (!a || c.peakK > a.peakK ? c : a), null);
    const hero = { side: c0.sg, minI: c0.peak };
    const apexS = c0.peak * tr.ds;
    // the pack: your team leads a battle into the corner, the rest strung out behind
    const teams = F1.Data.TEAMS.slice();
    const mine = teams.splice(teamIdx || 0, 1)[0];
    const rnd = U.rng(trackId.length * 97 + (teamIdx || 0));
    teams.sort(() => rnd() - 0.5);
    const order = [teams[0], mine, teams[1], teams[2], teams[3], teams[4]];
    const gaps = [0, 9, 26, 38, 55, 68];
    const lats = [0, 2.9, 0, -1.2, 0.6, 0];
    load.cars = order.map((team, k) => ({
      team, id: k, s: apexS - 26 - gaps[k], lat: lats[k] * hero.side, x: 0, y: 0, h: 0, steer: 0,
      drsOpen: false, limiter: false, wingDmg: 0, ghostT: 0, wheels: [], speed: 0, vx: 0, vy: 0,
    }));
    load.tr = tr; load.hero = hero; load.apexS = apexS; load.t = 0;
    // frame the corner itself, turned so the cars arrive from the bottom of the screen
    const [ax, ay] = Tracks.pointAt(tr, apexS - 6, tr.line.off[hero.minI]);
    const [, , eh] = Tracks.pointAt(tr, apexS - 45, 0);
    load.cx = ax; load.cy = ay;
    load.ang = eh + Math.PI / 2 - 0.35 * hero.side;
    load.grade = GRADES[trackId] || GRADES.kestrel;
    load.on = true;
    FX.parts.length = 0; FX.skidN = 0; FX.skidHead = 0; FX.debris.length = 0;
  }

  function stepLoadScene(dt) {
    const tr = load.tr;
    dt = Math.min(dt, 1 / 30); // a frame hitch while the page loads must not make the cars leap
    load.t += dt;
    for (const c of load.cars) {
      const i = Math.floor((((c.s % tr.L) + tr.L) % tr.L) / tr.ds) % tr.N;
      const v0 = tr.prof[i] * 0.16; // slow motion
      c.vS = c.vS == null ? v0 : c.vS + (v0 - c.vS) * Math.min(1, dt * 2.2); // the table steps; the car's speed must not
      const v = c.vS;
      c.speed = v;
      c.s += v * dt;
      // close the inside line back to the racing line after the apex
      const past = c.s - load.apexS;
      const lat = tr.line.off[i] + c.lat * U.clamp(1 - past / 40, 0, 1);
      const [x, y, h] = Tracks.pointAt(tr, c.s, lat);
      c.vx = (x - c.x) / Math.max(dt, 1e-3); c.vy = (y - c.y) / Math.max(dt, 1e-3);
      c.x = x; c.y = y;
      c.h = c.hS == null ? h : c.hS + U.wrapAngle(h - c.hS) * Math.min(1, dt * 12); c.hS = c.h;
      c.steer = c.stS = (c.stS || 0) + (U.clamp(Math.atan(3.6 * tr.line.kap[i]) * 1.4, -0.35, 0.35) - (c.stS || 0)) * Math.min(1, dt * 6);
      c.zRoad = fxZ = Tracks.surfZ(tr, i, lat);
      // brake dust, a puff of locking-tyre smoke and the odd plank spark
      if (tr.prof[(i + 10) % tr.N] < tr.prof[i] - 0.5 && rnd01() < dt * 6) puff(x - Math.cos(h) * 1.2, y - Math.sin(h) * 1.2, 0, 0, 0.5, 2.8, 1.4, '205,205,210', 0.22);
      if (rnd01() < dt * 3) spark(x - Math.cos(h) * 1.2, y - Math.sin(h) * 1.2, c.vx * 0.8 + (rnd01() - 0.5) * 3, c.vy * 0.8 + (rnd01() - 0.5) * 3);
    }
    stepFx(dt);
  }
  const rnd01 = Math.random;

  function drawLoadScene(dt) {
    const tr = load.tr, W2 = Game.world;
    const t = load.t;
    if (R3ok) {
      R3.render({ cars: load.cars, focus: null, mode: 'load', load, dt, fx: FX });
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const bar = H * 0.085 * U.smooth(Math.min(1, t * 2.5));
      ctx.fillStyle = '#050608';
      ctx.fillRect(0, 0, W, bar); ctx.fillRect(0, H - bar, W, bar);
      return;
    }
    // slow drift: push in, rotate a touch, slide along the corner
    const z = H / 1080 * 10 * (1 + t * 0.03);
    const ang = load.ang + t * 0.025 * load.hero.side;
    const [dx, dy] = [Math.cos(ang - Math.PI / 2) * t * 2.2, Math.sin(ang - Math.PI / 2) * t * 2.2];
    const cx = load.cx + dx, cy = load.cy + dy;
    const c = Math.cos(-ang), s = Math.sin(-ang);
    const m = { a: c * z, b: s * z, c: -s * z, d: c * z };
    m.e = W * 0.64 - (m.a * cx + m.c * cy); m.f = H * 0.58 - (m.b * cx + m.d * cy);
    ctx.setTransform(m.a * DPR, m.b * DPR, m.c * DPR, m.d * DPR, m.e * DPR, m.f * DPR);
    const view = viewBox(m);
    Render.drawWorld(ctx, W2, view, {});
    Render.drawUpperDecor(ctx, W2, view);
    Render.drawBarriers(ctx, W2, view);
    drawFx(view);
    for (const car of load.cars) Render.drawCarShadow(ctx, car);
    for (let k = load.cars.length - 1; k >= 0; k--) Render.drawCar(ctx, load.cars[k], 1);
    drawParticles();
    // the venue's light
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const g = load.grade;
    ctx.globalCompositeOperation = g.op; ctx.fillStyle = g.tint; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = g.lift; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    // letterbox bars slide in
    const bar = H * 0.085 * U.smooth(Math.min(1, t * 2.5));
    ctx.fillStyle = '#050608';
    ctx.fillRect(0, 0, W, bar); ctx.fillRect(0, H - bar, W, bar);
  }
  Game.load = load;

  // ---------- race lifecycle ----------
  let acc = 0;
  let evIdx = 0;
  let finishT = -1;
  const trace = { cur: [], best: null };

  function bestKey(id, mode) { return 'slip_best_' + id + '_' + (mode === 'arcade' ? 'arcade' : 'sim'); }
  Game.bestLap = (id, mode) => store.get(bestKey(id, mode), null);

  function buildWorld(tr) {
    if (Game.world && Game.world.tr === tr) return;
    Game.world = Render.build(tr, ctx);
    if (R3ok) R3.setTrack(tr, Game.world);
  }

  // The menu background keeps its own attract race. (Moving it to the circuit in focus was
  // tried: building a circuit's 3D world blocks the page for two to three seconds, which
  // showed as the menu freezing behind a dim whenever a card was hovered. The circuit card
  // and its map carry the preview instead.)
  Game.previewTrack = id => { void id; };
  // Team and driver select: the camera rides alongside that team's car (null: back to the TV director)
  Game.showcase = (team, driver) => {
    Game.show = team == null ? null : { team, driver: driver || 0, t0: performance.now() };
  };

  function newRace(cfg) {
    const race = Race.create(cfg);
    buildWorld(race.track);
    FX.parts.length = 0; FX.skidN = 0; FX.skidHead = 0; FX.debris.length = 0;
    evIdx = 0; finishT = -1; acc = 0;
    trace.cur = []; trace.best = null;
    for (const c of race.cars) c.onShift = c.isPlayer ? () => Audio.shiftClack() : null;
    return race;
  }

  function startAttract(want) {
    const ids = Tracks.DEFS.map(d => d.id);
    const id = want || Game.previewId || ids[Math.floor(Math.random() * ids.length)];
    const race = newRace({ track: id, mode: 'arcade', laps: 3, difficulty: 3, team: 0, driver: 0, grid: 'random', field: 20 });
    race.autoPlayer = true;
    // skip the grid in the attract loop: start already racing
    race.phase = 'lights'; race.lightsOn = 5; race.holdT = 0;
    Game.race = race; Game.state = 'menu';
    cam.mode = 'tv'; cam.tvT = 0;
    const p = race.cars[0];
    cam.x = p.x; cam.y = p.y; cam.zoom = H / 1080 * 7;
    for (let k = 0; k < 240 * 6; k++) Race.step(race, DT);
  }

  Game.startFromFlow = () => {
    const f = Game.flow, R = Game.raceDefaults;
    store.set('slip_race', R);
    if (f.kind === 'champ') {
      const table = {};
      for (const t of F1.Data.TEAMS) t.drivers.forEach((d, i) => {
        const player = t === F1.Data.TEAMS[f.team] && i === f.driver;
        table[d[2]] = { name: `${d[0]} ${d[1]}`, team: t.name, color: t.base === '#121417' ? t.accent : t.base, pts: 0, wins: 0, pods: 0, player };
      });
      Game.champ = { round: 0, table };
      launchRound();
      return;
    }
    if (f.kind === 'weekend') { weekendStart(); return; }
    launch({ track: f.track, mode: f.kind === 'tt' ? 'tt' : f.mode, ttHandling: f.mode });
  };

  // ---------- grand prix weekend ----------
  // Qualifying, then the race. Qualifying is the knockout format: Q1 with the whole field
  // (the slowest five drop out), Q2 (five more), Q3 for the top ten and pole. The player
  // drives each session alone on track for a set number of laps (the first is the out lap)
  // and their best valid lap counts; every other driver's time comes from their own car and
  // skill: the ideal lap of the speed profile they race to (the same team spec, pace and
  // learned grip the AI drives, scaled to the laps the AI actually turns), plus driver error, with the track rubbering in
  // from session to session. The race then starts from the qualifying order.
  const QSEG = [{ name: 'Q1', laps: 3 }, { name: 'Q2', laps: 2 }, { name: 'Q3', laps: 2 }];
  // the AI's real laps run slower than the ideal of its speed profile (braking points, line
  // errors, kerbs): measured on Kestrel Park the quickest race laps came out about 13 per cent over
  const AI_LAP_K = 1.13;
  function weekendStart() {
    const f = Game.flow, R = Game.raceDefaults;
    const roster = [];
    F1.Data.TEAMS.forEach(t => t.drivers.forEach((d, di) => roster.push({ t, d, di })));
    const me = roster.find(r => r.t === F1.Data.TEAMS[f.team || 0] && r.di === (f.driver || 0));
    const field = roster.slice(0, R.field || 20);
    if (!field.includes(me)) field[field.length - 1] = me;
    const n = field.length, cut = n >= 16 ? 5 : Math.max(1, Math.floor(n / 4));
    Game.weekend = { track: f.track, seg: 0, n, cut, me: me.d[2], info: {}, res: [], ai: null };
    for (const r of field) Game.weekend.info[r.d[2]] = { code: r.d[2], name: r.d[0] + ' ' + r.d[1], team: r.t, skill: r.d[4] };
    launchQuali();
  }
  function launchQuali() {
    const W = Game.weekend;
    launch({ track: W.track, mode: 'tt', ttHandling: Game.flow.mode, quali: W.seg, weekend: true });
  }
  // each AI driver's clean lap on this circuit, from the profile they race to
  function aiBaseTimes() {
    const W = Game.weekend;
    if (W.ai) return W.ai;
    const tr = Race.getTrack(W.track), R = Game.raceDefaults, sim = Game.flow.mode === 'sim';
    const diff = F1.Data.DIFFICULTY[R.difficulty == null ? 2 : R.difficulty];
    const grip = Race.learnedGrip(tr, sim ? 'sim' : 'arcade'), gripK = sim ? 1 : 1.12;
    W.ai = {};
    for (const code in W.info) {
      if (code === W.me) continue;
      const I = W.info[code];
      const pace = U.clamp(diff.pace * (0.97 + (I.skill - 0.95) * 0.75) / 0.9875, 0.5, 1) * gripK;
      W.ai[code] = F1.Raceline.lapTime(tr, tr.line, Object.assign({}, F1.Car.SPEC, Race.teamSpec(I.team)), { pace, grip });
    }
    return W.ai;
  }
  const gauss = () => { let u = 0; for (let k = 0; k < 6; k++) u += Math.random(); return (u - 3) / 1.22; };
  // run session `seg` for the given drivers; the player's time is passed in (null: no time)
  function runSegment(seg, codes, playerTime) {
    const W = Game.weekend, base = aiBaseTimes();
    const rows = codes.map(code => {
      if (code === W.me) return { code, t: playerTime };
      // a session's best of a few runs: driver error shrinks the more consistent they are
      const err = Math.abs(gauss()) * 0.0035 * (1.6 - W.info[code].skill);
      return { code, t: base[code] * AI_LAP_K * (1 - 0.0025 * seg + err) };
    });
    rows.sort((a, b) => (a.t == null ? 1e9 : a.t) - (b.t == null ? 1e9 : b.t));
    W.res[seg] = rows;
    return rows;
  }
  // who is still in after session seg
  function through(seg) { const r = Game.weekend.res[seg], W = Game.weekend; return r.slice(0, seg < 2 ? r.length - W.cut : r.length).map(x => x.code); }
  function endQuali() {
    const race = Game.race, W = Game.weekend;
    if (!race || race.quali == null || Game.state !== 'race') return;
    if (mouse.on) setMouseSteer(false, true);
    Game.state = 'results'; Game.paused = false;
    Audio.stopRace();
    setBlur(false);
    document.getElementById('hud').classList.add('off');
    document.getElementById('shade').className = 'full';
    const seg = W.seg, codes = seg === 0 ? Object.keys(W.info) : through(seg - 1);
    const pt = race.player.bestLap;
    runSegment(seg, codes, pt != null && isFinite(pt) ? pt : null);
    showQuali(seg);
  }
  Game.endQuali = endQuali;
  function showQuali(seg) {
    const W = Game.weekend, rows = W.res[seg];
    const out = seg < 2 ? rows.length - W.cut : rows.length;
    const playerIn = rows.findIndex(r => r.code === W.me) < out;
    const next = seg < 2 && playerIn
      ? { label: 'CONTINUE TO ' + QSEG[seg + 1].name, fn: () => { W.seg = seg + 1; launchQuali(); } }
      : { label: 'TO THE RACE', fn: () => weekendRace() };
    UIm.go('quali', { seg, name: QSEG[seg].name, rows: rows.map((r, k) => Object.assign({ pos: k + 1, out: k >= out && seg < 2 }, W.info[r.code], { t: r.t, me: r.code === W.me })), pole: rows[0].t, next, cut: seg < 2 ? out : null, track: Race.getTrack(W.track).name });
  }
  function weekendRace() {
    const W = Game.weekend;
    // sessions the player was knocked out of still run, for everyone else
    for (let s = W.res.length; s < 3; s++) runSegment(s, through(s - 1).filter(c => c !== W.me), null);
    const grid = W.res[2].map(r => r.code);
    for (let s = 1; s >= 0; s--) grid.push(...W.res[s].slice(W.res[s].length - W.cut).map(r => r.code));
    // the player, if knocked out after a session they set no time in, still has a slot
    for (const code in W.info) if (!grid.includes(code)) grid.push(code);
    W.grid = grid;
    launch({ track: W.track, mode: Game.flow.mode, gridOrder: grid, weekend: true });
  }


  function launchRound() {
    const ch = Game.champ, f = Game.flow;
    const def = Tracks.DEFS[ch.round];
    // grid in later rounds: reverse championship order for the player is not used; field by pace
    launch({ track: def.id, mode: f.mode, round: ch.round + 1 });
  }

  function cfgFromFlow(o) {
    const f = Game.flow, R = Game.raceDefaults;
    const sim = o.mode === 'sim' || (o.mode === 'tt' && o.ttHandling === 'sim');
    const assists = sim ? { abs: R.abs, tc: R.tc, autoGear: R.autoGear, steerAssist: R.steerAssist ? 1 : 0, stability: 0, damage: R.damage === 'full' ? 'full' : R.damage === false || R.damage === 'off' ? false : true, gripMul: 1 }
      : { abs: true, tc: 2, autoGear: true, steerAssist: 1, stability: 1, gripMul: 1.12, damage: R.damage === 'full' ? 'full' : false };
    return {
      mandatory: R.mandatory !== false, weather: R.weather || 'dry', safetyCar: R.safetyCar || 'on',
      track: o.track, mode: o.mode === 'tt' ? 'tt' : o.mode, laps: R.laps, difficulty: R.difficulty, team: f.team || 0, driver: f.driver || 0,
      grid: f.kind === 'champ' ? 'random' : (R.grid === 'pole' ? 1 : R.grid), field: R.field, assists, compound: R.compound,
      ttArcade: o.mode === 'tt' && o.ttHandling !== 'sim', gridOrder: o.gridOrder || null, noGhost: o.quali != null,
    };
  }

  function launch(o) {
    const def = Tracks.byId(o.track);
    if (def.gen && F1.LearnJob) F1.LearnJob.restore(def.id);
    Audio.ui.select();
    const fade = document.getElementById('fade');
    fade.classList.add('on');
    setTimeout(() => {
      Game.state = 'loading';
      startLoadScene(def.id, Game.flow.team || 0);
      const tr0 = Race.getTrack(def.id);
      const R0 = Game.raceDefaults;
      UIm.go('loading', {
        def, tr: tr0, round: o.round, total: Tracks.DEFS.length, mode: o.mode, ttHandling: o.ttHandling, quali: o.quali,
        laps: o.mode === 'tt' ? null : R0.laps, best: Game.bestLap(def.id, o.mode === 'arcade' || (o.mode === 'tt' && o.ttHandling !== 'sim') ? 'arcade' : 'sim'),
        team: F1.Data.TEAMS[Game.flow.team || 0], driver: F1.Data.TEAMS[Game.flow.team || 0].drivers[Game.flow.driver || 0],
      });
      document.getElementById('shade').className = 'load';
      fade.classList.remove('on');
      const build = () => {
        const cfg = cfgFromFlow(o);
        const race = newRace(cfg);
        if (cfg.ttArcade) {
          // arcade handling in time trial: same assists as the arcade race
          Object.assign(race.player.assist, { gripMul: 1.12, stability: 1, tc: 2, abs: true, autoGear: true, tyreSim: false });
          race.sim = false;
        }
        race.handling = cfg.ttArcade || o.mode === 'arcade' ? 'arcade' : 'sim';
        if (o.quali != null) race.quali = o.quali;
        Game.pendingRace = race;
        Game.lastLaunch = o;
        // hold the shot: continue on Enter once ready, or by itself after a few seconds
        let went = false;
        const goRace = () => {
          if (went) return;
          went = true;
          Game.onLoadReady = null;
          fade.classList.add('on');
          setTimeout(() => {
            load.on = false;
            Game.race = race;
            Game.state = 'race'; Game.paused = false; Game.pitMenu = false;
            UIm.hide();
            document.getElementById('shade').className = '';
            HUD.setup(race, Game.settings);
            document.getElementById('hud').classList.toggle('off', !Game.hudOn);
            const p = race.player;
            cam.mode = Game.settings.camera; cam.x = p.x; cam.y = p.y; cam.angle = p.h + Math.PI / 2; cam.zoom = H / 1080 * 10;
            inp.steer = inp.thr = inp.brk = 0;
            Audio.musicStop();
            Audio.startRace();
            fade.classList.remove('on');
            if (race.quali != null) HUD.message('QUALIFYING  ' + QSEG[race.quali].name, 'blue', QSEG[race.quali].laps + ' LAPS, OUT LAP FIRST', 3.5);
            else if (race.mode === 'tt') HUD.message('TIME TRIAL', 'blue', race.ghost ? 'GHOST ' + U.fmtTime(race.ghost.t) : 'SET A BENCHMARK LAP', 3);
          }, 380);
        };
        setTimeout(() => {
          Game.onLoadReady = goRace;
          const sc = UIm.UI.cur;
          if (sc && sc.ready) sc.ready();
          setTimeout(goRace, 6500);
        }, 1600);
      };
      // a procedural circuit the AI has not learned yet: finish learning it first
      const st = def.gen && F1.LearnJob ? F1.LearnJob.status(def.id) : null;
      if (st && st.state !== 'done') {
        const el = document.querySelector('#scr-loading .ld-learn');
        const show = s => {
          if (!el || s.id !== def.id) return;
          el.style.setProperty('--p', s.p || 0);
          el.textContent = s.state === 'failed' ? 'AI LEARNING FAILED: THEY WILL DRIVE CAUTIOUSLY' : `AI DRIVERS LEARNING THE CIRCUIT  ${Math.round((s.p || 0) * 100)}%   /   ENTER: RACE NOW WITH CAUTIOUS AI`;
          el.classList.add('on');
        };
        const off = F1.LearnJob.onChange(show);
        show(F1.LearnJob.status(def.id));
        // Enter (or a click) races straight away with cautious AI. Learning stops so the
        // race gets the whole CPU; it starts again the next time this seed is picked
        let started = false;
        const go = skip => {
          if (started) return;
          started = true; off(); Game.onLoadReady = null;
          if (skip === true) F1.LearnJob.cancel();
          if (el) el.classList.remove('on');
          setTimeout(build, 60);
        };
        Game.onLoadReady = () => go(true);
        F1.LearnJob.start(def.id).then(() => go(false));
      } else setTimeout(build, 60);
    }, 380);
  }

  Game.restart = () => {
    setBlur(false);
    if (mouse.on) setMouseSteer(false, true);
    Audio.stopRace();
    if (Game.flow.kind === 'champ' && Game.champ) launchRound();
    else launch(Game.lastLaunch);
  };

  Game.quitToMenu = () => {
    setBlur(false);
    if (mouse.on) setMouseSteer(false, true);
    Audio.stopRace();
    const fade = document.getElementById('fade');
    fade.classList.add('on');
    setTimeout(() => {
      document.getElementById('hud').classList.add('off');
      Game.paused = false;
      startAttract();
      document.getElementById('shade').className = 'on';
      UIm.go('main');
      Audio.musicStart();
      fade.classList.remove('on');
    }, 380);
  };

  // Grain tile for the pause screen: random grey pixels at low alpha. Over a blurred,
  // dimmed frame it breaks 8-bit brightness steps (banding) into invisible texture.
  (function makeGrain() {
    const g = document.createElement('canvas');
    g.width = g.height = 192;
    const gx = g.getContext('2d'), img = gx.createImageData(192, 192), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const v = Math.random() * 255; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 14; }
    gx.putImageData(img, 0, 0);
    document.documentElement.style.setProperty('--grain', `url(${g.toDataURL()})`);
  })();

  // pause / menus over a race: blur and dim the frozen frame behind them
  function setBlur(on) {
    cv.classList.toggle('blur', on); // Gaussian blur of the frozen frame
    document.getElementById('gl').classList.toggle('blur', on);
    document.getElementById('hud').classList.toggle('blur', on);
  }
  Game.setBlur = setBlur;
  function pause() {
    if (Game.state !== 'race') return;
    Game.paused = true;
    Game.pitMenu = false;
    document.getElementById('pitpanel').classList.remove('show');
    document.getElementById('shade').className = 'pause';
    unlockMouse();
    setBlur(true);
    UIm.go('pause', { race: Game.race });
  }
  Game.showPause = () => UIm.go('pause', { race: Game.race });
  Game.resume = () => {
    setBlur(false);
    Game.paused = false;
    if (mouse.on) { mouse.v = 0; lockMouse(); }
    UIm.hide();
    document.getElementById('shade').className = '';
  };

  function showResults() {
    const race = Game.race;
    if (mouse.on) setMouseSteer(false, true);
    Game.state = 'results';
    Audio.stopRace();
    document.getElementById('hud').classList.add('off');
    document.getElementById('shade').className = 'full';
    UIm.go('results', { race });
  }

  Game.champContinue = () => {
    const ch = Game.champ, race = Game.race;
    race.result.forEach((c, k) => {
      const r = ch.table[c.driver.code];
      if (!r) return;
      r.pts += c.points || 0;
      if (k === 0) r.wins++;
      if (k < 3) r.pods++;
    });
    const final = ch.round >= Tracks.DEFS.length - 1;
    UIm.go('standings', { final });
  };
  Game.champNext = () => { Game.champ.round++; launchRound(); };

  // fast-forward the rest of the field once the player has taken the flag
  function fastForward(race) {
    let n = 0;
    while (!race.done && n < 240 * 90) { Race.step(race, DT); n++; }
    if (!race.done) Race.finish(race);
  }

  // ---------- events -> HUD / audio ----------
  function handleEvents(race) {
    const p = race.player;
    while (evIdx < race.events.length) {
      const e = race.events[evIdx++];
      const mine = e.car === p;
      switch (e.type) {
        case 'light': Audio.light(e.n); break;
        case 'go': Audio.go(); if (race.mode !== 'tt') HUD.big('GO GO GO', '#2bd66b'); break;
        case 'fastest': HUD.message('FASTEST LAP', 'purple', `${e.car.driver.first} ${e.car.driver.last.toUpperCase()}  ${U.fmtTime(e.car.lastLap)}`); break;
        case 'lap':
          if (mine) {
            const done = Math.floor(p.dist / race.track.L);
            if (e.valid) {
              const best = Game.bestLap(race.track.id, race.handling);
              if (!best || e.lapTime < best) { store.set(bestKey(race.track.id, race.handling), e.lapTime); }
            }
            if (race.mode !== 'tt' && done === race.laps - 1) HUD.message('FINAL LAP', 'blue', 'LAP ' + race.laps + ' OF ' + race.laps);
            else HUD.message('LAP ' + (done), e.valid && p.bestLap === e.lapTime ? 'green' : '', U.fmtTime(e.lapTime) + (e.valid ? '' : '  DELETED'));
            if (e.valid && p.bestLap === e.lapTime) trace.best = trace.cur.slice();
            trace.cur = [];
          }
          break;
        case 'warn': case 'deleted': if (mine) { HUD.message(e.text, 'yellow'); Audio.chime(false); } break;
        case 'penalty': if (mine) { HUD.message(e.text, 'red'); Audio.chime(false); } break;
        case 'damage': if (mine) HUD.message('FRONT WING DAMAGE', 'red', 'BOX FOR A NEW NOSE'); break;
        case 'pitentry': if (mine) HUD.message('PIT LANE', 'blue', 'AUTOPILOT ENGAGED'); break;
        case 'pitdone': if (mine) HUD.message('PIT STOP COMPLETE', 'green', p.compound.name + ' TYRES FITTED'); break;
        case 'engineer': if (mine) { HUD.message('ENGINEER: BOX THIS LAP', 'red', `${Car.COMPOUNDS[e.compound].name} TYRES  /  PRESS P THEN ${['S', 'M', 'H'].indexOf(e.compound) + 1}`, 4); Audio.chime(true); } break;
        case 'strategy': if (mine) HUD.message('STRATEGY', 'blue', planText(e.plan), 5); break;
        case 'pb': HUD.message('NEW PERSONAL BEST', 'purple', U.fmtTime(p.bestLap)); Audio.chime(true); break;
        case 'recover': if (mine) HUD.message('CAR RESET', ''); break;
        case 'chequered': HUD.big('CHEQUERED FLAG'); break;
        case 'part': if (mine) { HUD.message('DAMAGE', 'red', e.text + ' LOST'); Audio.chime(false); } break;
        case 'failure': if (mine) { HUD.message(e.text, 'red', 'PULL OVER'); Audio.chime(false); } else HUD.message(e.car.driver.code + '  ' + e.text, 'yellow', '', 2.5); break;
        case 'retire': if (!mine && e.car) HUD.message(e.car.driver.code + '  RETIRED', 'yellow', '', 2); break;
        case 'sc': HUD.big('SAFETY CAR', '#ffc400'); HUD.message('SAFETY CAR DEPLOYED', 'yellow', 'NO OVERTAKING  /  HOLD POSITION'); Audio.chime(false); break;
        case 'scin': HUD.message('SAFETY CAR IN THIS LAP', 'yellow', 'RESTART AT THE LINE'); break;
        case 'green': HUD.big('GREEN FLAG', '#2bd66b'); break;
        case 'incident': HUD.message('INCIDENT', 'yellow', e.text.replace('INCIDENT  ', 'CAR ' )); break;
        case 'rain': HUD.message('RAIN STARTING', 'blue', 'CONSIDER INTERMEDIATE TYRES'); Audio.chime(true); break;
        case 'rainstop': HUD.message('RAIN HAS STOPPED', 'blue', 'TRACK DRYING'); break;
        case 'finish': if (mine) { HUD.message('FINISHED P' + p.pos, p.pos <= 3 ? 'purple' : 'green', race.track.name.toUpperCase()); finishT = race.time; } break;
      }
    }
  }

  function planText(p) {
    if (!p) return '';
    if (!p.stops.length) return 'NO STOP  /  ' + Car.COMPOUNDS[p.seq[0]].name;
    return p.seq.map(c => Car.COMPOUNDS[c].name).join(' > ') + '  /  BOX LAP ' + p.stops.map(k => k + (Game.race ? Game.race.player.lapTimes.length : 0)).join(', ');
  }
  Game.planText = planText;

  // ---------- main loop ----------
  let last = performance.now();
  let perf = { frames: 0, t: 0, fps: 0 };
  let booted = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    tick(dt);
    // the boot screen (index.html) goes once the first frames are on screen (the very first
    // one also compiles every shader, so it is slow)
    if (booted < 3 && G.__bootLog) G.__bootLog.push(['frame ' + (booted + 1), Math.round(performance.now()), R3ok && R3.renderer ? R3.renderer.info.programs.length : 0]);
    if (booted < 3 && ++booted === 3) { if (G.__bootDone) G.__bootDone(); if (G.__game) G.__game.ready = true; }
    requestAnimationFrame(frame);
  }

  // ---- pose interpolation between fixed physics steps ----
  const POSE = ['x', 'y', 'h', 'zh', 'pitch', 'roll'];
  function snapPoses(race) {
    for (const c of race.cars) { const q = c._pp || (c._pp = {}); for (const k of POSE) q[k] = c[k]; }
  }
  function blendPoses(race, a) {
    if (window.__noInterp) return;
    a = Math.max(0, Math.min(1, a));
    for (const c of race.cars) {
      const q = c._pp; if (!q || (c.x - q.x) ** 2 + (c.y - q.y) ** 2 > 25) { c._real = null; continue; } // teleported: no blend
      const r = c._real || (c._real = {});
      for (const k of POSE) r[k] = c[k];
      c.x = q.x + (c.x - q.x) * a; c.y = q.y + (c.y - q.y) * a;
      c.h = q.h + U.wrapAngle(c.h - q.h) * a;
      for (const k of ['zh', 'pitch', 'roll']) c[k] = q[k] + (c[k] - q[k]) * a;
    }
  }
  function restorePoses(race) {
    for (const c of race.cars) { const r = c._real; if (r) { for (const k of POSE) c[k] = r[k]; c._real = null; } }
  }

  function tick(dt) {
    showTouch();
    perf.frames++; perf.t += dt;
    if (perf.t > 1) { perf.fps = perf.frames / perf.t; perf.frames = 0; perf.t = 0; }
    const pad = pollPad();
    const race = Game.race;
    if (race && (Game.state === 'race' && !Game.paused || Game.state === 'menu')) {
      acc += dt;
      let n = 0;
      // the home-screen race is only a backdrop: after a slow frame it does not rush to catch up
      // (that makes the next frame slower still); it runs a little behind real time instead
      const maxSteps = Game.state === 'menu' ? 7 : 40;
      while (acc >= DT && n < maxSteps) {
        if (Game.state === 'race') applyInput(race.player, DT, pad);
        snapPoses(race);
        Race.step(race, DT);
        acc -= DT; n++;
      }
      if (n >= maxSteps) acc = Game.state === 'menu' ? acc % DT : 0;
      // effects
      for (const c of race.cars) carEffects(c, dt);
      for (const f of race.fx) {
        impactFx(f);
        if (Game.state === 'race' && f.type === 'break' && f.car === race.player) Audio.crack(f.power);
        if (Game.state === 'race' && (f.car === race.player || f.other === race.player)) { Audio.impact(f.power); cam.shake = Math.min(1.2, cam.shake + f.power / 20); }
      }
      race.fx.length = 0;
      stepFx(dt);
    }
    if (race && Game.state === 'race') {
      const p = race.player;
      if (!Game.paused) {
        handleEvents(race);
        // lap delta against the best lap trace (10 m resolution)
        if (race.green && p.dist > 0) {
          const k = Math.floor((p.dist % race.track.L) / 10);
          const tl = race.time - p.lapStart;
          if (trace.cur.length <= k) trace.cur[k] = tl;
        }
        let delta = null;
        if (trace.best && race.green && p.dist > 0) {
          const k = Math.floor((p.dist % race.track.L) / 10);
          if (trace.best[k] != null) delta = (race.time - p.lapStart) - trace.best[k];
        }
        updateCamera(dt, p, Game.settings.camera);
        cam.mode = Game.settings.camera;
        HUD.update(race, p, dt, Game.settings, { delta });
        drawMouseGauge();
        Render.drawMini(miniCtx, Game.world, race, 220, miniCv.width / 220);
        if (finishT > 0 && race.time - finishT > 5 && Game.state === 'race') {
          fastForward(race);
          showResults();
        } else if (race.done && Game.state === 'race' && p.finished) showResults();
        // qualifying: the session ends after its laps (the chequered flag on the last one)
        if (race.quali != null && Game.state === 'race' && !race.qDone && p.lapTimes.length >= QSEG[race.quali].laps) {
          race.qDone = true;
          HUD.message('SESSION COMPLETE', 'purple', p.bestLap ? 'BEST  ' + U.fmtTime(p.bestLap) : 'NO TIME SET', 2.5);
          setTimeout(endQuali, 2600);
        }
      }
      Audio.updateRace(race, p, cam, Game.paused);
    }
    if (race && Game.state === 'menu' && Game.show) {
      // showcase: the chosen team's car (that driver's, when one is chosen)
      const team = F1.Data.TEAMS[Game.show.team];
      const mine = race.cars.filter(c => c.team && c.team.id === team.id && !c.retired);
      cam.tvTarget = mine[Math.min(Game.show.driver, mine.length - 1)] || cam.tvTarget || race.cars[0];
      updateCamera(dt, cam.tvTarget, 'tv');
      cam.mode = 'tv';
      if (race.done || race.time > 240) startAttract();
    } else if (race && Game.state === 'menu') {
      // TV director: follow a car near the front, cut every few seconds
      cam.tvT -= dt;
      if (cam.tvT <= 0 || !cam.tvTarget) {
        const pool = race.order.slice(0, 8);
        cam.tvTarget = pool[Math.floor(Math.random() * pool.length)];
        cam.tvT = 7 + Math.random() * 4;
        cam.x = cam.tvTarget.x; cam.y = cam.tvTarget.y;
      }
      updateCamera(dt, cam.tvTarget, 'tv');
      cam.mode = 'tv';
      if (race.done || race.time > 240) startAttract();
    }
    if (Game.state === 'loading' && load.on) { stepLoadScene(dt); drawLoadScene(dt); }
    else {
      // draw the cars where they are between the last two fixed physics steps, not where the
      // last step left them: the number of steps per frame varies, and so would the motion
      const live = race && (Game.state === 'race' && !Game.paused || Game.state === 'menu');
      if (live) blendPoses(race, acc / DT);
      render(race, dt, Game.state === 'menu' ? (Game.show ? 'show' : 'tv') : 'chase');
      if (live) restorePoses(race);
    }
  }

  // ---------- settings ----------
  function saveSettings() { store.set('slip_settings', Game.settings); }
  Game.saveSettings = saveSettings;
  Game.applySettings = () => {
    const s = Game.settings;
    Audio.setVolumes({ master: Game.muted ? 0 : s.master, sfx: s.sfx, music: s.music });
    if (R3ok) R3.setQuality(s.gfx);
    saveSettings();
  };
  Game.menuMusic = () => Audio.musicStart();
  Game.onScreen = (id) => {
    const sh = document.getElementById('shade');
    if (Game.state === 'menu') sh.className = id === 'team' || id === 'driver' ? 'on show' : 'on';
    if (id !== 'team' && id !== 'driver') Game.showcase(null);
  };

  // ---------- boot ----------
  // in steps, each in its own task, so the boot screen shows what is happening before the next
  // step holds the page (building the first circuit and its 3D world takes a few seconds)
  {
    const boot = (p, t) => { if (G.__boot) G.__boot(p, t); };
    const steps = [
      [0.9, 'Building the circuit', () => { HUD.init(); UIm.init(); startAttract(); }],
      [0.93, 'Preparing the scene', () => { document.getElementById('shade').className = 'on'; UIm.go('title'); Game.applySettings(); }],
      // the GPU compiles the shaders in the background while this screen keeps moving
      [0.95, 'Compiling shaders', () => (R3ok ? R3.precompile(Game.race && Game.race.cars) : null)],
      [0.99, 'Almost there', () => requestAnimationFrame(frame)],
    ];
    G.__bootLog = [['scripts', Math.round(performance.now())]]; // how long each step took (ms since the page opened)
    const run = k => {
      if (k >= steps.length) return;
      boot(steps[k][0], steps[k][1]);
      setTimeout(() => {
        // a step may hand back a promise (the shader compile); the next waits for it
        Promise.resolve(steps[k][2]()).then(() => { G.__bootLog.push([steps[k][1], Math.round(performance.now()), R3ok && R3.renderer ? R3.renderer.info.programs.length : 0]); run(k + 1); });
      }, 40);
    };
    run(0);
  }

  // test hook: drive the game from automation even when rAF is throttled
  window.__game = {
    Game, keys, cam, FX, perf,
    tick: (n = 1, dt = 1 / 60) => { for (let k = 0; k < n; k++) tick(dt); },
    press: c => { keys.add(c); onKey(c, false); },
    release: c => keys.delete(c),
    quick: (o = {}) => { Object.assign(Game.flow, { kind: 'race', mode: 'arcade', track: 'kestrel', team: 0, driver: 0 }, o.flow || {}); Object.assign(Game.raceDefaults, o.race || {}); Game.startFromFlow(); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
