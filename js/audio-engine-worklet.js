// The engine voice of a current (2014 to 2025 rules) Formula 1 power unit, run on the audio
// thread (an AudioWorklet). The whole worklet is the body of F1.EngineWorklet: js/audio.js
// turns its source into a blob and loads that, so it works offline from file:// as well.
//
// What is modelled, from the hardware the regulations fix:
// - A 1.6 litre 90 degree V6, four-stroke, crankshaft with split pins so it fires evenly every
//   120 degrees: three firings per crank revolution, the third engine order, rpm / 20 Hz
//   (550 Hz at 11,000 rpm). Rev limit 15,000 rpm, but the 100 kg/h fuel-flow cap is reached at
//   10,500 rpm, so cars race between about 10,500 and 12,000 rpm and the note lives there.
// - Each firing is a blowdown pulse down that cylinder's primary pipe. The two banks have their
//   own primaries into a single six-into-one collector, and the small differences between the
//   banks and between cylinders give the half orders (1.5, 0.5) under the main note.
// - The collector feeds one turbine. The turbine takes energy out of the pulses (it drives
//   the compressor and the MGU-H), which smooths and quietens them: this is why the V6 is
//   quieter and duller than the old V8s. A wastegate lets surplus exhaust bypass the turbine
//   through its own small tailpipe(s) (separate wastegate pipes are compulsory from 2019); open
//   at high load and high rpm, it brings back the raw rasp.
// - The tailpipe is a resonator (a tuned pipe: a comb filter whose return is damped and
//   low-passed by the hot gas), then radiated with the rising top end of a pipe mouth.
// - The airbox and plenum above the driver's head: the induction pulses through a Helmholtz
//   resonance plus the hiss of the intake, loud on board, faint outside.
// - The turbocharger shaft (limited to 125,000 rpm). On throttle it spools with boost; off
//   throttle the MGU-H keeps it turning so there is no lag. Its compressor whistle, and the
//   MGU-H's own electric whine, ride on top.
// - The MGU-K, geared to the crankshaft (about 3.3 to 1: its 50,000 rpm limit against the
//   engine's 15,000). Its electric whine follows engine rpm, loudest when it deploys and
//   loudest of all when it harvests under braking (the falling whine on every onboard).
// - The straight-cut gears of the eight-speed seamless gearbox: one mesh tone from the input
//   shaft (engine rpm) and one from the output (road speed).
// - Seamless upshifts: a few milliseconds of ignition cut and a crack as the next gear takes
//   drive. Downshifts: the engine blips itself to match revs, a short bark, and on the overrun
//   a little unburnt fuel lights in the hot exhaust: crackle.
(function (G) {
  'use strict';
  (G.F1 = G.F1 || {}).EngineWorklet = function () {
    // firing order 1-6-3-4-2-5 style alternation between banks; per-cylinder strength and the
    // tiny timing spread of real combustion
    const BANK = [0, 1, 0, 1, 0, 1];
    const CYL = [1.0, 0.972, 1.018, 0.986, 1.01, 0.978];
    // on board, the cylinders differ more: each has its own intake runner length to the plenum
    const VAR = [0.0, 0.5, -0.6, 0.2, 0.55, -0.4];
    const TWO_PI = 6.283185307;
    class EngineVoice extends AudioWorkletProcessor {
      constructor(opts) {
        super();
        this.p = { rpm: 4000, thr: 0, speed: 0, gear: 1, dop: 1, kers: 0, harv: 0, view: 0, gain: 1, cheap: 0, on: 1, shift: 0, shiftDir: 0 };
        this.s = { rpm: 4000, thr: 0, kers: 0, harv: 0, view: 0, turbo: 60000, wg: 0, load: 0 };
        this.ph = 0; this.cyl = 0;
        this.env = [0, 0]; // blowdown pulse per bank
        this.prim = [new Float32Array(512), new Float32Array(512)]; this.pi = 0;
        this.comb = new Float32Array(4096); this.ci = 0; this.clp = 0;
        this.tlp1 = 0; this.tlp2 = 0; this.rad = 0; this.dcx = 0; this.dcy = 0; this.o1 = 0; this.o2 = 0;
        this.hb = [0, 0, 0, 0]; this.ib = [0, 0, 0, 0]; this.lb = [0, 0, 0, 0]; this.nb = [0, 0, 0, 0];
        this.tph = 0; this.hph = 0; this.kph = 0; this.giph = 0; this.goph = 0;
        this.lastShift = 0; this.cut = 0; this.bark = 0; this.crackle = 0; this.lastThr = 0; this.flutter = 0;
        this.seed = Math.random() * 1e9 | 0; this.si = 0;
        this.menv = 0; this.mb1 = [0, 0, 0, 0]; this.mb2 = [0, 0, 0, 0]; this.mlp = 0; this.mhb = [0, 0, 0, 0]; this.ml1 = 0; this.ml2 = 0;
        // the on-board microphone's voicing, fitted to a T-cam recording of a 2026 car at full
        // throttle (10,600 to 11,800 rpm) by matching its engine-order profile and octave balance;
        // see ONB below. The fit settled on the far bank inaudible (asym 1): from the airbox the
        // near bank's firings, the 1.5 order, carry the note
        this.T = { jit: 0.04, asym: 1.0, vary: 0.4, mDecay: 0.00412, plF: 299, plQ: 1.89, plG: 0.555, p2F: 240, p2Q: 3.44, p2G: 0.571, lpF: 2490, lpG: 0, hiF: 1676, hiQ: 0.4, hiG: 0.3755, mix: 0.85, mGain: 1, oLP: 761 };
        if (opts && opts.processorOptions) { Object.assign(this.p, opts.processorOptions); if (opts.processorOptions.tune) Object.assign(this.T, opts.processorOptions.tune); }
        this.port.onmessage = e => Object.assign(this.p, e.data);
      }
      rnd() { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296; }
      // biquad band-pass (constant skirt), state in an array
      bp(st, x, f, q) {
        const w = TWO_PI * Math.min(f, sampleRate * 0.45) / sampleRate, al = Math.sin(w) / (2 * q), cw = Math.cos(w), a0 = 1 + al;
        const y = (al * x - al * st[1] + 2 * cw * st[2] - (1 - al) * st[3]) / a0;
        st[1] = st[0]; st[0] = x; st[3] = st[2]; st[2] = y;
        return y;
      }
      process(inputs, outputs) {
        const out = outputs[0][0];
        if (!out) return true;
        const P = this.p, S = this.s, n = out.length, sr = sampleRate, cheap = P.cheap;
        // a timed schedule of [seconds, rpm, throttle, gear, speed, kers, harvest] (offline renders and tests)
        if (P.sched) {
          const sc = P.sched; while (this.si + 1 < sc.length && sc[this.si + 1][0] <= currentTime) this.si++;
          const r = sc[this.si || 0];
          if (r[3] !== P.gear && P.gear) { P.shift = (P.shift || 0) + 1; P.shiftDir = r[3] > P.gear ? 1 : -1; }
          P.rpm = r[1]; P.thr = r[2]; P.gear = r[3]; P.speed = r[4]; P.kers = r[5] || 0; P.harv = r[6] || 0;
        }
        // per-block smoothing (no zipper noise)
        const dtB = n / sr;
        S.rpm += (P.rpm * P.dop - S.rpm) * 0.3;
        S.thr += (P.thr - S.thr) * 0.35;
        S.kers += (P.kers - S.kers) * 0.25; S.harv += (P.harv - S.harv) * 0.2;
        S.view += (P.view - S.view) * 0.05;
        const rpm = Math.max(900, S.rpm), thr = Math.max(0, Math.min(1, S.thr)), x = rpm / 11000;
        // engine load: throttle, plus the fuel flow ramp up to 10,500 rpm
        S.load = thr * Math.min(1, 0.45 + 0.55 * rpm / 10500);
        // turbo shaft: spools toward boost on throttle; off throttle the MGU-H motors it to keep it near 70,000
        const tTarget = thr > 0.15 ? 55000 + 70000 * S.load : 68000 + 4000 * (rpm / 12000);
        S.turbo += (tTarget - S.turbo) * Math.min(1, dtB * (tTarget > S.turbo ? 3.5 : 2.2));
        // wastegate: opens when the turbine has more exhaust than the boost target needs
        S.wg += ((S.load > 0.75 && rpm > 9500 ? (S.load - 0.75) * 4 * Math.min(1, (rpm - 9500) / 2000) : 0) - S.wg) * 0.08;
        // shifts: a new count from the main thread starts a cut (up) or a blip (down)
        if (P.shift !== this.lastShift) {
          this.lastShift = P.shift;
          if (P.shiftDir > 0) { this.cut = 0.012 * sr; this.bark = 0.9; } else { this.bark = 1.3; this.crackle = Math.max(this.crackle, 0.45); }
        }
        // lifting at speed: the overrun crackles for a moment
        if (this.lastThr > 0.6 && P.thr < 0.1) { if (rpm > 8000) this.crackle = Math.max(this.crackle, 0.6); this.flutter = 1; }
        this.lastThr = P.thr;
        const fireHz = rpm / 20, cycHz = rpm / 120;
        // the turbine smooths the pulses more as it works harder; the wastegate path bypasses it
        const turbLP = 0.06 + 0.12 * (1 - S.load) + 0.08 * S.wg;
        const tailD = Math.max(8, Math.min(4000, sr / fireHz * 2)); // tailpipe tuned to half the firing rate
        const fb = 0.38 + 0.2 * thr;
        // blowdown pulse decay: a sharp front and about a millisecond of tail
        const decay = Math.exp(-1 / (sr * (0.0006 + 0.0005 * (1 - thr))));
        // primary pipe delays (in samples) differ a little between the banks
        const pd0 = Math.round(sr * 0.0011), pd1 = Math.round(sr * 0.00128);
        const view = S.view;
        const turboF = S.turbo / 60 * 3.3, hF = S.turbo / 60 * 2, kF = rpm / 60 * 3.33 * 4;
        // input shaft turns with the crank; the output shaft with the wheels (0.36 m tyre radius, about 3.5:1 final drive)
        const giF = rpm / 60 * 29, goF = P.speed / 2.262 * 3.5 * 31;
        const plenumF = 170 + rpm * 0.012;
        const kLvl = 0.018 * S.kers + 0.04 * S.harv, tLvl = 0.02 + 0.03 * S.load;
        // output low-pass corner: about 7 kHz outside, 5.5 kHz in the helmet
        const olp = 1 - Math.exp(-TWO_PI * (7000 - 1500 * view) / sr);
        const mdec = Math.exp(-1 / (sr * this.T.mDecay)), mlpK = 1 - Math.exp(-TWO_PI * this.T.lpF / sr), oK = 1 - Math.exp(-TWO_PI * this.T.oLP / sr);
        for (let i = 0; i < n; i++) {
          // crank: fire the next cylinder every 120 degrees (a sixth of the 720 degree cycle)
          this.ph += fireHz / sr;
          if (this.ph >= 1) {
            this.ph -= 1;
            this.cyl = (this.cyl + 1) % 6;
            let a = (0.16 + 0.84 * S.load + 0.12 * thr) * CYL[this.cyl] * (1 - this.T.jit / 2 + this.T.jit * this.rnd()); // combustion varies firing to firing
            if (this.cut > 0) a *= 0.08;                // upshift ignition cut
            if (thr < 0.08) {
              a *= 0.32;                                 // fuel cut on the overrun: just the pumping
              if (this.crackle > 0.05 && this.rnd() < 0.09 * this.crackle) a = 1.1 + 1.2 * this.rnd(); // fuel lights in the exhaust
            }
            if (this.bark > 0.05) a *= 1 + 0.35 * this.bark; // the blip or the gear taking drive
            if (P.on < 0.5 && this.rnd() < 0.8) a *= 0.05;  // limiter or engine off
            this.env[BANK[this.cyl]] = Math.max(this.env[BANK[this.cyl]], a);
            // ONB: what a microphone on the airbox hears. The nearer bank's induction and the
            // plenum dominate: the far bank comes through much weaker (asym), which puts the
            // 1.5 engine order (one bank's firings) on top, and the runners' differences (vary)
            // fill in the half orders between
            const Tn = this.T, mb = (BANK[this.cyl] ? 1 - Tn.asym : 1) * Math.max(0, 1 + Tn.vary * VAR[this.cyl]);
            this.menv = Math.max(this.menv, a * mb);
          }
          if (this.cut > 0) this.cut--;
          // the two banks' primaries into the collector (each pulse plus a weak reflection)
          const e0 = this.env[0], e1 = this.env[1];
          this.env[0] *= decay; this.env[1] *= decay;
          const pr0 = this.prim[0], pr1 = this.prim[1], pi = this.pi;
          pr0[pi] = e0; pr1[pi] = e1;
          const coll = e0 + e1 - 0.22 * (pr0[(pi - pd0 + 512) & 511] + pr1[(pi - pd1 + 512) & 511]);
          this.pi = (pi + 1) & 511;
          // turbine: a two-pole smoothing of the pulses; the wastegate share skips it
          this.tlp1 += (coll - this.tlp1) * turbLP; this.tlp2 += (this.tlp1 - this.tlp2) * turbLP;
          const exh = this.tlp2 * (1 - 0.6 * S.wg) + coll * (0.18 + 0.6 * S.wg);
          // tailpipe resonance: a comb with a damped, low-passed return
          const di = Math.floor(tailD), fr = tailD - di;
          const r0 = this.comb[(this.ci - di + 4096) & 4095], r1 = this.comb[(this.ci - di - 1 + 4096) & 4095];
          this.clp += (r0 + (r1 - r0) * fr - this.clp) * 0.45;
          const pipe = exh + this.clp * fb;
          this.comb[this.ci] = pipe; this.ci = (this.ci + 1) & 4095;
          // radiation from the pipe mouth: rises with frequency (a first difference)
          const radO = pipe - this.rad * 0.82; this.rad = pipe;
          let y = (pipe * 0.7 + radO * 0.35) * (1 - 0.55 * view);
          if (!cheap && view > 0.01) {
            // the on-board mix: the plenum's two resonances over the mic pulse train, its low-passed
            // body, and the bright intake hiss the pulses modulate
            const Tn = this.T, me = this.menv; this.menv *= mdec;
            this.mlp += (me - this.mlp) * mlpK;
            const hissM = (this.rnd() * 2 - 1) * me;
            let body = this.bp(this.mb1, me, Tn.plF, Tn.plQ) * Tn.plG + this.bp(this.mb2, me, Tn.p2F, Tn.p2Q) * Tn.p2G + this.mlp * Tn.lpG;
            // the airbox walls and the camera pod: a steep roll-off above the plenum's band
            this.ml1 += (body - this.ml1) * oK; this.ml2 += (this.ml1 - this.ml2) * oK; body = this.ml2;
            const onb = body + this.bp(this.mhb, hissM, Tn.hiF, Tn.hiQ) * Tn.hiG;
            y = y * (1 - Tn.mix * view) + onb * Tn.mGain * view * 3;
          }
          // the airbox: induction pulses through the plenum's resonance, and intake roar
          if (!cheap) {
            const ind = e0 + e1;
            y += this.bp(this.ib, ind, plenumF, 3) * (0.25 + 0.9 * view) * (0.4 + 0.6 * thr);
            const hiss = (this.rnd() * 2 - 1) * (0.25 + ind * 0.6);
            y += this.bp(this.nb, hiss, 1800 + rpm * 0.15, 0.9) * 0.05 * (0.2 + view) * (0.3 + thr);
            // the chassis and seat carry the firing as a low drone: on board only
            y += this.bp(this.lb, coll, fireHz * 0.5, 2) * 0.35 * view;
          }
          // valve train and mechanical clatter, a little more on board
          y += (this.rnd() * 2 - 1) * (0.004 + 0.005 * view) * x;
          if (!cheap) {
            // turbo whistle and the MGU-H's electric whine
            this.tph += turboF / sr; this.hph += hF / sr; this.kph += kF / sr; this.giph += giF / sr; this.goph += goF / sr;
            if (this.tph > 1) this.tph -= 1; if (this.hph > 1) this.hph -= 1; if (this.kph > 1) this.kph -= 1; if (this.giph > 1) this.giph -= 1; if (this.goph > 1) this.goph -= 1;
            y += Math.sin(this.tph * TWO_PI) * tLvl * (0.5 + 0.8 * view) + Math.sin(this.hph * TWO_PI) * 0.008 * (0.3 + view);
            // MGU-K: crank-geared electric machine, its whine with a second harmonic
            y += (Math.sin(this.kph * TWO_PI) + 0.35 * Math.sin(this.kph * 2 * TWO_PI)) * kLvl * (0.4 + 0.8 * view);
            // straight-cut gears: input and output shaft mesh tones, faint, on board
            y += (Math.sin(this.giph * TWO_PI) * 0.006 + Math.sin(this.goph * TWO_PI) * 0.005) * view * Math.min(1, P.speed / 30);
            // compressor surge flutter when the throttle snaps shut at high boost
            if (this.flutter > 0.001) { y += (this.rnd() * 2 - 1) * 0.05 * this.flutter * (0.5 + 0.5 * Math.sin(this.tph * 0.3)); this.flutter *= 0.9993; }
          }
          // the pulses are all positive: block the DC before the soft clip
          const hp = y - this.dcx + 0.995 * this.dcy; this.dcx = y; this.dcy = hp;
          // air and distance (outside) or the helmet and earplugs (on board) take the very top off
          this.o1 += (hp - this.o1) * olp; this.o2 += (this.o1 - this.o2) * olp;
          out[i] = Math.tanh(this.o2 * 0.75) * 0.62 * P.gain * (P.on < 0.5 ? 0.4 : 1);
        }
        this.bark *= Math.pow(0.0005, dtB); this.crackle *= Math.pow(0.08, dtB);
        return true;
      }
    }
    registerProcessor('engine-voice', EngineVoice);
  };
})(typeof window !== 'undefined' ? window : globalThis);
