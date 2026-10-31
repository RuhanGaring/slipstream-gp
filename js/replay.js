// Replays. While a session runs, the recorder samples every car twenty times a second: where
// it is and how it sits (pose, suspension, steering), what it is doing (speed, revs, gear,
// pedals, DRS, pit limiter, tyres) and its place in the race, plus the race around it
// (clock, start lights, weather, safety car). Floats only, in fixed-size chunks; the oldest
// chunk goes once the buffer holds 15 minutes, so a long race keeps its last stretch.
// Playback writes an interpolated sample back onto the race's own car objects, so the
// renderer, the audio and every camera work exactly as they do live; the live state is
// saved on the way in and put back on the way out, so a replay can be watched from the
// pause menu and the session carries on as if nothing happened.
(function (G) {
  'use strict';
  const F1 = G.F1;
  const U = F1.U;

  const HZ = 20, CHUNK = HZ * 30, MAX_FRAMES = HZ * 60 * 15;
  // per car: 0 x, 1 y, 2 h, 3 speed, 4 u, 5 steer, 6 zh, 7 pitch, 8 roll, 9 ax, 10 ay, 11 rpm,
  // 12 gear, 13 loc.s, 14 loc.d, 15 throttle, 16 brake, 17 flags, 18 compound, 19 pos, 20 lap,
  // 21 soc, 22 dist
  const NF = 23;
  // race: 0 time, 1 lights, 2 rain, 3 wet, 4 sc.x, 5 sc.y, 6 sc.h, 7 sc.vis, 8 leader lap
  const NR = 9;
  const SMOOTH = [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 15, 16, 21, 22]; // interpolated (h and s wrap)
  const COMP = ['S', 'M', 'H', 'I', 'W'];
  const F_DRS = 1, F_LIM = 2, F_RET = 4, F_HID = 8, F_PIT = 16;

  function Recorder(race) {
    this.race = race;
    this.n = race.cars.length;
    this.chunks = []; this.rchunks = [];
    this.frames = 0; this.first = 0; // frames recorded, index of the oldest still kept
    this.next = 0; // race time of the next sample
    // events for the timeline: { f: frame, type, car: id, other: id, label }
    this.events = []; this.prevPos = new Map(); this.prevPit = new Map(); this.fastest = null; this.scVis = false; this.lastHit = new Map();
  }
  Recorder.prototype.event = function (type, car, other, label) {
    this.events.push({ f: this.frames, t: this.race.time, type, car: car ? car.id : null, other: other ? other.id : null, label });
  };
  // a contact between two cars (from the race's effect events); one per pair every few seconds
  Recorder.prototype.contact = function (f) {
    if (!f || f.type !== 'car' || !(f.power > 3) || !f.car || !f.other) return;
    const key = Math.min(f.car.id, f.other.id) + ':' + Math.max(f.car.id, f.other.id), t = this.race.time;
    if (this.lastHit.get(key) > t - 4) return;
    this.lastHit.set(key, t);
    this.event('contact', f.car, f.other, `CONTACT  ${f.car.driver.code} / ${f.other.driver.code}`);
  };
  // overtakes, pit stops, fastest laps, the safety car: found by comparing with the last sample
  Recorder.prototype.scan = function () {
    const race = this.race;
    if (!race.green) return;
    for (const c of race.cars) {
      const pit = !!c.inPit, wasPit = this.prevPit.get(c.id);
      if (pit && wasPit === false) this.event('pit', c, null, `PIT STOP  ${c.driver.code}`);
      this.prevPit.set(c.id, pit);
    }
    if (race.mode !== 'tt' && race.time - race.startTime > 6) {
      for (const c of race.cars) {
        const was = this.prevPos.get(c.id);
        if (was != null && c.pos && c.pos < was && !c.inPit && !c.retired) {
          // passed on track: the car now behind it was ahead before, and is not in the pits either
          const o = race.cars.find(x => x.pos === c.pos + 1);
          if (o && !o.inPit && !o.retired && this.prevPos.get(o.id) === c.pos) this.event('pass', c, o, `${c.driver.code} PASSES ${o.driver.code} FOR P${c.pos}`);
        }
      }
    }
    for (const c of race.cars) this.prevPos.set(c.id, c.pos);
    const fl = race.fastest;
    if (fl && fl.car && (!this.fastest || fl.t < this.fastest)) { this.fastest = fl.t; this.event('fastest', fl.car, null, `FASTEST LAP  ${fl.car.driver.code}  ${U.fmtTime(fl.t)}`); }
    const vis = !!(race.sc && race.sc.vis);
    if (vis && !this.scVis) this.event('sc', null, null, 'SAFETY CAR');
    this.scVis = vis;
  };
  Recorder.prototype.capture = function () {
    const race = this.race;
    if (race.time < this.next) return;
    this.next = race.time + 1 / HZ;
    const k = this.frames % CHUNK;
    if (k === 0) { this.chunks.push(new Float32Array(CHUNK * this.n * NF)); this.rchunks.push(new Float32Array(CHUNK * NR)); }
    const A = this.chunks[this.chunks.length - 1], R = this.rchunks[this.rchunks.length - 1];
    race.cars.forEach((c, j) => writeCar(A, (k * this.n + j) * NF, c));
    const o = k * NR, sc = race.sc;
    R[o] = race.time; R[o + 1] = race.lightsOn || 0; R[o + 2] = race.rain || 0; R[o + 3] = race.wet || 0;
    if (sc) { R[o + 4] = sc.x || 0; R[o + 5] = sc.y || 0; R[o + 6] = sc.h || 0; R[o + 7] = sc.vis ? 1 : 0; }
    R[o + 8] = race.order && race.order[0] ? race.order[0].lap || 0 : 0;
    this.scan();
    this.frames++;
    // keep at most MAX_FRAMES: drop whole chunks from the front
    while ((this.chunks.length - 1) * CHUNK > MAX_FRAMES) { this.chunks.shift(); this.rchunks.shift(); this.first += CHUNK; }
  };
  Recorder.prototype.count = function () { return this.frames - this.first; };
  function writeCar(A, o, c) {
    A[o] = c.x; A[o + 1] = c.y; A[o + 2] = c.h; A[o + 3] = c.speed || 0; A[o + 4] = c.u || 0; A[o + 5] = c.steer || 0;
    A[o + 6] = c.zh || 0; A[o + 7] = c.pitch || 0; A[o + 8] = c.roll || 0; A[o + 9] = c.ax || 0; A[o + 10] = c.ay || 0;
    A[o + 11] = c.rpm || 0; A[o + 12] = c.gear || 0; A[o + 13] = c.loc ? c.loc.s : 0; A[o + 14] = c.loc ? c.loc.d : 0;
    A[o + 15] = c.throttleOut != null ? c.throttleOut : c.ctl ? c.ctl.throttle : 0; A[o + 16] = c.ctl ? c.ctl.brake : 0;
    A[o + 17] = (c.drsOpen ? F_DRS : 0) | (c.limiter ? F_LIM : 0) | (c.retired ? F_RET : 0) | (c.hidden ? F_HID : 0) | (c.inPit ? F_PIT : 0);
    A[o + 18] = Math.max(0, COMP.indexOf(c.compound && c.compound.id));
    A[o + 19] = c.pos || 0; A[o + 20] = c.lap || 0; A[o + 21] = c.soc != null ? c.soc : 0; A[o + 22] = c.dist || 0;
  }
  // the address of frame f (an absolute frame number) in the chunks
  Recorder.prototype.at = function (f) {
    const r = f - this.first, ci = Math.floor(r / CHUNK);
    return { A: this.chunks[ci], R: this.rchunks[ci], k: r - ci * CHUNK };
  };
  Recorder.prototype.raceAt = function (f, i) { const p = this.at(f); return p.R[p.k * NR + i]; };

  // ---------- playback ----------
  function Player(rec) {
    this.rec = rec; this.race = rec.race;
    this.f0 = rec.first; this.f1 = rec.frames - 1; // playable frame range
    this.t = 0; // frame position (float, absolute)
    this.rate = 1; this.playing = true;
    // the live state, to put back afterwards
    this.saved = this.race.cars.map(c => {
      const A = new Float32Array(NF); writeCar(A, 0, c);
      return { A, omega: c.wheels ? c.wheels.map(w => w.omega) : null, compound: c.compound, ctl: c.ctl ? { throttle: c.ctl.throttle, brake: c.ctl.brake } : null, throttleOut: c.throttleOut, wheelsV: c.wheels ? c.wheels.map(w => ({ comp: w.comp })) : null };
    });
    const r = this.race, sc = r.sc;
    this.savedRace = { time: r.time, lightsOn: r.lightsOn, rain: r.rain, wet: r.wet, sc: sc ? { x: sc.x, y: sc.y, h: sc.h, vis: sc.vis } : null };
    // events still inside the buffer, and the leader's lap starts for the timeline
    this.events = rec.events.filter(e => e.f >= this.f0 && e.f <= this.f1).map(e => Object.assign({ at: (e.f - this.f0) / HZ }, e));
    this.lapMarks = [];
    let lastLap = null;
    for (let f = this.f0; f <= this.f1; f += 2) { const l = rec.raceAt(f, 8); if (lastLap != null && l > lastLap && l > 1) this.lapMarks.push({ t: (f - this.f0) / HZ, lap: l }); lastLap = l; }
    this.seek(this.f0);
  }
  // the event after / before the current moment (with a few seconds of lead-in)
  Player.prototype.nextEvent = function (dir) {
    const at = this.pos(), lead = 3;
    const list = dir > 0 ? this.events.filter(e => e.at - lead > at + 0.5) : this.events.filter(e => e.at - lead < at - 1.5).reverse();
    return list[0] || null;
  };
  Player.prototype.length = function () { return Math.max(0, this.f1 - this.f0) / HZ; };
  Player.prototype.pos = function () { return (this.t - this.f0) / HZ; };
  Player.prototype.seek = function (f) { this.t = U.clamp(f, this.f0, this.f1); };
  Player.prototype.seekTime = function (s) { this.seek(this.f0 + s * HZ); };
  Player.prototype.advance = function (dt) {
    if (!this.playing) return;
    this.t += dt * HZ * this.rate;
    if (this.t >= this.f1) { this.t = this.f1; this.playing = false; }
    if (this.t <= this.f0) { this.t = this.f0; if (this.rate < 0) this.playing = false; }
  };
  // write the sample at the current position onto the cars and the race
  Player.prototype.apply = function () {
    const rec = this.rec, race = this.race, tr = race.track;
    const fa = Math.floor(this.t), fb = Math.min(this.f1, fa + 1), a = this.t - fa;
    const P = rec.at(fa), Q = rec.at(fb);
    race.cars.forEach((c, j) => {
      const oa = (P.k * rec.n + j) * NF, ob = (Q.k * rec.n + j) * NF, A = P.A, B = Q.A;
      const v = new Float32Array(NF);
      for (let i = 0; i < NF; i++) v[i] = A[oa + i];
      for (const i of SMOOTH) v[i] = A[oa + i] + (B[ob + i] - A[oa + i]) * a;
      v[2] = A[oa + 2] + U.wrapAngle(B[ob + 2] - A[oa + 2]) * a;
      let ds = B[ob + 13] - A[oa + 13];
      if (ds < -tr.L / 2) ds += tr.L; else if (ds > tr.L / 2) ds -= tr.L;
      v[13] = (A[oa + 13] + ds * a + tr.L) % tr.L;
      // a car that jumped (recovered onto the track, into its box) is not blended across
      if ((B[ob] - A[oa]) ** 2 + (B[ob + 1] - A[oa + 1]) ** 2 > 400) for (let i = 0; i < NF; i++) v[i] = (a < 0.5 ? A[oa + i] : B[ob + i]);
      readCar(c, v, tr);
    });
    const ra = P.R, rb = Q.R, oa = P.k * NR, ob = Q.k * NR;
    race.time = ra[oa] + (rb[ob] - ra[oa]) * a;
    race.lightsOn = ra[oa + 1]; race.rain = ra[oa + 2] + (rb[ob + 2] - ra[oa + 2]) * a; race.wet = ra[oa + 3] + (rb[ob + 3] - ra[oa + 3]) * a;
    if (race.sc) { race.sc.x = ra[oa + 4] + (rb[ob + 4] - ra[oa + 4]) * a; race.sc.y = ra[oa + 5] + (rb[ob + 5] - ra[oa + 5]) * a; race.sc.h = ra[oa + 6] + U.wrapAngle(rb[ob + 6] - ra[oa + 6]) * a; race.sc.vis = ra[oa + 7] > 0.5; }
    this.leaderLap = ra[oa + 8];
  };
  function readCar(c, v, tr) {
    c.x = v[0]; c.y = v[1]; c.h = v[2]; c.speed = v[3]; c.u = v[4]; c.steer = v[5]; c.zh = v[6]; c.pitch = v[7]; c.roll = v[8];
    c.ax = v[9]; c.ay = v[10]; c.rpm = v[11]; c.gear = Math.round(v[12]);
    if (c.loc) { c.loc.s = v[13]; c.loc.d = v[14]; c.loc.i = Math.floor(v[13] / tr.ds) % tr.N; }
    c.throttleOut = v[15]; if (c.ctl) { c.ctl.throttle = v[15]; c.ctl.brake = v[16]; }
    const fl = v[17] | 0;
    c.drsOpen = !!(fl & F_DRS); c.limiter = !!(fl & F_LIM); c.retired = !!(fl & F_RET); c.hidden = !!(fl & F_HID); c.inPit = !!(fl & F_PIT);
    const comp = F1.Car.COMPOUNDS[COMP[v[18] | 0]]; if (comp) c.compound = comp;
    c.pos = v[19] | 0; c.lap = v[20] | 0; c.soc = v[21]; c.dist = v[22];
    // the wheels turn with the road speed (the recorded spin of each one is not kept)
    if (c.wheels) for (const w of c.wheels) w.omega = c.u / 0.36;
  }
  // put the live session back as it was
  Player.prototype.restore = function () {
    const race = this.race, tr = race.track;
    race.cars.forEach((c, j) => {
      const s = this.saved[j];
      readCar(c, s.A, tr);
      c.compound = s.compound; c.throttleOut = s.throttleOut;
      if (c.ctl && s.ctl) { c.ctl.throttle = s.ctl.throttle; c.ctl.brake = s.ctl.brake; }
      if (c.wheels && s.omega) c.wheels.forEach((w, k) => { w.omega = s.omega[k]; });
    });
    const sr = this.savedRace;
    race.time = sr.time; race.lightsOn = sr.lightsOn; race.rain = sr.rain; race.wet = sr.wet;
    if (race.sc && sr.sc) Object.assign(race.sc, sr.sc);
  };

  F1.Replay = { HZ, Recorder, Player };
})(typeof window !== 'undefined' ? window : globalThis);
