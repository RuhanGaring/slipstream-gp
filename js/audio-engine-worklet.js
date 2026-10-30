// Physically inspired engine voice, run on the audio thread (an AudioWorklet). The whole
// worklet is the body of F1.EngineWorklet: js/audio.js turns its source into a blob and
// loads that, so it works offline from file:// as well.
// A 1.6 litre V6 four-stroke fires three times per crank revolution: rpm / 20 pulses a
// second, 600 Hz at 12,000 rpm. Each firing is a short pressure pulse, its size set by the
// throttle and load, with a little cylinder-to-cylinder spread. The pulses run through an
// exhaust model: a tuned pipe (a comb filter with a lossy, damped return, which gives the
// harmonic rasp of a high-revving engine) and two body resonances, then soft clipping.
// Off the throttle the pulses shrink and now and then a cylinder misfires into the hot
// exhaust: a pop. On top: the turbo's whistle (with the flutter of the compressor when the
// throttle shuts), the MGU-K's electric whine that follows road speed, gear whine, and
// mechanical noise from the valve train.
(function (G) {
  'use strict';
  (G.F1 = G.F1 || {}).EngineWorklet = function () {
    const CYL = [1.0, 0.975, 1.015, 0.985, 1.01, 0.98];
    class EngineVoice extends AudioWorkletProcessor {
      constructor(opts) {
        super();
        this.p = { rpm: 4000, thr: 0, load: 0.5, speed: 0, gear: 1, dop: 1, kers: 0, gain: 1, cheap: 0, on: 1 };
        this.s = { rpm: 4000, thr: 0, kers: 0 };
        this.ph = 0; this.cyl = 0; this.env = 0; this.envA = 0;
        this.comb = new Float32Array(4096); this.ci = 0; this.lp = 0; this.dcx = 0; this.dcy = 0;
        this.b1 = [0, 0, 0, 0]; this.b2 = [0, 0, 0, 0];
        this.tph = 0; this.kph = 0; this.gph = 0; this.flutter = 0; this.lastThr = 0;
        this.seed = Math.random() * 1e9 | 0; this.si = 0;
        if (opts && opts.processorOptions) Object.assign(this.p, opts.processorOptions);
        this.port.onmessage = e => Object.assign(this.p, e.data);
      }
      rnd() { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296; }
      // biquad band-pass, state in arrays
      bp(st, x, f, q) {
        const w = 2 * Math.PI * Math.min(f, sampleRate * 0.45) / sampleRate, al = Math.sin(w) / (2 * q), cw = Math.cos(w), a0 = 1 + al;
        const y = (al * x - al * st[1] - (-2 * cw) * st[2] - (1 - al) * st[3]) / a0;
        st[1] = st[0]; st[0] = x; st[3] = st[2]; st[2] = y;
        return y;
      }
      process(inputs, outputs) {
        const out = outputs[0][0];
        if (!out) return true;
        const P = this.p, S = this.s, n = out.length, sr = sampleRate;
        // a timed schedule of [seconds, rpm, throttle, gear, speed] (offline rendering and tests)
        if (P.sched) { const sc = P.sched; while (this.si + 1 < sc.length && sc[this.si + 1][0] <= currentTime) this.si++; const r = sc[this.si || 0]; P.rpm = r[1]; P.thr = r[2]; P.gear = r[3]; P.speed = r[4]; P.kers = r[2] > 0.9 ? 1 : 0; }
        // parameter smoothing per block (no zipper noise)
        S.rpm += (P.rpm * P.dop - S.rpm) * 0.25;
        S.thr += (P.thr - S.thr) * 0.3;
        S.kers += (P.kers - S.kers) * 0.2;
        if (this.lastThr > 0.6 && P.thr < 0.15) this.flutter = 1; // compressor flutter as the throttle snaps shut
        this.lastThr = P.thr;
        const rpm = Math.max(800, S.rpm), thr = S.thr, cheap = P.cheap;
        const fireHz = rpm / 20; // three firings per revolution
        // exhaust pipe: a return delay of one firing period, so the pipe reinforces the firing
        // harmonics (a tuned exhaust) instead of ringing at a pitch of its own
        const pipeD = Math.max(8, Math.min(4000, sr / fireHz));
        const fb = 0.42 + 0.22 * thr;
        const decay = Math.exp(-1 / (sr * (0.0005 + 0.0006 * (1 - thr))));
        // body resonances: one on the firing note itself, a weaker one around its third harmonic
        const f1 = fireHz, f2 = 900 + rpm * 0.12;
        const turboF = 2600 + rpm * 0.55, kersF = 900 + P.speed * 42, gearF = P.speed * (22 + 3 * P.gear);
        for (let i = 0; i < n; i++) {
          // crank: fire the next cylinder each third of a revolution
          this.ph += fireHz / sr;
          if (this.ph >= 1) {
            this.ph -= 1;
            this.cyl = (this.cyl + 1) % 6;
            let a = (0.18 + 0.82 * thr) * CYL[this.cyl] * (0.92 + 0.16 * this.rnd());
            // off throttle: weak firings, and now and then unburnt fuel lights in the exhaust
            if (thr < 0.1 && rpm > 7000 && this.rnd() < 0.012) a = 1.6 + this.rnd();
            else if (thr < 0.1) a *= 0.45;
            this.env = Math.max(this.env, a); this.envA = a;
          }
          const e = this.env * (0.88 + 0.12 * (this.rnd() * 2 - 1));
          this.env *= decay;
          // pipe: comb with a damped, low-passed return (fractional delay, linear interpolation)
          const di = Math.floor(pipeD), fr = pipeD - di;
          const r0 = this.comb[(this.ci - di + 4096) & 4095], r1 = this.comb[(this.ci - di - 1 + 4096) & 4095];
          this.lp += (r0 + (r1 - r0) * fr - this.lp) * 0.5;
          const xpipe = e + this.lp * fb;
          this.comb[this.ci] = xpipe; this.ci = (this.ci + 1) & 4095;
          let y = xpipe * 0.6 + this.bp(this.b1, xpipe, f1, 2.5) * 0.8 + (cheap ? 0 : this.bp(this.b2, xpipe, f2, 2) * 0.45);
          // valve train and mechanicals
          y += (this.rnd() * 2 - 1) * 0.02 * rpm / 12000;
          if (!cheap) {
            this.tph += turboF / sr; this.kph += kersF / sr; this.gph += gearF / sr;
            y += Math.sin(this.tph * 6.2832) * 0.035 * thr * Math.min(1, rpm / 9000);
            y += Math.sin(this.kph * 6.2832) * 0.03 * S.kers + Math.sin(this.kph * 12.566) * 0.012 * S.kers;
            y += Math.sin(this.gph * 6.2832) * 0.004 * Math.min(1, P.speed / 40);
            if (this.flutter > 0.001) { y += (this.rnd() * 2 - 1) * 0.12 * this.flutter * (0.5 + 0.5 * Math.sin(this.tph * 0.21)); this.flutter *= 0.9995; }
          }
          // the pulses are all positive: block the DC they carry before the soft clip
          const hp = y - this.dcx + 0.995 * this.dcy; this.dcx = y; this.dcy = hp;
          out[i] = Math.tanh(hp * 0.55) * 0.6 * P.gain * P.on;
        }
        return true;
      }
    }
    registerProcessor('engine-voice', EngineVoice);
  };
})(typeof window !== 'undefined' ? window : globalThis);
