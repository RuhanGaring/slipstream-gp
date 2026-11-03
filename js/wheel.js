// Racing wheels: detection, calibration, the input settings of the official F1 games, button
// mapping and force feedback.
//
// Browsers see a wheel through the Gamepad API as a device with a handful of axes and buttons
// whose order differs from wheel to wheel (and between browsers), so nothing is assumed: the
// calibration (Settings > Wheel > Calibrate) asks for the wheel centred, turned to each lock and
// each pedal pressed, and finds which axis moved and which way. Unpressed pedals rest at either
// end of their axis depending on the wheel, so a pedal is never read before it is calibrated
// (an uncalibrated pedal resting at -1 would otherwise be full throttle). The steering axis alone
// is used straight away (its centre is 0 on every wheel), until the calibration says otherwise.
//
// The settings follow the F1 games: deadzone, linearity and saturation for the steering and each
// pedal, the maximum wheel rotation (the soft lock: the wheel angle that gives full lock), and the
// vibration and force feedback group (strength, on-track, rumble strip and off-track effects,
// wheel damper). They are kept per wheel (by USB vendor and product), as the games do.
//
// Force feedback. The Gamepad API cannot drive a wheel's motor. On Chromium browsers a Logitech
// G29 / G27 / G25 / Driving Force GT (the "classic" Logitech protocol, also used by the G923 for
// PlayStation) can be driven over WebHID once the player allows it (Settings > Wheel > Connect
// force feedback): the game streams a constant force worked out from the front tyres (the
// aligning torque that goes light as they slide), kerbs, grass and gravel, and a damper. Other
// wheels drive without force feedback; their own driver settings (centring spring) still apply.
(function (G) {
  'use strict';
  const F1 = G.F1, U = F1.U;

  // ---------- devices ----------
  // known wheels: vendor, products (empty = any), name, the rotation their driver defaults to
  const KNOWN = [
    ['046d', ['c24f', 'c260'], 'Logitech G29', 900], ['046d', ['c262', 'c261'], 'Logitech G920', 900],
    ['046d', ['c266', 'c267', 'c26d', 'c26e'], 'Logitech G923', 900], ['046d', ['c29b'], 'Logitech G27', 900],
    ['046d', ['c299'], 'Logitech G25', 900], ['046d', ['c29a'], 'Logitech Driving Force GT', 900],
    ['046d', ['c298', 'c294', 'c295', 'c29c', 'ca03'], 'Logitech wheel', 900], ['046d', ['c272'], 'Logitech PRO Racing Wheel', 1080],
    ['044f', ['b66e', 'b66f', 'b66d', 'b65d', 'b65e'], 'Thrustmaster T300', 1080], ['044f', ['b677'], 'Thrustmaster T150', 1080],
    ['044f', ['b67f', 'b67e'], 'Thrustmaster TMX', 900], ['044f', ['b696', 'b697'], 'Thrustmaster T248', 900],
    ['044f', ['b69a', 'b69b'], 'Thrustmaster T128', 900], ['044f', ['b692', 'b691'], 'Thrustmaster TS-XW', 1080],
    ['044f', [], 'Thrustmaster wheel', 1080],
    ['0eb7', [], 'Fanatec wheel', 1080], ['346e', [], 'MOZA wheel', 900], ['16d0', [], 'Simucube', 900],
    ['3670', [], 'Simagic wheel', 900], ['2433', [], 'Asetek wheel', 900], ['1dd2', [], 'Leo Bodnar wheel', 900],
  ];
  const NAME_RE = /wheel|racing|driving force|g29|g920|g923|g27|g25|t300|t150|tmx|t248|t128|t500|t-gt|ts-xw|ts-pc|csl|clubsport|podium|gt dd|moza|simucube|simagic|asetek|dd pro/i;
  function ids(gp) {
    const s = gp.id || '';
    let m = /vendor:\s*([0-9a-f]{4}).*product:\s*([0-9a-f]{4})/i.exec(s);
    if (!m) m = /^([0-9a-f]{4})-([0-9a-f]{4})-/i.exec(s);
    const v = m ? m[1].toLowerCase() : '', p = m ? m[2].toLowerCase() : '';
    const name = s.replace(/\s*\(.*?vendor.*?\)\s*$/i, '').replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '').trim() || 'Wheel';
    return { v, p, name, key: v && p ? v + ':' + p : s };
  }
  function knownOf(d) {
    return KNOWN.find(([v, ps]) => v === d.v && (!ps.length || ps.includes(d.p))) || null;
  }
  // a device counts as a wheel when it is one we know, its name says so, or the player said so
  function isWheel(gp, cfg) {
    const d = ids(gp), f = cfg.force && cfg.force[d.key];
    if (f) return f === 'wheel';
    if (gp.mapping === 'standard' && !knownOf(d) && !/wheel|racing/i.test(gp.id)) return false;
    return !!(knownOf(d) || NAME_RE.test(gp.id));
  }

  // per-wheel defaults (F1 game values: deadzones, linearity and saturation at 0, 360 degrees)
  const DEFAULTS = {
    hw: 900, rot: 360,
    sDead: 0, sLin: 0, sSat: 0,
    tDead: 0, tLin: 0, tSat: 0,
    bDead: 0, bLin: 0, bSat: 0,
    cDead: 0, cSat: 0,
    ffb: true, ffbK: 70, ffbTrack: 50, ffbKerb: 50, ffbOff: 50, ffbDamp: 20, ffbInv: false,
    cal: null, binds: {},
  };
  function cfgOf() {
    const st = F1.Game.settings;
    return st.wheel || (st.wheel = { profiles: {}, force: {}, seen: {} });
  }
  function profile(d) {
    const cfg = cfgOf();
    let p = cfg.profiles[d.key];
    if (!p) {
      const k = knownOf(d);
      p = cfg.profiles[d.key] = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), { hw: k ? k[3] : 900 });
    }
    // fields added later must not break a profile saved before them
    for (const [k, v] of Object.entries(DEFAULTS)) if (p[k] === undefined) p[k] = JSON.parse(JSON.stringify(v));
    return p;
  }
  // the wheel among the connected pads (the first one), or null
  function find(pads) {
    const cfg = cfgOf();
    for (const gp of pads || []) {
      if (!gp || !gp.connected || !isWheel(gp, cfg)) continue;
      const d = ids(gp), k = knownOf(d);
      return { gp, key: d.key, name: k ? k[2] : d.name, prof: profile(d), known: !!k, logitech: d.v === '046d', ids: d };
    }
    return null;
  }
  function pads() {
    try { return Array.from(navigator.getGamepads ? navigator.getGamepads() : []).filter(Boolean); } catch (e) { return []; }
  }

  // ---------- reading ----------
  const ax = (gp, i) => (i != null && i >= 0 && i < gp.axes.length ? gp.axes[i] : 0);
  // a pedal from its calibration: 0 at rest, 1 fully pressed
  function pedal(gp, c) {
    if (!c || c.axis == null) return 0;
    const span = c.full - c.rest;
    if (Math.abs(span) < 0.05) return 0;
    return U.clamp((ax(gp, c.axis) - c.rest) / span, 0, 1);
  }
  // deadzone, saturation and linearity, F1-game style (0 to 100 each). Deadzone ignores the first
  // part of the travel, saturation reaches full output before full travel, linearity makes the
  // first part of the travel finer (0 = linear)
  function shape(x, dead, sat, lin) {
    const d = dead / 100, s = 1 - sat / 100;
    let o = s - d > 0.01 ? (x - d) / (s - d) : x > d ? 1 : 0;
    o = U.clamp(o, 0, 1);
    return lin > 0 ? Math.pow(o, 1 + lin / 40) : o;
  }
  // the wheel's angle, -1 to 1 of its hardware range (left is negative)
  function steerRaw(gp, p) {
    const c = p.cal && p.cal.steer;
    if (!c) return U.clamp(ax(gp, 0), -1, 1);
    const v = ax(gp, c.axis), dl = c.l - c.c, dr = c.r - c.c;
    if (Math.abs(dl) < 0.05 || Math.abs(dr) < 0.05) return U.clamp(v, -1, 1);
    // each side scaled on its own (a wheel whose centre is not mid-range still reads 0 there),
    // whichever way the axis runs
    const k = Math.sign(v - c.c) === Math.sign(dl) ? -(v - c.c) / dl : (v - c.c) / dr;
    return U.clamp(k, -1, 1);
  }
  // full read of a wheel
  function read(dev) {
    const gp = dev.gp, p = dev.prof, cal = p.cal || {};
    const raw = steerRaw(gp, p);
    const deg = raw * p.hw / 2;
    // the soft lock: full steering at half the maximum rotation either way
    const lock = Math.max(30, Math.min(p.rot, p.hw)) / 2;
    const e = U.clamp(deg / lock, -1, 1);
    const steer = Math.sign(e) * shape(Math.abs(e), p.sDead, p.sSat, p.sLin);
    const thrR = pedal(gp, cal.thr), brkR = pedal(gp, cal.brk), cluR = pedal(gp, cal.clu);
    return {
      raw, deg, steer, lock,
      thrR, brkR, cluR,
      thr: shape(thrR, p.tDead, p.tSat, p.tLin),
      brk: shape(brkR, p.bDead, p.bSat, p.bLin),
      clu: shape(cluR, p.cDead, p.cSat, 0),
      pedals: !!(cal.thr && cal.brk),
    };
  }

  // ---------- buttons ----------
  // a binding is a button {b} or an axis position {a, v} (hats and some paddles report as axes)
  function bindDown(gp, bd) {
    if (!bd) return false;
    if (bd.b != null) { const x = gp.buttons[bd.b]; return !!x && (x.pressed || x.value > 0.5); }
    if (bd.a != null) return Math.abs(ax(gp, bd.a) - bd.v) < 0.12;
    return false;
  }
  const prevDown = {};
  // edge-triggered: true on the frame the bound control goes down
  function pressed(dev, action) {
    const down = bindDown(dev.gp, dev.prof.binds[action]);
    const was = prevDown[action];
    prevDown[action] = down;
    return down && !was;
  }
  const held = (dev, action) => bindDown(dev.gp, dev.prof.binds[action]);
  // after a screen read the wheel itself: what is held now does not count as a new press
  function sync(dev) { for (const [a] of ACTIONS) prevDown[a] = bindDown(dev.gp, dev.prof.binds[a]); }
  function bindName(bd) {
    if (!bd) return 'NOT SET';
    if (bd.b != null) return 'BUTTON ' + (bd.b + 1);
    const hat = { '-1': 'UP', '-0.71': 'UP-RIGHT', '-0.43': 'RIGHT', '-0.14': 'DOWN-RIGHT', '0.14': 'DOWN', '0.43': 'DOWN-LEFT', '0.71': 'LEFT', '1': 'UP-LEFT' }[String(Math.round(bd.v * 100) / 100)];
    return hat ? 'D-PAD ' + hat : 'AXIS ' + (bd.a + 1) + (bd.v < 0 ? ' -' : ' +');
  }
  // the actions a wheel can be mapped to, in the order the mapping screen lists them
  const ACTIONS = [
    ['gearUp', 'Upshift'], ['gearDown', 'Downshift'], ['overtake', 'Overtake mode'], ['pit', 'Pit strategy'],
    ['camera', 'Change camera'], ['reset', 'Reset car (arcade)'], ['pause', 'Pause'],
    ['menuUp', 'Menu up'], ['menuDown', 'Menu down'], ['menuLeft', 'Menu left'], ['menuRight', 'Menu right'],
    ['menuOk', 'Menu select'], ['menuBack', 'Menu back'],
  ];
  // the control the player is touching now, against a snapshot taken when the screen asked:
  // a button that went down, or an axis (not the steering or a pedal) that moved well away
  function snapshot(gp) { return { axes: gp.axes.slice(), buttons: gp.buttons.map(b => b.pressed || b.value > 0.5) }; }
  function detectControl(gp, base, skipAxes) {
    for (let i = 0; i < gp.buttons.length; i++) if ((gp.buttons[i].pressed || gp.buttons[i].value > 0.5) && !base.buttons[i]) return { b: i };
    for (let i = 0; i < gp.axes.length; i++) {
      if (skipAxes.includes(i)) continue;
      if (Math.abs(gp.axes[i] - base.axes[i]) > 0.5 && Math.abs(gp.axes[i]) <= 1.01) return { a: i, v: Math.round(gp.axes[i] * 100) / 100 };
    }
    return null;
  }
  // the axis that moved furthest from the snapshot (for the calibration)
  function movedAxis(gp, base, skip) {
    let best = -1, d = 0;
    for (let i = 0; i < gp.axes.length; i++) {
      if (skip.includes(i)) continue;
      const x = Math.abs(gp.axes[i] - base.axes[i]);
      // a hat at rest reads about 1.29 and jumps in steps: never a steering wheel or pedal
      if (Math.abs(base.axes[i]) > 1.05) continue;
      if (x > d) { d = x; best = i; }
    }
    return { axis: best, d };
  }

  // ---------- force feedback (Logitech classic protocol over WebHID) ----------
  // 7-byte output reports, as the Linux hid-lg4ff driver sends them: 0x11 0x08 F 0x80 plays a
  // constant force F (0x80 none, 0x00 and 0xff full either way) in slot 1; 0xf5 turns the
  // driver's centring spring off; 0xf8 0x81 lo hi sets the rotation range (G25, G27, G29, DFGT)
  const FFB = { dev: null, last: 0x80, t: 0, ok: false, err: '', vel: 0, prevDeg: null, kerbT: 0 };
  const hidOK = () => !!(navigator.hid && navigator.hid.requestDevice);
  async function hidOpen(d) {
    if (!d.opened) await d.open();
    FFB.dev = d; FFB.ok = true; FFB.err = ''; FFB.last = -1;
    await send([0xf5, 0, 0, 0, 0, 0, 0]);
    return true;
  }
  // asks the player for the wheel (must run from a key press or click)
  async function connect() {
    if (!hidOK()) { FFB.err = 'This browser has no WebHID (use Chrome or Edge)'; return false; }
    try {
      const list = await navigator.hid.requestDevice({ filters: [{ vendorId: 0x046d }] });
      if (!list || !list.length) { FFB.err = 'No wheel chosen'; return false; }
      return await hidOpen(list[0]);
    } catch (e) { FFB.err = String(e && e.message || e); FFB.ok = false; return false; }
  }
  // a wheel allowed before reconnects by itself
  async function reconnect() {
    if (!hidOK() || FFB.dev) return;
    try { const list = await navigator.hid.getDevices(); const d = list.find(x => x.vendorId === 0x046d); if (d) await hidOpen(d); } catch (e) { /* not allowed yet */ }
  }
  async function send(bytes) {
    if (!FFB.dev) return;
    try { await FFB.dev.sendReport(0, new Uint8Array(bytes)); } catch (e) { FFB.err = String(e && e.message || e); FFB.ok = false; FFB.dev = null; }
  }
  function setRange(deg) { send([0xf8, 0x81, deg & 0xff, (deg >> 8) & 0xff, 0, 0, 0]); }
  function force(f) {
    // f: -1 (pull left) to 1 (pull right)
    const b = Math.round(0x80 - U.clamp(f, -1, 1) * 127);
    if (b === FFB.last) return;
    FFB.last = b;
    send([0x11, 0x08, b, 0x80, 0, 0, 0]);
  }
  function ffbStop() { if (FFB.dev) { FFB.last = -1; force(0); } }
  // the force for this frame: the front tyres' aligning torque (it peaks before the tyres do and
  // fades as they slide, which is what tells a driver the front is going), kerb and surface
  // effects, and a damper against fast wheel movement
  function ffbUpdate(dev, car, dt, r) {
    if (!FFB.dev) return;
    const p = dev.prof;
    if (!p.ffb || !car) { force(0); return; }
    FFB.t += dt;
    if (FFB.prevDeg != null && dt > 0) FFB.vel = U.expDamp(FFB.vel, (r.deg - FFB.prevDeg) / dt, 25, dt);
    FFB.prevDeg = r.deg;
    const sp = car.spec, W = car.wheels, fr = W.filter(w => w.front);
    let mz = 0, fz = 0;
    for (const w of fr) {
      // pneumatic trail falls to nothing a little past the peak slip angle
      const trail = Math.max(0, 1 - Math.abs(w.alpha) / (sp.alphaPk * 2.4));
      mz += w.Fy * trail; fz += w.Fz;
    }
    // normalised: the aligning force at the peak of a 4 g corner is about full scale
    let f = -mz / Math.max(4000, fz * 1.6) * (p.ffbTrack / 50);
    // kerbs: a buzz at a rate that rises with speed; grass and gravel: a rougher, slower shake
    const v = Math.min(1, car.speed / 60);
    if (car.onKerb) f += Math.sin(FFB.t * (40 + 60 * v) * 6.283) * 0.18 * (p.ffbKerb / 50) * (0.4 + 0.6 * v);
    if (car.surfMask & 0b11000) f += (Math.sin(FFB.t * 23) * 0.6 + Math.sin(FFB.t * 61) * 0.4) * 0.14 * (p.ffbOff / 50) * v;
    f -= FFB.vel / 900 * (p.ffbDamp / 40);
    f *= p.ffbK / 100;
    if (p.ffbInv) f = -f;
    force(U.clamp(f, -1, 1));
  }

  // a wheel the player allowed in an earlier session gets its force feedback back by itself
  if (typeof navigator !== 'undefined') setTimeout(reconnect, 0);

  F1.Wheel = {
    KNOWN, DEFAULTS, ACTIONS, find, pads, read, pressed, held, sync, bindName, snapshot, detectControl, movedAxis, profile, cfgOf, ids, isWheel,
    FFB, hidOK, connect, reconnect, setRange, ffbUpdate, ffbStop, force,
  };
})(typeof window !== 'undefined' ? window : globalThis);
