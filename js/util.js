// Shared math helpers. Every game module hangs off the global F1 namespace so the
// same files run in the browser (classic scripts, works from file://) and in Node
// for the headless race tests in tools/.
(function simModule(G) {
  'use strict';
  (G.F1simMods = G.F1simMods || []).push(simModule); // the learning workers rebuild the sim from these
  const F1 = G.F1 = G.F1 || {};

  const U = F1.U = {};
  U.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  U.lerp = (a, b, t) => a + (b - a) * t;
  U.smooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  U.sign = v => (v < 0 ? -1 : 1);
  U.wrapAngle = a => {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  };
  // Move v toward target by at most rate*dt.
  U.approach = (v, target, rate) => {
    if (v < target) return Math.min(target, v + rate);
    return Math.max(target, v - rate);
  };
  U.expDamp = (v, target, k, dt) => target + (v - target) * Math.exp(-k * dt);

  // Deterministic PRNG so track decoration and AI personalities repeat.
  U.rng = seed => {
    let s = seed >>> 0 || 1;
    return () => {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  };

  U.fmtTime = (t, withMinutes = true) => {
    if (t == null || !isFinite(t)) return '--:--.---';
    const neg = t < 0; t = Math.abs(t);
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    const ss = s.toFixed(3).padStart(6, '0');
    const out = withMinutes || m > 0 ? `${m}:${ss}` : s.toFixed(3);
    return neg ? '-' + out : out;
  };
  U.fmtGap = t => {
    if (t == null || !isFinite(t)) return '';
    return (t >= 0 ? '+' : '-') + Math.abs(t).toFixed(3);
  };

  U.kmh = ms => ms * 3.6;
})(typeof window !== 'undefined' ? window : globalThis);
