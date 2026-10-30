// All sound is synthesised with WebAudio: no samples, so it works offline.
// Engines: a physically inspired voice on the audio thread (js/audio-engine-worklet.js):
// cylinder firings through a tuned exhaust pipe, turbo, MGU-K and gear whine, overrun pops.
// The player's car has the full voice; the five nearest cars get lighter ones, placed by
// distance (level and air absorption), bearing (pan) and closing speed (Doppler).
// The rest of the car: tyre squeal and scrub, lock-up judder, road roar by surface, kerb
// thumps timed to the kerb blocks, gravel and grass crunch, wind and helmet buffeting,
// plank and wall scraping, rain and spray, shifts, the pit limiter, impacts and breakages.
// The mix changes with the camera: on board the intake and wind are close, outside the
// exhaust leads, and a little room reverb ties it together.
// If the AudioWorklet is not available, a simpler oscillator engine stands in.
(function (G) {
  'use strict';
  const F1 = G.F1;
  const U = F1.U;

  const A = { ctx: null, on: false, vol: { master: 0.8, sfx: 0.9, music: 0.5 }, worklet: false };

  function init() {
    if (A.ctx) { if (A.ctx.state === 'suspended') A.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = A.ctx = new AC();
    A.master = ctx.createGain(); A.master.gain.value = A.vol.master;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.ratio.value = 3.5; comp.attack.value = 0.003; comp.release.value = 0.18;
    A.master.connect(comp); comp.connect(ctx.destination);
    A.sfx = ctx.createGain(); A.sfx.gain.value = A.vol.sfx; A.sfx.connect(A.master);
    A.musicBus = ctx.createGain(); A.musicBus.gain.value = A.vol.music * 0.5; A.musicBus.connect(A.master);
    // shared noise buffers: white, and a brown (integrated) one for rumble
    const len = ctx.sampleRate * 2;
    const nb = ctx.createBuffer(1, len, ctx.sampleRate), d = nb.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    A.noise = nb;
    const bb = ctx.createBuffer(1, len, ctx.sampleRate), b = bb.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; b[i] = last * 3.5; }
    A.brown = bb;
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(x * 2.4); }
    A.curve = curve;
    // a short room: an exponentially decaying noise impulse
    A.verb = ctx.createConvolver();
    {
      const L = Math.floor(ctx.sampleRate * 1.4), ir = ctx.createBuffer(2, L, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) { const a = ir.getChannelData(ch); for (let i = 0; i < L; i++) a[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / L, 3.2); }
      A.verb.buffer = ir;
    }
    A.verbIn = ctx.createGain(); A.verbIn.gain.value = 0.12;
    A.verbIn.connect(A.verb); A.verb.connect(A.sfx);
    // A very small, dark space for the engines: about a third of a second of decorrelated,
    // low-passed decay. Mixed in faintly it moves the low end out of the head (dry bass sounds
    // as if it were inside the ears) without being heard as reverb.
    A.room = ctx.createConvolver();
    {
      const L = Math.floor(ctx.sampleRate * 0.35), ir = ctx.createBuffer(2, L, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const a = ir.getChannelData(ch); let lp = 0;
        for (let i = 0; i < L; i++) { lp += ((Math.random() * 2 - 1) - lp) * 0.18; a[i] = lp * Math.exp(-i / (ctx.sampleRate * 0.07)) * (i < ctx.sampleRate * 0.004 ? 0 : 1); }
      }
      A.room.buffer = ir;
    }
    A.roomIn = ctx.createGain(); A.roomIn.gain.value = 1;
    A.roomIn.connect(A.room); A.room.connect(A.sfx);
    A.on = true;
    // the engine worklet, from source in memory (works from file://)
    if (ctx.audioWorklet && F1.EngineWorklet) {
      // a blob URL first; opened as a local file (file://, an opaque origin) Chrome refuses
      // blob worklets, so then the same source goes in as a data: URL, which it accepts
      const src = '(' + F1.EngineWorklet.toString() + ')();';
      const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
      const dataUrl = () => 'data:application/javascript;base64,' + btoa(unescape(encodeURIComponent(src)));
      A.workletReady = ctx.audioWorklet.addModule(url)
        .catch(() => ctx.audioWorklet.addModule(dataUrl()))
        .then(() => { A.worklet = true; })
        .catch(e => { console.warn('engine worklet unavailable', e); });
    } else A.workletReady = Promise.resolve();
  }

  function noiseSrc(brown) {
    const s = A.ctx.createBufferSource(); s.buffer = brown ? A.brown : A.noise; s.loop = true;
    s.loopStart = Math.random(); s.loopEnd = s.loopStart + 0.9;
    return s;
  }
  const at = (param, v, tc) => param.setTargetAtTime(v, A.ctx.currentTime, tc || 0.04);

  // ---------- engine voices ----------
  function makeVoice(cheap, dest) {
    const ctx = A.ctx;
    const out = ctx.createGain(); out.gain.value = 0;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 16000; lp.Q.value = 0.5;
    const eq = ctx.createBiquadFilter(); eq.type = 'peaking'; eq.frequency.value = 1800; eq.Q.value = 0.8; eq.gain.value = 0;
    // a little less bass than a studio microphone would give: onboard cameras carry small
    // capsules that are lighter in the low end (a gentle shelf, nothing removed)
    const shelf = ctx.createBiquadFilter(); shelf.type = 'lowshelf'; shelf.frequency.value = 240; shelf.gain.value = -2;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    let node, legacy = null;
    if (A.worklet) {
      node = new AudioWorkletNode(ctx, 'engine-voice', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.postMessage({ cheap: cheap ? 1 : 0 });
    } else {
      legacy = legacyEngine(cheap); node = legacy.out;
    }
    node.connect(shelf); shelf.connect(eq); eq.connect(lp); lp.connect(out);
    if (pan) { out.connect(pan); pan.connect(dest || A.sfx); } else out.connect(dest || A.sfx);
    out.connect(A.verbIn);
    const roomSend = ctx.createGain(); roomSend.gain.value = 0.1;
    out.connect(roomSend); roomSend.connect(A.roomIn);
    return { node, legacy, out, lp, eq, shelf, pan, roomSend, last: {} };
  }
  // send parameters (only when they change enough)
  function setVoice(v, o) {
    if (v.legacy) { legacySet(v.legacy, o.rpm * (o.dop || 1), o.thr); return; }
    const L = v.last;
    if (Math.abs((L.rpm || 0) - o.rpm) > 15 || Math.abs((L.thr || 0) - o.thr) > 0.02 || Math.abs((L.speed || 0) - o.speed) > 0.5 || L.dop !== o.dop || L.on !== o.on || Math.abs((L.kers || 0) - o.kers) > 0.05 || Math.abs((L.harv || 0) - (o.harv || 0)) > 0.05 || L.gear !== o.gear || L.view !== o.view || L.shift !== o.shift) {
      v.node.port.postMessage(o); Object.assign(L, o);
    }
  }
  function stopVoice(v) {
    if (!v) return;
    try { v.out.gain.setTargetAtTime(0, A.ctx.currentTime, 0.05); } catch (x) { /* already stopped */ }
    setTimeout(() => { try { if (v.legacy) legacyStop(v.legacy); v.node.disconnect(); v.out.disconnect(); v.roomSend.disconnect(); } catch (x) { /* ignore */ } }, 300);
  }
  // the fallback: oscillators through a waveshaper (the original engine sound)
  function legacyEngine(cheap) {
    const ctx = A.ctx, out = ctx.createGain(); out.gain.value = 1;
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth';
    const o2 = ctx.createOscillator(); o2.type = 'square';
    const g1 = ctx.createGain(), g2 = ctx.createGain(); g1.gain.value = 0.5; g2.gain.value = 0.22;
    const shaper = ctx.createWaveShaper(); shaper.curve = A.curve;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 2.2;
    o1.connect(g1); o2.connect(g2); g1.connect(shaper); g2.connect(shaper); shaper.connect(lp); lp.connect(out);
    o1.start(); o2.start();
    return { out, o1, o2, lp, cheap };
  }
  function legacySet(e, rpm, thr) {
    const f = Math.max(40, rpm / 20);
    at(e.o1.frequency, f, 0.012); at(e.o2.frequency, f * 0.5, 0.012);
    at(e.lp.frequency, 500 + rpm * 0.32 * (0.35 + 0.65 * thr), 0.03);
    at(e.out.gain, 0.25 + 0.5 * thr, 0.03);
  }
  function legacyStop(e) { e.o1.stop(); e.o2.stop(); }

  // ---------- one-shots ----------
  function blip(freq, dur, type = 'sine', vol = 0.15, slide = 0, bus) {
    if (!A.on) return;
    const ctx = A.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(bus || A.sfx); o.start(t); o.stop(t + dur + 0.02);
  }
  function noiseBurst(dur, freq, q, vol, type = 'bandpass', when = 0, verb = 0) {
    if (!A.on) return;
    const ctx = A.ctx, t = ctx.currentTime + when;
    const s = noiseSrc(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(A.sfx); if (verb) { const vg = ctx.createGain(); vg.gain.value = verb; g.connect(vg); vg.connect(A.verbIn); }
    s.start(t); s.stop(t + dur + 0.05);
  }

  const ui = {
    move() { blip(1250, 0.05, 'triangle', 0.05); },
    select() { blip(880, 0.07, 'triangle', 0.08); setTimeout(() => blip(1320, 0.09, 'triangle', 0.07), 55); },
    back() { blip(660, 0.08, 'triangle', 0.07, 0.7); },
    tick() { blip(2000, 0.025, 'square', 0.025); },
  };

  // An impact: the thump of the chassis, the crunch of carbon and the rattle of bits,
  // scaled by how hard it was.
  function impact(power) {
    if (!A.on) return;
    const v = U.clamp(power / 25, 0.05, 1);
    blip(55 + Math.random() * 25, 0.18 + v * 0.25, 'sine', 0.55 * v, 0.45);
    noiseBurst(0.12 + v * 0.35, 700 + Math.random() * 400, 0.8, 0.45 * v, 'lowpass', 0, 0.6);
    if (v > 0.25) for (let k = 0; k < 3 + v * 8; k++) noiseBurst(0.03 + Math.random() * 0.05, 2500 + Math.random() * 4000, 3, 0.12 * v, 'bandpass', 0.02 + Math.random() * 0.35 * v, 0.3);
    R.scrape = Math.max(R.scrape, v * 0.6);
  }
  // a part breaking: a sharp carbon crack and its pieces skittering away
  function crack(power) {
    if (!A.on) return;
    const v = U.clamp(power / 25, 0.3, 1);
    noiseBurst(0.06, 3200, 1.2, 0.5 * v, 'highpass', 0, 0.8);
    blip(140, 0.12, 'triangle', 0.3 * v, 0.5);
    for (let k = 0; k < 10; k++) noiseBurst(0.02 + Math.random() * 0.04, 1800 + Math.random() * 5000, 4, 0.08 * v, 'bandpass', 0.08 + Math.random() * 0.9, 0.4);
  }
  function engineBlow() {
    if (!A.on) return;
    blip(48, 0.6, 'sawtooth', 0.4, 0.4);
    noiseBurst(0.5, 500, 0.7, 0.5, 'lowpass', 0, 0.9);
    for (let k = 0; k < 6; k++) noiseBurst(0.04, 900 + Math.random() * 1500, 3, 0.25, 'bandpass', 0.1 + k * 0.07 + Math.random() * 0.05, 0.5);
  }
  function light(n) { blip(n === 5 ? 520 : 440, 0.16, 'square', 0.05); }
  function go() { blip(880, 0.35, 'square', 0.06); }
  // a seamless-shift gearbox: the engine voice makes the ignition cut (up) or the rev-matching
  // blip (down); here only the dog rings engaging, a dull clunk through the chassis and the
  // driver's seat (louder on board)
  function shiftClack(dir) {
    R.shiftN = (R.shiftN || 0) + 1; R.shiftDir = dir || 1;
    const k = R.onboard ? 1 : 0.45;
    blip(dir < 0 ? 120 : 95, 0.05, 'sine', 0.14 * k, 0.6); noiseBurst(0.025, 2600, 2, 0.045 * k);
  }
  function chime(ok) { blip(ok ? 988 : 523, 0.12, 'sine', 0.08); setTimeout(() => blip(ok ? 1319 : 392, 0.18, 'sine', 0.07), 90); }

  // ---------- the race layer ----------
  const R = { engine: null, others: [], loops: null, scrape: 0, shiftT: 0, kerbT: 0, gravelT: 0, limT: 0, failed: false, pending: false };
  const N_OTHERS = 5;

  function loop(chain) {
    // a looping noise through a chain of filters into a gain (level 0 to start)
    const ctx = A.ctx, s = noiseSrc(chain.brown), g = ctx.createGain(); g.gain.value = 0;
    let n = s; const fs = [];
    for (const [type, f, q] of chain.f) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q || 0.7; n.connect(b); n = b; fs.push(b); }
    n.connect(g); g.connect(R.carBus || A.sfx); if (chain.verb) { const vg = ctx.createGain(); vg.gain.value = chain.verb; g.connect(vg); vg.connect(A.verbIn); }
    s.start();
    return { s, g, f: fs };
  }

  function startRace() {
    if (!A.on) return;
    stopRace();
    R.pending = true;
    A.workletReady.then(() => {
      if (!R.pending) return;
      R.pending = false;
      // the player's car's own sounds (tyres, road, wind...) share one bus, so a camera away
      // from the car hears them at the right distance and side
      const ctx0 = A.ctx;
      R.carBus = ctx0.createGain(); R.carLp = ctx0.createBiquadFilter(); R.carLp.type = 'lowpass'; R.carLp.frequency.value = 16000;
      R.carPan = ctx0.createStereoPanner ? ctx0.createStereoPanner() : null;
      R.carBus.connect(R.carLp); if (R.carPan) { R.carLp.connect(R.carPan); R.carPan.connect(A.sfx); } else R.carLp.connect(A.sfx);
      R.engine = makeVoice(false);
      // Reflections: the engine bounced back off the barrier on each side, delayed by the trip
      // there and back (2 x distance / 343 m/s), darker and quieter the further away the wall
      R.refl = [0, 1].map(k => {
        const dl = ctx0.createDelay(0.5), f = ctx0.createBiquadFilter(), g = ctx0.createGain();
        const pn = ctx0.createStereoPanner ? ctx0.createStereoPanner() : null;
        f.type = 'lowpass'; f.frequency.value = 2800; g.gain.value = 0; dl.delayTime.value = 0.05;
        R.engine.out.connect(dl); dl.connect(f); f.connect(g);
        if (pn) { pn.pan.value = k ? 0.75 : -0.75; g.connect(pn); pn.connect(A.sfx); } else g.connect(A.sfx);
        return { dl, f, g };
      });
      for (let k = 0; k < N_OTHERS; k++) R.others.push(makeVoice(true));
      R.loops = {
        squeal: loop({ f: [['bandpass', 1500, 9]] }),
        squeal2: loop({ f: [['bandpass', 2400, 12]] }),
        scrub: loop({ f: [['bandpass', 700, 1.2]] }),
        judder: loop({ brown: true, f: [['lowpass', 180, 1]] }),
        road: loop({ brown: true, f: [['lowpass', 300, 0.7]] }),
        // tyre on asphalt: the tread and the road texture (a band around 1 kHz) and the hum of the carcass
        tread: loop({ f: [['bandpass', 900, 0.8], ['lowpass', 2600, 0.7]] }),
        hum: loop({ brown: true, f: [['bandpass', 95, 1.4]] }),
        wind: loop({ f: [['lowpass', 700, 0.5]] }),
        buffet: loop({ brown: true, f: [['bandpass', 120, 0.8]] }),
        gravel: loop({ f: [['bandpass', 1600, 0.9]] }),
        grass: loop({ f: [['lowpass', 500, 0.7]] }),
        scrape: loop({ f: [['bandpass', 3200, 2], ['highpass', 1200, 0.7]], verb: 0.4 }),
        plank: loop({ f: [['bandpass', 4800, 3]] }),
        rain: loop({ f: [['highpass', 3000, 0.6]] }),
        spray: loop({ f: [['bandpass', 1100, 0.6]] }),
        crowd: loop({ brown: false, f: [['bandpass', 600, 0.4], ['lowpass', 1400, 0.6]], verb: 0.8 }),
      };
      // each turn of the wheels thumps a little through the rumble (a tyre is never perfectly round)
      const ctx = A.ctx, lfo = ctx.createOscillator(), dep = ctx.createGain();
      lfo.frequency.value = 1; dep.gain.value = 0; lfo.connect(dep); dep.connect(R.loops.hum.g.gain); lfo.start();
      R.wheelLfo = { lfo, dep };
    });
  }

  function stopRace() {
    R.pending = false;
    if (!A.ctx) return;
    stopVoice(R.engine); R.engine = null;
    R.others.forEach(stopVoice); R.others = [];
    if (R.loops) {
      const t = A.ctx.currentTime;
      for (const k in R.loops) { const l = R.loops[k]; l.g.gain.setTargetAtTime(0, t, 0.05); setTimeout(() => { try { l.s.stop(); l.g.disconnect(); } catch (x) { /* ignore */ } }, 300); }
      R.loops = null;
    }
    if (R.wheelLfo) { try { R.wheelLfo.lfo.stop(); R.wheelLfo.dep.disconnect(); } catch (x) { /* ignore */ } R.wheelLfo = null; }
    if (R.refl) { R.refl.forEach(r => { try { r.g.disconnect(); r.dl.disconnect(); } catch (x) { /* ignore */ } }); R.refl = null; }
    if (R.carBus) { const b = R.carBus; setTimeout(() => { try { b.disconnect(); } catch (x) { /* ignore */ } }, 300); R.carBus = null; }
    R.dist = {};
    R.failed = false;
  }

  let lastT = 0;
  // listener = the player's car; cam = the game camera ({ mode, ... })
  function updateRace(race, p, cam, paused) {
    if (!A.on || !R.engine || !R.loops) return;
    const t = A.ctx.currentTime, dt = Math.min(0.1, Math.max(0, t - lastT)); lastT = t;
    const L = R.loops;
    if (paused) {
      R.engine.out.gain.setTargetAtTime(0, t, 0.05);
      R.others.forEach(e => e.out.gain.setTargetAtTime(0, t, 0.05));
      for (const k in L) L[k].g.gain.setTargetAtTime(0, t, 0.05);
      return;
    }
    const mode = cam && cam.mode || 'chase', onboard = mode === 'cockpit' || mode === 'helmet' || mode === 'tcam';
    const v = p.speed || 0, kmh = v * 3.6;
    const thr0 = p.throttleOut != null ? p.throttleOut : p.ctl.throttle;
    const dm = p.dm, dead = dm && dm.failed === 'ENGINE';
    if (dead && !R.failed) { R.failed = true; engineBlow(); }
    // pit limiter: the ignition cuts in and out against the speed limit
    let on = 1;
    if (p.limiter && p.u > p.limitSpeed - 1) { R.limT += dt; on = Math.sin(R.limT * 2 * Math.PI * 9) > -0.2 ? 1 : 0.15; }
    R.onboard = onboard;
    // The listener: on board, the driver; outside, the camera itself, so a trackside camera hears
    // the car arrive, pass with the Doppler drop in pitch and fade away, and a chase camera hears
    // it just ahead. Each source's closing speed comes from how fast its distance to the
    // listener changes (camera and car motion both count); a camera cut resets it.
    const C3 = F1.R3 && F1.R3.camera;
    let lx = p.x, ly = p.y, fx = Math.cos(p.h), fy = Math.sin(p.h), rx = -fy, ry = fx;
    if (!onboard && C3) {
      // the camera's own axes (the sim's y is the scene's z): forward is -Z, right is +X
      lx = C3.position.x; ly = C3.position.z;
      const e = C3.matrixWorld.elements, l = Math.hypot(e[8], e[10]) || 1, lr = Math.hypot(e[0], e[2]) || 1;
      fx = -e[8] / l; fy = -e[10] / l; rx = e[0] / lr; ry = e[2] / lr;
    }
    if (R.lastMode !== mode) { R.dist = {}; R.lastMode = mode; }
    const src = (key, sx, sy) => {
      const dx = sx - lx, dy = sy - ly, d = Math.max(0.5, Math.hypot(dx, dy)), D = R.dist || (R.dist = {});
      const prev = D[key];
      let vr = prev ? (d - prev.d) / Math.max(1e-3, dt) : 0;
      if (Math.abs(vr) > 160) vr = 0; // a cut or a teleport, not motion
      const vs = prev ? prev.v + (vr - prev.v) * Math.min(1, dt * 8) : 0;
      D[key] = { d, v: vs };
      const lat = (dx * rx + dy * ry) / d, fwd = (dx * fx + dy * fy) / d;
      return { d, dop: U.clamp(343 / (343 + vs), 0.7, 1.4), lat, fwd };
    };
    const me = src('me', p.x, p.y);
    // --- the player's engine ---
    // view: 1 on board, 0 outside (the exhaust leads). On board uses the voicing fitted to a
    // T-cam microphone recording (js/audio-engine-worklet.js); the T-cam, cockpit and helmet
    // views all sit at the airbox, the cockpit and helmet a little duller (lp below)
    const view = onboard ? 1 : 0;
    const harv = (p.harvest || 0) * Math.min(1, v / 30);
    const dopMe = onboard ? 1 : +me.dop.toFixed(3);
    setVoice(R.engine, { rpm: dead ? Math.max(600, (p.rpm || 4000) * 0.2) : p.rpm, thr: dead ? 0 : thr0, speed: v, gear: p.gear, dop: dopMe, kers: p.deploy || 0, harv: +harv.toFixed(2), view, shift: R.shiftN || 0, shiftDir: R.shiftDir || 1, on: dead ? 0.05 : on, gain: 1 });
    // outside: the level falls past 10 m, the air takes the top end off, and the car sits where it is
    const far = onboard ? 1 : Math.min(1, Math.pow(10 / me.d, 1.25));
    const engLvl = (onboard ? 0.95 : 0.82) * far;
    R.engine.out.gain.setTargetAtTime(dead ? 0 : engLvl, t, 0.03);
    R.engine.eq.gain.setTargetAtTime(onboard ? 1.5 : -1, t, 0.2);
    R.engine.shelf.gain.setTargetAtTime(onboard ? -3 : -2, t, 0.2);
    // the engine's faint room: a touch more on board, where the dry low end is closest
    R.engine.roomSend.gain.setTargetAtTime(onboard ? 0.14 : 0.1, t, 0.3);
    const air = onboard ? (mode === 'tcam' ? 15000 : 9000) : Math.max(1500, 15000 / (1 + me.d / 60)) * (me.fwd < -0.3 ? 0.75 : 1);
    R.engine.lp.frequency.setTargetAtTime(air, t, 0.1);
    if (R.engine.pan) at(R.engine.pan.pan, onboard ? 0 : U.clamp(me.lat * 0.85, -1, 1), 0.05);
    if (R.carBus) {
      at(R.carBus.gain, onboard ? 1 : far, 0.05);
      at(R.carLp.frequency, onboard ? 16000 : air, 0.1);
      if (R.carPan) at(R.carPan.pan, onboard ? 0 : U.clamp(me.lat * 0.85, -1, 1), 0.05);
    }
    // reflections off the barriers either side of the car
    if (R.refl && race.track && p.loc && p.loc.i >= 0) {
      const tr = race.track, i = p.loc.i, dd = p.loc.d || 0;
      [Math.max(1, tr.barr[0][i] + dd), Math.max(1, tr.barr[1][i] - dd)].forEach((w, k) => {
        const r = R.refl[k];
        at(r.dl.delayTime, U.clamp(2 * w / 343, 0.004, 0.45), 0.08);
        at(r.g.gain, (onboard ? 0.16 : 0.11) * Math.exp(-w / 22) * far, 0.08);
        at(r.f.frequency, 3500 / (1 + w / 30), 0.1);
      });
    }
    // --- tyres ---
    const W = p.wheels || [];
    const lock = W.reduce((a, w) => Math.max(a, w.lock || 0), 0), spin = W.reduce((a, w) => Math.max(a, w.spin || 0), 0);
    const slideL = Math.max(0, (p.slipLat || 0) - 1.2) * 0.05, slip = slideL + (p.slipLong || 0) * 0.04;
    const tarmac = (p.surfMask & 0b100111) !== 0, wet = race.wet || 0;
    const sq = tarmac ? U.clamp(slip, 0, 0.24) * (1 - 0.7 * wet) : 0;
    at(L.squeal.g.gain, sq, 0.04); at(L.squeal2.g.gain, sq * 0.6, 0.05);
    at(L.squeal.f[0].frequency, 1200 + Math.min(900, v * 7) + (Math.random() - 0.5) * 160, 0.05);
    at(L.scrub.g.gain, tarmac ? U.clamp(slip * 0.6 + spin * 0.06, 0, 0.12) : 0, 0.05);
    at(L.judder.g.gain, lock * Math.min(1, v / 20) * 0.35, 0.03); // a locked tyre flat-spotting
    // --- road and surfaces ---
    const SURF = F1.SURF, gravel = (p.surfMask & (1 << SURF.GRAVEL)) ? 1 : 0, grass = (p.surfMask & (1 << SURF.GRASS)) ? 1 : 0;
    at(L.road.g.gain, Math.min(0.4, v / 210) * (onboard ? 1.3 : 0.7), 0.1);
    at(L.road.f[0].frequency, 120 + v * 3.2, 0.1);
    // rolling: tread noise grows a little faster than speed and brightens with it; on board the
    // tyres are an arm's length from the helmet
    const roll = tarmac ? Math.min(1, Math.pow(v / 85, 1.3)) * (1 - 0.5 * wet) : 0;
    at(L.tread.g.gain, roll * (onboard ? 0.135 : 0.063), 0.08);
    at(L.tread.f[0].frequency, 600 + v * 6, 0.1);
    at(L.hum.g.gain, Math.min(0.25, v / 280) * (onboard ? 1.4 : 0.6), 0.1);
    if (R.wheelLfo) { at(R.wheelLfo.lfo.frequency, Math.max(0.5, v / 2.262), 0.05); at(R.wheelLfo.dep.gain, Math.min(0.09, v / 900) * (onboard ? 1 : 0.4), 0.1); }
    // seams and patches in the asphalt: a tick and a thud through the stiff suspension now and then
    if (tarmac && v > 12) {
      R.seamT = (R.seamT == null ? 1 : R.seamT) - dt;
      if (R.seamT <= 0) {
        R.seamT = (18 + Math.random() * 60) / v;
        const k = Math.min(1, v / 70) * (onboard ? 1 : 0.35);
        blip(85 + Math.random() * 40, 0.045, 'sine', 0.07 * k, 0.6); noiseBurst(0.018, 1400 + Math.random() * 900, 1.2, 0.025 * k);
      }
    }
    // the DRS flap opening and closing: a pneumatic clack behind the driver
    if (p.drsOpen !== R.drs) { if (R.drs != null && v > 20) { noiseBurst(0.04, 1900, 1.5, (onboard ? 0.09 : 0.05)); blip(160, 0.05, 'triangle', onboard ? 0.06 : 0.03, 0.7); } R.drs = p.drsOpen; }
    at(L.gravel.g.gain, gravel * Math.min(0.45, v / 60) * (0.6 + 0.4 * Math.random()), 0.03);
    at(L.grass.g.gain, grass * Math.min(0.3, v / 80), 0.05);
    // kerbs: a thump each time a tyre crosses a kerb block (about 1 m apart)
    if (p.onKerb > 0 && v > 6) {
      R.kerbT -= dt;
      if (R.kerbT <= 0) { R.kerbT = Math.max(0.025, 1.0 / v); blip(70 + Math.random() * 15, 0.05, 'sine', Math.min(0.32, v / 160) * (onboard ? 1.2 : 0.8), 0.7); noiseBurst(0.03, 900, 1, Math.min(0.08, v / 600)); }
    }
    // --- air ---
    at(L.wind.g.gain, Math.min(0.16, v * v / 50000) * (onboard ? 1.3 : 0.75), 0.1);
    at(L.wind.f[0].frequency, 300 + v * 14, 0.1);
    at(L.buffet.g.gain, onboard ? Math.min(0.2, v * v / 70000) * (0.75 + 0.25 * Math.sin(t * 7.3)) : 0, 0.05);
    // --- contact: walls, the plank, a corner with no wheel ---
    R.scrape *= Math.pow(0.02, dt);
    const wheelGone = dm && dm.wheelOff.some(x => x) ? 1 : 0;
    at(L.scrape.g.gain, Math.min(0.4, R.scrape * Math.min(1, v / 15) + wheelGone * Math.min(0.35, v / 30)), 0.03);
    at(L.plank.g.gain, Math.min(0.18, (p.bottoming || 0) * Math.min(1, v / 40) * 0.3), 0.02);
    // --- weather and the crowd ---
    const rain = race.rain || 0;
    at(L.rain.g.gain, rain * (onboard ? 0.16 : 0.1), 0.3);
    at(L.spray.g.gain, wet * Math.min(0.2, v / 250), 0.1);
    at(L.crowd.g.gain, 0.025 + 0.015 * Math.max(0, Math.sin(t * 0.13)), 0.5);

    // --- the nearest cars ---
    const near = race.cars.filter(c => c !== p && !c.retired).map(c => ({ c, d: Math.hypot(c.x - lx, c.y - ly) })).sort((a, b) => a.d - b.d).slice(0, R.others.length);
    R.others.forEach((e, k) => {
      const n = near[k];
      if (!n || n.d > 400) { e.out.gain.setTargetAtTime(0, t, 0.1); return; }
      const c = n.c, s0 = src('c' + c.id, c.x, c.y), dop = s0.dop, lat = s0.lat, fwd = s0.fwd;
      const cdead = c.dm && c.dm.failed === 'ENGINE';
      setVoice(e, { rpm: cdead ? 700 : c.rpm, thr: cdead ? 0 : (c.throttleOut != null ? c.throttleOut : 0.5), speed: c.speed, gear: c.gear, dop: +dop.toFixed(3), kers: 0, on: cdead ? 0 : 1, gain: 1 });
      // level falls with distance; the air takes the top end off far-away cars; behind is duller
      const lvl = 0.75 / (1 + (n.d / 9) ** 1.6);
      at(e.out.gain, lvl, 0.06);
      at(e.lp.frequency, Math.max(900, 15000 / (1 + n.d / 25) * (fwd < 0 ? 0.7 : 1)), 0.08);
      if (e.pan) at(e.pan.pan, U.clamp(lat * 0.9, -1, 1), 0.06);
    });
  }

  // ---------- menu music: slow generative synth pad ----------
  const M = { nodes: null, step: 0, timer: null };
  const CHORDS = [[45, 52, 57, 60, 64], [41, 48, 53, 57, 60], [43, 50, 55, 59, 62], [40, 47, 52, 55, 59]];
  const mtof = n => 440 * Math.pow(2, (n - 69) / 12);
  function musicStart() {
    if (!A.on || M.timer) return;
    const ctx = A.ctx;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1200; lp.Q.value = 0.7;
    const dly = ctx.createDelay(1.2); dly.delayTime.value = 0.42;
    const fb = ctx.createGain(); fb.gain.value = 0.38;
    lp.connect(A.musicBus); lp.connect(dly); dly.connect(fb); fb.connect(dly); dly.connect(A.musicBus);
    M.nodes = { lp, dly, fb };
    const bar = () => {
      const ch = CHORDS[M.step % CHORDS.length];
      const t = ctx.currentTime;
      ch.forEach((n, k) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = k === 0 ? 'triangle' : 'sawtooth';
        o.frequency.value = mtof(n) * (k === 0 ? 0.5 : 1);
        o.detune.value = (Math.random() - 0.5) * 12;
        const v = k === 0 ? 0.09 : 0.022;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 1.2);
        g.gain.setValueAtTime(v, t + 3.2); g.gain.exponentialRampToValueAtTime(0.0001, t + 4.6);
        o.connect(g); g.connect(lp); o.start(t); o.stop(t + 4.8);
      });
      for (let q = 0; q < 8; q++) {
        const n = ch[1 + (q * 3) % 4] + 12;
        const tt = t + q * 0.5;
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'triangle'; o.frequency.value = mtof(n);
        g.gain.setValueAtTime(0.0001, tt); g.gain.exponentialRampToValueAtTime(0.035, tt + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.4);
        o.connect(g); g.connect(lp); o.start(tt); o.stop(tt + 0.45);
      }
      M.step++;
    };
    bar();
    M.timer = setInterval(bar, 4000);
  }
  function musicStop() {
    if (M.timer) { clearInterval(M.timer); M.timer = null; }
    if (M.nodes) { const n = M.nodes; setTimeout(() => { try { n.lp.disconnect(); n.dly.disconnect(); } catch (x) { /* ignore */ } }, 5000); M.nodes = null; }
  }

  function setVolumes(v) {
    Object.assign(A.vol, v);
    if (!A.ctx) return;
    A.master.gain.value = A.vol.master;
    A.sfx.gain.value = A.vol.sfx;
    A.musicBus.gain.value = A.vol.music * 0.5;
  }

  F1.Audio = { A, init, ui, impact, crack, engineBlow, light, go, shiftClack, chime, startRace, stopRace, updateRace, musicStart, musicStop, setVolumes, blip, _race: R };
})(typeof window !== 'undefined' ? window : globalThis);
